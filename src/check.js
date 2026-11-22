import { HORIZON_DAYS, LIMITS, PUSH, keys } from './config.js';
import { fetchSlots, upcomingDates } from './availability.js';
import { buildAlertEmail, sendEmail } from './email.js';
import { pruneDevices } from './devices.js';
import { log, maskEmail } from './http.js';
import { findMatches, isPaused, unseen, updateSeen } from './matching.js';
import { buildPushPayload } from './notifications.js';
import { manageLinks } from './subscriptions.js';
import { sendPush, vapidFromEnv } from './webpush.js';

// Tell one subscriber about fresh slots on every channel they chose.
// Returns what happened so the caller can count it.
async function deliver(env, sub, fresh, vapid) {
  const outcome = { email: false, pushes: 0, gone: [] };
  const sendAlertEmail = async () => {
    const { manageUrl, unsubscribeUrl } = await manageLinks(env, sub.email);
    return sendEmail(env, sub.email, buildAlertEmail(sub.email, fresh, manageUrl), {
      unsubscribeUrl,
    });
  };

  const devices = vapid ? sub.push || [] : [];
  if (devices.length) {
    const payload = buildPushPayload(fresh);
    const results = await Promise.all(
      devices.map((d) => sendPush(d, payload, vapid, { ttlSeconds: PUSH.ttlSeconds })),
    );
    results.forEach((r, i) => {
      if (r.ok) outcome.pushes++;
      else if (r.gone) outcome.gone.push(devices[i].endpoint);
      // Not pruned on other errors: a 403 after a key change or a server
      // misconfiguration would otherwise wipe every device at once. The email
      // fallback below keeps alerts flowing, and the browser re-subscribes when
      // its key no longer matches (public/push.js).
      else log('push_failed', { to: maskEmail(sub.email), status: r.status });
    });
  }

  // Email if they want it, and also if they turned it off but no push got
  // through: someone with email off must never be left hearing nothing.
  if (sub.emailAlerts !== false || outcome.pushes === 0) {
    outcome.email = await sendAlertEmail();
  }
  return outcome;
}

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
    pushesSent: 0,
    devicesRemoved: 0,
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

  const vapid = vapidFromEnv(env);
  for (const sub of subscribers) {
    try {
      const seenIds = JSON.parse((await env.PREFERENCES.get(keys.seen(sub.email))) || '[]');
      const fresh = unseen(findMatches(sub, horizon, slotsByDate), seenIds);
      if (fresh.length === 0) continue;

      const outcome = await deliver(env, sub, fresh, vapid);
      if (outcome.email) summary.emailsSent++;
      summary.pushesSent += outcome.pushes;
      summary.devicesRemoved += await pruneDevices(env, sub.email, outcome.gone);

      // Only remember slots that reached them somehow, so a failure retries next run.
      if (!outcome.email && outcome.pushes === 0) {
        summary.errors++;
        continue;
      }
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
