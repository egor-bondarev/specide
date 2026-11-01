'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  FilePlus2,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  createDocumentSchema,
  type CreateDocumentRequest,
  type DocumentOperation,
  type RequirementDocument,
} from '@specide/schema';
import { api, RequestError } from '../lib/api';

export const CREATE_OPERATION_KEY = 'specide.pending-create';

interface Props {
  onClose: () => void;
  onCreated: (document: RequirementDocument) => void;
}

export function CreateDocumentDialog({ onClose, onCreated }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const [attempt, setAttempt] = useState<CreateDocumentRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [requiresReview, setRequiresReview] = useState(false);
  const locked = busy || attempt !== null;

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(CREATE_OPERATION_KEY);
      if (stored) {
        const parsed = createDocumentSchema.safeParse(JSON.parse(stored));
        if (parsed.success) {
          setTitle(parsed.data.title);
          setOwner(parsed.data.owner ?? '');
          setAttempt(parsed.data);
          setMessage('Результат предыдущего создания нужно проверить.');
        } else {
          sessionStorage.removeItem(CREATE_OPERATION_KEY);
        }
      }
    } catch {
      setError('Не удалось прочитать данные незавершенного создания.');
    }
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (title.trim() || owner.trim() || attempt) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [title, owner, attempt]);

  function clearAttempt() {
    sessionStorage.removeItem(CREATE_OPERATION_KEY);
    setAttempt(null);
  }

  function complete(operation: DocumentOperation) {
    if (
      operation.status === 'succeeded' &&
      operation.document?.metadata.type === 'system'
    ) {
      clearAttempt();
      onCreated(operation.document);
    } else if (
      operation.status === 'failed' ||
      operation.status === 'needs_review'
    ) {
      clearAttempt();
      setRequiresReview(operation.status === 'needs_review');
      setMessage('');
      setError(operation.error?.message ?? 'Документ не был создан.');
    } else {
      setMessage('Результат пока неизвестен. Создание ожидает подтверждения.');
    }
  }

  async function execute(request: CreateDocumentRequest, verify: boolean) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      let operation: DocumentOperation;
      if (verify) {
        try {
          operation = await api<DocumentOperation>(
            '/operations/' + request.operationId,
          );
        } catch (cause) {
          if (
            !(cause instanceof RequestError) ||
            cause.code !== 'OPERATION_NOT_FOUND'
          )
            throw cause;
          operation = await api<DocumentOperation>('/documents', {
            method: 'POST',
            body: JSON.stringify(request),
          });
        }
      } else {
        operation = await api<DocumentOperation>('/documents', {
          method: 'POST',
          body: JSON.stringify(request),
        });
      }
      complete(operation);
    } catch (cause) {
      if (cause instanceof RequestError && cause.status < 500) {
        clearAttempt();
        setError(cause.message);
      } else {
        setMessage(
          'Подтверждение создания не получено. Результат пока неизвестен.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || requiresReview) return;
    const parsed = createDocumentSchema.safeParse({
      operationId: crypto.randomUUID(),
      title,
      owner,
    });
    if (!parsed.success) {
      setError('Укажите название требования.');
      return;
    }
    try {
      sessionStorage.setItem(CREATE_OPERATION_KEY, JSON.stringify(parsed.data));
    } catch {
      setError(
        'Не удалось сохранить идентификатор операции в браузере. Запрос не отправлен.',
      );
      return;
    }
    setAttempt(parsed.data);
    await execute(parsed.data, false);
  }

  return (
    <dialog
      ref={dialog}
      className="create-dialog"
      aria-labelledby="create-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="create-dialog-header">
          <div className="create-dialog-symbol">
            <FilePlus2 size={19} />
          </div>
          <h2 id="create-title">Новое системное требование</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть"
            title="Закрыть"
            disabled={locked}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="create-dialog-fields">
          <label htmlFor="new-title">
            Название <span aria-hidden="true">*</span>
          </label>
          <input
            id="new-title"
            name="title"
            autoFocus
            required
            maxLength={200}
            value={title}
            disabled={locked || requiresReview}
            onChange={(event) => setTitle(event.target.value)}
          />
          <label htmlFor="new-owner">Ответственный</label>
          <input
            id="new-owner"
            name="owner"
            maxLength={160}
            value={owner}
            disabled={locked || requiresReview}
            onChange={(event) => setOwner(event.target.value)}
            placeholder="Не назначен"
          />
          <div className="create-default-status">
            <span>Статус</span>
            <span className="status-label draft">
              <span />
              Черновик
            </span>
          </div>
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
        <div className="create-dialog-footer">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={locked}
          >
            Отмена
          </button>
          {attempt ? (
            <button
              type="button"
              className="save-button"
              onClick={() => void execute(attempt, true)}
              disabled={busy}
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <RefreshCw size={15} />
              )}
              {busy ? 'Создание…' : 'Проверить создание'}
            </button>
          ) : (
            <button
              type="submit"
              className="save-button"
              disabled={busy || !title.trim() || requiresReview}
            >
              <FilePlus2 size={15} />
              Создать
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
