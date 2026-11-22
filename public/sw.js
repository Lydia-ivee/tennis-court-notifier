// Service worker: shows court alerts and opens the booking page when tapped.
// No caching on purpose: the pages are tiny and stale copies would only confuse.

const BOOKING_ORIGIN = 'https://bookings.better.org.uk';
const BOOKING_FALLBACK = `${BOOKING_ORIGIN}/location/islington-tennis-centre/highbury-tennis`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Only ever open the booking site, whatever the payload says.
function safeBookingUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === BOOKING_ORIGIN ? parsed.href : BOOKING_FALLBACK;
  } catch {
    return BOOKING_FALLBACK;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Unreadable payload: still show something, as browsers require.
  }
  const title = data.title || 'A court falls free';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || 'Tap to see the booking page.',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag || 'court-alert',
      // Buzz again even if an older alert is still on screen.
      renotify: true,
      data: { url: safeBookingUrl(data.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(safeBookingUrl(event.notification.data?.url)));
});
