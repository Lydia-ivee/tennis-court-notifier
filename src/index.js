const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// KV keys are namespaced and lower-cased so lookups are case-insensitive.
function kvKey(email) {
  return `pref:${email.trim().toLowerCase()}`;
}

async function savePreferences(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const { email, days, times } = body || {};

  if (!isValidEmail(email)) {
    return json({ error: 'A valid email is required.' }, 400);
  }
  if (!Array.isArray(days) || days.length === 0) {
    return json({ error: 'Select at least one day.' }, 400);
  }
  if (!Array.isArray(times) || times.length === 0) {
    return json({ error: 'Select at least one time.' }, 400);
  }

  const record = {
    email: email.trim(),
    days,
    times,
    createdAt: new Date().toISOString(),
  };

  await env.PREFERENCES.put(kvKey(email), JSON.stringify(record));
  return json({ message: 'Preferences saved.', preferences: record }, 201);
}

async function getPreferences(email, env) {
  if (!isValidEmail(email)) {
    return json({ error: 'A valid email is required.' }, 400);
  }
  const stored = await env.PREFERENCES.get(kvKey(email));
  if (!stored) {
    return json({ error: 'No preferences found for that email.' }, 404);
  }
  return json({ preferences: JSON.parse(stored) });
}

async function deletePreferences(email, env) {
  if (!isValidEmail(email)) {
    return json({ error: 'A valid email is required.' }, 400);
  }
  const stored = await env.PREFERENCES.get(kvKey(email));
  if (!stored) {
    return json({ error: 'No preferences found for that email.' }, 404);
  }
  await env.PREFERENCES.delete(kvKey(email));
  return json({ message: 'Preferences deleted.' });
}

// ---- Court availability scraping ----
//
// NOTE: the public booking page (bookings.better.org.uk/.../by-time) is a React
// single-page app — the slots are NOT in the server HTML, so cheerio would find
// nothing. The app fetches its data from this JSON API, which we call directly.
const BOOKING = {
  apiBase: 'https://better-admin.org.uk/api/activities',
  venue: 'islington-tennis-centre',
  activity: 'highbury-tennis',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Dates for today through the next `days - 1` days, each tagged with its weekday.
function upcomingDates(days) {
  const now = new Date();
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i));
    out.push({ date: d.toISOString().slice(0, 10), weekday: WEEKDAYS[d.getUTCDay()] });
  }
  return out;
}

// Fetch bookable slots for a single date. Returns [{ start, end, spaces, price, name }].
async function fetchSlots(date) {
  const url = `${BOOKING.apiBase}/venue/${BOOKING.venue}/activity/${BOOKING.activity}/v2/times?date=${date}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://bookings.better.org.uk',
      Referer: 'https://bookings.better.org.uk/',
    },
  });
  if (!res.ok) {
    throw new Error(`booking API returned ${res.status} for ${date}`);
  }
  const body = await res.json();
  return (body.data || [])
    .filter((s) => s.spaces > 0 && s.action_to_show?.status === 'BOOK')
    .map((s) => ({
      start: s.starts_at?.format_24_hour,
      end: s.ends_at?.format_24_hour,
      spaces: s.spaces,
      price: s.price?.formatted_amount,
      name: s.name,
    }));
}

// Build the HTML body for the notification email. Inline styles only — email
// clients strip <style> blocks and don't load external CSS.
function buildEmailHtml(email, matches) {
  const rows = matches
    .map(
      (m) => `
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #d8c8a0;font-family:Georgia,serif;color:#2c2415;">
            <strong>${m.weekday}</strong> ${m.date}
          </td>
          <td style="padding:12px 16px;border-bottom:1px solid #d8c8a0;font-family:Georgia,serif;color:#2c2415;">
            ${m.start}&ndash;${m.end}
          </td>
          <td style="padding:12px 16px;border-bottom:1px solid #d8c8a0;font-family:Georgia,serif;color:#4a5d3a;text-align:center;">
            ${m.spaces} court${m.spaces > 1 ? 's' : ''}${m.price ? ` &middot; ${m.price}` : ''}
          </td>
        </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background-color:#2b2a28;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background-color:#efe4c9;border:2px solid #9c7a1e;border-radius:6px;">
    <tr>
      <td style="padding:28px 24px;text-align:center;">
        <div style="font-size:52px;line-height:1;">🎾</div>
        <h1 style="margin:12px 0 4px;font-family:Georgia,serif;font-size:26px;color:#2c2415;">A Court Falls Free!</h1>
        <p style="margin:0;font-family:Georgia,serif;font-style:italic;color:#9c7a1e;">
          Highbury Fields Tennis — matches for thy chosen hours
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:0 24px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:rgba(255,255,255,0.4);border:1px solid #d8c8a0;border-radius:4px;">
          ${rows}
        </table>
        <p style="margin:20px 0 0;text-align:center;">
          <a href="https://bookings.better.org.uk/location/islington-tennis-centre/highbury-tennis"
             style="display:inline-block;padding:12px 28px;font-family:Georgia,serif;font-weight:bold;font-size:16px;color:#efe4c9;background-color:#4a5d3a;border:2px solid #9c7a1e;border-radius:5px;text-decoration:none;">
            Claim thy court ⚔️
          </a>
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:0 24px 24px;text-align:center;font-family:Georgia,serif;font-size:12px;font-style:italic;color:#8a7a54;">
        Sent to ${email} by the Tennis Court Notifier.
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Send a notification via SendGrid's Mail Send API. Returns true on success,
// false on failure — never throws, so one bad send won't halt the run.
async function sendEmail(email, matches, env) {
  if (!env.SENDGRID_API_KEY) {
    console.error(`SENDGRID_API_KEY not set — cannot email ${email}.`);
    return false;
  }

  const payload = {
    personalizations: [{ to: [{ email }] }],
    from: { email: env.FROM_EMAIL, name: 'Tennis Court Notifier' },
    subject: '⚔️ Court Available!',
    content: [{ type: 'text/html', value: buildEmailHtml(email, matches) }],
  };

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(`SendGrid failed for ${email}: ${res.status} ${detail}`);
      return false;
    }

    console.log(`Emailed ${email} — ${matches.length} matching slot(s).`);
    return true;
  } catch (err) {
    console.error(`SendGrid request errored for ${email}: ${err.message}`);
    return false;
  }
}

async function runScrape(env) {
  // 1. Load every subscriber.
  const users = [];
  let cursor;
  do {
    const page = await env.PREFERENCES.list({ prefix: 'pref:', cursor });
    for (const key of page.keys) {
      const stored = await env.PREFERENCES.get(key.name);
      if (stored) {
        try {
          users.push(JSON.parse(stored));
        } catch {
          console.error(`skipping unparseable record: ${key.name}`);
        }
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  if (users.length === 0) {
    console.log('No subscribers — nothing to check.');
    return { datesScraped: [], subscribersChecked: 0, matchesFound: 0, emailsSent: 0, errors: 0 };
  }

  // 2. Only fetch dates that at least one user cares about, over the next 7 days.
  const wantedWeekdays = new Set(users.flatMap((u) => u.days || []));
  const horizon = upcomingDates(7).filter((d) => wantedWeekdays.has(d.weekday));

  // 3. Scrape slots per date once, reused across users.
  const slotsByDate = {};
  const datesScraped = [];
  for (const { date, weekday } of horizon) {
    try {
      slotsByDate[date] = await fetchSlots(date);
      console.log(`Scraped ${slotsByDate[date].length} open slot(s) for ${date}.`);
    } catch (err) {
      slotsByDate[date] = [];
      console.error(`Scrape failed for ${date}: ${err.message}`);
    }
    datesScraped.push({ date, weekday, openSlots: slotsByDate[date].length });
  }

  // 4. Match each user's preferred days + times against open slots.
  let notified = 0;
  let errors = 0;
  let matchesFound = 0;
  for (const user of users) {
    try {
      const matches = [];
      for (const { date, weekday } of horizon) {
        if (!(user.days || []).includes(weekday)) continue;
        for (const slot of slotsByDate[date] || []) {
          if ((user.times || []).includes(slot.start)) {
            matches.push({ date, weekday, ...slot });
          }
        }
      }

      matchesFound += matches.length;

      if (matches.length > 0) {
        const sent = await sendEmail(user.email, matches, env);
        if (sent) {
          notified++;
        } else {
          errors++;
        }
      } else {
        console.log(`No matching slots for ${user.email}.`);
      }
    } catch (err) {
      errors++;
      console.error(`Failed processing ${user.email}: ${err.message}`);
    }
  }

  console.log(
    `Scrape complete: ${users.length} subscriber(s), ${notified} notified, ${errors} error(s).`,
  );
  return {
    datesScraped,
    subscribersChecked: users.length,
    matchesFound,
    emailsSent: notified,
    errors,
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScrape(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // Collection route: POST /api/preferences
      if (pathname === '/api/preferences') {
        if (request.method === 'POST') {
          return await savePreferences(request, env);
        }
        return json({ error: 'Method not allowed.' }, 405);
      }

      // Item routes: GET|DELETE /api/preferences/:email
      if (pathname.startsWith('/api/preferences/')) {
        const email = decodeURIComponent(pathname.slice('/api/preferences/'.length));
        if (request.method === 'GET') {
          return await getPreferences(email, env);
        }
        if (request.method === 'DELETE') {
          return await deletePreferences(email, env);
        }
        return json({ error: 'Method not allowed.' }, 405);
      }

      // Everything else: static files from public/
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: 'Internal server error.', detail: err.message }, 500);
    }
  },
};
