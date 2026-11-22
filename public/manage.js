import {
  api,
  checkedValues,
  describeChoice,
  renderDayChips,
  renderTimeChips,
  setChecked,
  showStatus,
  takeHashParams,
  wireSelectAll,
} from './common.js';
import {
  currentSubscription,
  deviceId,
  disablePush,
  enablePush,
  isStandalone,
  pushSupport,
} from './push.js';

const $ = (id) => document.getElementById(id);
const status = $('statusMessage');
const form = $('prefsForm');
const toggle = $('toggle');
const saveBtn = $('saveBtn');

// An installed app opens at /manage with no token in the URL, so it keeps its
// own copy in localStorage (iOS gives home-screen apps storage separate from
// Safari's). Only installed apps store it: a shared browser should not.
const TOKEN_KEY = 'manageToken';
const params = takeHashParams();
let token = params.get('token') || readStoredToken();
if (token && isStandalone()) storeToken(token);

function readStoredToken() {
  try {
    return isStandalone() ? localStorage.getItem(TOKEN_KEY) : null;
  } catch {
    return null;
  }
}

function storeToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode or blocked storage: the link in the email still works.
  }
}
let prefs = null;

renderDayChips($('dayChips'));
renderTimeChips($('timeChips'));
wireSelectAll(form);

const isPaused = (p) => p.paused && (!p.pausedUntil || new Date(p.pausedUntil) > new Date());

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/London',
  });
}

function render() {
  const paused = isPaused(prefs);
  $('who').textContent = `For ${prefs.email}`;
  toggle.setAttribute('aria-checked', String(!paused));

  if (!paused) {
    $('stateText').textContent = `On: ${describeChoice(prefs.days, prefs.times)}`;
  } else if (prefs.pausedUntil) {
    $('stateText').textContent = `Paused until ${formatDate(prefs.pausedUntil)}, then back on`;
  } else {
    $('stateText').textContent = 'Off: no alerts until thou turnest them back on';
  }
  $('snoozeBtn').hidden = paused;

  setChecked(form, 'day', prefs.days);
  setChecked(form, 'time', prefs.times);
  saveBtn.disabled = true;
  $('settings').hidden = false;
  renderChannels();
}

const SUPPORT_HINTS = {
  'needs-install':
    'On iPhone or iPad: tap Share, then Add to Home Screen, and open Court Quest from there to turn this on.',
  denied:
    'Notifications are blocked for this site. Allow them in thy browser settings, then try again.',
  unsupported: 'This browser cannot do instant alerts. Chrome, Edge, Firefox and Safari can.',
};

async function renderChannels() {
  $('emailSwitch').setAttribute('aria-checked', String(prefs.emailAlerts));
  $('emailText').textContent = prefs.emailAlerts ? `To ${prefs.email}` : 'Off';

  const support = pushSupport();
  const subscription = await currentSubscription().catch(() => null);
  const myId = subscription ? await deviceId(subscription.endpoint) : null;
  const here = prefs.devices.find((d) => d.id === myId);

  const deviceSwitch = $('deviceSwitch');
  deviceSwitch.disabled = support !== 'ready';
  deviceSwitch.setAttribute('aria-checked', String(Boolean(here)));
  $('deviceText').textContent = here
    ? 'Instant alerts on, straight to the booking page'
    : support === 'ready'
      ? 'Off: turn on for instant alerts'
      : 'Not available here';
  $('deviceHint').hidden = support === 'ready';
  $('deviceHint').textContent = SUPPORT_HINTS[support] || '';

  const others = prefs.devices.filter((d) => d.id !== myId).map((d) => d.label);
  $('otherDevices').hidden = others.length === 0;
  $('otherDevices').textContent = `Also sending to: ${others.join(', ')}`;
  $('testBtn').hidden = prefs.devices.length === 0;
}

$('emailSwitch').addEventListener('click', () =>
  prefs.emailAlerts
    ? update({ emailAlerts: false }, 'Emails off. Alerts go to thy devices only.')
    : update({ emailAlerts: true }, 'Emails back on.'),
);

$('deviceSwitch').addEventListener('click', async () => {
  const deviceSwitch = $('deviceSwitch');
  const turningOn = deviceSwitch.getAttribute('aria-checked') !== 'true';
  const emailWasOff = !prefs.emailAlerts;
  deviceSwitch.disabled = true;
  showStatus(
    status,
    turningOn ? 'Asking thy device for leave...' : 'Removing this device...',
    'pending',
  );
  try {
    const result = turningOn ? await enablePush(token) : await disablePush(token);
    if (result) prefs = result.preferences;
    showStatus(
      status,
      turningOn
        ? 'This device will now buzz the moment a court falls free.'
        : emailWasOff && prefs.emailAlerts
          ? 'This device will no longer get alerts, so emails are back on.'
          : 'This device will no longer get alerts.',
      'success',
    );
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
  renderChannels();
});

$('testBtn').addEventListener('click', async () => {
  $('testBtn').disabled = true;
  try {
    const { sent } = await api('/api/subscription/push/test', { method: 'POST', token });
    showStatus(
      status,
      `Test sent to ${sent} device${sent === 1 ? '' : 's'}. It should arrive within seconds.`,
      'success',
    );
  } catch (err) {
    showStatus(status, err.message, 'error');
  } finally {
    $('testBtn').disabled = false;
  }
});

async function update(changes, message) {
  try {
    ({ preferences: prefs } = await api('/api/subscription', {
      method: 'PATCH',
      token,
      body: changes,
    }));
    render();
    showStatus(status, message, 'success');
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
}

const turnOff = () =>
  update({ paused: true }, 'Alerts off. Flip the switch whenever thou wishest.');
const turnOn = () => update({ paused: false }, 'Alerts back on. The heralds ride again.');
const snooze = () =>
  update({ paused: true, pauseDays: 7 }, 'Paused for a week. Alerts return by themselves.');

toggle.addEventListener('click', () => (isPaused(prefs) ? turnOn() : turnOff()));
$('snoozeBtn').addEventListener('click', snooze);

// Links in alert emails add &action=off or &action=snooze. Ask for one tap
// rather than acting on page load, so mail scanners cannot change anything.
function offerAction(action) {
  const offers = {
    off: ['Turn off all court alerts?', 'Turn off alerts', turnOff],
    snooze: ['Pause court alerts for a week?', 'Pause for a week', snooze],
  };
  const offer = offers[action];
  if (!offer || isPaused(prefs)) return;
  const [question, label, run] = offer;
  $('promptText').textContent = question;
  $('promptBtn').textContent = label;
  $('promptBtn').onclick = async () => {
    $('prompt').hidden = true;
    await run();
  };
  $('prompt').hidden = false;
  $('promptBtn').focus();
}

form.addEventListener('change', () => {
  const days = checkedValues(form, 'day');
  const times = checkedValues(form, 'time');
  // Order-insensitive: the page lists Monday first, the server stores Sunday first.
  const same = (a, b) => a.length === b.length && a.every((v) => b.includes(v));
  const changed = !same(days, prefs.days) || !same(times, prefs.times);
  saveBtn.disabled = !changed || days.length === 0 || times.length === 0;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveBtn.disabled = true;
  await update(
    { days: checkedValues(form, 'day'), times: checkedValues(form, 'time') },
    'Saved. Thy new hours are being watched.',
  );
});

$('deleteBtn').addEventListener('click', async () => {
  try {
    await api('/api/subscription', { method: 'DELETE', token });
    storeToken(null);
    (await currentSubscription().catch(() => null))?.unsubscribe();
    $('settings').hidden = true;
    $('who').textContent = 'Thy details are gone';
    showStatus(status, 'Everything is deleted. Fare thee well, and good tennis.', 'success');
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
});

// ---- Linking a device with an emailed code ----

function showLinkPanel(message) {
  $('who').textContent = isStandalone() ? 'Welcome to Court Quest' : 'Link this device';
  $('settings').hidden = true;
  $('linkPanel').hidden = false;
  if (message) showStatus(status, message, 'pending');
}

let linkEmail = '';

$('linkEmailForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  linkEmail = $('linkEmail').value.trim();
  try {
    await api('/api/link/request', { method: 'POST', body: { email: linkEmail } });
    $('linkEmailForm').hidden = true;
    $('linkCodeForm').hidden = false;
    $('linkCode').focus();
    showStatus(
      status,
      `If ${linkEmail} has alerts, a code is on its way. It lasts 10 minutes.`,
      'success',
    );
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
});

$('linkCodeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { manageToken } = await api('/api/link/verify', {
      method: 'POST',
      body: { email: linkEmail, code: $('linkCode').value },
    });
    token = manageToken;
    if (isStandalone()) storeToken(token);
    $('linkPanel').hidden = true;
    await load();
    showStatus(status, 'Linked. Turn on This device below for instant alerts.', 'success');
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
});

async function load() {
  if (!token) {
    showLinkPanel(
      isStandalone()
        ? 'Link this app to thy alerts to turn on instant notifications.'
        : 'Open the Settings link from an alert email, or link this device with a code.',
    );
    return;
  }
  try {
    ({ preferences: prefs } = await api('/api/subscription', { token }));
    render();
    offerAction(params.get('action'));
  } catch (err) {
    if (/invalid|expired|No alerts/.test(err.message)) {
      // A stale stored token (e.g. after deleting and signing up again).
      storeToken(null);
      token = null;
      showLinkPanel(err.message);
      return;
    }
    $('who').textContent = 'Something went awry';
    showStatus(status, err.message, 'error');
  }
}

load();
