import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, parseSlots, upcomingDates } from '../src/availability.js';
import { buildAlertEmail, escapeHtml } from '../src/email.js';
import { maskEmail } from '../src/http.js';
import { deviceLabel, upsertDevice, withoutDevices } from '../src/devices.js';
import { buildPushPayload } from '../src/notifications.js';
import { generateCode } from '../src/linking.js';
import { findMatches, isPaused, unseen, updateSeen } from '../src/matching.js';
import { confirmToken, manageToken, signToken, verifyToken } from '../src/tokens.js';
import { isValidEmail, parseSettings, parseSubscription } from '../src/validation.js';
import { bookableSlot } from './helpers.js';

const SECRET = 'unit-test-secret-that-is-long-enough-000';

afterEach(() => vi.unstubAllGlobals());

describe('validation', () => {
  it('accepts ordinary addresses and rejects junk', () => {
    expect(isValidEmail('ace@example.co.uk')).toBe(true);
    expect(isValidEmail('no-at-sign.com')).toBe(false);
    expect(isValidEmail('<script>@x.com')).toBe(false);
    expect(isValidEmail(`${'a'.repeat(250)}@x.com`)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
  });

  it('cleans days and times into canonical order without duplicates', () => {
    const sub = parseSubscription({
      email: '  Ace@Example.com ',
      days: ['Saturday', 'Monday', 'Monday'],
      times: ['18:00', '07:00'],
    });
    expect(sub).toEqual({
      email: 'Ace@Example.com',
      days: ['Monday', 'Saturday'],
      times: ['07:00', '18:00'],
    });
  });

  it.each([
    [{ email: 'a@b.co', days: ['Funday'], times: ['07:00'] }, 'Days must be weekday names.'],
    [{ email: 'a@b.co', days: [], times: ['07:00'] }, 'Select at least one day.'],
    [{ email: 'a@b.co', days: ['Monday'], times: ['06:30'] }, /Times must be/],
    [{ email: 'a@b.co', days: ['Monday'], times: '07:00' }, /Times must be/],
    [{ email: 'a@b.co', days: ['Monday'], times: [] }, 'Select at least one time.'],
    [null, 'A valid email is required.'],
  ])('rejects %j', (body, message) => {
    expect(() => parseSubscription(body)).toThrow(message);
  });
});

describe('parseSettings', () => {
  it('accepts a partial change', () => {
    expect(parseSettings({ times: ['22:00', '07:00'] })).toEqual({ times: ['07:00', '22:00'] });
  });

  it('turns a pause length into an end date', () => {
    const now = Date.UTC(2026, 6, 6);
    expect(parseSettings({ paused: true, pauseDays: 7 }, now)).toEqual({
      paused: true,
      pausedUntil: '2026-07-13T00:00:00.000Z',
    });
  });

  it('clears any end date when resuming', () => {
    expect(parseSettings({ paused: false })).toEqual({ paused: false, pausedUntil: null });
  });
});

describe('isPaused', () => {
  const now = new Date('2026-07-06T12:00:00Z');
  it.each([
    [{}, false],
    [{ paused: false }, false],
    [{ paused: true }, true],
    [{ paused: true, pausedUntil: '2026-07-07T00:00:00Z' }, true],
    [{ paused: true, pausedUntil: '2026-07-06T11:59:00Z' }, false],
  ])('%j -> %s', (sub, expected) => {
    expect(isPaused(sub, now)).toBe(expected);
  });
});

describe('tokens', () => {
  it('round-trips a signed payload', async () => {
    const token = await signToken({ purpose: 'manage', email: 'a@b.co' }, SECRET);
    expect(await verifyToken(token, 'manage', SECRET)).toMatchObject({ email: 'a@b.co' });
  });

  it('rejects a tampered payload', async () => {
    const token = await manageToken('a@b.co', SECRET);
    const [, sig] = token.split('.');
    const forged = btoa(JSON.stringify({ purpose: 'manage', email: 'victim@b.co' }))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(await verifyToken(`${forged}.${sig}`, 'manage', SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await manageToken('a@b.co', `${SECRET}-other`);
    expect(await verifyToken(token, 'manage', SECRET)).toBeNull();
  });

  it('will not accept a token minted for another purpose', async () => {
    const token = await manageToken('a@b.co', SECRET);
    expect(await verifyToken(token, 'confirm', SECRET)).toBeNull();
  });

  it('expires confirmation tokens', async () => {
    const now = Date.UTC(2026, 6, 1);
    const token = await confirmToken({ email: 'a@b.co', days: [], times: [] }, SECRET, 60, now);
    expect(await verifyToken(token, 'confirm', SECRET, now + 59_000)).not.toBeNull();
    expect(await verifyToken(token, 'confirm', SECRET, now + 61_000)).toBeNull();
  });

  it.each([undefined, '', 'abc', 'a.b.c', 'x'.repeat(5000), '!!!.???'])(
    'returns null for garbage token %j',
    async (token) => {
      expect(await verifyToken(token, 'manage', SECRET)).toBeNull();
    },
  );

  it('refuses to run with a weak secret', async () => {
    await expect(signToken({ purpose: 'manage' }, 'short')).rejects.toThrow(/TOKEN_SECRET/);
  });
});

describe('upcomingDates', () => {
  it('uses the London calendar date, not UTC', () => {
    // 23:30 UTC on 1 July is 00:30 on 2 July in London (BST).
    const [first] = upcomingDates(1, new Date('2026-07-01T23:30:00Z'));
    expect(first).toEqual({ date: '2026-07-02', weekday: 'Thursday' });
  });

  it('steps across the end of British Summer Time without skipping a day', () => {
    const dates = upcomingDates(3, new Date('2026-10-24T12:00:00Z')).map((d) => d.date);
    expect(dates).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
  });
});

describe('parseSlots', () => {
  it('keeps only slots that can be booked now', () => {
    const slots = parseSlots({
      data: [
        bookableSlot('07:00'),
        bookableSlot('08:00', { spaces: 0 }),
        bookableSlot('09:00', { action_to_show: { status: 'WAITLIST' } }),
      ],
    });
    expect(slots).toEqual([
      { start: '07:00', end: '08:00', spaces: 1, price: '£12.40', name: 'Court 1' },
    ]);
  });

  it('copes with an empty or odd response', () => {
    expect(parseSlots({})).toEqual([]);
    expect(parseSlots(null)).toEqual([]);
  });
});

describe('fetchWithRetry', () => {
  const fast = { timeoutMs: 1000, retries: 2, baseDelayMs: 1 };

  it('retries server errors and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithRetry('https://x.test', {}, fast);
    expect(await res.text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a client error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithRetry('https://x.test', {}, fast)).rejects.toThrow('HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget on network errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithRetry('https://x.test', {}, fast)).rejects.toThrow(
      /gave up after 3 attempts/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('matching', () => {
  const horizon = [
    { date: '2026-07-06', weekday: 'Monday' },
    { date: '2026-07-07', weekday: 'Tuesday' },
  ];
  const slotsByDate = {
    '2026-07-06': [{ start: '07:00' }, { start: '18:00' }],
    '2026-07-07': [{ start: '07:00' }],
  };

  it('matches on both day and time', () => {
    const matches = findMatches({ days: ['Monday'], times: ['18:00'] }, horizon, slotsByDate);
    expect(matches).toEqual([{ date: '2026-07-06', weekday: 'Monday', start: '18:00' }]);
  });

  it('tolerates a record with missing fields', () => {
    expect(findMatches({}, horizon, slotsByDate)).toEqual([]);
  });

  it('filters out slots already emailed and prunes past dates', () => {
    const matches = findMatches(
      { days: ['Monday', 'Tuesday'], times: ['07:00'] },
      horizon,
      slotsByDate,
    );
    const fresh = unseen(matches, ['2026-07-06T07:00']);
    expect(fresh.map((m) => m.date)).toEqual(['2026-07-07']);
    expect(updateSeen(['2026-07-01T07:00', '2026-07-06T07:00'], fresh, '2026-07-06')).toEqual([
      '2026-07-06T07:00',
      '2026-07-07T07:00',
    ]);
  });
});

describe('email', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;',
    );
  });

  it('never lets slot data from the booking API inject markup', () => {
    const { html } = buildAlertEmail(
      'a@b.co',
      [{ date: '2026-07-06', weekday: 'Monday', start: '<b>07:00</b>', end: '08:00', spaces: 1 }],
      'https://x.test/manage.html#token=t',
    );
    expect(html).not.toContain('<b>07:00</b>');
    expect(html).toContain('&lt;b&gt;07:00&lt;/b&gt;');
  });

  it('includes a plain-text part and a manage link', () => {
    const { text } = buildAlertEmail(
      'a@b.co',
      [
        {
          date: '2026-07-06',
          weekday: 'Monday',
          start: '07:00',
          end: '08:00',
          spaces: 2,
          price: '£10',
        },
      ],
      'https://x.test/manage',
    );
    expect(text).toContain('- Monday 2026-07-06, 07:00-08:00, 2 courts · £10');
    expect(text).toContain(
      'Book: https://bookings.better.org.uk/location/islington-tennis-centre/highbury-tennis/2026-07-06/by-time',
    );
    expect(text).toContain('Settings: https://x.test/manage');
    expect(text).toContain('Pause for a week: https://x.test/manage&action=snooze');
    expect(text).toContain('Turn off: https://x.test/manage&action=off');
  });
});

describe('maskEmail', () => {
  it('hides the local part in logs', () => {
    expect(maskEmail('ace@example.com')).toBe('a***@example.com');
  });
});

describe('buildPushPayload', () => {
  const slot = (date, weekday, start, price) => ({ date, weekday, start, price });

  it('names a single slot in the title', () => {
    expect(buildPushPayload([slot('2026-11-26', 'Thursday', '19:00', '£12.40')])).toEqual({
      title: 'Court free: Thu 7pm',
      body: 'Thu 26 Nov, 19:00 · £12.40',
      url: 'https://bookings.better.org.uk/location/islington-tennis-centre/highbury-tennis/2026-11-26/by-time',
      tag: 'court-alert',
    });
  });

  it('summarises several slots, soonest first, and links to the soonest date', () => {
    const payload = buildPushPayload([
      slot('2026-11-28', 'Saturday', '09:00'),
      slot('2026-11-24', 'Tuesday', '18:00'),
      slot('2026-11-24', 'Tuesday', '07:00'),
      slot('2026-11-29', 'Sunday', '10:00'),
      slot('2026-11-30', 'Monday', '12:00'),
    ]);
    expect(payload.title).toBe('5 courts free at Highbury');
    expect(payload.body.split('\n')).toEqual([
      'Tue 24 Nov, 07:00',
      'Tue 24 Nov, 18:00',
      'Sat 28 Nov, 09:00',
      'and 2 more',
    ]);
    expect(payload.url).toMatch(/2026-11-24\/by-time$/);
  });
});

describe('devices', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9)', 'Android'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Mac'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows'],
    ['', 'Browser'],
  ])('labels %j as %s', (ua, label) => expect(deviceLabel(ua)).toBe(label));

  it('replaces a re-registered device and keeps the newest five', () => {
    const d = (n) => ({ endpoint: `e${n}` });
    let list = [];
    for (const n of [1, 2, 3, 4, 5, 6, 3]) list = upsertDevice(list, d(n));
    expect(list.map((x) => x.endpoint)).toEqual(['e2', 'e4', 'e5', 'e6', 'e3']);
  });

  it('turns email back on when the last device goes', () => {
    const record = { emailAlerts: false, push: [{ endpoint: 'a' }, { endpoint: 'b' }] };
    expect(withoutDevices(record, ['a'])).toMatchObject({ emailAlerts: false });
    expect(withoutDevices(record, ['a', 'b'])).toMatchObject({ emailAlerts: true, push: [] });
  });
});

describe('generateCode', () => {
  it('always gives six digits', () => {
    for (let i = 0; i < 500; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });
});
