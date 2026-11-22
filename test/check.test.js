import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../src/check.js';
import { bookableSlot, createEnv, stubFetch } from './helpers.js';

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

async function addSubscriber(email, days, times) {
  await env.PREFERENCES.put(`pref:${email}`, JSON.stringify({ email, days, times }));
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
});
