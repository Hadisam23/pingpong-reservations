// Notifications (Phase 8): the in-app list behind the bell, and the matching email.
// Players choose what arrives by email (Profile → Notifications); critical messages
// (payment problems) always go out. Guests get email only.
const { renderEmail } = require('./emails');

// Which preference covers which message type
const PREF = { booking_reminder: 'notifyReminders' };

function createNotifier(db, { mailer, now = () => new Date(), baseUrl = () => null, centerName = () => 'Rally Club' }) {
  const stmts = {
    insert: db.prepare('INSERT INTO notifications (userId, type, title, body, readAt, createdAt) VALUES (?, ?, ?, ?, NULL, ?)'),
    user: db.prepare('SELECT email, name, notifyEmail, notifyReminders FROM users WHERE id = ?'),
    list: db.prepare('SELECT id, type, title, body, readAt, createdAt FROM notifications WHERE userId = ? ORDER BY createdAt DESC, id DESC LIMIT 50'),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE userId = ? AND readAt IS NULL'),
    readAll: db.prepare('UPDATE notifications SET readAt = ? WHERE userId = ? AND readAt IS NULL'),
    prefs: db.prepare('SELECT notifyEmail, notifyReminders FROM users WHERE id = ?'),
    setPrefs: db.prepare('UPDATE users SET notifyEmail = ?, notifyReminders = ?, updatedAt = ? WHERE id = ?'),
  };

  // userId: an account (gets the bell entry); email: where to send (defaults to the account's).
  // button.path is a page in the app, made absolute with the club's public URL.
  function notify({ userId = null, email = null, type, title, body, emailSubject, emailText, button, attachments, critical = false, inApp = true }) {
    if (userId && inApp) stmts.insert.run(userId, type, title, body, now().toISOString());
    if (!emailText) return;
    const user = userId ? stmts.user.get(userId) : null;
    const to = email || (user && user.email);
    if (!to) return;
    if (user && !critical && !user[PREF[type] || 'notifyEmail']) return;
    const base = baseUrl();
    const { html, text } = renderEmail({
      title: emailSubject || title, text: emailText, centerName: centerName(),
      button: button && base ? { label: button.label, url: `${base}/${button.path}` } : null,
    });
    mailer.send({ to, subject: emailSubject || title, text, html, attachments });
  }

  return {
    notify,
    list: userId => stmts.list.all(userId).map(n => ({ ...n, unread: !n.readAt })),
    unread: userId => stmts.unread.get(userId).n,
    readAll: userId => stmts.readAll.run(now().toISOString(), userId),
    prefs: userId => {
      const p = stmts.prefs.get(userId);
      return { email: !!p.notifyEmail, reminders: !!p.notifyReminders };
    },
    setPrefs(userId, { email, reminders } = {}) {
      const cur = stmts.prefs.get(userId);
      stmts.setPrefs.run(email === undefined ? cur.notifyEmail : (email ? 1 : 0), reminders === undefined ? cur.notifyReminders : (reminders ? 1 : 0), now().toISOString(), userId);
      return this.prefs(userId);
    },
  };
}

module.exports = { createNotifier };
