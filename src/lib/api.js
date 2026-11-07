// Thin fetch wrapper for the same-origin /api backend.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function apiRequest(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('Network error — check your connection and try again.', 0);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status);
  return data;
}

async function download(path, token) {
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let message = `Download failed (${res.status}).`;
    try { message = (await res.json()).error || message; } catch { /* not JSON */ }
    throw new ApiError(message, res.status);
  }
  const blob = await res.blob();
  const match = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match?.[1] || 'export.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Returns an api() bound to a token; calls onUnauthorized on any 401.
export function createApi(token, onUnauthorized) {
  const guard = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 401) onUnauthorized?.(err.message);
      throw err;
    }
  };
  const api = (path, options = {}) => guard(() => apiRequest(path, { ...options, token }));
  api.download = (path) => guard(() => download(path, token));
  return api;
}

const SESSION_KEY = 'leavePortalSession';

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable (private mode etc.) — session lasts for this tab only */
  }
}
