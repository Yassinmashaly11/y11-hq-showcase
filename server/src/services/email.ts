/**
 * Emails go through Resend (resend.com) once it's set up: RESEND_API_KEY and ORDER_EMAIL_TO
 * (one address, or several separated by commas). Until then emails are skipped.
 * Resend's free test sender (onboarding@resend.dev) can only send to the address you signed up with,
 * which is fine for emailing yourself; set ORDER_EMAIL_FROM once you verify your own domain.
 */

// Read forgivingly: stray spaces or quotes around a value still work.
const clean = (v: string | undefined) => (v ?? '').trim().replace(/^["']+|["']+$/g, '').trim();

export function emailSetup() {
  return {
    key: clean(process.env.RESEND_API_KEY),
    to: clean(process.env.ORDER_EMAIL_TO).split(',').map(clean).filter(Boolean),
    from: clean(process.env.ORDER_EMAIL_FROM) || 'Y11 HQ <onboarding@resend.dev>',
  };
}

async function postToResend(msg: { subject: string; text: string }) {
  const { key, to, from } = emailSetup();
  const escaped = msg.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to,
      subject: msg.subject,
      text: msg.text,
      html: `<pre style="font: 14px/1.55 ui-monospace, Menlo, monospace; white-space: pre-wrap">${escaped}</pre>`,
    }),
  });
  return { status: res.status, body: await res.text() };
}

export async function sendEmail(msg: { subject: string; text: string }): Promise<boolean> {
  const { key, to } = emailSetup();
  if (!key || !to.length) {
    console.warn('Email skipped: RESEND_API_KEY or ORDER_EMAIL_TO is not set on this server.');
    return false;
  }
  const r = await postToResend(msg);
  if (r.status >= 300) throw new Error(`Resend said ${r.status}: ${r.body.slice(0, 300)}`);
  return true;
}

const meaning = (status: number, body: string) =>
  status >= 200 && status < 300 ? 'Sent. Check the inbox (and spam) of ORDER_EMAIL_TO.'
  : status === 401 || (status === 400 && /api key/i.test(body)) ? 'Resend rejected the API key: it is wrong, revoked, or copied with something extra.'
  : status === 403 && /own email address|testing emails/i.test(body)
    ? 'With onboarding@resend.dev you can only email the address you signed up to Resend with. Set ORDER_EMAIL_TO to exactly that address, or verify your own domain in Resend.'
  : status === 403 ? 'Resend refused to send: check the API key has "Sending access" for all domains, or verify your domain.'
  : status === 422 ? 'Resend says something in the email is invalid, usually the from or to address.'
  : status === 429 ? 'Too many emails: Resend\'s rate or daily limit was reached.'
  : 'Unexpected answer from Resend.';

// A variable name with anything unusual spelled out, so "ORDER_EMAIL_TO " or a lookalike letter stands out.
const showName = (n: string) =>
  [...n].map((ch) => (/[A-Za-z0-9_]/.test(ch) ? ch : ch === ' ' ? '[space]' : `[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`)).join('');
const squash = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O');

/** Every variable the running server sees that mentions EMAIL, ORDER or RESEND: name and value length only. */
function emailVariablesSeen() {
  const wanted = ['RESEND_API_KEY', 'ORDER_EMAIL_TO', 'ORDER_EMAIL_FROM'];
  return Object.keys(process.env)
    .filter((n) => /EMAIL|ORDER|RESEND/i.test(n) || wanted.some((w) => squash(n) === squash(w)))
    .sort()
    .map((n) => {
      const near = wanted.find((w) => w !== n && squash(n) === squash(w));
      return `${showName(n)} (${(process.env[n] ?? '').length} characters)${near ? ` ← looks like ${near} but isn't exactly that name` : ''}`;
    });
}

/** CEO only (Settings → Order emails): send a real test email and report the setup and Resend's exact answer. */
export async function diagnoseEmail() {
  const { key, to, from } = emailSetup();
  const setup = {
    RESEND_API_KEY: key
      ? `set: ${key.length} characters, ${key.slice(0, 3)}…${key.slice(-4)}${key.startsWith('re_') ? '' : ' (Resend keys start with re_)'}`
      : 'NOT SET on the running server',
    ORDER_EMAIL_TO: to.length ? to.join(', ') : 'NOT SET on the running server',
    from,
    variablesSeen: emailVariablesSeen(),
  };
  if (!key || !to.length) {
    return {
      setup,
      sent: false,
      meaning: 'Emails are skipped because a variable is missing on the running server. Compare "variablesSeen" with the names in Railway → Variables (on the y11-hq service), fix the name, then click Deploy.',
    };
  }
  try {
    const r = await postToResend({
      subject: 'Y11 HQ test email',
      text: 'This is a test from Y11 HQ (Settings → Order emails). If you can read this, website order emails will reach you too.',
    });
    return { setup, sent: r.status >= 200 && r.status < 300, resendStatus: r.status, resendSays: r.body.slice(0, 500), meaning: meaning(r.status, r.body) };
  } catch (e) {
    return { setup, sent: false, resendStatus: null, error: String(e), meaning: "Couldn't reach Resend at all from the server." };
  }
}
