import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleRequest } from '../src/index.js';
import { manageToken } from '../src/tokens.js';
import { apiRequest, createEnv, stubFetch, tokenFromEmail } from './helpers.js';

const signup = { email: 'Ace@Example.com', days: ['Monday'], times: ['07:00'] };

let env;
beforeEach(() => {
  env = createEnv();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function subscribeAndConfirm() {
  const { sent } = stubFetch();
  await handleRequest(apiRequest('/api/subscriptions', { method: 'POST', body: signup }), env);
  const token = tokenFromEmail(sent[0], 'Confirm here');
  const res = await handleRequest(
    apiRequest('/api/subscriptions/confirm', { method: 'POST', body: { token } }),
    env,
  );
  return { res, body: await res.json(), sent };
}

describe('sign-up with double opt-in', () => {
  it('saves nothing until the emailed link is confirmed', async () => {
    const { sent } = stubFetch();
    const res = await handleRequest(
      apiRequest('/api/subscriptions', { method: 'POST', body: signup }),
      env,
    );

    expect(res.status).toBe(202);
    expect(await env.PREFERENCES.get('pref:ace@example.com')).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0].personalizations[0].to[0].email).toBe('Ace@Example.com');
    expect(sent[0].content[0].value).toContain('https://courts.example.com/confirm#token=');
  });

  it('activates the subscription on confirm and returns a manage token', async () => {
    const { res, body } = await subscribeAndConfirm();
    expect(res.status).toBe(200);
    expect(body.preferences).toEqual({ ...signup, paused: false, pausedUntil: null });
    expect(body.manageToken).toEqual(expect.any(String));
    const stored = JSON.parse(await env.PREFERENCES.get('pref:ace@example.com'));
    expect(stored).toMatchObject({ days: ['Monday'], times: ['07:00'] });
  });

  it('rejects a forged or expired confirmation token', async () => {
    stubFetch();
    const res = await handleRequest(
      apiRequest('/api/subscriptions/confirm', { method: 'POST', body: { token: 'nope.nope' } }),
      env,
    );
    expect(res.status).toBe(400);
    expect(env.PREFERENCES.store.size).toBe(0);
  });

  it('will not send a second confirmation to the same inbox within the cooldown', async () => {
    const { sent } = stubFetch();
    const send = () =>
      handleRequest(apiRequest('/api/subscriptions', { method: 'POST', body: signup }), env);
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(429);
    expect(sent).toHaveLength(1);
  });

  it('reports a 502 and sets no cooldown when the email cannot be sent', async () => {
    stubFetch({ sendgridStatus: 500 });
    const res = await handleRequest(
      apiRequest('/api/subscriptions', { method: 'POST', body: signup }),
      env,
    );
    expect(res.status).toBe(502);
    expect(await env.PREFERENCES.get('cooldown:ace@example.com')).toBeNull();
  });

  it('applies the per-IP rate limiter when it is bound', async () => {
    stubFetch();
    env.SUBSCRIBE_LIMITER = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const req = apiRequest('/api/subscriptions', {
      method: 'POST',
      body: signup,
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
    });
    const res = await handleRequest(req, env);
    expect(res.status).toBe(429);
    expect(env.SUBSCRIBE_LIMITER.limit).toHaveBeenCalledWith({ key: '203.0.113.9' });
  });
});

describe('input handling', () => {
  it('validates the body', async () => {
    const res = await handleRequest(
      apiRequest('/api/subscriptions', {
        method: 'POST',
        body: { ...signup, days: ['<script>'] },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Days must be weekday names.' });
  });

  it('rejects malformed JSON', async () => {
    const res = await handleRequest(
      apiRequest('/api/subscriptions', { method: 'POST', body: '{not json' }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects oversized bodies', async () => {
    const res = await handleRequest(
      apiRequest('/api/subscriptions', { method: 'POST', body: { pad: 'x'.repeat(5000) } }),
      env,
    );
    expect(res.status).toBe(413);
  });

  it('sets safe headers on API responses', async () => {
    const res = await handleRequest(apiRequest('/api/subscription'), env);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('managing a subscription', () => {
  it('needs a valid manage token to read preferences', async () => {
    await subscribeAndConfirm();
    const noToken = await handleRequest(apiRequest('/api/subscription'), env);
    expect(noToken.status).toBe(401);

    const wrong = await manageToken(
      'someone-else@example.com',
      'a-different-secret-entirely-0000000',
    );
    const forged = await handleRequest(
      apiRequest('/api/subscription', { headers: { Authorization: `Bearer ${wrong}` } }),
      env,
    );
    expect(forged.status).toBe(401);
  });

  it('reads and deletes with the manage token', async () => {
    const { body } = await subscribeAndConfirm();
    const auth = { Authorization: `Bearer ${body.manageToken}` };

    const read = await handleRequest(apiRequest('/api/subscription', { headers: auth }), env);
    expect(read.status).toBe(200);
    expect((await read.json()).preferences.days).toEqual(['Monday']);

    const del = await handleRequest(
      apiRequest('/api/subscription', { method: 'DELETE', headers: auth }),
      env,
    );
    expect(del.status).toBe(200);
    expect(await env.PREFERENCES.get('pref:ace@example.com')).toBeNull();

    const gone = await handleRequest(apiRequest('/api/subscription', { headers: auth }), env);
    expect(gone.status).toBe(404);
  });

  it('supports RFC 8058 one-click unsubscribe', async () => {
    const { body } = await subscribeAndConfirm();
    const res = await handleRequest(
      apiRequest(`/api/unsubscribe?token=${encodeURIComponent(body.manageToken)}`, {
        method: 'POST',
        body: 'List-Unsubscribe=One-Click',
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await env.PREFERENCES.get('pref:ace@example.com')).toBeNull();
  });

  it('no longer exposes the old unauthenticated email routes', async () => {
    await subscribeAndConfirm();
    const res = await handleRequest(apiRequest('/api/preferences/ace%40example.com'), env);
    expect(res.status).toBe(404);
  });
});

describe('settings', () => {
  async function patch(token, body) {
    return handleRequest(
      apiRequest('/api/subscription', {
        method: 'PATCH',
        body,
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
  }
  const stored = async () => JSON.parse(await env.PREFERENCES.get('pref:ace@example.com'));

  it('turns alerts off and back on', async () => {
    const { body } = await subscribeAndConfirm();
    const off = await patch(body.manageToken, { paused: true });
    expect(off.status).toBe(200);
    expect((await off.json()).preferences).toMatchObject({ paused: true, pausedUntil: null });

    await patch(body.manageToken, { paused: false });
    expect(await stored()).toMatchObject({ paused: false, pausedUntil: null });
  });

  it('pauses for a set number of days', async () => {
    const { body } = await subscribeAndConfirm();
    const before = Date.now();
    await patch(body.manageToken, { paused: true, pauseDays: 7 });
    const until = new Date((await stored()).pausedUntil).getTime();
    expect(until - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(until - before).toBeLessThan(7 * 86_400_000 + 5000);
  });

  it('changes days and times without another confirmation', async () => {
    const { body, sent } = await subscribeAndConfirm();
    const res = await patch(body.manageToken, { days: ['Sunday', 'Friday'], times: ['20:00'] });
    expect(res.status).toBe(200);
    expect(await stored()).toMatchObject({ days: ['Sunday', 'Friday'], times: ['20:00'] });
    expect(sent).toHaveLength(1);
  });

  it.each([
    [{}, 'Nothing to change.'],
    [{ paused: 'yes' }, 'paused must be true or false.'],
    [{ paused: true, pauseDays: 99 }, /pauseDays must be/],
    [{ pauseDays: 3 }, 'pauseDays needs paused: true.'],
    [{ days: [] }, 'Select at least one day.'],
    [[], 'Expected a JSON object.'],
  ])('rejects %j', async (change, message) => {
    const { body } = await subscribeAndConfirm();
    const res = await patch(body.manageToken, change);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
  });

  it('needs a manage token', async () => {
    await subscribeAndConfirm();
    const res = await patch('forged.token', { paused: true });
    expect(res.status).toBe(401);
    expect(await stored()).toMatchObject({ paused: false });
  });

  it('returns 404 once the subscription is deleted', async () => {
    const { body } = await subscribeAndConfirm();
    await env.PREFERENCES.delete('pref:ace@example.com');
    expect((await patch(body.manageToken, { paused: true })).status).toBe(404);
  });

  it('turns alerts back on when someone confirms again', async () => {
    const { body } = await subscribeAndConfirm();
    await patch(body.manageToken, { paused: true });
    await env.PREFERENCES.delete('cooldown:ace@example.com');
    await subscribeAndConfirm();
    expect(await stored()).toMatchObject({ paused: false });
  });
});

describe('status', () => {
  it('reports nothing before the first check', async () => {
    const res = await handleRequest(apiRequest('/api/status'), env);
    expect(await res.json()).toEqual({ checkedAt: null, openSlots: null });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('reports the last check', async () => {
    await env.PREFERENCES.put(
      'status:last',
      JSON.stringify({ checkedAt: '2026-07-06T11:00:00.000Z', openSlots: 4, datesChecked: 2 }),
    );
    const res = await handleRequest(apiRequest('/api/status'), env);
    expect(await res.json()).toMatchObject({ openSlots: 4 });
  });
});

describe('routing', () => {
  it('returns 405 for a known path with the wrong method', async () => {
    const res = await handleRequest(apiRequest('/api/subscriptions'), env);
    expect(res.status).toBe(405);
  });

  it('hands non-API paths to static assets', async () => {
    const res = await handleRequest(apiRequest('/index.html'), env);
    expect(await res.text()).toBe('static');
  });

  it('hides internal error details', async () => {
    env.TOKEN_SECRET = 'too-short';
    stubFetch();
    const res = await handleRequest(
      apiRequest('/api/subscriptions', { method: 'POST', body: signup }),
      env,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error.' });
  });

  it('wires the cron trigger to the availability check', async () => {
    const ctx = { waitUntil: vi.fn() };
    await worker.scheduled({}, env, ctx);
    expect(ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    await ctx.waitUntil.mock.calls[0][0];
  });
});
