import type { ApiError } from '@specide/schema';

export class RequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error: Partial<ApiError> = await response.json().catch(() => ({}));
    throw new RequestError(
      response.status,
      error.code ?? 'REQUEST_FAILED',
      error.message ?? 'Не удалось выполнить запрос.',
    );
  }
  return response.json() as Promise<T>;
}
