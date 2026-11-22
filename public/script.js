const form = document.getElementById('preferencesForm');
const emailInput = document.getElementById('email');
const submitBtn = document.getElementById('submitBtn');
const btnLabel = submitBtn.querySelector('.btn-label');
const status = document.getElementById('statusMessage');

const API_ENDPOINT = '/api/subscriptions';

function showStatus(message, type) {
  status.textContent = message;
  status.className = `status show ${type}`;
}

function clearStatus() {
  status.className = 'status';
}

function checkedValues(name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((el) => el.value);
}

// "All / None" toggles per group
document.querySelectorAll('.select-all').forEach((btn) => {
  btn.addEventListener('click', () => {
    const boxes = [...form.querySelectorAll(`input[name="${btn.dataset.group}"]`)];
    const turnOn = boxes.some((b) => !b.checked);
    boxes.forEach((b) => {
      b.checked = turnOn;
    });
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const email = emailInput.value.trim();
  const days = checkedValues('day');
  const times = checkedValues('time');

  // Friendly checks first. The server validates everything again.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showStatus('A herald needs a valid address to reach thee.', 'error');
    emailInput.focus();
    return;
  }
  if (days.length === 0) {
    showStatus('Choose at least one day for thy quest.', 'error');
    return;
  }
  if (times.length === 0) {
    showStatus('Choose at least one hour of play.', 'error');
    return;
  }

  submitBtn.disabled = true;
  btnLabel.textContent = 'Dispatching raven...';
  showStatus('Thy request rides to the castle...', 'pending');

  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, days, times }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `The castle answered with ${response.status}.`);
    }

    showStatus(
      `A raven flies to ${email}. Open the letter and confirm to begin thy quest.`,
      'success',
    );
    form.reset();
  } catch (err) {
    showStatus(`Alas, thy request could not reach the castle. ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
    btnLabel.textContent = 'Start Quest';
  }
});

// Clear an error the moment the knight starts fixing things
form.addEventListener('input', () => {
  if (status.classList.contains('error')) clearStatus();
});
