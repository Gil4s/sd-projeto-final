import { COGNITO_CONFIG } from '../auth/cognito';
import type {
  HealthResponse,
  MeResponse,
  RawTestResult,
  Task,
  TaskPriority,
  TaskStatus,
} from '../types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function apiFetch<T>(
  path: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${COGNITO_CONFIG.apiUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }
  }

  if (!res.ok) {
    let msg = `Erro HTTP ${res.status}`;
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      msg = String((parsed as { message: unknown }).message);
    }
    throw new ApiError(res.status, msg);
  }

  return parsed as T;
}

export const apiClient = {
  getHealth: () => apiFetch<HealthResponse>('/health'),

  getMe: (token: string) => apiFetch<MeResponse>('/me', { token }),

  listTasks: (token: string) =>
    apiFetch<{ items: Task[] }>('/tasks', { token }).then((r) => r.items),

  createTask: (
    token: string,
    payload: {
      title: string;
      description: string;
      status: TaskStatus;
      priority: TaskPriority;
      dueDate: string | null;
    },
  ) =>
    apiFetch<{ item: Task }>('/tasks', { method: 'POST', token, body: payload }).then(
      (r) => r.item,
    ),

  updateTask: (
    token: string,
    taskId: string,
    payload: Partial<{
      title: string;
      description: string;
      status: TaskStatus;
      priority: TaskPriority;
      dueDate: string | null;
    }>,
  ) =>
    apiFetch<{ item: Task }>(`/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PUT',
      token,
      body: payload,
    }).then((r) => r.item),

  deleteTask: (token: string, taskId: string) =>
    apiFetch<void>(`/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
      token,
    }),

  testRawRequest: async (path: string, token?: string | null): Promise<RawTestResult> => {
    const start = performance.now();
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${COGNITO_CONFIG.apiUrl}${path}`, {
      method: 'GET',
      headers,
    });
    const durationMs = Math.round(performance.now() - start);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // mantém texto puro se não for JSON
    }
    return {
      endpoint: `${COGNITO_CONFIG.apiUrl}${path}`,
      withAuth: Boolean(token),
      status: res.status,
      statusText: res.statusText || (res.status === 200 ? 'OK' : res.status === 401 ? 'Unauthorized' : ''),
      durationMs,
      body,
    };
  },
};
