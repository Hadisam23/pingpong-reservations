# Rally Club — table tennis club app

Book a table, book a coach, play more. Players book tables, lessons and group classes from their
phone (iOS app or website), pay or use credits, and check in with a QR code. Staff run the club
from a desktop admin panel. Built from `docs/BUILD_SPEC.md` and the screens in
`docs/design/screens/` (the visual source of truth).

**Stack:** Node 22, Express 4, SQLite (better-sqlite3), plain HTML/CSS/JS (no build step),
Capacitor 8 for iOS. Tests: `node:test`, Playwright, axe-core.

## Run it locally

```bash
npm install
npm run seed      # demo world: 4 tables, 3 coaches, a week of classes, demo accounts, bookings
npm start         # http://localhost:3000
```

| Open | What |
|---|---|
| http://localhost:3000 | The player app (Welcome → Home) |
| http://localhost:3000/admin | Front desk / admin panel |
| http://localhost:3000/styleguide | Every component and state |

**Demo logins** (password `rally-demo-2026` for all):

| Email | Who |
|---|---|
| `player@rallyclub.test` | Noa Cohen, Club member: bookings, 3 table credits, lesson pack 4 of 10, on a waitlist |
| `coach@rallyclub.test` | Dana Peretz, head coach |
| `admin@rallyclub.test` | Staff account for `/admin` |

**Payments: test card `4242 4242 4242 4242`.** Without Stripe keys the app runs in demo mode: card
payments go through at once with the test card and no real money moves. With
`STRIPE_SECRET_KEY` (test mode) and `STRIPE_WEBHOOK_SECRET`, payments and memberships use Stripe
Checkout; in Stripe's checkout use `4242 4242 4242 4242`, any future date, any CVC. For local
webhooks: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

`npm run seed` replaces bookings, classes, coaches, price rules and promo codes in `DB_PATH` and
recreates the `@rallyclub.test` accounts; other accounts are kept. `-- --seed 42` gives the same
data every time.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/pingpong.db` | SQLite file. Use a persistent volume in production |
| `BASE_URL` | request address | Public URL for links in emails and Stripe return pages |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | – | Stripe test/live mode (otherwise demo payments) |
| `RESEND_API_KEY` or `SMTP_URL`, `EMAIL_FROM` | – | Real email (otherwise printed to the console) |
| `CHECKIN_SECRET` | generated, kept in the DB | Signs the QR check-in codes |
| `ADMIN_PASSWORD` | – | Optional Bearer token for scripts; staff normally log in with an ADMIN account |
| `CORS_ORIGINS` | – | Extra allowed origins. The app's own origins are always allowed |

On a real install with no demo data: sign up in the app, then `npm run make-admin -- you@club.com`.

## Tests

```bash
npm test                      # 70+ API tests: booking rules, holds, payments, lessons, memberships, admin, emails
cd mobile && npm run test:e2e # the app on an emulated iPhone + axe accessibility scan of every screen
cd mobile && npm run test:ios # macOS + Xcode: builds the app, runs it in the iOS Simulator, books a table inside it
```

`test:ios` takes `DEVICE="iPhone 17"` to pick a simulator. Screenshots go to `mobile/shots/`.

## Mobile app (Capacitor, iOS)

The app bundles the same pages (`public/`) and talks to the backend at `API_URL`.

```bash
cd mobile
npm install
API_URL=http://localhost:3000 npm run sync   # build www/ and copy it into ios/
npm run open                                  # open in Xcode, or:
npx cap run ios                               # build + run on a simulator/device
```

On a physical iPhone, set `API_URL` to your Mac's LAN IP (e.g. `http://192.168.1.20:3000`). For
release builds, use your deployed HTTPS server.

## Placeholder content to replace

- **Prices:** table price rules, plan prices (Club ₪149, Pro ₪299), lesson prices (₪180/240/150),
  class prices, lesson-pack savings, promo `WELCOME10`. All editable in Admin → Pricing & plans.
- **Coaches:** Dana Peretz, Yossi Ben-David, Lina Haddad (names, bios, certifications, hours).
- **Classes:** the weekly schedule in the seed (Admin → Classes).
- **Club details:** name "Rally Club", 4 tables in 2 areas, opening hours, policies text in
  Profile → Club rules, the sender address `bookings@rallyclub.test` (`EMAIL_FROM`).
- **Brand:** the Rally Club mark and app icon (the iOS icon is still Capacitor's default).
- Seeded players, bookings and payments are random demo data.

## Accounts (Phase 2)

Players can create an account (email + password), pick a membership, and manage their profile.
**Guest booking keeps working without an account.**

| Page | What it does |
|---|---|
| `/welcome` | Create account, log in, or book as a guest |
| `/signup` | Step 1: name, email, phone, password, level, terms. Step 2: choose a membership. Step 3: pay (paid plans) |
| `/login`, `/forgot-password`, `/reset-password` | Log in; reset by an emailed, single-use link that expires in 1 hour |
| `/profile`, `/profile/edit` | Name, level, membership card, club rules, log out |

- Passwords are hashed with scrypt. Sessions last 30 days and only token hashes are stored.
- The website keeps the session in an HttpOnly cookie. The iOS app (another origin) keeps the token
  and sends `Authorization: Bearer`.
- 10 failed logins per email or IP in 15 minutes → wait 15 minutes.
- **Email:** see Notifications below. Without an email provider, messages are printed to the
  server console.
- **Paid plans** start after payment (step 3 of sign up, or Manage membership). Plan prices in
  `src/plans.js` are placeholders.
- Google and Apple sign-in come later. They need OAuth keys.

API: `POST /api/auth/signup | login | logout | forgot | reset`, `GET /api/session` (current user or
null), `GET|PATCH /api/me`, `PUT /api/me/plan`, `GET /api/plans`.

## Design system

The UI follows the Rally Club design in `docs/design/screens/` and `docs/BUILD_SPEC.md` (§1). Open
**`/styleguide`** to see every component in every state.

- **`public/tokens.css`** holds every colour, type size, spacing step, radius, shadow and timing. Change the
  look here. Nothing else in `public/` contains a raw colour; `test/design-tokens.test.js` checks this,
  checks the spec values, and checks WCAG AA contrast.
  - Palette: navy `--navy-900` #0B1F3A, hover `--navy-700` #13305C, focus `--navy-500` #1E3A8A, white, app
    background #F4F6FA, borders #E2E8F0, muted text #5B6B82. One accent, the ball orange `--orange` #F97316,
    used as a fill only; orange text uses `--orange-text` #C2410C.
  - Type: Plus Jakarta Sans (self-hosted in `public/fonts/`, OFL licence). Display 40 · H1 28 · H2 22 ·
    Section 17 · Body 15 · Small 13 · Caption 11–12.
  - Spacing 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48. Radius 12 (inputs) · 18 (cards) · 22–24 (hero) · pill.
- **`public/components.css`** + **`public/ui.js`** hold the components (prefix `ui-`):
  - **Button** `UI.button({ label, variant, size, iconLeft, iconRight, block })`. Variants: primary,
    inverse, secondary, outline-on-navy, ghost, danger, accent. Sizes: sm 40 · md 48 · lg 56 (44px tap
    target). States: hover, pressed, focus ring, disabled, and loading via `UI.setLoading(btn, true)`,
    which keeps the width.
  - Selection: `UI.dateStrip`, `UI.segmented` (also tabs), `UI.slots`, `UI.chips`, `UI.options`.
    All support the arrow keys.
  - Card, HeroCard, stat card, date block, ticket, badges, avatars, inputs, checkbox, toggle,
    radio cards, steps, bottom action bar, tab bar, empty/error states, skeletons, `UI.toast()`, icons.
- `public/styles.css` styles the pages that haven't been rebuilt yet; it reads the same tokens.

The taste-skill (`.claude/skills/taste-skill`) is available for reviews; its output goes to the ignored `.taste-skill/`.

## API

Errors always look like `{ "error": { "code": "slot_taken", "message": "…", "field": "…" } }`.
The endpoints for each part are listed in its section above. Below: the original booking API,
still used by the front desk (walk-ins, blocks) and older guest links.

### Public (original)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Center name, hours, durations, prices, rules, today's date |
| GET | `/api/availability?date=YYYY-MM-DD` | Slots (with price/peak/past) and busy ranges per table |
| POST | `/api/bookings` | `{ tableId, date, start: "HH:MM", duration, type, name, phone, players }` → booking, `manageToken`, `manageUrl` |
| GET | `/api/bookings/:code?token=…` or `?phone=…` | View a booking |
| POST | `/api/bookings/:code/cancel` | `{ token }` or `{ phone }` |

### Admin (staff session, or `Authorization: Bearer <ADMIN_PASSWORD>`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/day?date=` | Tables, hours, all bookings (with contact details), blocks |
| POST | `/api/admin/bookings` | Walk-in booking (phone optional, no advance/per-phone limits) |
| PATCH | `/api/admin/bookings/:code` | `{ status: confirmed \| checked_in \| no_show \| cancelled }` |
| POST | `/api/admin/blocks` | `{ tableId \| null, date, start, end, reason }`; response lists clashing bookings |
| DELETE | `/api/admin/blocks/:id` | Remove a block |
| GET/PUT | `/api/admin/settings` | Read / update settings (partial updates are merged) |
| GET/POST | `/api/admin/tables` | List / add tables |
| PATCH | `/api/admin/tables/:id` | `{ name, active }`. Can't deactivate a table with upcoming bookings |

## Data & demo world (Phase 3)

The database schema is versioned. `src/migrations.js` lists the steps; each runs once, in a
transaction, and the version is kept in SQLite's `user_version`. Older databases are upgraded in
place on start (existing tables move to the Main hall, Phase 2 plans become memberships).

New tables: areas, membership plans and memberships, price rules, coaches (availability, time off),
lesson types, class sessions, booking participants, waitlist, credit ledger, lesson packs, promo
codes, notifications. Bookings gained a kind (table, lesson or class) and an optional account.
New times are stored in UTC; table bookings keep the club's local date and minutes.

`npm run seed` creates:

| | |
|---|---|
| Accounts (password `rally-demo-2026`) | `player@rallyclub.test` (Noa Cohen, Club member: 3 table credits, lesson pack 4 of 10 left, upcoming table, lesson and open play, waitlisted for a full class), `coach@rallyclub.test` (Dana Peretz), `admin@rallyclub.test` |
| Coaches | Dana Peretz, Yossi Ben-David, Lina Haddad, with weekly hours (one has time off) |
| Lessons | Private (60 min), Semi-private (60 min), Video analysis (45 min) |
| Classes this week | Beginner fundamentals, Intermediate drills (full), Kids club, Match tactics, Open play |
| Other | 6 price rules (30, 60 and 90 min; weekday peak after 17:00, weekend rate), promo `WELCOME10`, a maintenance block, ~250 random table bookings |

Names, prices and schedules are placeholders.

## Table booking (Phase 4)

The app opens on **Home** (signed in) or **Welcome** (guests). A tab bar (Home · Tables · Lessons ·
Bookings · Profile) stays on every screen after sign-in, and for guests too.

| Screen | What it does |
|---|---|
| `home.html` | Next booking with its check-in pass, quick actions, free tables today |
| `book.html` | Date strip (limited by your plan's booking window), 30/60/90 min, start times (peak / full), Main hall (auto-assign) or Private room, live price |
| `checkout.html` | 10-minute hold with a countdown, players, split the cost, card / table credit / included in Pro, promo code, price breakdown, cancellation policy |
| `confirmed.html` | Ticket with a signed QR check-in code, Add to calendar (.ics), Invite friends |
| `bookings.html` | Upcoming / Past, credit counters, Reschedule, Cancel, Book again |
| `pay.html` | Pay-your-share link for split bookings |

Rules (enforced on the server):

- **No double booking.** Every path (app, website, front desk) checks one occupancy source:
  confirmed bookings, live holds, class sessions and maintenance blocks, inside an `IMMEDIATE`
  SQLite transaction.
- **Holds.** Continue reserves the lowest-numbered free table for 10 minutes. Expired holds are
  ignored and released by a background job (every minute).
- **Price** = price rule for the duration (peak/off-peak) − plan discount − promo. Pro plays
  off-peak tables free. One table credit covers a booking up to 60 min.
- **Cancel** until the start; full refund (card or credit) until 24 h before
  (`cancelCutoffMinutes`). **Reschedule** = move to a free time up to 24 h before, same price.
- **Split the cost:** you pay your share now, the others get a pay link; 2 h before the start the
  unpaid shares are charged to you.
- **Check-in code:** HMAC-signed token (booking, player, expiry = end time) in the QR code.
  Not checked in 15 min after the start → no-show.

**Payments.** Without keys the app runs in **demo mode**: card payments succeed with the test card
`4242 4242 4242 4242`. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (test mode) to use Stripe
Checkout; point a Stripe webhook at `/api/stripe/webhook` (`checkout.session.completed`,
`checkout.session.expired`).

API: `GET /api/tables/availability`, `GET /api/tables/free-today`, `POST /api/holds`,
`GET|DELETE /api/holds/:code`, `POST /api/holds/:code/quote|checkout`, `GET /api/my/bookings`,
`GET /api/reservations/:code` (+ `qrSvg`), `POST /api/reservations/:code/cancel|reschedule`,
`GET /api/reservations/:code/calendar.ics`, `GET|POST /api/shares/:token(/pay)`. Guests pass the
booking's `token` instead of a session.

## Lessons & classes (Phase 5)

| Screen | What it does |
|---|---|
| `lessons.html` | Private lessons (coach cards with the next free time) / Group classes (capacity bar, Join, Join waitlist), level filter |
| `coach.html` | Coach header, lesson type (Private 60 · Semi-private 60 · Video analysis 45), lesson-pack callout, free times for a day + See other days, Book |
| `packs.html` | Buy a 5 or 10-lesson pack, lessons left and expiry |

- A lesson slot needs the coach to be working (weekly hours, no time off, not already teaching)
  **and** a free table; the table is reserved with the lesson. Lessons and classes need an account.
- Lessons and class seats use the same hold → checkout → confirmed flow as tables. Payment:
  lesson-pack credit (picked automatically), card, or included in the plan (Pro: 1 lesson a month;
  Club and Pro: open play).
- **Classes:** capacity is checked in the same transaction as the hold. When full you can join the
  waitlist. A freed seat is offered to #1 for 2 hours (in-app + email), then moves to #2.
- **Packs:** 5 lessons save 10%, 10 save 15% on the private-lesson price; members save another 10%.
  Valid 6 months. Prices are placeholders.

API: `GET /api/coaches`, `GET /api/coaches/:id`, `GET /api/coaches/:id/slots`, `POST /api/lessons/holds`,
`GET /api/classes`, `POST /api/classes/:id/join`, `POST|DELETE /api/classes/:id/waitlist`,
`GET|POST /api/lesson-packs`.

## Memberships (Phase 6)

- Sign up step 3 / **Manage membership** (`membership.html`): pay to start Club or Pro, switch
  plans, cancel at the end of the period (benefits stay until then), keep it after all.
- **Demo mode:** the test card is charged at once; the background job renews each month (charge →
  new period → the plan's table credits; unused credits lapse) and moves cancelled members to
  Drop-in when the period ends. A failed renewal sets **past due**: member prices and the longer
  booking window pause until it's paid.
- **Stripe mode:** Stripe Checkout in subscription mode; Stripe renews and the webhook keeps the
  membership in step. Subscribe the webhook to `checkout.session.completed`, `invoice.paid`,
  `invoice.payment_failed`, `customer.subscription.updated` and `customer.subscription.deleted`.
  Plan changes update the subscription (prorated); Payment methods opens the Stripe billing portal.

API: `GET /api/me/membership`, `PUT /api/me/plan` (→ `{ user, membership, redirect? }`),
`POST /api/me/membership/cancel|resume`, `POST /api/me/payment-methods`.

## Admin panel (Phase 7)

`/admin`: desktop first, works on a tablet or phone. Staff log in with their own account (role
**ADMIN**). The demo seed has `admin@rallyclub.test`; on a real install sign up in the app, then run
`npm run make-admin -- you@club.com`. `ADMIN_PASSWORD` still works as a Bearer token for scripts.

| Section | What staff can do |
|---|---|
| Calendar | Day view: rows are tables, columns are time; bookings, lessons, classes and maintenance in their own colours. Drag across a table to block time or add a walk-in. Click anything to check in, mark a no-show, cancel with or without a refund |
| Bookings | Search by name, phone, email or code; filter by date, status and type |
| Check-in | Camera QR scanner (BarcodeDetector, or jsQR on Safari) + type a code + today's list |
| Coaches | Profile, specialties, levels, weekly hours, time off, show/hide in the app |
| Classes | Create one-off or weekly sessions (level, coach, tables, capacity, price); edit; cancel with refunds |
| Pricing & plans | Table price rules, plans (price, discount, window, credits), lesson types, lesson packs, promo codes |
| Members | Plan and status, credits, pack lessons, bookings, credits and payment history; adjust credits; change role |
| Settings | Club name, time zone, cancellation window, opening hours, tables & areas, holiday closures |
| Reports | Utilization by hour, revenue by type, no-show rate, bookings, active members |

## Notifications (Phase 8)

- **In the app:** the bell on Home (orange dot when unread) opens `notifications.html`: every
  confirmation, change, cancellation, reminder, waitlist offer and membership message. Opening it
  marks them read. Players choose what also comes by email (booking updates, reminders).
- **Email** (branded HTML + plain text): booking confirmed (with the `.ics` file and a link to the
  check-in pass), reminder 2 hours before, moved, cancelled (refund or not), waitlist spot opened,
  split-the-cost pay link to invited players, membership renewing in 3 days, payment failed (always
  sent), password reset.
- **Delivery:** set `RESEND_API_KEY` (Resend) or `SMTP_URL` (any SMTP server, e.g.
  `smtps://user:pass@smtp.example.com`), and `EMAIL_FROM`. Neither set → printed to the console.
  Set `BASE_URL` to the public address so email links work (otherwise the last address the server
  was reached on is used).
- Push notifications for the iOS app need an Apple Push certificate and are not set up yet.

## Project layout

```
server.js              entry point: env config, background jobs (every minute), shutdown
src/app.js             Express app and every route
src/db.js, migrations.js   SQLite + versioned schema (PRAGMA user_version)
src/service.js         settings, opening hours, closures, the original booking API
src/occupancy.js       what makes a table busy (bookings, holds, classes, blocks): one source for all
src/pricing.js         price rules, member discounts, promo codes
src/reservations.js    holds, checkout, cancel/refund, reschedule, split cost, check-in, reminders
src/lessons.js         coaches, lesson slots, classes, waitlist offers, lesson packs
src/memberships.js     plans, subscriptions, renewals, Stripe subscription webhooks
src/payments.js        demo + Stripe (REST, webhooks), refunds
src/checkin.js         signed QR check-in codes
src/notify.js, emails.js, mailer.js   bell + email (Resend / SMTP / console)
src/admin.js           admin panel: calendar, bookings, coaches, classes, pricing, members, settings, reports
src/seed.js            demo world
public/                every screen (plain HTML/CSS/JS): tokens.css, components.css, ui.js, app.js, admin.js
test/                  API tests (node:test)
mobile/                Capacitor iOS app, build script, e2e, accessibility and simulator tests
docs/                  build spec and design screens
```

## Not done yet / next steps

- Google and Apple sign-in (need OAuth keys), push notifications in the iOS app (needs an Apple
  push certificate), a real app icon and splash screen.
- Stripe is wired but only tested against a mocked Stripe API: run it once in test mode with your
  keys before going live.
- Background jobs run inside the web process: fine for one server; use a single job runner if you
  scale out.
