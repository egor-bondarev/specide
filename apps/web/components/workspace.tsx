'use client';

import dynamic from 'next/dynamic';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Circle,
  FileText,
  FolderOpen,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Save,
  Search,
  TriangleAlert,
} from 'lucide-react';
import type {
  DocumentList,
  RequirementDocument,
  RequirementKind,
  RequirementMetadata,
  RequirementStatus,
  SaveDocumentRequest,
  SaveOperation,
  WorkspaceInfo,
} from '@specide/schema';
import { api, RequestError } from '../lib/api';

const MarkdownEditor = dynamic(() => import('./markdown-editor'), {
  ssr: false,
  loading: () => (
    <div className="state">
      <LoaderCircle className="spin" /> Загрузка редактора…
    </div>
  ),
});
const kindLabels: Record<RequirementKind, string> = {
  business: 'Бизнес-требования',
  system: 'Системные требования',
  test_case: 'Тест-кейсы',
};
const statusLabels: Record<RequirementStatus, string> = {
  draft: 'Черновик',
  review: 'На проверке',
  approved: 'Согласовано',
  deprecated: 'Устарело',
};
const kinds: RequirementKind[] = ['system'];
const pendingKey = 'specide.pending-save';
type PendingSave = { id: string; request: SaveDocumentRequest };
type Draft = { metadata: RequirementMetadata; body: string };

export function Workspace() {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<RequirementDocument | null>(null);
  const [pending, setPending] = useState<PendingSave | null>(null);
  const pendingRef = useRef<PendingSave | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editorError, setEditorError] = useState('');
  const [reloadRequired, setReloadRequired] = useState(false);
  const [message, setMessage] = useState('');
  const [sidebar, setSidebar] = useState(true);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const workspace = useQuery({
    queryKey: ['workspace', 'system'],
    queryFn: () => api<WorkspaceInfo>('/workspace'),
  });
  const listing = useQuery({
    queryKey: ['documents', 'system'],
    queryFn: () => api<DocumentList>('/documents'),
  });
  const document = useQuery({
    queryKey: ['document', selected],
    queryFn: () =>
      api<RequirementDocument>('/documents/' + encodeURIComponent(selected!)),
    enabled: selected !== null && selected.startsWith('SR-'),
    retry: false,
  });
  const dirty =
    !!draft &&
    !!saved &&
    (draft.body !== saved.body ||
      JSON.stringify(draft.metadata) !== JSON.stringify(saved.metadata));
  const locked = busy || pending !== null;
  const documents = (listing.data?.documents ?? []).filter(
    (doc) => doc.metadata.type === 'system',
  );

  useEffect(() => {
    if (window.matchMedia('(max-width: 600px)').matches) setSidebar(false);
    try {
      const stored = sessionStorage.getItem(pendingKey);
      if (stored) {
        const value = JSON.parse(stored) as PendingSave;
        if (
          typeof value.id === 'string' &&
          typeof value.request?.operationId === 'string'
        ) {
          if (value.request.metadata?.type !== 'system') {
            sessionStorage.setItem(
              pendingKey + '.inactive.' + value.request.operationId,
              stored,
            );
            sessionStorage.removeItem(pendingKey);
            return;
          }
          pendingRef.current = value;
          setPending(value);
          setSelected(value.id);
          setMessage('Результат предыдущего сохранения нужно проверить.');
        }
      }
    } catch {
      sessionStorage.removeItem(pendingKey);
    }
  }, []);

  useEffect(() => {
    if (!listing.data || pendingRef.current?.id === selected) return;
    const available = listing.data.documents.filter(
      (doc) => doc.metadata.type === 'system',
    );
    if (available.some((doc) => doc.metadata.id === selected)) return;
    setSelected(available[0]?.metadata.id ?? null);
    setSaved(null);
    setDraft(null);
    setError('');
    setEditorError('');
    setReloadRequired(false);
    setMessage('');
  }, [listing.data, selected]);

  useEffect(() => {
    if (!document.data || document.data.metadata.type !== 'system') return;
    const doc = document.data;
    setSaved(doc);
    const retained = pendingRef.current;
    setDraft(
      retained?.id === doc.metadata.id
        ? { metadata: retained.request.metadata, body: retained.request.body }
        : { metadata: doc.metadata, body: doc.body },
    );
  }, [document.data]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || pending) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, pending]);

  function remember(value: PendingSave | null) {
    pendingRef.current = value;
    setPending(value);
    if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value));
    else sessionStorage.removeItem(pendingKey);
  }

  function select(id: string) {
    if (id === selected || locked) return;
    if (
      dirty &&
      !window.confirm(
        'Есть несохраненные изменения. Перейти к другому документу и отменить их?',
      )
    )
      return;
    setSelected(id);
    setSaved(null);
    setDraft(null);
    setError('');
    setEditorError('');
    setReloadRequired(false);
    setMessage('');
    if (window.matchMedia('(max-width: 600px)').matches) setSidebar(false);
  }

  async function applyResult(operation: SaveOperation) {
    if (operation.status === 'succeeded' && operation.document) {
      remember(null);
      setReloadRequired(false);
      const value = operation.document;
      setSaved(value);
      setDraft({ metadata: value.metadata, body: value.body });
      client.setQueryData(['document', value.metadata.id], value);
      await client.invalidateQueries({ queryKey: ['documents'] });
      setMessage('Сохранено в файл');
      setError('');
    } else if (
      operation.status === 'failed' ||
      operation.status === 'needs_review'
    ) {
      remember(null);
      setReloadRequired(operation.status === 'needs_review');
      setMessage('');
      setError(
        operation.error?.message ??
          'Сохранение не выполнено. Ваш текст остался в редакторе.',
      );
    } else {
      setMessage('Результат пока неизвестен. Проверьте сохранение.');
    }
  }

  async function submit() {
    if (!draft || !saved || locked || editorError || reloadRequired) return;
    const value: PendingSave = {
      id: saved.metadata.id,
      request: {
        operationId: crypto.randomUUID(),
        expectedVersion: saved.version,
        metadata: draft.metadata,
        body: draft.body,
      },
    };
    try {
      remember(value);
    } catch {
      setError(
        'Не удалось сохранить идентификатор операции в браузере. Запрос не отправлен.',
      );
      pendingRef.current = null;
      setPending(null);
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await applyResult(
        await api<SaveOperation>('/documents/' + value.id, {
          method: 'PUT',
          body: JSON.stringify(value.request),
        }),
      );
    } catch (cause) {
      if (cause instanceof RequestError && cause.status < 500) {
        remember(null);
        setReloadRequired(
          cause.code === 'VERSION_CONFLICT' ||
            cause.code === 'RECOVERY_REQUIRED',
        );
        setError(cause.message);
      } else {
        setMessage(
          'Подтверждение не получено. Проверьте результат сохранения.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function checkSave() {
    const value = pendingRef.current;
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      let operation: SaveOperation;
      try {
        operation = await api<SaveOperation>(
          '/operations/' + value.request.operationId,
        );
      } catch (cause) {
        if (
          !(cause instanceof RequestError) ||
          cause.code !== 'OPERATION_NOT_FOUND'
        )
          throw cause;
        operation = await api<SaveOperation>('/documents/' + value.id, {
          method: 'PUT',
          body: JSON.stringify(value.request),
        });
      }
      await applyResult(operation);
    } catch (cause) {
      if (cause instanceof RequestError && cause.status < 500) {
        remember(null);
        setReloadRequired(
          cause.code === 'VERSION_CONFLICT' ||
            cause.code === 'RECOVERY_REQUIRED',
        );
        setMessage('');
      }
      setError(
        cause instanceof Error
          ? cause.message
          : 'Не удалось проверить сохранение.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    if (locked) return;
    if (
      dirty &&
      !window.confirm(
        'Перечитать файл и отменить несохраненные изменения редактора?',
      )
    )
      return;
    setError('');
    setEditorError('');
    setMessage('');
    const result = await document.refetch();
    if (result.data) {
      setReloadRequired(false);
      setSaved(result.data);
      setDraft({ metadata: result.data.metadata, body: result.data.body });
      setEditorEpoch((value) => value + 1);
    }
  }

  function updateMetadata(key: 'title' | 'owner' | 'status', value: string) {
    setDraft((current) =>
      current
        ? { ...current, metadata: { ...current.metadata, [key]: value } }
        : current,
    );
    setMessage('');
  }

  const filtered = documents.filter((doc) =>
    (doc.metadata.id + ' ' + doc.metadata.title)
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="specIDE">
          <span className="brand-symbol">
            <FileText size={19} />
          </span>
          <span>
            spec<span className="brand-ide">IDE</span>
          </span>
        </a>
        <div className="header-divider" />
        <span className="workspace-label">
          <FolderOpen size={15} />{' '}
          {workspace.data?.name ?? 'Рабочее пространство'}
        </span>
        <span className="local-indicator">
          <span /> Локально
        </span>
      </header>
      <div className={'workspace-grid ' + (!sidebar ? 'sidebar-hidden' : '')}>
        {sidebar && (
          <aside className="sidebar">
            <div className="sidebar-title">
              <span>Документы</span>
              <span className="count">{documents.length}</span>
            </div>
            <label className="search">
              <Search size={16} />
              <input
                aria-label="Поиск документов"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск документов"
              />
            </label>
            <nav aria-label="Требования">
              {kinds.map((kind) => {
                const items = filtered.filter(
                  (doc) => doc.metadata.type === kind,
                );
                return (
                  <section className="document-group" key={kind}>
                    <div className="group-title">
                      <ChevronRight size={13} />
                      <span>{kindLabels[kind]}</span>
                      <span>{items.length}</span>
                    </div>
                    {items.map((doc) => (
                      <button
                        key={doc.path}
                        className={
                          'document-item ' +
                          (selected === doc.metadata.id ? 'selected' : '')
                        }
                        aria-current={
                          selected === doc.metadata.id ? 'page' : undefined
                        }
                        disabled={locked}
                        onClick={() => select(doc.metadata.id)}
                      >
                        <span className={'kind-mark ' + kind}>
                          {doc.metadata.id.split('-')[0]}
                        </span>
                        <span className="document-item-text">
                          <span className="doc-id">{doc.metadata.id}</span>
                          <span className="doc-title">
                            {doc.metadata.title}
                          </span>
                        </span>
                        {selected === doc.metadata.id && (
                          <span className="selected-dot" />
                        )}
                      </button>
                    ))}
                  </section>
                );
              })}
            </nav>
            {listing.isPending && (
              <p className="sidebar-note">Загрузка документов…</p>
            )}
            {listing.isError && (
              <div className="sidebar-error" role="alert">
                Не удалось загрузить документы.
                <button onClick={() => void listing.refetch()}>
                  Повторить
                </button>
              </div>
            )}
            {listing.data && filtered.length === 0 && (
              <p className="sidebar-note">
                {search ? 'Ничего не найдено' : 'Пока нет документов'}
              </p>
            )}
            {!!listing.data?.issues.length && (
              <details className="document-issues">
                <summary>
                  <TriangleAlert size={14} /> Проблемы файлов:{' '}
                  {listing.data.issues.length}
                </summary>
                {listing.data.issues.map((issue) => (
                  <p key={issue.path}>
                    <b>{issue.path}</b>
                    <br />
                    {issue.message}
                  </p>
                ))}
              </details>
            )}
            <footer className="sidebar-footer">
              <FolderOpen size={14} />
              <span>Рабочее пространство</span>
            </footer>
          </aside>
        )}
        <main className="main">
          <div className="document-bar">
            <button
              className="icon-button"
              title={sidebar ? 'Скрыть документы' : 'Показать документы'}
              aria-label={sidebar ? 'Скрыть документы' : 'Показать документы'}
              onClick={() => setSidebar(!sidebar)}
            >
              {sidebar ? (
                <PanelLeftClose size={18} />
              ) : (
                <PanelLeftOpen size={18} />
              )}
            </button>
            <div className="breadcrumbs">
              <span>Требования</span>
              <ChevronRight size={13} />
              <span>{selected ?? 'Документ'}</span>
            </div>
            <div className="document-actions">
              <span className={'save-state ' + (dirty ? 'unsaved' : '')}>
                {busy ? (
                  <LoaderCircle className="spin" size={14} />
                ) : pending ? (
                  <TriangleAlert size={14} />
                ) : dirty ? (
                  <Circle size={9} fill="currentColor" />
                ) : (
                  <Check size={14} />
                )}
                <span>
                  {busy
                    ? 'Сохранение…'
                    : pending
                      ? 'Нужно подтверждение'
                      : dirty
                        ? 'Не сохранено'
                        : saved
                          ? 'Сохранено'
                          : ''}
                </span>
              </span>
              {pending ? (
                <button
                  className="save-button"
                  onClick={() => void checkSave()}
                  disabled={busy}
                >
                  <RefreshCw size={15} /> Проверить
                </button>
              ) : (
                <button
                  className="save-button"
                  onClick={() => void submit()}
                  disabled={
                    !dirty ||
                    locked ||
                    !!editorError ||
                    reloadRequired ||
                    !draft?.metadata.title.trim()
                  }
                >
                  <Save size={15} /> Сохранить
                </button>
              )}
            </div>
          </div>
          {(error || editorError) && (
            <div className="error-banner" role="alert">
              <TriangleAlert size={17} />
              <span>{editorError || error}</span>
              {!locked && (
                <button onClick={() => void reload()}>
                  <RefreshCw size={14} /> Перечитать файл
                </button>
              )}
            </div>
          )}
          {message && (
            <div className="message-banner" role="status">
              <Check size={15} />
              {message}
            </div>
          )}
          {document.isError && (
            <div className="state error-state">
              <TriangleAlert />
              <p>{document.error.message}</p>
              <button onClick={() => void document.refetch()}>Повторить</button>
            </div>
          )}
          {document.isPending && selected && (
            <div className="state">
              <LoaderCircle className="spin" /> Открытие документа…
            </div>
          )}
          {!selected && !listing.isPending && !listing.isError && (
            <div className="state">
              <FolderOpen />
              <p>В рабочем пространстве пока нет доступных требований.</p>
            </div>
          )}
          {draft &&
            saved &&
            draft.metadata.type === 'system' &&
            !document.isError && (
              <div className="document-layout">
                <article className="document-canvas">
                  <div className="document-heading">
                    <div className="document-eyebrow">
                      <span className={'type-label ' + draft.metadata.type}>
                        {draft.metadata.id}
                      </span>
                      <span className={'status-label ' + draft.metadata.status}>
                        <span />
                        {statusLabels[draft.metadata.status]}
                      </span>
                    </div>
                    <input
                      className="title-input"
                      aria-label="Название документа"
                      value={draft.metadata.title}
                      disabled={locked || !!editorError}
                      maxLength={200}
                      onChange={(e) => updateMetadata('title', e.target.value)}
                      placeholder="Название требования"
                    />
                    <div className="document-subtitle">
                      <FileText size={13} />
                      <span>{saved.path}</span>
                    </div>
                  </div>
                  <MarkdownEditor
                    key={saved.path + ':' + saved.version + ':' + editorEpoch}
                    markdown={draft.body}
                    readOnly={locked || !!editorError}
                    onChange={(body) => {
                      setDraft((current) =>
                        current ? { ...current, body } : current,
                      );
                      setMessage('');
                    }}
                    onError={setEditorError}
                  />
                </article>
                <aside className="properties" aria-label="Свойства документа">
                  <div className="properties-title">Свойства</div>
                  <label>
                    Идентификатор
                    <input value={draft.metadata.id} readOnly />
                  </label>
                  <label>
                    Тип
                    <div className="property-value">
                      {kindLabels[draft.metadata.type]}
                    </div>
                  </label>
                  <label>
                    Статус
                    <select
                      aria-label="Статус"
                      value={draft.metadata.status}
                      disabled={locked || !!editorError}
                      onChange={(e) => updateMetadata('status', e.target.value)}
                    >
                      {Object.entries(statusLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Ответственный
                    <input
                      aria-label="Ответственный"
                      value={draft.metadata.owner ?? ''}
                      disabled={locked || !!editorError}
                      maxLength={160}
                      onChange={(e) => updateMetadata('owner', e.target.value)}
                      placeholder="Не назначен"
                    />
                  </label>
                  <div className="properties-divider" />
                  <div className="properties-title muted-title">Документ</div>
                  <div className="property-row">
                    <span>Формат</span>
                    <b>Markdown</b>
                  </div>
                  <div className="property-row">
                    <span>Версия файла</span>
                    <code title={saved.version}>
                      {saved.version.slice(0, 8)}
                    </code>
                  </div>
                  <button
                    className="text-button reload-button"
                    disabled={locked}
                    onClick={() => void reload()}
                  >
                    <RefreshCw size={14} /> Перечитать файл
                    <ArrowRight size={14} />
                  </button>
                </aside>
              </div>
            )}
          <footer className="status-bar">
            <span>
              <span className="connection-dot" />
              {workspace.isSuccess
                ? 'Рабочее пространство подключено'
                : 'Подключение…'}
            </span>
            <span>
              {saved?.metadata.id ?? 'specIDE'}
              <span className="status-separator">/</span>Markdown
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
