import {
  api,
  checkedValues,
  clearStatus,
  describeChoice,
  renderDayChips,
  renderTimeChips,
  setChecked,
  showStatus,
  timeAgo,
  wireSelectAll,
} from './common.js';

const form = document.getElementById('preferencesForm');
const emailInput = document.getElementById('email');
const submitBtn = document.getElementById('submitBtn');
const btnLabel = submitBtn.querySelector('.btn-label');
const status = document.getElementById('statusMessage');
const summary = document.getElementById('choiceSummary');

renderDayChips(document.getElementById('dayChips'));
renderTimeChips(document.getElementById('timeChips'));
wireSelectAll(form);

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const PRESETS = {
  'weekday-evenings': { days: WEEKDAYS, times: ['17:00', '18:00', '19:00', '20:00', '21:00'] },
  'weekend-mornings': {
    days: ['Saturday', 'Sunday'],
    times: ['07:00', '08:00', '09:00', '10:00', '11:00'],
  },
  any: { all: true },
};

document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = PRESETS[btn.dataset.preset];
    if (preset.all) {
      form.querySelectorAll('input[type="checkbox"]').forEach((b) => {
        b.checked = true;
      });
    } else {
      setChecked(form, 'day', preset.days);
      setChecked(form, 'time', preset.times);
    }
    updateSummary();
  });
});

function updateSummary() {
  const days = checkedValues(form, 'day');
  const times = checkedValues(form, 'time');
  if (days.length === 0 && times.length === 0) {
    summary.textContent = 'Nothing chosen yet';
  } else if (days.length === 0 || times.length === 0) {
    summary.textContent = days.length ? 'Now choose some hours' : 'Now choose some days';
  } else {
    summary.textContent = `Watching: ${describeChoice(days, times)}`;
  }
}
form.addEventListener('change', updateSummary);

// "Last checked 12 minutes ago · 5 open slots" makes the service feel alive.
async function showLastChecked() {
  try {
    const { checkedAt, openSlots } = await api('/api/status');
    if (!checkedAt) return;
    const el = document.getElementById('lastChecked');
    const slots =
      typeof openSlots === 'number'
        ? ` · ${openSlots} open slot${openSlots === 1 ? '' : 's'} on watched days`
        : '';
    el.textContent = `Courts last checked ${timeAgo(checkedAt)}${slots}`;
    el.hidden = false;
  } catch {
    // Purely decorative: stay hidden if the status call fails.
  }
}
showLastChecked();

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const email = emailInput.value.trim();
  const days = checkedValues(form, 'day');
  const times = checkedValues(form, 'time');

  // Friendly checks first. The server validates everything again.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showStatus(status, 'A herald needs a valid address to reach thee.', 'error');
    emailInput.focus();
    return;
  }
  if (days.length === 0) {
    showStatus(status, 'Choose at least one day for thy quest.', 'error');
    return;
  }
  if (times.length === 0) {
    showStatus(status, 'Choose at least one hour of play.', 'error');
    return;
  }

  submitBtn.disabled = true;
  btnLabel.textContent = 'Dispatching raven...';
  showStatus(status, 'Thy request rides to the castle...', 'pending');

  try {
    await api('/api/subscriptions', { method: 'POST', body: { email, days, times } });
    showStatus(
      status,
      `A raven flies to ${email}. Open the letter and confirm to begin thy quest.`,
      'success',
    );
    form.reset();
    updateSummary();
  } catch (err) {
    showStatus(status, `Alas, thy request could not reach the castle. ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
    btnLabel.textContent = 'Start Quest';
  }
});

// Clear an error the moment the knight starts fixing things
form.addEventListener('input', () => {
  if (status.classList.contains('error')) clearStatus(status);
});
