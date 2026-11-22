import { api, renderPreferences, showStatus, takeHashParams } from './common.js';

const status = document.getElementById('statusMessage');
const summary = document.getElementById('summary');
const manageLink = document.getElementById('manageLink');

async function confirm() {
  const token = takeHashParams().get('token');
  if (!token) {
    showStatus(status, 'This page needs the link from thy confirmation email.', 'error');
    return;
  }

  showStatus(status, 'Sealing thy quest...', 'pending');
  try {
    // A POST, not a GET, so email link scanners that prefetch URLs cannot
    // confirm on someone's behalf.
    const data = await api('/api/subscriptions/confirm', { method: 'POST', body: { token } });
    showStatus(
      status,
      'Huzzah! Thy quest has begun. We shall send word when a court falls free.',
      'success',
    );
    renderPreferences(summary, data.preferences);
    manageLink.href = `/manage#token=${data.manageToken}`;
    manageLink.hidden = false;
  } catch (err) {
    showStatus(status, `Alas. ${err.message}`, 'error');
  }
}

confirm();
