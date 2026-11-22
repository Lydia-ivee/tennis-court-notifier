// Static configuration. Anything secret lives in Worker secrets, never here.

export const BOOKING = {
  apiBase: 'https://better-admin.org.uk/api/activities',
  venue: 'islington-tennis-centre',
  activity: 'highbury-tennis',
  bookingPage: 'https://bookings.better.org.uk/location/islington-tennis-centre/highbury-tennis',
};

// How many days ahead to look, including today.
export const HORIZON_DAYS = 7;

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// The hourly start times offered on the sign-up form (07:00 to 22:00).
export const ALLOWED_TIMES = Array.from(
  { length: 16 },
  (_, i) => `${String(i + 7).padStart(2, '0')}:00`,
);

export const LIMITS = {
  maxBodyBytes: 2048,
  maxEmailLength: 254,
  // Confirmation links expire after this long.
  confirmTokenTtlSeconds: 24 * 60 * 60,
  // Minimum gap between confirmation emails to the same address.
  confirmCooldownSeconds: 10 * 60,
};

// KV key layout. Emails are lower-cased so lookups are case-insensitive.
export const keys = {
  subscriber: (email) => `pref:${normaliseEmail(email)}`,
  cooldown: (email) => `cooldown:${normaliseEmail(email)}`,
  subscriberPrefix: 'pref:',
};

export function normaliseEmail(email) {
  return String(email).trim().toLowerCase();
}
