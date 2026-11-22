import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { handleRequest } from '../src/index.js';
import { manageToken } from '../src/tokens.js';
import { apiRequest, createEnv, makeDevice, stubFetch, tokenFromEmail } from './helpers.js';

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
    expect(body.preferences).toEqual({
      ...signup,
      paused: false,
      pausedUntil: null,
      emailAlerts: true,
      devices: [],
    });
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

  it('one-click unsubscribe stops email only when phone alerts are on', async () => {
    const { body } = await subscribeAndConfirm();
    const record = JSON.parse(await env.PREFERENCES.get('pref:ace@example.com'));
    await env.PREFERENCES.put(
      'pref:ace@example.com',
      JSON.stringify({ ...record, push: [{ endpoint: 'https://fcm.googleapis.com/x' }] }),
    );
    const res = await handleRequest(
      apiRequest(`/api/unsubscribe?token=${encodeURIComponent(body.manageToken)}`, {
        method: 'POST',
        body: 'List-Unsubscribe=One-Click',
      }),
      env,
    );
    expect((await res.json()).message).toBe('Emails stopped. Phone alerts carry on.');
    const after = JSON.parse(await env.PREFERENCES.get('pref:ace@example.com'));
    expect(after).toMatchObject({ emailAlerts: false, push: [expect.any(Object)] });
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

describe('push devices', () => {
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';

  async function addDevice(token, device, ua = iphone) {
    return handleRequest(
      apiRequest('/api/subscription/push', {
        method: 'POST',
        body: { subscription: device.subscription },
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': ua },
      }),
      env,
    );
  }
  const call = (path, token, opts = {}) =>
    handleRequest(
      apiRequest(path, { ...opts, headers: { Authorization: `Bearer ${token}` } }),
      env,
    );
  const stored = async () => JSON.parse(await env.PREFERENCES.get('pref:ace@example.com'));

  it('serves the VAPID public key, or 404 when push is not configured', async () => {
    const res = await handleRequest(apiRequest('/api/push/key'), env);
    expect((await res.json()).publicKey).toBe(env.VAPID_PUBLIC_KEY);
    delete env.VAPID_PRIVATE_KEY;
    expect((await handleRequest(apiRequest('/api/push/key'), env)).status).toBe(404);
  });

  it('registers a device and shows only a hashed id and a coarse label', async () => {
    const { body } = await subscribeAndConfirm();
    const res = await addDevice(body.manageToken, makeDevice());
    expect(res.status).toBe(201);
    const { devices } = (await res.json()).preferences;
    expect(devices).toEqual([
      { id: expect.any(String), label: 'iPhone', addedAt: expect.any(String) },
    ]);
    expect(JSON.stringify(devices)).not.toContain('fcm.googleapis.com');
    expect((await stored()).push[0].endpoint).toBe('https://fcm.googleapis.com/fcm/send/device-1');
  });

  it('does not duplicate a device that registers twice, and caps the list', async () => {
    const { body } = await subscribeAndConfirm();
    const device = makeDevice();
    await addDevice(body.manageToken, device);
    await addDevice(body.manageToken, device);
    expect((await stored()).push).toHaveLength(1);

    for (let i = 2; i <= 7; i++) {
      await addDevice(
        body.manageToken,
        makeDevice(`https://fcm.googleapis.com/fcm/send/device-${i}`),
      );
    }
    const push = (await stored()).push;
    expect(push).toHaveLength(5);
    expect(push[0].endpoint).toMatch(/device-3$/);
  });

  it.each([
    ['https://evil.example/push', 'That push service is not supported.'],
    ['http://fcm.googleapis.com/fcm/send/x', 'That push service is not supported.'],
  ])('refuses endpoint %s', async (endpoint, message) => {
    const { body } = await subscribeAndConfirm();
    const device = makeDevice(endpoint);
    const res = await addDevice(body.manageToken, device);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(message);
  });

  it('refuses malformed keys', async () => {
    const { body } = await subscribeAndConfirm();
    const device = makeDevice();
    device.subscription.keys.auth = 'short';
    expect((await addDevice(body.manageToken, device)).status).toBe(400);
    device.subscription.keys = { p256dh: 'not base64!!', auth: 'AAAAAAAAAAAAAAAAAAAAAA' };
    expect((await addDevice(body.manageToken, device)).status).toBe(400);
  });

  it('needs a manage token to register', async () => {
    await subscribeAndConfirm();
    expect((await addDevice('forged.token', makeDevice())).status).toBe(401);
  });

  it('removes a device by id', async () => {
    const { body } = await subscribeAndConfirm();
    const added = await (await addDevice(body.manageToken, makeDevice())).json();
    const id = added.preferences.devices[0].id;
    const res = await call('/api/subscription/push', body.manageToken, {
      method: 'DELETE',
      body: { id },
    });
    expect((await res.json()).preferences.devices).toEqual([]);
    const again = await call('/api/subscription/push', body.manageToken, {
      method: 'DELETE',
      body: { id },
    });
    expect(again.status).toBe(404);
  });

  it('allows email off only while a device is registered, and restores it with the last device', async () => {
    const { body } = await subscribeAndConfirm();
    const off = () =>
      call('/api/subscription', body.manageToken, {
        method: 'PATCH',
        body: { emailAlerts: false },
      });

    expect((await off()).status).toBe(400);

    const added = await (await addDevice(body.manageToken, makeDevice())).json();
    expect((await off()).status).toBe(200);
    expect((await stored()).emailAlerts).toBe(false);

    await call('/api/subscription/push', body.manageToken, {
      method: 'DELETE',
      body: { id: added.preferences.devices[0].id },
    });
    expect((await stored()).emailAlerts).toBe(true);
  });

  it('sends a readable test notification that opens the booking site', async () => {
    const { body } = await subscribeAndConfirm();
    const device = makeDevice();
    await addDevice(body.manageToken, device);
    const { pushes } = stubFetch();

    const res = await call('/api/subscription/push/test', body.manageToken, { method: 'POST' });
    expect(await res.json()).toEqual({ sent: 1 });

    const [push] = pushes;
    expect(push.headers['Content-Encoding']).toBe('aes128gcm');
    expect(push.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    const payload = device.read(push.body);
    expect(payload.title).toMatch(/Test alert/);
    expect(payload.url).toMatch(
      /^https:\/\/bookings\.better\.org\.uk\/location\/islington-tennis-centre\/highbury-tennis\/\d{4}-\d{2}-\d{2}\/by-time$/,
    );

    const tooSoon = await call('/api/subscription/push/test', body.manageToken, { method: 'POST' });
    expect(tooSoon.status).toBe(429);
  });

  it('drops a device the push service says is gone', async () => {
    const { body } = await subscribeAndConfirm();
    await addDevice(body.manageToken, makeDevice());
    stubFetch({ pushStatus: () => 410 });
    const res = await call('/api/subscription/push/test', body.manageToken, { method: 'POST' });
    expect(res.status).toBe(502);
    expect((await stored()).push).toEqual([]);
  });
});

describe('linking a device with a code', () => {
  const request = (email) =>
    handleRequest(apiRequest('/api/link/request', { method: 'POST', body: { email } }), env);
  const verify = (email, code) =>
    handleRequest(apiRequest('/api/link/verify', { method: 'POST', body: { email, code } }), env);
  const codeFrom = (mail) =>
    mail.content.find((c) => c.type === 'text/plain').value.match(/code is (\d{8})/)[1];

  it('emails a code that exchanges for a working manage token', async () => {
    await subscribeAndConfirm();
    const { sent } = stubFetch();
    const res = await request('ACE@example.com');
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);

    const linked = await verify('ace@example.com', codeFrom(sent[0]));
    expect(linked.status).toBe(200);
    const { manageToken } = await linked.json();
    const read = await handleRequest(
      apiRequest('/api/subscription', { headers: { Authorization: `Bearer ${manageToken}` } }),
      env,
    );
    expect(read.status).toBe(200);
  });

  it('gives the same answer for unknown addresses and sends nothing', async () => {
    const { sent } = stubFetch();
    const res = await request('stranger@example.com');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      message: 'If that address has alerts, a code is on its way.',
    });
    expect(sent).toHaveLength(0);
  });

  it('limits codes to one per inbox every 10 minutes', async () => {
    await subscribeAndConfirm();
    stubFetch();
    expect((await request('ace@example.com')).status).toBe(202);
    expect((await request('ace@example.com')).status).toBe(429);
  });

  it('answers before the email is sent, the same as for unknown addresses', async () => {
    await subscribeAndConfirm();
    const { sent } = stubFetch();
    const tasks = [];
    const ctx = { waitUntil: (p) => tasks.push(p) };
    const res = await handleRequest(
      apiRequest('/api/link/request', { method: 'POST', body: { email: 'ace@example.com' } }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(0);
    await Promise.all(tasks);
    expect(sent).toHaveLength(1);
  });

  it('still answers 202 if the email fails, and lets them retry at once', async () => {
    await subscribeAndConfirm();
    stubFetch({ sendgridStatus: 500 });
    expect((await request('ace@example.com')).status).toBe(202);
    expect(await env.PREFERENCES.get('linkcode:ace@example.com')).toBeNull();
    const { sent } = stubFetch();
    expect((await request('ace@example.com')).status).toBe(202);
    expect(sent).toHaveLength(1);
  });

  it('rate limits guesses per email address, not per IP', async () => {
    env.SUBSCRIBE_LIMITER = {
      limit: vi.fn(async ({ key }) => ({ success: !key.startsWith('link-verify:') })),
    };
    const res = await verify('ace@example.com', '12345678');
    expect(res.status).toBe(429);
    expect(env.SUBSCRIBE_LIMITER.limit).toHaveBeenCalledWith({
      key: 'link-verify:ace@example.com',
    });
  });

  it('accepts each code once', async () => {
    await subscribeAndConfirm();
    const { sent } = stubFetch();
    await request('ace@example.com');
    const code = codeFrom(sent[0]);
    expect((await verify('ace@example.com', code)).status).toBe(200);
    expect((await verify('ace@example.com', code)).status).toBe(400);
  });

  it('locks the code after five wrong guesses', async () => {
    await subscribeAndConfirm();
    const { sent } = stubFetch();
    await request('ace@example.com');
    const code = codeFrom(sent[0]);
    const wrongCode = code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 4; i++) {
      expect((await (await verify('ace@example.com', wrongCode)).json()).error).toBe(
        'That code is wrong or has expired.',
      );
    }
    expect((await (await verify('ace@example.com', wrongCode)).json()).error).toBe(
      'Too many wrong codes. Ask for a new one.',
    );
    expect((await verify('ace@example.com', code)).status).toBe(400);
  });

  it('rejects an expired code', async () => {
    await subscribeAndConfirm();
    const { sent } = stubFetch();
    await request('ace@example.com');
    const code = codeFrom(sent[0]);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
    expect((await verify('ace@example.com', code)).status).toBe(400);
  });

  it.each(['123456', 'abcdefgh', '123456789', undefined])(
    'rejects malformed code %j',
    async (code) => {
      const res = await verify('ace@example.com', code);
      expect(res.status).toBe(400);
    },
  );

  it('never stores the code itself', async () => {
    await subscribeAndConfirm();
    const { sent } = stubFetch();
    await request('ace@example.com');
    const stored = await env.PREFERENCES.get('linkcode:ace@example.com');
    expect(stored).not.toContain(codeFrom(sent[0]));
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
