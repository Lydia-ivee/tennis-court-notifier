// What a push notification says. Kept short: lock screens show about two lines.

import { upcomingDates } from './availability.js';
import { bookingUrlFor } from './config.js';

const SHORT_DAY = {
  Sunday: 'Sun',
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
};

// "18:00" -> "6pm"
function hourLabel(time) {
  const h = Number(String(time).slice(0, 2));
  return `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
}

// "2026-11-24" -> "24 Nov"
function dayMonth(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

const describe = (m) =>
  `${SHORT_DAY[m.weekday] || m.weekday} ${dayMonth(m.date)}, ${m.start}${m.price ? ` · ${m.price}` : ''}`;

/**
 * @param {Array<{ date: string, weekday: string, start: string, price?: string }>} matches
 * @returns {{ title: string, body: string, url: string, tag: string }}
 */
export function buildPushPayload(matches) {
  const sorted = [...matches].sort((a, b) =>
    `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`),
  );
  const first = sorted[0];
  const title =
    sorted.length === 1
      ? `Court free: ${SHORT_DAY[first.weekday]} ${hourLabel(first.start)}`
      : `${sorted.length} courts free at Highbury`;

  const lines = sorted.slice(0, 3).map(describe);
  if (sorted.length > 3) lines.push(`and ${sorted.length - 3} more`);

  return {
    title,
    body: lines.join('\n'),
    // Straight to the booking page for the soonest slot's date.
    url: bookingUrlFor(first.date),
    tag: 'court-alert',
  };
}

export function buildTestPayload() {
  return {
    title: 'Test alert: the heralds can reach thee',
    body: 'This is how open courts will look. Tap to see the booking page.',
    // Today in London, not UTC, so a late-night test never opens yesterday.
    url: bookingUrlFor(upcomingDates(1)[0].date),
    tag: 'court-alert-test',
  };
}
