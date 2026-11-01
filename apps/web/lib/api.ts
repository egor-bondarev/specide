import type { ApiError, WorkspaceConnection } from '@specide/schema';

export const WORKSPACE_CHANGED_EVENT = 'specide:workspace-changed';
let connection: WorkspaceConnection | undefined;
let bootstrap: Promise<WorkspaceConnection> | undefined;
let stale = false;

function changed(message: string): RequestError {
  stale = true;
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
  return new RequestError(409, 'WORKSPACE_CHANGED', message);
}

export function isWorkspaceStale() {
  return stale;
}

export function workspaceStorageKey(base: string) {
  if (!connection) throw new Error('Рабочее пространство еще не загружено.');
  const key = base + ':' + connection.storageKey;
  if (connection.source === 'default' && sessionStorage.getItem(key) === null) {
    const legacy = sessionStorage.getItem(base);
    if (legacy !== null) {
      sessionStorage.setItem(key, legacy);
      sessionStorage.removeItem(base);
    }
  }
  return key;
}

export class RequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  if (connection) headers.set('X-Specide-Workspace', connection.id);
  const response = await fetch('/api' + path, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(path === '/git/push' ? 90000 : 15000),
  });
  if (!response.ok) {
    const error: Partial<ApiError> = await response.json().catch(() => ({}));
    if (error.code === 'WORKSPACE_CHANGED')
      throw changed(error.message ?? 'Рабочее пространство переключено.');
    throw new RequestError(
      response.status,
      error.code ?? 'REQUEST_FAILED',
      error.message ?? 'Не удалось выполнить запрос.',
    );
  }
  return response.json() as Promise<T>;
}

async function loadWorkspace(): Promise<WorkspaceConnection> {
  if (!bootstrap) {
    bootstrap = request<WorkspaceConnection>('/workspace')
      .then((value) => {
        if (!value.id || !value.storageKey)
          throw new RequestError(
            500,
            'INVALID_WORKSPACE',
            'Некорректные данные рабочего пространства.',
          );
        if (connection && connection.id !== value.id)
          throw changed(
            'Рабочее пространство переключено в другой вкладке. Перезагрузите страницу.',
          );
        connection = value;
        return value;
      })
      .finally(() => {
        bootstrap = undefined;
      });
  }
  return bootstrap;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (path === '/workspace' && (!init?.method || init.method === 'GET'))
    return loadWorkspace() as Promise<T>;
  if (!connection) await loadWorkspace();
  return request<T>(path, init);
}
