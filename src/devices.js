// Push devices live on the subscriber record as `push: [{ endpoint, keys, label, addedAt }]`.

import { PUSH, keys } from './config.js';
import { encoder, toBase64Url } from './encoding.js';
import { log, maskEmail } from './http.js';

// A short, stable id for a device, so endpoints (capability URLs) never need
// to leave the server. The browser computes the same hash of its own endpoint.
export async function deviceId(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(endpoint));
  return toBase64Url(new Uint8Array(digest)).slice(0, 16);
}

// A coarse label for the settings page ("iPhone", "Mac"). Nothing finer is kept.
export function deviceLabel(userAgent = '') {
  const ua = userAgent.toLowerCase();
  if (ua.includes('iphone')) return 'iPhone';
  if (ua.includes('ipad')) return 'iPad';
  if (ua.includes('android')) return 'Android';
  if (ua.includes('mac os')) return 'Mac';
  if (ua.includes('windows')) return 'Windows';
  if (ua.includes('linux') || ua.includes('cros')) return 'Computer';
  return 'Browser';
}

// Add or refresh a device, keeping at most PUSH.maxDevices (newest win).
export function upsertDevice(devices = [], device) {
  const others = devices.filter((d) => d.endpoint !== device.endpoint);
  return [...others, device].slice(-PUSH.maxDevices);
}

// Never leave someone with no way of hearing about courts: if the last device
// goes while email is off, email comes back on.
export function withoutDevices(record, endpoints) {
  const push = (record.push || []).filter((d) => !endpoints.includes(d.endpoint));
  const emailAlerts = push.length === 0 ? true : record.emailAlerts !== false;
  return { ...record, push, emailAlerts };
}

// Remove devices whose push service said they are gone. Re-reads the record
// first so a settings change made during the run is not overwritten.
export async function pruneDevices(env, email, endpoints) {
  if (endpoints.length === 0) return 0;
  const key = keys.subscriber(email);
  const stored = await env.PREFERENCES.get(key);
  if (!stored) return 0;
  const record = JSON.parse(stored);
  const next = withoutDevices(record, endpoints);
  await env.PREFERENCES.put(key, JSON.stringify(next));
  const removed = (record.push || []).length - next.push.length;
  log('push_devices_pruned', { to: maskEmail(email), removed });
  return removed;
}
