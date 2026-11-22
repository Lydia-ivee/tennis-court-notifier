// Shared helpers for the confirm and manage pages.

// Tokens arrive in the URL fragment (#token=...) so they never reach the server
// logs. Read it, then strip it from the address bar and history.
export function takeTokenFromHash() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token) history.replaceState(null, '', window.location.pathname);
  return token;
}

export function showStatus(el, message, type) {
  el.textContent = message;
  el.className = `status show ${type}`;
}

const SHORT_DAYS = {
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
  Sunday: 'Sun',
};

// Render preferences with textContent only: no HTML injection possible.
export function renderPreferences(el, { email, days, times }) {
  el.replaceChildren();
  const rows = [
    ['Address', email],
    ['Days', days.map((d) => SHORT_DAYS[d] || d).join(', ')],
    ['Hours', times.join(', ')],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    el.append(dt, dd);
  }
  el.hidden = false;
}
