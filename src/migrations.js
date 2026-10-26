// Database migrations. Each runs once, in order, inside a transaction; the schema version is
// kept in SQLite's PRAGMA user_version. Every step is written so it is also safe on databases
// created before migrations existed (CREATE ... IF NOT EXISTS, guarded ALTERs).
//
// Times: bookings made through the legacy flow use a club-local date + minutes. New models
// (classes, holds, memberships) store UTC ISO strings, as the build spec asks; Phase 4 moves
// table bookings over to the same.
const { DEFAULT_PLANS } = require('./plans');

const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
const addColumn = (db, table, column, definition) => {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};

const MIGRATIONS = [
  {
    name: 'baseline: settings, tables, bookings, blocks, accounts',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tables (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS bookings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE,
          manageToken TEXT NOT NULL,
          tableId INTEGER NOT NULL REFERENCES tables(id),
          date TEXT NOT NULL,
          startMin INTEGER NOT NULL,
          endMin INTEGER NOT NULL,
          name TEXT NOT NULL,
          phone TEXT,
          players INTEGER NOT NULL,
          price REAL NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS blocks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tableId INTEGER REFERENCES tables(id),
          date TEXT NOT NULL,
          startMin INTEGER NOT NULL,
          endMin INTEGER NOT NULL,
          reason TEXT,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks(date);
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          phone TEXT,
          passwordHash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'PLAYER',
          skillLevel TEXT NOT NULL,
          planId TEXT NOT NULL DEFAULT 'dropin',
          planStatus TEXT NOT NULL DEFAULT 'active',
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        -- Only a SHA-256 of each token is stored, so a leaked database can't be used to log in.
        CREATE TABLE IF NOT EXISTS sessions (
          tokenHash TEXT PRIMARY KEY,
          userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          createdAt TEXT NOT NULL,
          expiresAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);
        CREATE TABLE IF NOT EXISTS password_resets (
          tokenHash TEXT PRIMARY KEY,
          userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expiresAt TEXT NOT NULL,
          usedAt TEXT
        );
      `);
      addColumn(db, 'bookings', 'type', "TEXT NOT NULL DEFAULT 'casual'");
    },
  },
  {
    name: 'areas: tables belong to an area (Main hall, Private room)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS areas (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0
        );
      `);
      addColumn(db, 'tables', 'areaId', 'INTEGER REFERENCES areas(id)');
      addColumn(db, 'tables', 'number', 'INTEGER');
      if (db.prepare('SELECT COUNT(*) AS c FROM areas').get().c === 0) {
        const insert = db.prepare('INSERT INTO areas (name, description, sortOrder) VALUES (?, ?, ?)');
        insert.run('Main hall', 'Auto-assign best table', 1);
        insert.run('Private room', 'More space · 1 table', 2);
      }
      const main = db.prepare("SELECT id FROM areas WHERE name = 'Main hall'").get().id;
      const room = db.prepare("SELECT id FROM areas WHERE name = 'Private room'").get().id;
      const tables = db.prepare('SELECT * FROM tables ORDER BY id').all();
      if (tables.length === 0) {
        // A new club: 3 tables in the main hall, 1 in the private room
        const insert = db.prepare('INSERT INTO tables (name, areaId, number) VALUES (?, ?, ?)');
        [1, 2, 3].forEach(n => insert.run(`Table ${n}`, main, n));
        insert.run('Table 4', room, 4);
      } else {
        // An existing club keeps its tables, all in the main hall
        const update = db.prepare('UPDATE tables SET areaId = COALESCE(areaId, ?), number = COALESCE(number, ?) WHERE id = ?');
        tables.forEach((t, i) => update.run(main, i + 1, t.id));
      }
    },
  },
  {
    name: 'memberships: plans in the database, one membership per user',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS membership_plans (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          priceMonthly REAL NOT NULL,
          tableDiscountPct REAL NOT NULL DEFAULT 0,
          bookingWindowDays INTEGER NOT NULL,
          monthlyTableCredits INTEGER NOT NULL DEFAULT 0,
          includedLessonsPerMonth INTEGER NOT NULL DEFAULT 0,
          offPeakTablesFree INTEGER NOT NULL DEFAULT 0,
          summary TEXT NOT NULL,
          perks TEXT NOT NULL DEFAULT '[]',
          popular INTEGER NOT NULL DEFAULT 0,
          stripePriceId TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          sortOrder INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS memberships (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          planId TEXT NOT NULL REFERENCES membership_plans(id),
          status TEXT NOT NULL,                -- ACTIVE | PENDING_PAYMENT | PAST_DUE | CANCELED
          currentPeriodEnd TEXT,
          cancelAtPeriodEnd INTEGER NOT NULL DEFAULT 0,
          stripeSubscriptionId TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
      `);
      addColumn(db, 'users', 'stripeCustomerId', 'TEXT');
      const insertPlan = db.prepare(`INSERT OR IGNORE INTO membership_plans
        (id, name, priceMonthly, tableDiscountPct, bookingWindowDays, monthlyTableCredits, includedLessonsPerMonth,
         offPeakTablesFree, summary, perks, popular, sortOrder)
        VALUES (@id, @name, @priceMonthly, @tableDiscountPct, @bookingWindowDays, @monthlyTableCredits,
         @includedLessonsPerMonth, @offPeakTablesFree, @summary, @perks, @popular, @sortOrder)`);
      DEFAULT_PLANS.forEach((p, i) => insertPlan.run({
        ...p, perks: JSON.stringify(p.perks), popular: p.popular ? 1 : 0, offPeakTablesFree: p.offPeakTablesFree ? 1 : 0, sortOrder: i,
      }));
      // Move each account's plan from the users table (Phase 2) into memberships
      const now = new Date().toISOString();
      db.prepare(`INSERT OR IGNORE INTO memberships (userId, planId, status, createdAt, updatedAt)
        SELECT id, planId, CASE planStatus WHEN 'pending_payment' THEN 'PENDING_PAYMENT' ELSE 'ACTIVE' END, ?, ?
        FROM users`).run(now, now);
    },
  },
  {
    name: 'pricing and coaching: price rules, coaches, availability, lesson types, classes',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS price_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          durationMin INTEGER NOT NULL,
          basePrice REAL NOT NULL,
          peakPrice REAL NOT NULL,
          peakStart TEXT,                      -- HH:MM club time; NULL = no peak window
          peakEnd TEXT,
          daysOfWeek TEXT NOT NULL             -- JSON [0..6], 0 = Sunday
        );
        CREATE TABLE IF NOT EXISTS coaches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          bio TEXT,
          certification TEXT,
          yearsCoaching INTEGER,
          specialties TEXT NOT NULL DEFAULT '[]',
          levels TEXT NOT NULL DEFAULT '[]',
          photoUrl TEXT,
          active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS coach_availability (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          coachId INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
          dayOfWeek INTEGER NOT NULL,
          startTime TEXT NOT NULL,
          endTime TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS coach_time_off (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          coachId INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
          startDate TEXT NOT NULL,
          endDate TEXT NOT NULL,
          reason TEXT
        );
        CREATE TABLE IF NOT EXISTS lesson_types (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          durationMin INTEGER NOT NULL,
          maxStudents INTEGER NOT NULL,
          price REAL NOT NULL,
          active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS class_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'CLASS',  -- CLASS | OPEN_PLAY
          level TEXT NOT NULL,
          coachId INTEGER REFERENCES coaches(id),
          tableIds TEXT NOT NULL DEFAULT '[]',
          startsAt TEXT NOT NULL,              -- UTC
          endsAt TEXT NOT NULL,
          capacity INTEGER NOT NULL,
          price REAL NOT NULL,
          recurrenceRule TEXT,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_classes_start ON class_sessions(startsAt);
      `);
    },
  },
  {
    name: 'bookings for accounts, lessons and classes; credits, packs, promos, notifications',
    up(db) {
      // Class bookings have no single table, so tableId becomes optional. SQLite can't drop
      // NOT NULL in place: rebuild the table and copy every row across.
      const tableIdRequired = db.prepare('PRAGMA table_info(bookings)').all().find(c => c.name === 'tableId').notnull === 1;
      if (tableIdRequired) {
        db.exec(`
          CREATE TABLE bookings_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            manageToken TEXT NOT NULL,
            tableId INTEGER REFERENCES tables(id),
            date TEXT NOT NULL,
            startMin INTEGER NOT NULL,
            endMin INTEGER NOT NULL,
            name TEXT NOT NULL,
            phone TEXT,
            players INTEGER NOT NULL,
            price REAL NOT NULL,
            status TEXT NOT NULL,
            source TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'casual'
          );
          INSERT INTO bookings_new (id, code, manageToken, tableId, date, startMin, endMin, name, phone, players, price, status, source, createdAt, updatedAt, type)
            SELECT id, code, manageToken, tableId, date, startMin, endMin, name, phone, players, price, status, source, createdAt, updatedAt, type FROM bookings;
          DROP TABLE bookings;
          ALTER TABLE bookings_new RENAME TO bookings;
        `);
      }
      addColumn(db, 'bookings', 'userId', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
      addColumn(db, 'bookings', 'kind', "TEXT NOT NULL DEFAULT 'TABLE'");   // TABLE | LESSON | CLASS
      addColumn(db, 'bookings', 'coachId', 'INTEGER REFERENCES coaches(id)');
      addColumn(db, 'bookings', 'lessonTypeId', 'INTEGER REFERENCES lesson_types(id)');
      addColumn(db, 'bookings', 'classSessionId', 'INTEGER REFERENCES class_sessions(id)');
      addColumn(db, 'bookings', 'holdExpiresAt', 'TEXT');
      addColumn(db, 'bookings', 'paymentMethod', 'TEXT');                   // CARD | CREDIT | PACK | MEMBERSHIP | DESK
      addColumn(db, 'bookings', 'checkInCode', 'TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, tableId);
        CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(phone);
        CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(userId);
        CREATE INDEX IF NOT EXISTS idx_bookings_class ON bookings(classSessionId);

        CREATE TABLE IF NOT EXISTS booking_participants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bookingId INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
          userId INTEGER REFERENCES users(id) ON DELETE SET NULL,
          inviteEmail TEXT,
          shareAmount REAL NOT NULL DEFAULT 0,
          paid INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS waitlist (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          classSessionId INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
          userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          notifiedAt TEXT,
          createdAt TEXT NOT NULL,
          UNIQUE (classSessionId, userId)
        );
        -- Balances are always the sum of entries; nothing stores a mutable balance.
        CREATE TABLE IF NOT EXISTS credit_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL,                  -- TABLE_CREDIT | LESSON_PACK
          delta INTEGER NOT NULL,
          reason TEXT NOT NULL,
          bookingId INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(userId, type);
        CREATE TABLE IF NOT EXISTS lesson_packs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          lessonsTotal INTEGER NOT NULL,
          lessonsUsed INTEGER NOT NULL DEFAULT 0,
          expiresAt TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS promo_codes (
          code TEXT PRIMARY KEY,
          percentOff REAL,
          amountOff REAL,
          validFrom TEXT NOT NULL,
          validTo TEXT NOT NULL,
          maxUses INTEGER,
          uses INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          readAt TEXT,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(userId, readAt);
      `);
    },
  },
  {
    name: 'payments, split shares and promo on bookings',
    up(db) {
      db.exec(`
        -- Every money movement: card (demo or Stripe), refunds are a status change on the row
        CREATE TABLE IF NOT EXISTS payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bookingId INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
          participantId INTEGER REFERENCES booking_participants(id) ON DELETE SET NULL,
          userId INTEGER REFERENCES users(id) ON DELETE SET NULL,
          kind TEXT NOT NULL,                  -- BOOKING | SHARE | REMAINDER | LESSON_PACK | MEMBERSHIP
          provider TEXT NOT NULL,              -- demo | stripe
          amount REAL NOT NULL,
          currency TEXT NOT NULL,
          status TEXT NOT NULL,                -- PENDING | SUCCEEDED | FAILED | REFUNDED | CANCELED
          providerRef TEXT,                    -- Stripe Checkout session id
          paymentIntent TEXT,
          description TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(bookingId);
        CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments(providerRef);
      `);
      addColumn(db, 'booking_participants', 'name', 'TEXT');
      addColumn(db, 'booking_participants', 'payToken', 'TEXT');
      addColumn(db, 'booking_participants', 'paidAt', 'TEXT');
      addColumn(db, 'booking_participants', 'coveredByOrganizerAt', 'TEXT');
      addColumn(db, 'bookings', 'basePrice', 'REAL');
      addColumn(db, 'bookings', 'promoCode', 'TEXT');
      addColumn(db, 'bookings', 'splitCost', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'bookings', 'email', 'TEXT');
      addColumn(db, 'bookings', 'cancelledAt', 'TEXT');
      addColumn(db, 'bookings', 'refundedAt', 'TEXT');
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_token ON booking_participants(payToken);
        CREATE INDEX IF NOT EXISTS idx_bookings_hold ON bookings(status, holdExpiresAt);
      `);
      // A club without price rules starts from the defaults
      if (db.prepare('SELECT COUNT(*) AS c FROM price_rules').get().c === 0) {
        const { DEFAULT_PRICE_RULES } = require('./pricing');
        const insert = db.prepare('INSERT INTO price_rules (durationMin, basePrice, peakPrice, peakStart, peakEnd, daysOfWeek) VALUES (?, ?, ?, ?, ?, ?)');
        for (const r of DEFAULT_PRICE_RULES) insert.run(r.durationMin, r.basePrice, r.peakPrice, r.peakStart, r.peakEnd, JSON.stringify(r.daysOfWeek));
      }
    },
  },
  {
    name: 'lessons and classes: lesson type copy, waitlist offers, pack purchases',
    up(db) {
      addColumn(db, 'lesson_types', 'description', 'TEXT');
      addColumn(db, 'lesson_types', 'sortOrder', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'waitlist', 'offerExpiresAt', 'TEXT');     // a freed seat is held for #1 until then
      addColumn(db, 'lesson_packs', 'paymentId', 'INTEGER REFERENCES payments(id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_bookings_coach ON bookings(coachId, date)');
    },
  },
  {
    name: 'admin: holiday closures',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS closures (
          date TEXT PRIMARY KEY,               -- club-local YYYY-MM-DD
          reason TEXT,
          createdAt TEXT NOT NULL
        );
      `);
    },
  },
  {
    name: 'notifications: email preferences, reminders, renewal notices',
    up(db) {
      addColumn(db, 'users', 'notifyEmail', 'INTEGER NOT NULL DEFAULT 1');      // booking updates by email
      addColumn(db, 'users', 'notifyReminders', 'INTEGER NOT NULL DEFAULT 1');  // 2-hour reminders
      addColumn(db, 'bookings', 'reminderSentAt', 'TEXT');
      addColumn(db, 'memberships', 'renewalNoticeFor', 'TEXT');                 // the period end we warned about
    },
  },
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let i = current; i < MIGRATIONS.length; i++) {
    // The bookings rebuild needs foreign keys off while the old table is dropped
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      MIGRATIONS[i].up(db);
      db.pragma(`user_version = ${i + 1}`);
    })();
    db.pragma('foreign_keys = ON');
    const problems = db.pragma('foreign_key_check');
    if (problems.length) throw new Error(`Migration ${i + 1} broke foreign keys: ${JSON.stringify(problems.slice(0, 3))}`);
  }
  return { from: current, to: MIGRATIONS.length };
}

module.exports = { migrate, MIGRATIONS };
