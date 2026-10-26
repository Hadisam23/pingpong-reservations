// Outgoing email. Until real email is wired up (Phase 8), messages are printed to the
// server console and kept in memory, so you can open reset links while developing
// and tests can read them.
function createMailer({ log = true } = {}) {
  const outbox = [];
  return {
    outbox,
    send({ to, subject, text }) {
      const message = { to, subject, text, sentAt: new Date().toISOString() };
      outbox.push(message);
      if (outbox.length > 50) outbox.shift();
      if (log) console.log(`\n[email] to ${to}: ${subject}\n${text}\n`);
      return message;
    },
  };
}

module.exports = { createMailer };
