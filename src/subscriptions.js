import { LIMITS, keys } from './config.js';
import { buildConfirmEmail, sendEmail } from './email.js';
import { HttpError, bearerToken, json, log, maskEmail, readJson } from './http.js';
import { confirmToken, manageToken, verifyToken } from './tokens.js';
import { parseSettings, parseSubscription } from './validation.js';

// Base URL for links in emails. Cron runs have no request, so PUBLIC_URL is
// the source of truth; the request origin is only a local-dev fallback.
export function publicUrl(env, request) {
  const base = env.PUBLIC_URL || (request && new URL(request.url).origin);
  if (!base) throw new Error('PUBLIC_URL must be set.');
  return base.replace(/\/+$/, '');
}

export async function manageLinks(env, email, request) {
  const token = await manageToken(email, env.TOKEN_SECRET);
  const base = publicUrl(env, request);
  return {
    // The token sits in the fragment, which browsers never send to servers,
    // so it stays out of access logs and Referer headers.
    manageUrl: `${base}/manage#token=${token}`,
    unsubscribeUrl: `${base}/api/unsubscribe?token=${encodeURIComponent(token)}`,
  };
}

const publicView = ({ email, days, times, paused, pausedUntil }) => ({
  email,
  days,
  times,
  paused: Boolean(paused),
  pausedUntil: pausedUntil || null,
});

async function enforceRateLimit(request, env) {
  if (!env.SUBSCRIBE_LIMITER) return;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.SUBSCRIBE_LIMITER.limit({ key: ip });
  if (!success) throw new HttpError(429, 'Too many requests. Try again in a minute.');
}

async function requireManageToken(request, env, token = bearerToken(request)) {
  const payload = await verifyToken(token, 'manage', env.TOKEN_SECRET);
  if (!payload) throw new HttpError(401, 'This link is invalid or has expired.');
  return payload.email;
}

// POST /api/subscriptions
// Nothing is saved yet: we email a signed confirmation link (double opt-in), so
// nobody can sign a stranger up for alerts.
export async function requestSubscription(request, env) {
  await enforceRateLimit(request, env);
  const sub = parseSubscription(await readJson(request, LIMITS.maxBodyBytes));

  // Stops the form being used to flood someone's inbox with confirmations.
  if (await env.PREFERENCES.get(keys.cooldown(sub.email))) {
    throw new HttpError(
      429,
      'We sent a confirmation to that address recently. Check thy inbox, or try again in 10 minutes.',
    );
  }

  const token = await confirmToken(sub, env.TOKEN_SECRET, LIMITS.confirmTokenTtlSeconds);
  const confirmUrl = `${publicUrl(env, request)}/confirm#token=${token}`;
  const sent = await sendEmail(env, sub.email, buildConfirmEmail(confirmUrl));
  if (!sent) throw new HttpError(502, 'Could not send the confirmation email. Try again shortly.');

  await env.PREFERENCES.put(keys.cooldown(sub.email), '1', {
    expirationTtl: LIMITS.confirmCooldownSeconds,
  });
  log('confirmation_sent', { to: maskEmail(sub.email) });
  return json({ message: 'Check your inbox to confirm.' }, 202);
}

// POST /api/subscriptions/confirm  { token }
export async function confirmSubscription(request, env) {
  const { token } = await readJson(request, LIMITS.maxBodyBytes);
  const payload = await verifyToken(token, 'confirm', env.TOKEN_SECRET);
  if (!payload) throw new HttpError(400, 'This confirmation link is invalid or has expired.');

  const { email, days, times } = payload;
  const key = keys.subscriber(email);
  const existing = JSON.parse((await env.PREFERENCES.get(key)) || 'null');
  const now = new Date().toISOString();
  // Confirming again (for example after changing choices on the sign-up page)
  // also turns alerts back on.
  const record = {
    ...existing,
    email,
    days,
    times,
    paused: false,
    pausedUntil: null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await env.PREFERENCES.put(key, JSON.stringify(record));
  await env.PREFERENCES.delete(keys.cooldown(email));
  log('subscription_confirmed', { to: maskEmail(email) });

  return json({
    preferences: publicView(record),
    manageToken: await manageToken(email, env.TOKEN_SECRET),
  });
}

// GET /api/subscription  (Authorization: Bearer <manage token>)
export async function getSubscription(request, env) {
  const email = await requireManageToken(request, env);
  const stored = await env.PREFERENCES.get(keys.subscriber(email));
  if (!stored) throw new HttpError(404, 'No alerts are set up for this address.');
  return json({ preferences: publicView(JSON.parse(stored)) });
}

// PATCH /api/subscription  (Authorization: Bearer <manage token>)
// Change days or times, or pause and resume, without another confirmation:
// holding the manage token already proves the inbox is theirs.
export async function updateSubscription(request, env) {
  const email = await requireManageToken(request, env);
  const changes = parseSettings(await readJson(request, LIMITS.maxBodyBytes));
  const key = keys.subscriber(email);
  const stored = await env.PREFERENCES.get(key);
  if (!stored) throw new HttpError(404, 'No alerts are set up for this address.');

  const record = { ...JSON.parse(stored), ...changes, updatedAt: new Date().toISOString() };
  await env.PREFERENCES.put(key, JSON.stringify(record));
  log('subscription_updated', { to: maskEmail(email), fields: Object.keys(changes) });
  return json({ preferences: publicView(record) });
}

// GET /api/status  When the courts were last checked, for the sign-up page.
export async function getStatus(_request, env) {
  const stored = await env.PREFERENCES.get(keys.status);
  const status = stored ? JSON.parse(stored) : { checkedAt: null, openSlots: null };
  return json(status, 200, { 'Cache-Control': 'public, max-age=60' });
}

async function removeSubscriber(env, email) {
  await env.PREFERENCES.delete(keys.subscriber(email));
  await env.PREFERENCES.delete(keys.seen(email));
  log('subscription_deleted', { to: maskEmail(email) });
}

// DELETE /api/subscription  (Authorization: Bearer <manage token>)
export async function deleteSubscription(request, env) {
  const email = await requireManageToken(request, env);
  await removeSubscriber(env, email);
  return json({ message: 'Alerts stopped.' });
}

// POST /api/unsubscribe?token=...  RFC 8058 one-click unsubscribe from mail clients.
export async function oneClickUnsubscribe(request, env) {
  const token = new URL(request.url).searchParams.get('token');
  const email = await requireManageToken(request, env, token);
  await removeSubscriber(env, email);
  return json({ message: 'Alerts stopped.' });
}
