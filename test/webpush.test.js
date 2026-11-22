import { createECDH } from 'node:crypto';
import ece from 'http_ece';
import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from '../src/encoding.js';
import { encryptPayload, isAllowedEndpoint, vapidAuthorization } from '../src/webpush.js';

const enc = new TextEncoder();

// RFC 8291 Appendix A: the worked example from the specification.
const rfc = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('RFC 8291 encryption', () => {
  it('reproduces the worked example from the RFC byte for byte', async () => {
    const body = await encryptPayload(
      enc.encode(rfc.plaintext),
      { p256dh: fromBase64Url(rfc.uaPublic), auth: fromBase64Url(rfc.authSecret) },
      {
        serverKeys: {
          publicKey: fromBase64Url(rfc.asPublic),
          privateKey: fromBase64Url(rfc.asPrivate),
        },
        salt: fromBase64Url(rfc.salt),
      },
    );
    expect(toBase64Url(body)).toBe(rfc.body);
  });

  it('can be decrypted by the reference implementation (http_ece)', async () => {
    // A fresh "browser" key pair, as a real subscription would have.
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const message = JSON.stringify({ title: 'Court free: Thu 7pm', url: 'https://example.com' });

    const body = await encryptPayload(enc.encode(message), {
      p256dh: new Uint8Array(browser.getPublicKey()),
      auth,
    });

    const plaintext = ece.decrypt(Buffer.from(body), {
      version: 'aes128gcm',
      privateKey: browser,
      authSecret: Buffer.from(auth),
    });
    expect(plaintext.toString()).toBe(message);
  });

  it('uses a fresh key and salt for every message', async () => {
    const keys = { p256dh: fromBase64Url(rfc.uaPublic), auth: fromBase64Url(rfc.authSecret) };
    const a = await encryptPayload(enc.encode('same'), keys);
    const b = await encryptPayload(enc.encode('same'), keys);
    expect(toBase64Url(a.slice(0, 16))).not.toBe(toBase64Url(b.slice(0, 16)));
    expect(toBase64Url(a.slice(21, 86))).not.toBe(toBase64Url(b.slice(21, 86)));
  });

  it('refuses malformed keys and oversized payloads', async () => {
    const good = { p256dh: fromBase64Url(rfc.uaPublic), auth: fromBase64Url(rfc.authSecret) };
    await expect(
      encryptPayload(enc.encode('x'), { ...good, auth: new Uint8Array(8) }),
    ).rejects.toThrow('Invalid auth secret.');
    await expect(
      encryptPayload(enc.encode('x'), { ...good, p256dh: new Uint8Array(65) }),
    ).rejects.toThrow('Invalid p256dh key.');
    await expect(encryptPayload(new Uint8Array(4000), good)).rejects.toThrow('Payload too large.');
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs a JWT that verifies with the public key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const publicKey = toBase64Url(
      new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    );
    const vapid = { publicKey, privateKey: jwk.d, subject: 'https://courts.example.com' };
    const now = Date.UTC(2026, 10, 22, 12);

    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, now);
    const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(k).toBe(publicKey);

    const [h, c, s] = jwt.split('.');
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      fromBase64Url(s),
      enc.encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);

    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(c)));
    expect(claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'https://courts.example.com',
    });
  });
});

describe('endpoint allowlist', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGh2abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('allows %s', (url) => expect(isAllowedEndpoint(url)).toBe(true));

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com.example/x',
    'https://notfcm.googleapis.com@169.254.169.254/latest',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://localhost/x',
    'not a url',
  ])('blocks %s', (url) => expect(isAllowedEndpoint(url)).toBe(false));
});
