// In-app notifications (the bell) and the matching email. Phase 8 adds reminders and
// per-person preferences on top of this.
function createNotifier(db, { mailer, now = () => new Date() }) {
  const insert = db.prepare('INSERT INTO notifications (userId, type, title, body, readAt, createdAt) VALUES (?, ?, ?, ?, NULL, ?)');
  const userEmail = db.prepare('SELECT email, name FROM users WHERE id = ?');

  // userId: an account (gets the bell entry); email: where to send (defaults to the account's)
  function notify({ userId = null, email = null, type, title, body, emailSubject, emailText }) {
    if (userId) insert.run(userId, type, title, body, now().toISOString());
    const to = email || (userId && (userEmail.get(userId) || {}).email);
    if (to && emailText) mailer.send({ to, subject: emailSubject || title, text: emailText });
  }

  const stmts = {
    list: db.prepare('SELECT id, type, title, body, readAt, createdAt FROM notifications WHERE userId = ? ORDER BY createdAt DESC, id DESC LIMIT 50'),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE userId = ? AND readAt IS NULL'),
    readAll: db.prepare('UPDATE notifications SET readAt = ? WHERE userId = ? AND readAt IS NULL'),
  };

  return {
    notify,
    list: userId => stmts.list.all(userId).map(n => ({ ...n, unread: !n.readAt })),
    unread: userId => stmts.unread.get(userId).n,
    readAll: userId => stmts.readAll.run(now().toISOString(), userId),
  };
}

module.exports = { createNotifier };
