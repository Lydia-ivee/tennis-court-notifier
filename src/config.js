// Static configuration. Anything secret lives in Worker secrets, never here.

export const BOOKING = {
  apiBase: 'https://better-admin.org.uk/api/activities',
  venue: 'islington-tennis-centre',
  activity: 'highbury-tennis',
  bookingPage: 'https://bookings.better.org.uk/location/islington-tennis-centre/highbury-tennis',
};

// The booking site's page for one date, so a tap lands on the right day.
export const bookingUrlFor = (date) => `${BOOKING.bookingPage}/${date}/by-time`;

export const PUSH = {
  // Devices per subscriber; adding another drops the oldest.
  maxDevices: 5,
  // How long a push service should keep trying to deliver an alert.
  ttlSeconds: 60 * 60,
  // Minimum gap between "send a test" presses.
  testCooldownSeconds: 60,
  maxEndpointLength: 2048,
};

// Six-digit codes that link an installed app to a subscription.
export const LINK_CODE = {
  ttlSeconds: 10 * 60,
  maxAttempts: 5,
  // Minimum gap between codes sent to the same inbox.
  cooldownSeconds: 60,
};

// The courts are in London, so "today" means today in London, not in UTC.
export const TIME_ZONE = 'Europe/London';

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
  // Longest snooze the settings page can set.
  maxPauseDays: 30,
  // How long we remember that a slot was already emailed to someone.
  seenTtlSeconds: (HORIZON_DAYS + 1) * 24 * 60 * 60,
};

export const FETCH = {
  timeoutMs: 10_000,
  retries: 3,
  baseDelayMs: 500,
};

// KV key layout. Emails are lower-cased so lookups are case-insensitive.
export const keys = {
  subscriber: (email) => `pref:${normaliseEmail(email)}`,
  seen: (email) => `seen:${normaliseEmail(email)}`,
  cooldown: (email) => `cooldown:${normaliseEmail(email)}`,
  pushTestCooldown: (email) => `pushtest:${normaliseEmail(email)}`,
  linkCode: (email) => `linkcode:${normaliseEmail(email)}`,
  linkCooldown: (email) => `linkcooldown:${normaliseEmail(email)}`,
  subscriberPrefix: 'pref:',
  // Outside the pref: prefix so it is never mistaken for a subscriber.
  status: 'status:last',
};

export function normaliseEmail(email) {
  return String(email).trim().toLowerCase();
}
