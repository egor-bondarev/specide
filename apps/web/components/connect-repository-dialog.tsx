'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  connectWorkspaceSchema,
  type ConnectWorkspaceRequest,
  type WorkspaceConnection,
} from '@specide/schema';
import { api, RequestError } from '../lib/api';

export const CONNECTION_OPERATION_KEY = 'specide.pending-connection';

interface Props {
  current: WorkspaceConnection;
  onClose: () => void;
  onConnected: () => void;
}

export function ConnectRepositoryDialog({
  current,
  onClose,
  onConnected,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const allowNavigation = useRef(false);
  const [path, setPath] = useState('');
  const [attempt, setAttempt] = useState<ConnectWorkspaceRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const locked = busy || attempt !== null;

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(CONNECTION_OPERATION_KEY);
      if (stored) {
        const parsed = connectWorkspaceSchema.safeParse(JSON.parse(stored));
        if (parsed.success) {
          setAttempt(parsed.data);
          setPath(parsed.data.path ?? '');
          setMessage('Результат предыдущего подключения нужно проверить.');
        } else sessionStorage.removeItem(CONNECTION_OPERATION_KEY);
      }
    } catch {
      setError('Не удалось прочитать данные подключения.');
    }
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!allowNavigation.current && attempt) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [attempt]);

  async function execute(request: ConnectWorkspaceRequest, verify: boolean) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (verify) {
        try {
          await api<WorkspaceConnection>(
            '/workspace/connections/' + request.operationId,
          );
        } catch (cause) {
          if (
            !(cause instanceof RequestError) ||
            cause.code !== 'OPERATION_NOT_FOUND'
          )
            throw cause;
          await api<WorkspaceConnection>('/workspace/connect', {
            method: 'POST',
            body: JSON.stringify(request),
          });
        }
      } else
        await api<WorkspaceConnection>('/workspace/connect', {
          method: 'POST',
          body: JSON.stringify(request),
        });
      sessionStorage.removeItem(CONNECTION_OPERATION_KEY);
      allowNavigation.current = true;
      onConnected();
    } catch (cause) {
      if (cause instanceof RequestError && cause.status < 500) {
        sessionStorage.removeItem(CONNECTION_OPERATION_KEY);
        setAttempt(null);
        setError(cause.message);
      } else
        setMessage(
          'Подтверждение не получено. Проверьте результат подключения.',
        );
    } finally {
      setBusy(false);
    }
  }

  async function connect(target: string | null) {
    if (locked) return;
    const parsed = connectWorkspaceSchema.safeParse({
      operationId: crypto.randomUUID(),
      expectedWorkspaceId: current.id,
      path: target,
    });
    if (!parsed.success) {
      setError('Укажите путь к репозиторию.');
      return;
    }
    try {
      sessionStorage.setItem(
        CONNECTION_OPERATION_KEY,
        JSON.stringify(parsed.data),
      );
    } catch {
      setError(
        'Не удалось сохранить данные операции в браузере. Запрос не отправлен.',
      );
      return;
    }
    setAttempt(parsed.data);
    await execute(parsed.data, false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void connect(path);
  }

  return (
    <dialog
      ref={dialog}
      className="create-dialog connection-dialog"
      aria-labelledby="connection-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
    >
      <form onSubmit={submit}>
        <div className="create-dialog-header">
          <div className="create-dialog-symbol">
            <FolderOpen size={19} />
          </div>
          <h2 id="connection-title">Подключить репозиторий</h2>
          <button
            type="button"
            className="icon-button"
            title="Закрыть"
            aria-label="Закрыть"
            disabled={locked}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="create-dialog-fields">
          <span className="connection-current-label">Текущая папка</span>
          <code className="connection-path">{current.path}</code>
          <label htmlFor="repository-path">Локальный Git-репозиторий</label>
          <input
            id="repository-path"
            name="path"
            autoFocus
            required
            maxLength={4096}
            placeholder="/Users/name/Repos/requirements"
            value={path}
            disabled={locked}
            onChange={(event) => setPath(event.target.value)}
          />
        </div>
        {error && (
          <div className="create-dialog-error" role="alert">
            <TriangleAlert size={16} />
            <span>{error}</span>
          </div>
        )}
        {message && (
          <div className="create-dialog-message" role="status">
            {message}
          </div>
        )}
        <div className="create-dialog-footer connection-footer">
          {current.source === 'repository' && (
            <button
              type="button"
              className="text-button"
              disabled={locked}
              onClick={() => void connect(null)}
            >
              <RefreshCw size={14} />
              Исходная папка
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={locked}
            onClick={onClose}
          >
            Отмена
          </button>
          {attempt ? (
            <button
              type="button"
              className="save-button"
              disabled={busy}
              onClick={() => void execute(attempt, true)}
            >
              {busy ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <RefreshCw size={15} />
              )}
              {busy ? 'Подключение…' : 'Проверить подключение'}
            </button>
          ) : (
            <button
              type="submit"
              className="save-button"
              disabled={busy || !path.trim()}
            >
              <FolderOpen size={15} />
              Подключить
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
