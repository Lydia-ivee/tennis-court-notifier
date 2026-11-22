import { ALLOWED_TIMES, LIMITS, WEEKDAYS } from './config.js';
import { HttpError } from './http.js';

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

// Validate a sign-up body and return a clean { email, days, times } object.
// Throws HttpError(400) with a user-facing message on bad input.
export function parseSubscription(body) {
  const { email, days, times } = body || {};

  if (!isValidEmail(email)) {
    throw new HttpError(400, 'A valid email is required.');
  }

  const cleanDays = pickAllowed(days, WEEKDAYS);
  if (!cleanDays) throw new HttpError(400, 'Days must be weekday names.');
  if (cleanDays.length === 0) throw new HttpError(400, 'Select at least one day.');

  const cleanTimes = pickAllowed(times, ALLOWED_TIMES);
  if (!cleanTimes) throw new HttpError(400, 'Times must be on the hour, 07:00 to 22:00.');
  if (cleanTimes.length === 0) throw new HttpError(400, 'Select at least one time.');

  return { email: email.trim(), days: cleanDays, times: cleanTimes };
}
