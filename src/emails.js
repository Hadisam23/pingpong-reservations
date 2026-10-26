// Branded email layout: one template for every message, plain text alongside the HTML.
// Email clients ignore stylesheets, so the styles are inline (colors match tokens.css).
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// text: paragraphs separated by blank lines. button: { label, url } (optional)
function renderEmail({ title, text, button, centerName = 'Rally Club' }) {
  const paragraphs = String(text).split(/\n{2,}/).map(p => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#0B1F3A">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const cta = button && button.url
    ? `<p style="margin:22px 0 6px"><a href="${esc(button.url)}" style="display:inline-block;background:#0B1F3A;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:15px;padding:14px 22px;border-radius:14px">${esc(button.label)}</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#F4F6FA;font-family:'Plus Jakarta Sans',-apple-system,Segoe UI,Roboto,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:18px">
<tr><td style="background:#0B1F3A;border-radius:18px 18px 0 0;padding:18px 24px;color:#FFFFFF;font-weight:800;font-size:18px">${esc(centerName)} <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#F97316;margin-left:4px"></span></td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:#0B1F3A">${esc(title)}</h1>${paragraphs}${cta}
</td></tr></table>
<p style="max-width:520px;margin:14px auto 0;font-size:12px;color:#5B6B82">You get this email because you booked at ${esc(centerName)}. Change what we send in the app: Profile → Notifications.</p>
</td></tr></table></body></html>`;
  const plain = `${title}\n\n${text}${button && button.url ? `\n\n${button.label}: ${button.url}` : ''}\n\n— ${centerName}`;
  return { html, text: plain };
}

module.exports = { renderEmail };
