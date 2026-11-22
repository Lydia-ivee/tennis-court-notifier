import { createECDH, generateKeyPairSync } from 'node:crypto';
import ece from 'http_ece';
import { vi } from 'vitest';

// A VAPID key pair for the test server, in the same base64url form as the secrets.
function testVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const b = (s) => Buffer.from(s, 'base64url');
  return {
    publicKey: Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]).toString('base64url'),
    privateKey: jwk.d,
  };
}
const VAPID = testVapidKeys();

// A browser push subscription with real keys, plus a way to read what was sent to it.
export function makeDevice(endpoint = 'https://fcm.googleapis.com/fcm/send/device-1') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  return {
    subscription: {
      endpoint,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    },
    // Decrypt a captured push body exactly as the browser would.
    read(body) {
      const plain = ece.decrypt(Buffer.from(body), {
        version: 'aes128gcm',
        privateKey: ecdh,
        authSecret: auth,
      });
      return JSON.parse(plain.toString());
    },
  };
}

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
    VAPID_PUBLIC_KEY: VAPID.publicKey,
    VAPID_PRIVATE_KEY: VAPID.privateKey,
    ...overrides,
  };
}

// Stub global fetch. SendGrid calls are captured in `sent`; booking API calls
// are answered by `bookingHandler(date)`.
export function stubFetch({
  bookingHandler = () => ({ data: [] }),
  sendgridStatus = 202,
  pushStatus = () => 201,
} = {}) {
  const sent = [];
  const bookingCalls = [];
  const pushes = [];
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
    if (href.startsWith('https://fcm.googleapis.com/') || href.includes('push.apple.com')) {
      pushes.push({ url: href, headers: init.headers, body: init.body });
      return new Response(null, { status: pushStatus(href) });
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { sent, bookingCalls, pushes, fetchMock };
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
