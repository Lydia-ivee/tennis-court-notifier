import { LIMITS, PUSH, keys } from './config.js';
import { deviceId, deviceLabel, pruneDevices, upsertDevice, withoutDevices } from './devices.js';
import { buildConfirmEmail, sendEmail } from './email.js';
import { HttpError, bearerToken, json, log, maskEmail, readJson } from './http.js';
import { confirmToken, manageToken, verifyToken } from './tokens.js';
import { buildTestPayload } from './notifications.js';
import { parsePushSubscription, parseSettings, parseSubscription } from './validation.js';
import { sendPush, vapidFromEnv } from './webpush.js';

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

// What the settings page sees. Push endpoints are capability URLs, so only a
// hashed id and a coarse label leave the server.
async function publicView({ email, days, times, paused, pausedUntil, emailAlerts, push = [] }) {
  return {
    email,
    days,
    times,
    paused: Boolean(paused),
    pausedUntil: pausedUntil || null,
    emailAlerts: emailAlerts !== false,
    devices: await Promise.all(
      push.map(async (d) => ({
        id: await deviceId(d.endpoint),
        label: d.label,
        addedAt: d.addedAt,
      })),
    ),
  };
}

async function loadRecord(env, email) {
  const stored = await env.PREFERENCES.get(keys.subscriber(email));
  if (!stored) throw new HttpError(404, 'No alerts are set up for this address.');
  return JSON.parse(stored);
}

async function saveRecord(env, record) {
  const next = { ...record, updatedAt: new Date().toISOString() };
  await env.PREFERENCES.put(keys.subscriber(record.email), JSON.stringify(next));
  return next;
}

// Apply the rate limit binding to any key. No binding (local dev, tests) means no limit.
export async function rateLimit(env, key, message = 'Too many requests. Try again in a minute.') {
  if (!env.SUBSCRIBE_LIMITER) return;
  const { success } = await env.SUBSCRIBE_LIMITER.limit({ key });
  if (!success) throw new HttpError(429, message);
}

export async function enforceRateLimit(request, env) {
  await rateLimit(env, request.headers.get('CF-Connecting-IP') || 'unknown');
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
    preferences: await publicView(record),
    manageToken: await manageToken(email, env.TOKEN_SECRET),
  });
}

// GET /api/subscription  (Authorization: Bearer <manage token>)
export async function getSubscription(request, env) {
  const email = await requireManageToken(request, env);
  const stored = await env.PREFERENCES.get(keys.subscriber(email));
  if (!stored) throw new HttpError(404, 'No alerts are set up for this address.');
  return json({ preferences: await publicView(JSON.parse(stored)) });
}

// PATCH /api/subscription  (Authorization: Bearer <manage token>)
// Change days or times, or pause and resume, without another confirmation:
// holding the manage token already proves the inbox is theirs.
export async function updateSubscription(request, env) {
  const email = await requireManageToken(request, env);
  const changes = parseSettings(await readJson(request, LIMITS.maxBodyBytes));
  const record = { ...(await loadRecord(env, email)), ...changes };
  if (record.emailAlerts === false && !(record.push || []).length) {
    throw new HttpError(400, 'Keep at least one way to hear of courts: email or a device.');
  }
  const saved = await saveRecord(env, record);
  log('subscription_updated', { to: maskEmail(email), fields: Object.keys(changes) });
  return json({ preferences: await publicView(saved) });
}

// GET /api/push/key  The VAPID public key browsers need to subscribe.
export async function getPushKey(_request, env) {
  const vapid = vapidFromEnv(env);
  if (!vapid) throw new HttpError(404, 'Phone alerts are not set up on this server.');
  return json({ publicKey: vapid.publicKey }, 200, { 'Cache-Control': 'public, max-age=3600' });
}

// POST /api/subscription/push  { subscription }  Register this device.
export async function addPushDevice(request, env) {
  const email = await requireManageToken(request, env);
  if (!vapidFromEnv(env)) throw new HttpError(404, 'Phone alerts are not set up on this server.');
  const subscription = parsePushSubscription(await readJson(request, LIMITS.maxBodyBytes));
  const record = await loadRecord(env, email);
  const device = {
    ...subscription,
    label: deviceLabel(request.headers.get('User-Agent') || ''),
    addedAt: new Date().toISOString(),
  };
  const saved = await saveRecord(env, { ...record, push: upsertDevice(record.push, device) });
  log('push_device_added', { to: maskEmail(email), label: device.label });
  return json({ preferences: await publicView(saved) }, 201);
}

// DELETE /api/subscription/push  { id }  Forget a device.
export async function removePushDevice(request, env) {
  const email = await requireManageToken(request, env);
  const { id } = await readJson(request, LIMITS.maxBodyBytes);
  if (typeof id !== 'string') throw new HttpError(400, 'A device id is required.');
  const record = await loadRecord(env, email);
  const ids = await Promise.all((record.push || []).map((d) => deviceId(d.endpoint)));
  const target = (record.push || [])[ids.indexOf(id)];
  if (!target) throw new HttpError(404, 'That device is not registered.');
  const saved = await saveRecord(env, withoutDevices(record, [target.endpoint]));
  return json({ preferences: await publicView(saved) });
}

// POST /api/subscription/push/test  Send a test notification to every device.
export async function testPush(request, env) {
  const email = await requireManageToken(request, env);
  const vapid = vapidFromEnv(env);
  if (!vapid) throw new HttpError(404, 'Phone alerts are not set up on this server.');
  const record = await loadRecord(env, email);
  if (!(record.push || []).length) throw new HttpError(400, 'No devices are registered yet.');
  if (await env.PREFERENCES.get(keys.pushTestCooldown(email))) {
    throw new HttpError(429, 'A test went out a moment ago. Try again in a minute.');
  }
  await env.PREFERENCES.put(keys.pushTestCooldown(email), '1', {
    expirationTtl: PUSH.testCooldownSeconds,
  });

  const payload = buildTestPayload();
  const results = await Promise.all(record.push.map((d) => sendPush(d, payload, vapid)));
  await pruneDevices(
    env,
    email,
    record.push.filter((_, i) => results[i].gone).map((d) => d.endpoint),
  );
  const sent = results.filter((r) => r.ok).length;
  if (sent === 0)
    throw new HttpError(
      502,
      'The push service did not accept the test. Try turning this device off and on.',
    );
  return json({ sent });
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
// It comes from the email, so it stops email. Someone who also has push
// devices keeps those; with no devices left, the whole record goes.
export async function oneClickUnsubscribe(request, env) {
  const token = new URL(request.url).searchParams.get('token');
  const email = await requireManageToken(request, env, token);
  const stored = await env.PREFERENCES.get(keys.subscriber(email));
  if (stored && (JSON.parse(stored).push || []).length) {
    await saveRecord(env, { ...JSON.parse(stored), emailAlerts: false });
    log('email_unsubscribed', { to: maskEmail(email) });
    return json({ message: 'Emails stopped. Phone alerts carry on.' });
  }
  await removeSubscriber(env, email);
  return json({ message: 'Alerts stopped.' });
}
