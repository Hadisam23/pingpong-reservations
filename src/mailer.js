// Outgoing email (Phase 8). The transport is picked from the environment:
//   RESEND_API_KEY → Resend's HTTP API      SMTP_URL → any SMTP server (nodemailer)
//   neither        → printed to the server console (development)
// Every message is also kept in a short in-memory outbox, which the tests read.
// Sending never blocks or breaks the request that triggered it: failures are logged.

function createMailer({ log = true, transport = null, from = process.env.EMAIL_FROM || 'Rally Club <bookings@rallyclub.test>', fetchImpl = globalThis.fetch } = {}) {
  const outbox = [];
  let send = transport;
  let kind = 'console';
  if (!send && process.env.RESEND_API_KEY) {
    kind = 'resend';
    send = async m => {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from, to: [m.to], subject: m.subject, text: m.text, html: m.html,
          attachments: (m.attachments || []).map(a => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })),
        }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    };
  } else if (!send && process.env.SMTP_URL) {
    kind = 'smtp';
    const nodemailer = require('nodemailer');
    const smtp = nodemailer.createTransport(process.env.SMTP_URL);
    send = m => smtp.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments });
  }

  return {
    outbox,
    kind,
    send(message) {
      const m = { ...message, sentAt: new Date().toISOString() };
      outbox.push(m);
      if (outbox.length > 50) outbox.shift();
      if (send) {
        Promise.resolve().then(() => send(m)).catch(err => console.error(`[email] to ${m.to} failed:`, err.message));
      } else if (log) {
        console.log(`\n[email] to ${m.to}: ${m.subject}\n${m.text}${m.attachments && m.attachments.length ? `\n(+ ${m.attachments.map(a => a.filename).join(', ')})` : ''}\n`);
      }
      return m;
    },
  };
}

module.exports = { createMailer };
