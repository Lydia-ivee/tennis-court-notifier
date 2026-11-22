import { ALLOWED_TIMES, LIMITS, PUSH, WEEKDAYS } from './config.js';
import { fromBase64Url } from './encoding.js';
import { HttpError } from './http.js';
import { isAllowedEndpoint } from './webpush.js';

const EMAIL_PATTERN = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

export function isValidEmail(email) {
  return (
    typeof email === 'string' &&
    email.trim().length <= LIMITS.maxEmailLength &&
    EMAIL_PATTERN.test(email.trim())
  );
}

// Keep only known values, drop duplicates, and return them in canonical order.
function pickAllowed(values, allowed) {
  if (!Array.isArray(values)) return null;
  if (values.some((v) => !allowed.includes(v))) return null;
  return allowed.filter((v) => values.includes(v));
}

function parseDays(days) {
  const clean = pickAllowed(days, WEEKDAYS);
  if (!clean) throw new HttpError(400, 'Days must be weekday names.');
  if (clean.length === 0) throw new HttpError(400, 'Select at least one day.');
  return clean;
}

function parseTimes(times) {
  const clean = pickAllowed(times, ALLOWED_TIMES);
  if (!clean) throw new HttpError(400, 'Times must be on the hour, 07:00 to 22:00.');
  if (clean.length === 0) throw new HttpError(400, 'Select at least one time.');
  return clean;
}

// Validate a sign-up body and return a clean { email, days, times } object.
// Throws HttpError(400) with a user-facing message on bad input.
export function parseSubscription(body) {
  const { email, days, times } = body || {};
  if (!isValidEmail(email)) {
    throw new HttpError(400, 'A valid email is required.');
  }
  return { email: email.trim(), days: parseDays(days), times: parseTimes(times) };
}

// Validate a settings change. Every field is optional, but at least one is needed:
//   days, times       replace the subscriber's choices
//   paused            true turns alerts off, false turns them back on
//   pauseDays         with paused: true, pause for this many days (1 to 30)
//   emailAlerts       false stops alert emails (push devices only)
export function parseSettings(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Expected a JSON object.');
  }
  const changes = {};
  if ('days' in body) changes.days = parseDays(body.days);
  if ('times' in body) changes.times = parseTimes(body.times);

  if ('paused' in body) {
    if (typeof body.paused !== 'boolean') throw new HttpError(400, 'paused must be true or false.');
    changes.paused = body.paused;
    changes.pausedUntil = null;
    if (body.paused && body.pauseDays !== undefined) {
      const days = body.pauseDays;
      if (!Number.isInteger(days) || days < 1 || days > LIMITS.maxPauseDays) {
        throw new HttpError(
          400,
          `pauseDays must be a whole number from 1 to ${LIMITS.maxPauseDays}.`,
        );
      }
      changes.pausedUntil = new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
    }
  } else if ('pauseDays' in body) {
    throw new HttpError(400, 'pauseDays needs paused: true.');
  }

  if ('emailAlerts' in body) {
    if (typeof body.emailAlerts !== 'boolean') {
      throw new HttpError(400, 'emailAlerts must be true or false.');
    }
    changes.emailAlerts = body.emailAlerts;
  }

  if (Object.keys(changes).length === 0) throw new HttpError(400, 'Nothing to change.');
  return changes;
}

function decodedLength(value) {
  try {
    return fromBase64Url(value).length;
  } catch {
    return -1;
  }
}

// Validate a browser PushSubscription (as produced by subscription.toJSON()).
export function parsePushSubscription(body) {
  const sub = body?.subscription;
  const endpoint = sub?.endpoint;
  const { p256dh, auth } = sub?.keys || {};

  if (
    typeof endpoint !== 'string' ||
    endpoint.length > PUSH.maxEndpointLength ||
    !isAllowedEndpoint(endpoint)
  ) {
    throw new HttpError(400, 'That push service is not supported.');
  }
  if (decodedLength(p256dh) !== 65 || fromBase64Url(p256dh)[0] !== 4) {
    throw new HttpError(400, 'Invalid push subscription key.');
  }
  if (decodedLength(auth) !== 16) {
    throw new HttpError(400, 'Invalid push subscription secret.');
  }
  return { endpoint, keys: { p256dh, auth } };
}
