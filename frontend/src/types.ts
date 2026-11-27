export type TaskStatus = 'todo' | 'doing' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email: string | null;
  sub: string;
  username: string;
}

export interface MeResponse {
  user: {
    sub: string;
    email: string | null;
    username: string;
    tokenUse: string | null;
    scope: string | null;
    authTime: number | null;
    exp: number | null;
  };
  stats: {
    tasks: number;
    todo: number;
    doing: number;
    done: number;
  };
  architecture: {
    api: string;
    database: string;
    isolationKey: string;
  };
}

export interface HealthResponse {
  status: string;
  service: string;
  author: string;
  dns: {
    app: string;
    api: string;
  };
  layers: {
    presentation: string;
    business: string;
    data: string;
    auth: string;
  };
  timestamp: string;
}

export interface RawTestResult {
  endpoint: string;
  withAuth: boolean;
  status: number;
  statusText: string;
  durationMs: number;
  body: unknown;
}
