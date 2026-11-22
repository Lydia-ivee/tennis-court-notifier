import { HORIZON_DAYS, LIMITS, keys } from './config.js';
import { fetchSlots, upcomingDates } from './availability.js';
import { buildAlertEmail, sendEmail } from './email.js';
import { log, maskEmail } from './http.js';
import { findMatches, isPaused, unseen, updateSeen } from './matching.js';
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
// subscriber only about slots they have not already been told about.
export async function runCheck(env, { now = new Date(), fetchOpts } = {}) {
  const everyone = await loadSubscribers(env);
  const subscribers = everyone.filter((s) => !isPaused(s, now));
  const summary = {
    datesChecked: 0,
    subscribers: subscribers.length,
    paused: everyone.length - subscribers.length,
    emailsSent: 0,
    errors: 0,
  };
  if (subscribers.length === 0) {
    log('check_complete', summary);
    return summary;
  }

  // Only ask the booking site about weekdays somebody actually wants.
  const wanted = new Set(subscribers.flatMap((s) => s.days || []));
  const horizon = upcomingDates(HORIZON_DAYS, now).filter((d) => wanted.has(d.weekday));
  const today = upcomingDates(1, now)[0].date;

  // Sequential on purpose: be gentle with the booking site.
  const slotsByDate = {};
  for (const { date } of horizon) {
    try {
      slotsByDate[date] = await fetchSlots(date, fetchOpts);
      summary.datesChecked++;
    } catch (err) {
      slotsByDate[date] = [];
      summary.errors++;
      log('availability_failed', { date, message: err.message });
    }
  }

  // Public, anonymous summary for the "last checked" line on the sign-up page.
  const openSlots = Object.values(slotsByDate).reduce((n, slots) => n + slots.length, 0);
  await env.PREFERENCES.put(
    keys.status,
    JSON.stringify({ checkedAt: now.toISOString(), openSlots, datesChecked: summary.datesChecked }),
  );

  for (const sub of subscribers) {
    try {
      const seenIds = JSON.parse((await env.PREFERENCES.get(keys.seen(sub.email))) || '[]');
      const fresh = unseen(findMatches(sub, horizon, slotsByDate), seenIds);
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
      await env.PREFERENCES.put(
        keys.seen(sub.email),
        JSON.stringify(updateSeen(seenIds, fresh, today)),
        {
          expirationTtl: LIMITS.seenTtlSeconds,
        },
      );
    } catch (err) {
      summary.errors++;
      log('subscriber_failed', { to: maskEmail(sub.email), message: err.message });
    }
  }

  log('check_complete', summary);
  return summary;
}
