import { vi } from 'vitest';

// In-memory stand-in for a Workers KV namespace (get/put/delete/list).
export function createKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key).value : null;
    },
    async put(key, value, opts = {}) {
      store.set(key, { value, ttl: opts.expirationTtl });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '', cursor } = {}) {
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      // Two keys per page so pagination is exercised.
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + 2);
      const done = start + 2 >= all.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: done,
        cursor: done ? undefined : String(start + 2),
      };
    },
  };
}

export function createEnv(overrides = {}) {
  return {
    PREFERENCES: createKV(),
    ASSETS: { fetch: async () => new Response('static', { status: 200 }) },
    SENDGRID_API_KEY: 'SG.test',
    FROM_EMAIL: 'alerts@example.com',
    TOKEN_SECRET: 'test-secret-that-is-definitely-long-enough-123',
    PUBLIC_URL: 'https://courts.example.com',
    ...overrides,
  };
}

// Stub global fetch. SendGrid calls are captured in `sent`; booking API calls
// are answered by `bookingHandler(date)`.
export function stubFetch({ bookingHandler = () => ({ data: [] }), sendgridStatus = 202 } = {}) {
  const sent = [];
  const bookingCalls = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith('https://api.sendgrid.com/')) {
      sent.push(JSON.parse(init.body));
      return new Response(sendgridStatus < 300 ? null : 'nope', { status: sendgridStatus });
    }
    if (href.includes('/v2/times')) {
      const date = new URL(href).searchParams.get('date');
      bookingCalls.push(date);
      const result = await bookingHandler(date);
      if (result instanceof Response) return result;
      return Response.json(result);
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { sent, bookingCalls, fetchMock };
}

export function apiRequest(path, { method = 'GET', body, headers = {} } = {}) {
  return new Request(`https://courts.example.com${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// Pull the token out of a "...#token=XYZ" or "...?token=XYZ" link in email text.
export function tokenFromEmail(email, marker) {
  const text = email.content.find((c) => c.type === 'text/plain').value;
  const line = text.split('\n').find((l) => l.includes(marker));
  return decodeURIComponent(line.split('token=')[1].trim());
}

export function bookableSlot(start, overrides = {}) {
  const [h] = start.split(':').map(Number);
  return {
    name: 'Court 1',
    spaces: 1,
    starts_at: { format_24_hour: start },
    ends_at: { format_24_hour: `${String(h + 1).padStart(2, '0')}:00` },
    price: { formatted_amount: '£12.40' },
    action_to_show: { status: 'BOOK' },
    ...overrides,
  };
}
