import { HORIZON_DAYS, keys } from './config.js';
import { fetchSlots, upcomingDates } from './availability.js';
import { buildAlertEmail, sendEmail } from './email.js';
import { log, maskEmail } from './http.js';
import { findMatches } from './matching.js';
import { manageLinks } from './subscriptions.js';

async function loadSubscribers(env) {
  const subscribers = [];
  let cursor;
  do {
    const page = await env.PREFERENCES.list({ prefix: keys.subscriberPrefix, cursor });
    const values = await Promise.all(page.keys.map((k) => env.PREFERENCES.get(k.name)));
    page.keys.forEach((k, i) => {
      if (!values[i]) return;
      try {
        subscribers.push(JSON.parse(values[i]));
      } catch {
        log('skipped_bad_record', { key: k.name.slice(0, 6) });
      }
    });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return subscribers;
}

// The scheduled job: fetch availability once per wanted date, then email each
// subscriber the slots that match their days and times.
export async function runCheck(env, { now = new Date() } = {}) {
  const subscribers = await loadSubscribers(env);
  const summary = { datesChecked: 0, subscribers: subscribers.length, emailsSent: 0, errors: 0 };
  if (subscribers.length === 0) {
    log('check_complete', summary);
    return summary;
  }

  // Only ask the booking site about weekdays somebody actually wants.
  const wanted = new Set(subscribers.flatMap((s) => s.days || []));
  const horizon = upcomingDates(HORIZON_DAYS, now).filter((d) => wanted.has(d.weekday));

  // Sequential on purpose: be gentle with the booking site.
  const slotsByDate = {};
  for (const { date } of horizon) {
    try {
      slotsByDate[date] = await fetchSlots(date);
      summary.datesChecked++;
    } catch (err) {
      slotsByDate[date] = [];
      summary.errors++;
      log('availability_failed', { date, message: err.message });
    }
  }

  for (const sub of subscribers) {
    try {
      const fresh = findMatches(sub, horizon, slotsByDate);
      if (fresh.length === 0) continue;

      const { manageUrl, unsubscribeUrl } = await manageLinks(env, sub.email);
      const sent = await sendEmail(env, sub.email, buildAlertEmail(sub.email, fresh, manageUrl), {
        unsubscribeUrl,
      });
      if (!sent) {
        summary.errors++;
        continue;
      }
      summary.emailsSent++;
    } catch (err) {
      summary.errors++;
      log('subscriber_failed', { to: maskEmail(sub.email), message: err.message });
    }
  }

  log('check_complete', summary);
  return summary;
}
