const BASE = window.location.origin;
let JWT = localStorage.getItem('ekatra_admin_jwt') || '';

function api(path, opts = {}) {
  return fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(JWT ? { Authorization: 'Bearer ' + JWT } : {}) },
    ...opts,
  }).then(async (r) => {
    const body = await r.json().catch(() => ({ error: 'Non-JSON response' }));
    if (!r.ok) {
      throw Object.assign(new Error(body.error || 'Request failed'), { status: r.status, body });
    }
    return body;
  });
}

function show(id, data, isError = false) {
  const el = document.getElementById(id);
  el.className = 'output visible ' + (isError ? 'status-err' : 'status-ok');
  el.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

async function login() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';

  if (!email || !password) {
    errEl.textContent = 'Email and password required';
    errEl.style.display = 'block';
    return;
  }

  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    JWT = res.token;
    localStorage.setItem('ekatra_admin_jwt', JWT);
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
  } catch (e) {
    errEl.textContent = e.message || 'Login failed';
    errEl.style.display = 'block';
  }
}

function logout() {
  JWT = '';
  localStorage.removeItem('ekatra_admin_jwt');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-screen').classList.add('hidden');
}

async function getState() {
  const id = document.getElementById('state-learner-id').value.trim();
  if (!id) return show('state-output', 'Enter a learner ID', true);
  try {
    const res = await api(`/api/admin/learners/${encodeURIComponent(id)}/state`);
    show('state-output', res);
  } catch (e) {
    show('state-output', e.body || e.message, true);
  }
}

async function simulate() {
  const phone = document.getElementById('sim-phone').value.trim();
  const payload = document.getElementById('sim-payload').value.trim();
  const type = document.getElementById('sim-type').value;
  if (!phone || !payload) return show('sim-output', 'Phone and payload required', true);
  try {
    const res = await api('/api/admin/simulate', {
      method: 'POST',
      body: JSON.stringify({ phone, buttonPayload: payload, messageType: type }),
    });
    show('sim-output', res);
  } catch (e) {
    show('sim-output', e.body || e.message, true);
  }
}

async function sendMsg() {
  const id = document.getElementById('send-learner-id').value.trim();
  const type = document.getElementById('send-type').value;
  const content = document.getElementById('send-content').value.trim();
  if (!id || !content) return show('send-output', 'ID and content required', true);
  try {
    const res = await api(`/api/admin/learners/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      body: JSON.stringify({ type, content }),
    });
    show('send-output', res);
  } catch (e) {
    show('send-output', e.body || e.message, true);
  }
}

async function resetLearner() {
  const id = document.getElementById('reset-learner-id').value.trim();
  const courseId = document.getElementById('reset-course-id').value.trim();
  if (!id) return show('reset-output', 'Enter a learner ID', true);
  if (!window.confirm(`Reset learner ${id}? This clears all FSM state and progress and cannot be undone.`)) return;
  try {
    const body = courseId ? { courseId } : {};
    const res = await api(`/api/admin/learners/${encodeURIComponent(id)}/reset`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    show('reset-output', res);
  } catch (e) {
    show('reset-output', e.body || e.message, true);
  }
}

async function checkHealth() {
  try {
    const res = await api('/health/ready');
    show('health-output', res);
  } catch (e) {
    show('health-output', e.body || e.message, true);
  }
}

function bindEvents() {
  document.getElementById('login-btn').addEventListener('click', login);
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('get-state-btn').addEventListener('click', getState);
  document.getElementById('simulate-btn').addEventListener('click', simulate);
  document.getElementById('send-msg-btn').addEventListener('click', sendMsg);
  document.getElementById('reset-learner-btn').addEventListener('click', resetLearner);
  document.getElementById('check-health-btn').addEventListener('click', checkHealth);

  document.getElementById('login-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });
}

function initAuthState() {
  if (JWT) {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  initAuthState();
});
