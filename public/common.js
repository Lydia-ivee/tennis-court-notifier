// Shared helpers for the sign-up, confirm and settings pages.

export const DAYS = [
  ['Monday', 'Mon'],
  ['Tuesday', 'Tue'],
  ['Wednesday', 'Wed'],
  ['Thursday', 'Thu'],
  ['Friday', 'Fri'],
  ['Saturday', 'Sat'],
  ['Sunday', 'Sun'],
];

const hours = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(2, '0')}:00`);

export const TIME_GROUPS = [
  { label: 'Morning', times: hours(7, 11) },
  { label: 'Afternoon', times: hours(12, 16) },
  { label: 'Evening', times: hours(17, 22) },
];

// "07:00" -> "7am", "12:00" -> "12pm", "18:00" -> "6pm"
export function timeLabel(time) {
  const h = Number(time.slice(0, 2));
  const suffix = h < 12 ? 'am' : 'pm';
  return `${h % 12 || 12}${suffix}`;
}

const shortDay = (day) => DAYS.find(([d]) => d === day)?.[1] || day;

function chip(name, value, label) {
  const wrapper = document.createElement('label');
  wrapper.className = 'chip';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = name;
  input.value = value;
  const span = document.createElement('span');
  span.textContent = label;
  wrapper.append(input, span);
  return wrapper;
}

export function renderDayChips(container) {
  container.replaceChildren(...DAYS.map(([day, short]) => chip('day', day, short)));
}

export function renderTimeChips(container) {
  container.replaceChildren(
    ...TIME_GROUPS.map(({ label, times }) => {
      const group = document.createElement('div');
      group.className = 'time-group';
      const heading = document.createElement('p');
      heading.className = 'time-group__label';
      heading.textContent = label;
      const chips = document.createElement('div');
      chips.className = 'chips chips--time';
      chips.append(...times.map((t) => chip('time', t, timeLabel(t))));
      group.append(heading, chips);
      return group;
    }),
  );
}

export function checkedValues(root, name) {
  return [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((el) => el.value);
}

export function setChecked(root, name, values) {
  root.querySelectorAll(`input[name="${name}"]`).forEach((el) => {
    el.checked = values.includes(el.value);
  });
}

// Wire the "All / None" buttons inside `root`.
export function wireSelectAll(root) {
  root.querySelectorAll('.select-all').forEach((btn) => {
    btn.addEventListener('click', () => {
      const boxes = [...root.querySelectorAll(`input[name="${btn.dataset.group}"]`)];
      const turnOn = boxes.some((b) => !b.checked);
      boxes.forEach((b) => {
        b.checked = turnOn;
      });
      root.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

// "Mon, Sat · 7am, 6pm". Runs of three or more collapse: "Mon to Fri".
export function describeChoice(days, times) {
  const collapse = (items, all, label) => {
    const idx = items.map((i) => all.indexOf(i)).sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < idx.length; i++) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
      if (j - i >= 2) parts.push(`${label(all[idx[i]])} to ${label(all[idx[j]])}`);
      else for (let k = i; k <= j; k++) parts.push(label(all[idx[k]]));
      i = j;
    }
    return parts.join(', ');
  };
  const allDays = DAYS.map(([d]) => d);
  const allTimes = TIME_GROUPS.flatMap((g) => g.times);
  const dayText = days.length === 7 ? 'Every day' : collapse(days, allDays, shortDay);
  const timeText =
    times.length === allTimes.length ? 'any hour' : collapse(times, allTimes, timeLabel);
  return `${dayText} · ${timeText}`;
}

// Tokens arrive in the URL fragment (#token=...&action=...) so they never
// reach the server logs. By default they are then stripped from the address
// bar; the settings page keeps them (see manage.js for why).
export function takeHashParams({ strip = true } = {}) {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (params.get('token') && strip) history.replaceState(null, '', window.location.pathname);
  return params;
}

export function showStatus(el, message, type) {
  el.textContent = message;
  el.className = `status show ${type}`;
}

export function clearStatus(el) {
  el.className = 'status';
}

// JSON fetch that throws the API's own error message on failure.
export async function api(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The castle answered with ${response.status}.`);
  return data;
}

// "12 minutes ago", "2 hours ago"
export function timeAgo(iso, now = Date.now()) {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const h = Math.round(minutes / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}

// Render preferences with textContent only: no HTML injection possible.
export function renderPreferences(el, { email, days, times }) {
  el.replaceChildren();
  const rows = [
    ['Address', email],
    ['Watching', describeChoice(days, times)],
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
