import { renderPreferences, showStatus, takeTokenFromHash } from './common.js';

const status = document.getElementById('statusMessage');
const summary = document.getElementById('summary');
const manageLink = document.getElementById('manageLink');

async function confirm() {
  const token = takeTokenFromHash();
  if (!token) {
    showStatus(status, 'This page needs the link from thy confirmation email.', 'error');
    return;
  }

  showStatus(status, 'Sealing thy quest...', 'pending');
  try {
    // A POST, not a GET, so email link scanners that prefetch URLs cannot
    // confirm on someone's behalf.
    const response = await fetch('/api/subscriptions/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `The castle answered with ${response.status}.`);

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
