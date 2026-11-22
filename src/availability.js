import { BOOKING, FETCH, TIME_ZONE, WEEKDAYS } from './config.js';

// Today's calendar date in London as YYYY-MM-DD. en-CA formats dates that way.
function londonToday(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// Today (in London) and the following `days - 1` dates, each with its weekday.
export function upcomingDates(days, now = new Date()) {
  const [y, m, d] = londonToday(now).split('-').map(Number);
  return Array.from({ length: days }, (_, i) => {
    // Pure calendar arithmetic in UTC, so DST changes cannot shift the day.
    const date = new Date(Date.UTC(y, m - 1, d + i));
    return { date: date.toISOString().slice(0, 10), weekday: WEEKDAYS[date.getUTCDay()] };
  });
}

class RetryableError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// fetch with a timeout and exponential backoff with jitter. Retries network
// errors, timeouts, 429 and 5xx. Fails fast on other 4xx: retrying won't help.
export async function fetchWithRetry(url, init = {}, opts = FETCH) {
  let lastError;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(`HTTP ${res.status}`);
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const retryable =
        err instanceof RetryableError || err.name === 'TimeoutError' || err.name === 'TypeError';
      if (!retryable) throw err;
      lastError = err;
      if (attempt < opts.retries) {
        const backoff = opts.baseDelayMs * 2 ** attempt;
        await sleep(backoff + Math.random() * backoff * 0.5);
      }
    }
  }
  throw new Error(`gave up after ${opts.retries + 1} attempts: ${lastError.message}`);
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
export async function fetchSlots(date, opts) {
  const url = `${BOOKING.apiBase}/venue/${BOOKING.venue}/activity/${BOOKING.activity}/v2/times?date=${encodeURIComponent(date)}`;
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: 'application/json',
        Origin: 'https://bookings.better.org.uk',
        Referer: 'https://bookings.better.org.uk/',
      },
    },
    opts,
  );
  return parseSlots(await res.json());
}
