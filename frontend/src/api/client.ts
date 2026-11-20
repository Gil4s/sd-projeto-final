import { COGNITO_CONFIG } from '../auth/cognito';
import type {
  HealthResponse,
  MeResponse,
  Project,
  RawTestResult,
  Task,
  TaskAttachment,
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

  listProjects: (token: string) =>
    apiFetch<{ items: Project[] }>('/projects', { token }).then((r) => r.items),

  createProject: (
    token: string,
    payload: { name: string; description: string; color: string },
  ) =>
    apiFetch<{ item: Project }>('/projects', { method: 'POST', token, body: payload }).then(
      (r) => r.item,
    ),

  updateProject: (
    token: string,
    projectId: string,
    payload: Partial<{ name: string; description: string; color: string }>,
  ) =>
    apiFetch<{ item: Project }>(`/projects/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      token,
      body: payload,
    }).then((r) => r.item),

  deleteProject: (token: string, projectId: string) =>
    apiFetch<void>(`/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      token,
    }),

  listTasks: (token: string, projectId?: string | null) => {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return apiFetch<{ items: Task[] }>(`/tasks${qs}`, { token }).then((r) => r.items);
  },

  createTask: (
    token: string,
    payload: {
      title: string;
      description: string;
      status: TaskStatus;
      priority: TaskPriority;
      dueDate: string | null;
      projectId: string | null;
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
      projectId: string | null;
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

  requestUploadUrl: (
    token: string,
    taskId: string,
    file: { filename: string; contentType: string; size: number },
  ) =>
    apiFetch<{ uploadUrl: string; expiresIn: number; attachment: TaskAttachment }>(
      `/tasks/${encodeURIComponent(taskId)}/attachments/upload-url`,
      { method: 'POST', token, body: file },
    ),

  uploadFileDirectToS3: async (uploadUrl: string, file: File): Promise<void> => {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
      },
      body: file,
    });
    if (!res.ok) {
      throw new ApiError(res.status, `Falha ao enviar arquivo para o Amazon S3 (HTTP ${res.status}).`);
    }
  },

  requestDownloadUrl: (token: string, taskId: string, attachmentId: string) =>
    apiFetch<{ downloadUrl: string; expiresIn: number; attachment: TaskAttachment }>(
      `/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/download-url`,
      { token },
    ),

  deleteAttachment: (token: string, taskId: string, attachmentId: string) =>
    apiFetch<void>(
      `/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: 'DELETE', token },
    ),

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
