import { BOOKING, WEEKDAYS } from './config.js';

// Today and the following `days - 1` dates (UTC), each with its weekday.
export function upcomingDates(days, now = new Date()) {
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i));
    return { date: date.toISOString().slice(0, 10), weekday: WEEKDAYS[date.getUTCDay()] };
  });
}

// Normalise the booking API's response into the slots someone could book now.
export function parseSlots(body) {
  return (body?.data || [])
    .filter((s) => s.spaces > 0 && s.action_to_show?.status === 'BOOK')
    .map((s) => ({
      start: s.starts_at?.format_24_hour,
      end: s.ends_at?.format_24_hour,
      spaces: s.spaces,
      price: s.price?.formatted_amount,
      name: s.name,
    }));
}

// The booking page is a single-page app, so the slots are not in its HTML.
// This is the JSON endpoint the page itself calls. It is undocumented and may
// change without notice.
export async function fetchSlots(date) {
  const url = `${BOOKING.apiBase}/venue/${BOOKING.venue}/activity/${BOOKING.activity}/v2/times?date=${encodeURIComponent(date)}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://bookings.better.org.uk',
      Referer: 'https://bookings.better.org.uk/',
    },
  });
  if (!res.ok) throw new Error(`booking API returned ${res.status} for ${date}`);
  return parseSlots(await res.json());
}
