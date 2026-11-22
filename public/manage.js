import { renderPreferences, showStatus, takeTokenFromHash } from './common.js';

const status = document.getElementById('statusMessage');
const summary = document.getElementById('summary');
const actions = document.getElementById('actions');
const stopBtn = document.getElementById('stopBtn');

const token = takeTokenFromHash();

async function api(method) {
  const response = await fetch('/api/subscription', {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The castle answered with ${response.status}.`);
  return data;
}

async function load() {
  if (!token) {
    showStatus(status, 'This page needs the link from one of thy alert emails.', 'error');
    return;
  }
  try {
    const { preferences } = await api('GET');
    renderPreferences(summary, preferences);
    actions.hidden = false;
    status.className = 'status';
  } catch (err) {
    showStatus(status, err.message, 'error');
  }
}

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  try {
    await api('DELETE');
    summary.hidden = true;
    actions.hidden = true;
    showStatus(status, 'Thy alerts are stopped. Fare thee well, and good tennis.', 'success');
  } catch (err) {
    stopBtn.disabled = false;
    showStatus(status, err.message, 'error');
  }
});

load();
