// Browser side of push alerts: service worker, permission and subscription.

import { api } from './common.js';

const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/**
 * What this browser can do right now:
 *   'ready'         push works here
 *   'needs-install' iPhone or iPad: push only works from a home-screen app
 *   'denied'        the person blocked notifications for this site
 *   'unsupported'   this browser has no Web Push
 */
export function pushSupport() {
  const hasPush =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!hasPush) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ready';
}

// The same short id the server derives from an endpoint (see src/devices.js).
export async function deviceId(endpoint) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)),
  );
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16);
}

function keyBytes(base64url) {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(buffer, bytes) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  return a.length === bytes.length && a.every((b, i) => b === bytes[i]);
}

async function registration() {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

// This browser's current subscription, or null.
export async function currentSubscription() {
  if (pushSupport() !== 'ready') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

// Ask permission, subscribe, and register the device with the server.
export async function enablePush(token) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notifications were not allowed. Check thy browser settings for this site.');
  }
  const { publicKey } = await api('/api/push/key');
  const serverKey = keyBytes(publicKey);
  const reg = await registration();

  // A subscription made under an old server key is rejected by push services
  // for ever, so replace it rather than reuse it.
  let subscription = await reg.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options?.applicationServerKey, serverKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ||= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: serverKey,
  });
  return api('/api/subscription/push', {
    method: 'POST',
    token,
    body: { subscription: subscription.toJSON() },
  });
}

// Forget this device on the server, then unsubscribe the browser.
export async function disablePush(token) {
  const subscription = await currentSubscription();
  if (!subscription) return null;
  try {
    return await api('/api/subscription/push', {
      method: 'DELETE',
      token,
      body: { id: await deviceId(subscription.endpoint) },
    });
  } finally {
    // Unsubscribe locally even if the server had already forgotten this device.
    await subscription.unsubscribe();
  }
}
