import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../src/check.js';
import { bookableSlot, createEnv, stubFetch } from './helpers.js';

// Monday 6 July 2026, midday in London.
const NOW = new Date('2026-07-06T11:00:00Z');

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
  it('emails each subscriber only the slots that match them', async () => {
    await addSubscriber('a@example.com', ['Monday'], ['07:00']);
    await addSubscriber('b@example.com', ['Monday'], ['18:00']);
    const { sent } = stubFetch({
      bookingHandler: () => ({ data: [bookableSlot('07:00'), bookableSlot('09:00')] }),
    });
    const summary = await runCheck(env, { now: NOW });
    expect(summary.emailsSent).toBe(1);
    expect(sent[0].personalizations[0].to[0].email).toBe('a@example.com');
    expect(sent[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('does nothing and calls nobody when there are no subscribers', async () => {
    const { fetchMock } = stubFetch();
    const summary = await runCheck(env, { now: NOW });
    expect(summary.subscribers).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only asks the booking site about weekdays someone wants', async () => {
    await addSubscriber('a@example.com', ['Monday', 'Wednesday'], ['07:00']);
    const { bookingCalls } = stubFetch();
    await runCheck(env, { now: NOW });
    expect(bookingCalls).toEqual(['2026-07-06', '2026-07-08']);
  });

  it('keeps going when the booking site fails for one date', async () => {
    await addSubscriber('a@example.com', ['Monday', 'Tuesday'], ['07:00']);
    const { sent } = stubFetch({
      bookingHandler: (date) =>
        date === '2026-07-06'
          ? new Response('', { status: 503 })
          : { data: [bookableSlot('07:00')] },
    });
    const summary = await runCheck(env, { now: NOW });
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
    const summary = await runCheck(env, { now: NOW });
    expect(summary.subscribers).toBe(5);
    expect(sent).toHaveLength(5);
  });
});
