// Stateless signed tokens (HMAC-SHA256), used for confirmation and manage links.
//
// A token is `base64url(payload).base64url(signature)`. The payload carries a
// `purpose` so a token minted for one job cannot be replayed for another.
// Nothing is stored in KV, so there is no token table to leak or clean up.

import { decoder, encoder, fromBase64Url, toBase64Url } from './encoding.js';

async function hmacKey(secret) {
  if (!secret || secret.length < 32) {
    throw new Error('TOKEN_SECRET must be set and at least 32 characters long.');
  }
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signToken(payload, secret) {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

// Returns the payload if the token is genuine, unexpired and for `purpose`,
// otherwise null. crypto.subtle.verify compares in constant time.
export async function verifyToken(token, purpose, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, fromBase64Url(sig), encoder.encode(body));
    if (!valid) return null;

    const payload = JSON.parse(decoder.decode(fromBase64Url(body)));
    if (payload.purpose !== purpose) return null;
    if (payload.exp && now > payload.exp * 1000) return null;
    return payload;
  } catch (err) {
    if (err.message.startsWith('TOKEN_SECRET')) throw err;
    return null;
  }
}

export function confirmToken({ email, days, times }, secret, ttlSeconds, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  return signToken({ purpose: 'confirm', email, days, times, exp }, secret);
}

// Manage tokens do not expire, so every alert email can carry a working
// unsubscribe link. Rotating TOKEN_SECRET invalidates all of them at once.
export function manageToken(email, secret) {
  return signToken({ purpose: 'manage', email: email.toLowerCase() }, secret);
}
