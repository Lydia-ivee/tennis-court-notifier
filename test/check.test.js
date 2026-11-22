import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../src/check.js';
import { bookableSlot, createEnv, makeDevice, stubFetch } from './helpers.js';

// Monday 6 July 2026, midday in London.
const NOW = new Date('2026-07-06T11:00:00Z');
const fetchOpts = { timeoutMs: 1000, retries: 1, baseDelayMs: 1 };

let env;
beforeEach(() => {
  env = createEnv();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function addSubscriber(email, days, times, extra = {}) {
  await env.PREFERENCES.put(`pref:${email}`, JSON.stringify({ email, days, times, ...extra }));
}

describe('runCheck', () => {
  it('does nothing and calls nobody when there are no subscribers', async () => {
    const { fetchMock } = stubFetch();
    const summary = await runCheck(env, { now: NOW, fetchOpts });
    expect(summary.subscribers).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only asks the booking site about weekdays someone wants', async () => {
    await addSubscriber('a@example.com', ['Monday', 'Wednesday'], ['07:00']);
    const { bookingCalls } = stubFetch();
    await runCheck(env, { now: NOW, fetchOpts });
    expect(bookingCalls).toEqual(['2026-07-06', '2026-07-08']);
  });

  it('emails matching slots once, then stays silent about the same slots', async () => {
    await addSubscriber('a@example.com', ['Monday'], ['07:00']);
    await addSubscriber('b@example.com', ['Monday'], ['18:00']);
    const { sent } = stubFetch({
      bookingHandler: () => ({ data: [bookableSlot('07:00'), bookableSlot('09:00')] }),
    });

    const first = await runCheck(env, { now: NOW, fetchOpts });
    expect(first.emailsSent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].personalizations[0].to[0].email).toBe('a@example.com');
    expect(sent[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(sent[0].headers['List-Unsubscribe']).toMatch(
      /^<https:\/\/courts\.example\.com\/api\/unsubscribe\?token=/,
    );

    const second = await runCheck(env, { now: NOW, fetchOpts });
    expect(second.emailsSent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('emails again when a new matching slot appears', async () => {
    await addSubscriber('a@example.com', ['Monday'], ['07:00', '08:00']);
    let slots = [bookableSlot('07:00')];
    const { sent } = stubFetch({ bookingHandler: () => ({ data: slots }) });

    await runCheck(env, { now: NOW, fetchOpts });
    slots = [bookableSlot('07:00'), bookableSlot('08:00')];
    await runCheck(env, { now: NOW, fetchOpts });

    expect(sent).toHaveLength(2);
    const secondText = sent[1].content[0].value;
    expect(secondText).toContain('08:00-09:00');
    expect(secondText).not.toContain('07:00-08:00');
  });

  it('retries the email next run if sending failed', async () => {
    await addSubscriber('a@example.com', ['Monday'], ['07:00']);
    stubFetch({ bookingHandler: () => ({ data: [bookableSlot('07:00')] }), sendgridStatus: 500 });
    const failed = await runCheck(env, { now: NOW, fetchOpts });
    expect(failed.errors).toBe(1);
    expect(await env.PREFERENCES.get('seen:a@example.com')).toBeNull();
  });

  it('keeps going when the booking site fails for one date', async () => {
    await addSubscriber('a@example.com', ['Monday', 'Tuesday'], ['07:00']);
    const { sent } = stubFetch({
      bookingHandler: (date) =>
        date === '2026-07-06'
          ? new Response('', { status: 503 })
          : { data: [bookableSlot('07:00')] },
    });
    const summary = await runCheck(env, { now: NOW, fetchOpts });
    expect(summary.errors).toBe(1);
    expect(summary.emailsSent).toBe(1);
    expect(sent[0].content[0].value).toContain('Tuesday 2026-07-07');
  });

  it('pages through every subscriber and skips corrupt records', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await addSubscriber(`${name}@example.com`, ['Monday'], ['07:00']);
    }
    await env.PREFERENCES.put('pref:broken@example.com', '{oops');
    const { sent } = stubFetch({ bookingHandler: () => ({ data: [bookableSlot('07:00')] }) });
    const summary = await runCheck(env, { now: NOW, fetchOpts });
    expect(summary.subscribers).toBe(5);
    expect(sent).toHaveLength(5);
  });

  it('skips paused subscribers and does not fetch for them', async () => {
    await addSubscriber('a@example.com', ['Monday'], ['07:00'], { paused: true });
    const { bookingCalls, sent } = stubFetch({
      bookingHandler: () => ({ data: [bookableSlot('07:00')] }),
    });
    const summary = await runCheck(env, { now: NOW, fetchOpts });
    expect(summary).toMatchObject({ subscribers: 0, paused: 1, emailsSent: 0 });
    expect(bookingCalls).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('resumes by itself once a timed pause has passed', async () => {
    await addSubscriber('a@example.com', ['Monday'], ['07:00'], {
      paused: true,
      pausedUntil: '2026-07-06T09:00:00.000Z',
    });
    const { sent } = stubFetch({ bookingHandler: () => ({ data: [bookableSlot('07:00')] }) });
    await runCheck(env, { now: NOW, fetchOpts });
    expect(sent).toHaveLength(1);
  });

  it('records an anonymous status for the sign-up page', async () => {
    await addSubscriber('a@example.com', ['Monday', 'Tuesday'], ['07:00']);
    stubFetch({ bookingHandler: () => ({ data: [bookableSlot('07:00'), bookableSlot('08:00')] }) });
    await runCheck(env, { now: NOW, fetchOpts });
    expect(JSON.parse(await env.PREFERENCES.get('status:last'))).toEqual({
      checkedAt: NOW.toISOString(),
      openSlots: 4,
      datesChecked: 2,
    });
  });

  describe('push alerts', () => {
    const phone = makeDevice('https://web.push.apple.com/phone');
    const laptop = makeDevice('https://fcm.googleapis.com/fcm/send/laptop');
    const asDevice = (d, label) => ({ ...d.subscription, label, addedAt: '2026-07-01T00:00:00Z' });

    it('pushes to every device with a deep link to the slot date', async () => {
      await addSubscriber('a@example.com', ['Monday'], ['18:00'], {
        push: [asDevice(phone, 'iPhone'), asDevice(laptop, 'Mac')],
      });
      const { pushes, sent } = stubFetch({
        bookingHandler: () => ({ data: [bookableSlot('18:00')] }),
      });
      const summary = await runCheck(env, { now: NOW, fetchOpts });

      expect(summary).toMatchObject({ emailsSent: 1, pushesSent: 2, errors: 0 });
      expect(sent).toHaveLength(1);
      // Devices are notified in parallel, so arrival order is not fixed.
      expect(pushes.map((p) => p.url).sort()).toEqual([
        'https://fcm.googleapis.com/fcm/send/laptop',
        'https://web.push.apple.com/phone',
      ]);
      const toPhone = pushes.find((p) => p.url === 'https://web.push.apple.com/phone');
      expect(toPhone.headers).toMatchObject({ TTL: '3600', Urgency: 'high' });
      expect(phone.read(toPhone.body)).toEqual({
        title: 'Court free: Mon 6pm',
        body: 'Mon 6 Jul, 18:00 · £12.40',
        url: 'https://bookings.better.org.uk/location/islington-tennis-centre/highbury-tennis/2026-07-06/by-time',
        tag: 'court-alert',
      });
    });

    it('can skip email entirely', async () => {
      await addSubscriber('a@example.com', ['Monday'], ['18:00'], {
        emailAlerts: false,
        push: [asDevice(phone, 'iPhone')],
      });
      const { pushes, sent } = stubFetch({
        bookingHandler: () => ({ data: [bookableSlot('18:00')] }),
      });
      await runCheck(env, { now: NOW, fetchOpts });
      expect(sent).toHaveLength(0);
      expect(pushes).toHaveLength(1);
      expect(await env.PREFERENCES.get('seen:a@example.com')).not.toBeNull();
    });

    it('prunes devices that have gone, emails instead, and turns email back on', async () => {
      await addSubscriber('a@example.com', ['Monday'], ['18:00'], {
        emailAlerts: false,
        push: [asDevice(phone, 'iPhone')],
      });
      const { sent } = stubFetch({
        bookingHandler: () => ({ data: [bookableSlot('18:00')] }),
        pushStatus: () => 410,
      });
      const summary = await runCheck(env, { now: NOW, fetchOpts });
      expect(summary).toMatchObject({ devicesRemoved: 1, emailsSent: 1, errors: 0 });
      expect(sent).toHaveLength(1);
      const record = JSON.parse(await env.PREFERENCES.get('pref:a@example.com'));
      expect(record).toMatchObject({ push: [], emailAlerts: true });
    });

    it('falls back to email when email is off but no push gets through', async () => {
      await addSubscriber('a@example.com', ['Monday'], ['18:00'], {
        emailAlerts: false,
        push: [asDevice(phone, 'iPhone')],
      });
      const { sent } = stubFetch({
        bookingHandler: () => ({ data: [bookableSlot('18:00')] }),
        pushStatus: () => 403,
      });
      const summary = await runCheck(env, { now: NOW, fetchOpts });
      expect(summary).toMatchObject({ emailsSent: 1, pushesSent: 0, errors: 0 });
      expect(sent).toHaveLength(1);
      // A 403 is not proof the device is gone, so it is kept.
      const record = JSON.parse(await env.PREFERENCES.get('pref:a@example.com'));
      expect(record.push).toHaveLength(1);
    });

    it('falls back to email when email is off and push is not configured', async () => {
      delete env.VAPID_PRIVATE_KEY;
      await addSubscriber('a@example.com', ['Monday'], ['18:00'], {
        emailAlerts: false,
        push: [asDevice(phone, 'iPhone')],
      });
      const { sent } = stubFetch({ bookingHandler: () => ({ data: [bookableSlot('18:00')] }) });
      await runCheck(env, { now: NOW, fetchOpts });
      expect(sent).toHaveLength(1);
    });

    it('counts a push alone as delivered when email fails', async () => {
      await addSubscriber('a@example.com', ['Monday'], ['18:00'], {
        push: [asDevice(phone, 'iPhone')],
      });
      stubFetch({ bookingHandler: () => ({ data: [bookableSlot('18:00')] }), sendgridStatus: 500 });
      const summary = await runCheck(env, { now: NOW, fetchOpts });
      expect(summary).toMatchObject({ emailsSent: 0, pushesSent: 1, errors: 0 });
    });

    it('keeps devices on a transient push failure', async () => {
      await addSubscriber('a@example.com', ['Monday'], ['18:00'], {
        push: [asDevice(phone, 'iPhone')],
      });
      stubFetch({
        bookingHandler: () => ({ data: [bookableSlot('18:00')] }),
        pushStatus: () => 503,
      });
      await runCheck(env, { now: NOW, fetchOpts });
      const record = JSON.parse(await env.PREFERENCES.get('pref:a@example.com'));
      expect(record.push).toHaveLength(1);
    });

    it('sends email only when push is not configured on the server', async () => {
      delete env.VAPID_PRIVATE_KEY;
      await addSubscriber('a@example.com', ['Monday'], ['18:00'], {
        push: [asDevice(phone, 'iPhone')],
      });
      const { pushes, sent } = stubFetch({
        bookingHandler: () => ({ data: [bookableSlot('18:00')] }),
      });
      await runCheck(env, { now: NOW, fetchOpts });
      expect(pushes).toHaveLength(0);
      expect(sent).toHaveLength(1);
    });
  });
});
