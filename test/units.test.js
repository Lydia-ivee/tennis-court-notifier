import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, parseSlots, upcomingDates } from '../src/availability.js';
import { buildAlertEmail, escapeHtml } from '../src/email.js';
import { maskEmail } from '../src/http.js';
import { findMatches, unseen, updateSeen } from '../src/matching.js';
import { confirmToken, manageToken, signToken, verifyToken } from '../src/tokens.js';
import { isValidEmail, parseSubscription } from '../src/validation.js';
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
    expect(text).toContain('https://x.test/manage');
  });
});

describe('maskEmail', () => {
  it('hides the local part in logs', () => {
    expect(maskEmail('ace@example.com')).toBe('a***@example.com');
  });
});
