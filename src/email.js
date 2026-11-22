import { BOOKING } from './config.js';
import { log, maskEmail } from './http.js';

// Escape anything interpolated into email HTML. Slot data comes from a third
// party API, so it is treated as untrusted just like user input.
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FONT = 'font-family:Georgia,serif;';
const CELL = `padding:12px 16px;border-bottom:1px solid #d8c8a0;${FONT}`;

// Shared parchment frame. Inline styles only: email clients strip <style>.
function frame({ heading, subheading, body, footer }) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background-color:#2b2a28;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background-color:#efe4c9;border:2px solid #9c7a1e;border-radius:6px;">
    <tr>
      <td style="padding:28px 24px;text-align:center;">
        <div style="font-size:52px;line-height:1;">🎾</div>
        <h1 style="margin:12px 0 4px;${FONT}font-size:26px;color:#2c2415;">${heading}</h1>
        <p style="margin:0;${FONT}font-style:italic;color:#9c7a1e;">${subheading}</p>
      </td>
    </tr>
    <tr><td style="padding:0 24px 24px;">${body}</td></tr>
    <tr>
      <td style="padding:0 24px 24px;text-align:center;${FONT}font-size:12px;font-style:italic;color:#8a7a54;">${footer}</td>
    </tr>
  </table>
</body>
</html>`;
}

function button(href, label) {
  return `<p style="margin:20px 0 0;text-align:center;">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 28px;${FONT}font-weight:bold;font-size:16px;color:#efe4c9;background-color:#4a5d3a;border:2px solid #9c7a1e;border-radius:5px;text-decoration:none;">${label}</a>
  </p>`;
}

function describeSlot(m) {
  const courts = `${m.spaces} court${m.spaces > 1 ? 's' : ''}`;
  return { courts, price: m.price ? ` · ${m.price}` : '' };
}

// The manage page reads ?action= from the fragment and asks for one tap to
// confirm, so a mail scanner opening these links changes nothing.
function settingsLinks(manageUrl) {
  return [
    ['Settings', manageUrl],
    ['Pause for a week', `${manageUrl}&action=snooze`],
    ['Turn off', `${manageUrl}&action=off`],
  ];
}

export function buildAlertEmail(email, matches, manageUrl) {
  const links = settingsLinks(manageUrl);
  const rows = matches
    .map((m) => {
      const { courts, price } = describeSlot(m);
      return `
        <tr>
          <td style="${CELL}color:#2c2415;"><strong>${escapeHtml(m.weekday)}</strong> ${escapeHtml(m.date)}</td>
          <td style="${CELL}color:#2c2415;">${escapeHtml(m.start)}&ndash;${escapeHtml(m.end)}</td>
          <td style="${CELL}color:#4a5d3a;text-align:center;">${escapeHtml(courts + price)}</td>
        </tr>`;
    })
    .join('');

  const html = frame({
    heading: 'A Court Falls Free!',
    subheading: 'Highbury Fields Tennis - matches for thy chosen hours',
    body: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:rgba(255,255,255,0.4);border:1px solid #d8c8a0;border-radius:4px;">${rows}</table>
      ${button(BOOKING.bookingPage, 'Claim thy court ⚔️')}`,
    footer: `Sent to ${escapeHtml(email)} by the Tennis Court Notifier.<br>
      ${links
        .map(([label, href]) => `<a href="${escapeHtml(href)}" style="color:#8a7a54;">${label}</a>`)
        .join(' &middot; ')}`,
  });

  const text = [
    'A court falls free at Highbury Fields Tennis:',
    '',
    ...matches.map((m) => {
      const { courts, price } = describeSlot(m);
      return `- ${m.weekday} ${m.date}, ${m.start}-${m.end}, ${courts}${price}`;
    }),
    '',
    `Book: ${BOOKING.bookingPage}`,
    '',
    ...links.map(([label, href]) => `${label}: ${href}`),
  ].join('\n');

  return { subject: '⚔️ Court Available!', html, text };
}

export function buildConfirmEmail(confirmUrl) {
  const html = frame({
    heading: 'Confirm Thy Quest',
    subheading: 'One click and the heralds ride',
    body: `<p style="margin:0;${FONT}color:#2c2415;text-align:center;">Someone (we trust it was thee) asked for court alerts at this address. Confirm below to start them.</p>
      ${button(confirmUrl, 'Confirm my alerts')}`,
    footer:
      'If this was not thee, ignore this email and nothing more will be sent. The link expires in 24 hours.',
  });

  const text = [
    'Someone asked for Highbury court alerts at this address.',
    '',
    `Confirm here: ${confirmUrl}`,
    '',
    'If this was not you, ignore this email and nothing more will be sent.',
    'The link expires in 24 hours.',
  ].join('\n');

  return { subject: 'Confirm thy tennis court alerts', html, text };
}

// Send through SendGrid's Mail Send API. Returns true on success and never
// throws, so one bad send cannot halt a run.
export async function sendEmail(env, to, { subject, html, text }, { unsubscribeUrl } = {}) {
  if (!env.SENDGRID_API_KEY || !env.FROM_EMAIL) {
    log('email_not_configured', { to: maskEmail(to) });
    return false;
  }

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: env.FROM_EMAIL, name: 'Tennis Court Notifier' },
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html', value: html },
    ],
    // Alerts are notifications, not marketing, but turn off click tracking so
    // signed links reach the subscriber untouched.
    tracking_settings: { click_tracking: { enable: false } },
  };

  // RFC 8058 one-click unsubscribe, which Gmail and Yahoo now expect.
  if (unsubscribeUrl) {
    payload.headers = {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log('email_failed', {
        to: maskEmail(to),
        status: res.status,
        detail: (await res.text()).slice(0, 300),
      });
      return false;
    }
    return true;
  } catch (err) {
    log('email_errored', { to: maskEmail(to), message: err.message });
    return false;
  }
}
