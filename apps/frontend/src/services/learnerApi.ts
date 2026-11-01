const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const LEARNER_AUTH_KEY = 'ekatra_learner_auth';

export interface LearnerSession {
  token: string;
  learner: {
    id: string;
    phone: string;
    name?: string;
    organizationId: string;
  };
}

function getSession(): LearnerSession | null {
  const raw = localStorage.getItem(LEARNER_AUTH_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as LearnerSession;
  } catch {
    return null;
  }
}

function setSession(session: LearnerSession) {
  localStorage.setItem(LEARNER_AUTH_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(LEARNER_AUTH_KEY);
}

async function request<T>(endpoint: string, options: RequestInit = {}, withAuth = true): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');

  if (withAuth) {
    const token = getSession()?.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export const learnerApi = {
  getSession,
  clearSession,

  async exchangeFirebaseOTP(idToken: string, phoneNumber?: string, name?: string) {
    const data = await request<{ success: boolean; token: string; learner: LearnerSession['learner'] }>(
      '/api/learner-auth/verify',
      {
        method: 'POST',
        body: JSON.stringify({
          provider: 'firebase',
          idToken,
          phoneNumber,
          name,
        }),
      },
      false,
    );

    const session: LearnerSession = {
      token: data.token,
      learner: data.learner,
    };
    setSession(session);
    return session;
  },

  async me() {
    return request('/api/learner/profile');
  },

  async getMessages(limit = 60) {
    return request(`/api/learner/messages?limit=${limit}`);
  },

  async sendMessage(text: string) {
    return request('/api/learner/messages', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },
};
