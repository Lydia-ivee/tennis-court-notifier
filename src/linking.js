// Link a device (usually an installed home-screen app) to a subscription with
// an eight-digit emailed code. A code, not a link: links in email open in the
// browser, while an installed app on iPhone has its own separate storage.
//
// Guessing: 10^8 codes, one code per inbox per 10 minutes, and a rate limit
// on guesses keyed by the email address, so spreading guesses across many IPs
// does not help. The per-code attempt counter in KV is a second line only:
// KV has no atomic increment, so parallel guesses can all read the same count.
// The rate limiter is the real bound (about 50 guesses per code at most).

import { LIMITS, LINK_CODE, keys } from './config.js';
import { buildLinkCodeEmail, sendEmail } from './email.js';
import { encoder } from './encoding.js';
import { HttpError, json, log, maskEmail, readJson } from './http.js';
import { enforceRateLimit, rateLimit } from './subscriptions.js';
import { manageToken } from './tokens.js';
import { isValidEmail } from './validation.js';

const CODE_SPACE = 10 ** LINK_CODE.digits;

// Uniform code (rejection sampling avoids modulo bias).
export function generateCode() {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / CODE_SPACE) * CODE_SPACE;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return String(buf[0] % CODE_SPACE).padStart(LINK_CODE.digits, '0');
}

async function hashCode(email, code) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${email}:${code}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compare equal-length strings without an early exit.
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseEmail(body) {
  if (!isValidEmail(body?.email)) throw new HttpError(400, 'A valid email is required.');
  return body.email.trim().toLowerCase();
}

const SAME_ANSWER = { message: 'If that address has alerts, a code is on its way.' };

// Create and email a code. Runs after the response, so subscribed and
// unsubscribed addresses get the same answer in the same time.
async function issueCode(env, email) {
  if (!(await env.PREFERENCES.get(keys.subscriber(email)))) return;
  const code = generateCode();
  await env.PREFERENCES.put(
    keys.linkCode(email),
    JSON.stringify({
      hash: await hashCode(email, code),
      attempts: 0,
      expiresAt: Date.now() + LINK_CODE.ttlSeconds * 1000,
    }),
    { expirationTtl: LINK_CODE.ttlSeconds },
  );
  if (await sendEmail(env, email, buildLinkCodeEmail(code))) {
    log('link_code_sent', { to: maskEmail(email) });
    return;
  }
  // Let them try again straight away rather than waiting out the cooldown.
  await env.PREFERENCES.delete(keys.linkCooldown(email));
  await env.PREFERENCES.delete(keys.linkCode(email));
}

// POST /api/link/request  { email }
// Answers the same, immediately, whether or not the address is subscribed, so
// it cannot be used to find out who uses the service.
export async function requestLinkCode(request, env, ctx) {
  await enforceRateLimit(request, env);
  const email = parseEmail(await readJson(request, LIMITS.maxBodyBytes));

  // Checked for every address, so it gives nothing away either.
  if (await env.PREFERENCES.get(keys.linkCooldown(email))) {
    throw new HttpError(
      429,
      'A code went out in the last 10 minutes. Check thy inbox, including spam.',
    );
  }
  await env.PREFERENCES.put(keys.linkCooldown(email), '1', {
    expirationTtl: LINK_CODE.cooldownSeconds,
  });

  const task = issueCode(env, email).catch((err) =>
    log('link_code_failed', { to: maskEmail(email), message: err.message }),
  );
  if (ctx?.waitUntil) ctx.waitUntil(task);
  else await task;
  return json(SAME_ANSWER, 202);
}

// POST /api/link/verify  { email, code }  ->  { manageToken }
export async function verifyLinkCode(request, env) {
  await enforceRateLimit(request, env);
  const body = await readJson(request, LIMITS.maxBodyBytes);
  const email = parseEmail(body);
  // Keyed by address, not IP: this is what bounds guessing (see top of file).
  await rateLimit(env, `link-verify:${email}`, 'Too many tries. Wait a minute and try again.');
  const code = typeof body.code === 'string' ? body.code.replace(/\s/g, '') : '';
  if (!new RegExp(`^\\d{${LINK_CODE.digits}}$`).test(code)) {
    throw new HttpError(400, `The code is ${LINK_CODE.digits} digits.`);
  }

  const wrong = new HttpError(400, 'That code is wrong or has expired.');
  const key = keys.linkCode(email);
  const stored = JSON.parse((await env.PREFERENCES.get(key)) || 'null');
  if (!stored || Date.now() > stored.expiresAt) throw wrong;

  if (!constantTimeEqual(stored.hash, await hashCode(email, code))) {
    const attempts = stored.attempts + 1;
    if (attempts >= LINK_CODE.maxAttempts) {
      await env.PREFERENCES.delete(key);
      throw new HttpError(400, 'Too many wrong codes. Ask for a new one.');
    }
    // KV needs a TTL on every write. Keep the original expiry (60s is KV's minimum);
    // expiresAt is checked above anyway, so the code never outlives 10 minutes.
    const remaining = Math.ceil((stored.expiresAt - Date.now()) / 1000);
    await env.PREFERENCES.put(key, JSON.stringify({ ...stored, attempts }), {
      expirationTtl: Math.max(60, remaining),
    });
    throw wrong;
  }

  await env.PREFERENCES.delete(key);
  log('device_linked', { to: maskEmail(email) });
  return json({ manageToken: await manageToken(email, env.TOKEN_SECRET) });
}
