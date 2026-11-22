// Web Push, built on WebCrypto with no dependencies.
//
//   RFC 8291  Message Encryption for Web Push (aes128gcm, ECDH + HKDF)
//   RFC 8188  Encrypted Content-Encoding for HTTP (the aes128gcm record format)
//   RFC 8292  VAPID: proving to the push service which server sent a message
//
// Browsers hand us a subscription: an endpoint URL on their push service plus
// two keys. We encrypt the payload so only that browser can read it, sign a
// short-lived JWT with our VAPID key, and POST the result to the endpoint.

import { concatBytes, encoder, fromBase64Url, toBase64Url } from './encoding.js';

const RECORD_SIZE = 4096;

// Push services we are willing to POST to. The endpoint comes from the
// browser, so without this list the Worker could be pointed at any URL.
export const PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge on Android, most Chromium browsers
  'updates.push.services.mozilla.com', // Firefox
  'push.apple.com', // Safari, iOS and iPadOS home-screen apps (web.push.apple.com)
  'notify.windows.com', // Edge on Windows (wns2-*.notify.windows.com)
];

export function isAllowedEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

// ---- HKDF (RFC 5869) with a single 32-byte block, which is all RFC 8291 needs ----

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concatBytes(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

// ---- P-256 key helpers ----

// An uncompressed P-256 public key is 0x04 || X (32 bytes) || Y (32 bytes).
function jwkFromRaw(publicKey, privateKey) {
  if (publicKey.length !== 65 || publicKey[0] !== 4) {
    throw new Error('Expected an uncompressed P-256 public key.');
  }
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: toBase64Url(publicKey.slice(1, 33)),
    y: toBase64Url(publicKey.slice(33, 65)),
    ext: true,
  };
  if (privateKey) jwk.d = toBase64Url(privateKey);
  return jwk;
}

async function importEcdhKeyPair({ publicKey, privateKey }) {
  return {
    publicKey,
    privateKey: await crypto.subtle.importKey(
      'jwk',
      jwkFromRaw(publicKey, privateKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    ),
  };
}

async function generateEcdhKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey, privateKey: pair.privateKey };
}

// ---- RFC 8291 encryption ----

/**
 * Encrypt `plaintext` for one browser subscription.
 *
 * @param {Uint8Array} plaintext
 * @param {{ p256dh: Uint8Array, auth: Uint8Array }} subscriberKeys
 * @param {{ serverKeys?: { publicKey: Uint8Array, privateKey: Uint8Array }, salt?: Uint8Array }} [fixed]
 *   Only for tests: pin the ephemeral key pair and salt so the output can be
 *   compared with the RFC 8291 worked example. Production always uses fresh ones.
 * @returns {Promise<Uint8Array>} the aes128gcm body, header included
 */
export async function encryptPayload(plaintext, { p256dh, auth }, fixed = {}) {
  if (p256dh.length !== 65 || p256dh[0] !== 4) throw new Error('Invalid p256dh key.');
  if (auth.length !== 16) throw new Error('Invalid auth secret.');
  // One record only: payload + delimiter + 16-byte tag must fit in RECORD_SIZE.
  if (plaintext.length > RECORD_SIZE - 17 - 86) throw new Error('Payload too large.');

  const server = fixed.serverKeys
    ? await importEcdhKeyPair(fixed.serverKeys)
    : await generateEcdhKeyPair();
  const salt = fixed.salt || crypto.getRandomValues(new Uint8Array(16));

  const subscriberPublic = await crypto.subtle.importKey(
    'jwk',
    jwkFromRaw(p256dh),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: subscriberPublic },
      server.privateKey,
      256,
    ),
  );

  // Mix in the browser's auth secret and both public keys (RFC 8291 section 3.4).
  const keyInfo = concatBytes(encoder.encode('WebPush: info\0'), p256dh, server.publicKey);
  const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);

  // Derive the content key and nonce (RFC 8188 section 2.2 and 2.3).
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  // 0x02 marks the last (and only) record.
  const record = concatBytes(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record),
  );

  // Header: salt (16) || record size (uint32 BE) || key id length (1) || key id.
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = 65;
  header.set(server.publicKey, 21);

  return concatBytes(header, ciphertext);
}

// ---- RFC 8292 VAPID ----

async function importVapidSigningKey(publicKeyB64, privateKeyB64) {
  return crypto.subtle.importKey(
    'jwk',
    jwkFromRaw(fromBase64Url(publicKeyB64), fromBase64Url(privateKeyB64)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * Build the VAPID Authorization header value for one push service origin.
 * WebCrypto's ECDSA output is already the raw r || s form that JWS ES256 wants.
 */
export async function vapidAuthorization(endpoint, vapid, now = Date.now()) {
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        // Push services reject tokens valid for more than 24 hours.
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  const key = await importVapidSigningKey(vapid.publicKey, vapid.privateKey);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned)),
  );
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${vapid.publicKey}`;
}

/**
 * Send one notification. Never throws.
 *
 * @returns {Promise<{ ok: boolean, gone: boolean, status: number | null }>}
 *   `gone` means the browser unsubscribed (404 or 410): delete the subscription.
 */
export async function sendPush(subscription, payload, vapid, { ttlSeconds = 3600 } = {}) {
  try {
    if (!isAllowedEndpoint(subscription.endpoint)) {
      return { ok: false, gone: true, status: null };
    }
    const body = await encryptPayload(encoder.encode(JSON.stringify(payload)), {
      p256dh: fromBase64Url(subscription.keys.p256dh),
      auth: fromBase64Url(subscription.keys.auth),
    });
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(subscription.endpoint, vapid),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        // Slots go fast: an alert that cannot be delivered within the hour is useless.
        TTL: String(ttlSeconds),
        Urgency: 'high',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
  } catch {
    return { ok: false, gone: false, status: null };
  }
}

// Read VAPID settings from the environment, or null if push is not configured.
export function vapidFromEnv(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.PUBLIC_URL) return null;
  // An https: subject is allowed by RFC 8292 and keeps a personal address out of every request.
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || env.PUBLIC_URL,
  };
}
