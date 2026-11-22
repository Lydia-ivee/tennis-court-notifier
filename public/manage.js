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

const $ = (id) => document.getElementById(id);
const status = $('statusMessage');
const form = $('prefsForm');
const toggle = $('toggle');
const saveBtn = $('saveBtn');

const params = takeHashParams();
const token = params.get('token');
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
    $('stateText').textContent = 'Off: no emails until thou turnest them back on';
  }
  $('snoozeBtn').hidden = paused;

  setChecked(form, 'day', prefs.days);
  setChecked(form, 'time', prefs.times);
  saveBtn.disabled = true;
  $('settings').hidden = false;
}

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
    $('settings').hidden = true;
    $('who').textContent = 'Thy details are gone';
    showStatus(status, 'Everything is deleted. Fare thee well, and good tennis.', 'success');
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
});

async function load() {
  if (!token) {
    $('who').textContent = 'No link found';
    showStatus(status, 'This page needs the Settings link from one of thy alert emails.', 'error');
    return;
  }
  try {
    ({ preferences: prefs } = await api('/api/subscription', { token }));
    render();
    offerAction(params.get('action'));
  } catch (err) {
    $('who').textContent = 'Something went awry';
    showStatus(status, err.message, 'error');
  }
}

load();
