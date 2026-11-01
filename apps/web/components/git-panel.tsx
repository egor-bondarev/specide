'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CloudUpload,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  gitCommitRequestSchema,
  type GitCommit,
  type GitCommitRequest,
  type GitDiff,
  type GitHistory,
  type GitOperation,
  type GitStatus,
  type GitPushResult,
} from '@specide/schema';
import { api, RequestError, workspaceStorageKey } from '../lib/api';

export const GIT_OPERATION_KEY = 'specide.pending-git-commit';
const labels = { added: 'Добавлен', modified: 'Изменен', deleted: 'Удален' };
interface Props {
  onClose: () => void;
  onCommitted: () => void;
  hasUnsavedChanges: boolean;
}

export function GitPanel({ onClose, onCommitted, hasUnsavedChanges }: Props) {
  const operationKey = workspaceStorageKey(GIT_OPERATION_KEY);
  const dialog = useRef<HTMLDialogElement>(null);
  const client = useQueryClient();
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [reviews, setReviews] = useState<Record<string, string>>({});
  const [description, setDescription] = useState('');
  const [commitHash, setCommitHash] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<GitCommitRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const locked = busy || pushing || pending !== null;
  const status = useQuery({
    queryKey: ['git', 'status'],
    queryFn: () => api<GitStatus>('/git/status'),
    enabled: !pushing,
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });
  const history = useQuery({
    queryKey: ['git', 'history', offset, status.data?.head],
    queryFn: () => api<GitHistory>('/git/history?offset=' + offset),
    enabled: tab === 'history' && status.data?.available === true,
  });
  const details = useQuery({
    queryKey: ['git', 'commit', commitHash],
    queryFn: () => api<GitCommit>('/git/commits/' + commitHash),
    enabled:
      tab === 'history' && !!commitHash && status.data?.available === true,
  });
  const files =
    tab === 'changes'
      ? (status.data?.changes ?? [])
      : (details.data?.files ?? []);
  const currentToken = status.data?.changes.find(
    (file) => file.path === active,
  )?.snapshotToken;
  const diff = useQuery({
    queryKey: [
      'git',
      'diff',
      tab,
      active,
      tab === 'history' ? commitHash : currentToken,
    ],
    queryFn: () =>
      api<GitDiff>(
        '/git/diff?path=' +
          encodeURIComponent(active!) +
          (tab === 'history' ? '&commit=' + commitHash : ''),
      ),
    enabled:
      !locked &&
      !!active &&
      status.data?.available === true &&
      files.some((file) => file.path === active) &&
      (tab === 'changes' ? !!currentToken : !!commitHash),
    retry: false,
  });
  const reviewed = selected.filter(
    (path) =>
      reviews[path] &&
      reviews[path] ===
        status.data?.changes.find((file) => file.path === path)?.snapshotToken,
  ).length;
  const canCommit =
    status.data?.available === true &&
    selected.length > 0 &&
    reviewed === selected.length &&
    !!description.trim() &&
    !locked &&
    !status.data?.hasStagedChanges &&
    !status.data?.recoveryRequired &&
    !hasUnsavedChanges;

  useEffect(() => {
    try {
      const value = sessionStorage.getItem(operationKey);
      if (value) {
        const parsed = gitCommitRequestSchema.safeParse(JSON.parse(value));
        if (parsed.success) {
          setPending(parsed.data);
          setSelected(parsed.data.files.map((file) => file.path));
          setDescription(parsed.data.message);
          setMessage('Результат предыдущей фиксации нужно проверить.');
        } else sessionStorage.removeItem(operationKey);
      }
    } catch {
      setError('Не удалось восстановить данные Git-операции.');
    }
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pending || busy || pushing) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending, busy, pushing]);

  useEffect(() => {
    const available =
      tab === 'changes' ? status.data?.changes : details.data?.files;
    if (available && !available.some((file) => file.path === active))
      setActive(available[0]?.path ?? null);
  }, [tab, status.data, details.data, active]);

  useEffect(() => {
    if (!commitHash && history.data?.commits[0])
      setCommitHash(history.data.commits[0].hash);
  }, [history.data, commitHash]);

  useEffect(() => {
    if (tab === 'changes' && diff.data?.snapshotToken) {
      const { path, snapshotToken } = diff.data;
      setReviews((previous) =>
        previous[path] === snapshotToken
          ? previous
          : { ...previous, [path]: snapshotToken },
      );
    }
  }, [diff.data, tab]);

  useEffect(() => {
    if (!pending && status.data)
      setSelected((previous) =>
        previous.filter((path) =>
          status.data!.changes.some(
            (file) => file.path === path && !file.blockedReason,
          ),
        ),
      );
  }, [status.data, pending]);

  function clearPending() {
    sessionStorage.removeItem(operationKey);
    setPending(null);
  }

  async function complete(operation: GitOperation) {
    if (operation.status === 'succeeded' && operation.commit) {
      clearPending();
      setSelected([]);
      setReviews({});
      setDescription('');
      setCommitHash(operation.commit.hash);
      setOffset(0);
      setTab('history');
      setMessage('Версия зафиксирована: ' + operation.commit.hash.slice(0, 8));
      await refreshGit();
      onCommitted();
    } else if (
      operation.status === 'failed' ||
      operation.status === 'needs_review'
    ) {
      clearPending();
      setReviews({});
      setMessage('');
      setError(operation.error?.message ?? 'Фиксация не завершена.');
      await refreshGit();
    } else setMessage('Результат фиксации пока неизвестен.');
  }

  async function execute(request: GitCommitRequest, verify: boolean) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      let result: GitOperation;
      if (verify) {
        try {
          result = await api<GitOperation>(
            '/git/operations/' + request.operationId,
          );
        } catch (cause) {
          if (
            !(cause instanceof RequestError) ||
            cause.code !== 'OPERATION_NOT_FOUND'
          )
            throw cause;
          result = await api<GitOperation>('/git/commit', {
            method: 'POST',
            body: JSON.stringify(request),
          });
        }
      } else
        result = await api<GitOperation>('/git/commit', {
          method: 'POST',
          body: JSON.stringify(request),
        });
      await complete(result);
    } catch (cause) {
      if (cause instanceof RequestError && cause.status < 500) {
        clearPending();
        setReviews({});
        setError(cause.message);
        await refreshGit();
      } else
        setMessage(
          'Подтверждение фиксации не получено. Проверьте результат операции.',
        );
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    if (!canCommit) return;
    const request = gitCommitRequestSchema.parse({
      operationId: crypto.randomUUID(),
      message: description,
      files: selected.map((path) => ({ path, snapshotToken: reviews[path] })),
    });
    try {
      sessionStorage.setItem(operationKey, JSON.stringify(request));
    } catch {
      setError('Не удалось сохранить ID операции. Запрос не отправлен.');
      return;
    }
    setPending(request);
    void execute(request, false);
  }

  function refresh() {
    setError('');
    void refreshGit();
  }

  async function push() {
    const current = status.data;
    const target = current?.push;
    if (
      locked ||
      !current ||
      !target?.available ||
      !target.token ||
      !current.head ||
      current.recoveryRequired
    )
      return;
    if (
      !window.confirm(
        'Отправить все коммиты текущей ветки в ' +
          target.remote +
          '/' +
          target.branch +
          '?\n\nPush отправит всю историю ветки, не только системные требования. Несохраненные и незакоммиченные изменения не отправляются.',
      )
    )
      return;
    setPushing(true);
    setError('');
    setMessage('');
    try {
      const result = await api<GitPushResult>('/git/push', {
        method: 'POST',
        body: JSON.stringify({
          expectedHead: current.head,
          targetToken: target.token,
        }),
      });
      setMessage(
        'Отправлено в ' +
          result.remote +
          '/' +
          result.branch +
          ': ' +
          result.head.slice(0, 8),
      );
    } catch (cause) {
      setError(
        cause instanceof RequestError
          ? cause.message
          : 'Подтверждение Push не получено. Отправка могла завершиться; ее можно повторить без force-push.',
      );
    } finally {
      setPushing(false);
      await refreshGit();
    }
  }

  function refreshGit() {
    return client.invalidateQueries({
      queryKey: ['git'],
      predicate: (query) => query.queryKey[1] !== 'diff',
    });
  }

  return (
    <dialog
      ref={dialog}
      className="git-dialog"
      aria-labelledby="git-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
    >
      <div className="git-panel-header">
        <GitBranch size={19} />
        <h2 id="git-title">Git</h2>
        {status.data?.available && (
          <span className="git-repository">
            {status.data.repository}
            <span>/</span>
            {status.data.branch ??
              status.data.head?.slice(0, 8) ??
              'Новая ветка'}
          </span>
        )}
        <button
          className="secondary-button git-push-button"
          aria-busy={pushing}
          title={
            status.data?.push?.available
              ? 'Push в ' +
                status.data.push.remote +
                '/' +
                status.data.push.branch
              : (status.data?.push?.reason ?? 'Push недоступен')
          }
          disabled={
            locked ||
            !status.data?.push?.available ||
            !!status.data?.recoveryRequired ||
            status.isError ||
            status.isFetching
          }
          onClick={() => void push()}
        >
          {pushing ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <CloudUpload size={16} />
          )}
          Push
        </button>
        <button
          className="icon-button"
          aria-label="Обновить Git"
          title="Обновить Git"
          disabled={locked}
          onClick={refresh}
        >
          <RefreshCw size={17} />
        </button>
        <button
          className="icon-button"
          aria-label="Закрыть Git"
          title="Закрыть"
          disabled={locked}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="git-tabs" role="tablist" aria-label="Git">
        <button
          role="tab"
          aria-selected={tab === 'changes'}
          disabled={locked}
          onClick={() => {
            setTab('changes');
            setActive(null);
          }}
        >
          <GitBranch size={15} />
          Изменения<span>{status.data?.changes.length ?? 0}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'history'}
          disabled={locked}
          onClick={() => {
            setTab('history');
            setActive(null);
          }}
        >
          <History size={15} />
          История
        </button>
      </div>
      {status.data?.available && (
        <div className="git-push-target">
          <CloudUpload size={14} />
          <span>
            {status.data.push?.available
              ? status.data.push.remote + '/' + status.data.push.branch
              : status.data.push?.reason}
          </span>
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          <TriangleAlert size={16} />
          {error}
        </div>
      )}
      {message && (
        <div className="message-banner" role="status">
          <Check size={15} />
          {message}
        </div>
      )}
      {status.data?.hasStagedChanges && (
        <div className="git-warning">
          <TriangleAlert size={15} />В индексе Git есть подготовленные
          изменения. Фиксация из приложения недоступна.
        </div>
      )}
      {status.data?.recoveryRequired && (
        <div className="git-warning">
          <TriangleAlert size={15} />
          Нужна проверка состояния незавершенной Git-операции.
        </div>
      )}
      {hasUnsavedChanges && (
        <div className="git-warning">
          <TriangleAlert size={15} />В редакторе есть несохраненные изменения.
        </div>
      )}
      {status.isPending ? (
        <div className="state">
          <LoaderCircle size={18} className="spin" />
          Загрузка Git…
        </div>
      ) : status.isError ? (
        <div className="state error-state">
          <TriangleAlert />
          <span>Не удалось прочитать состояние Git.</span>
          <button onClick={refresh}>Повторить</button>
        </div>
      ) : !status.data?.available ? (
        <div className="state">
          <GitBranch />
          <span>{status.data?.reason}</span>
        </div>
      ) : (
        <div className="git-body">
          <aside
            className="git-list"
            aria-label={
              tab === 'changes' ? 'Измененные требования' : 'Версии требований'
            }
          >
            {tab === 'history' && (
              <div className="git-history-list">
                {history.isPending && (
                  <p className="git-empty">Загрузка истории…</p>
                )}
                {history.isError && (
                  <p className="git-empty">Не удалось загрузить историю.</p>
                )}
                {history.data?.commits.map((commit) => (
                  <button
                    key={commit.hash}
                    className={
                      'git-history-item ' +
                      (commitHash === commit.hash ? 'active' : '')
                    }
                    onClick={() => {
                      setCommitHash(commit.hash);
                      setActive(null);
                    }}
                  >
                    <span>{commit.message.split('\n')[0]}</span>
                    <small>
                      {commit.author} ·{' '}
                      {new Date(commit.date).toLocaleDateString('ru-RU')}
                    </small>
                    <code>{commit.hash.slice(0, 8)}</code>
                  </button>
                ))}
                {history.data?.commits.length === 0 && (
                  <p className="git-empty">
                    История системных требований пуста.
                  </p>
                )}
                <div className="git-pagination">
                  {offset > 0 && (
                    <button onClick={() => setOffset(Math.max(0, offset - 20))}>
                      Назад
                    </button>
                  )}
                  {history.data?.hasMore && (
                    <button onClick={() => setOffset(history.data!.nextOffset)}>
                      Далее
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="git-file-list">
              {tab === 'changes' && files.length === 0 && (
                <p className="git-empty">Сохраненных изменений нет.</p>
              )}
              {files.map((file) => (
                <div
                  className={
                    'git-file-item ' + (active === file.path ? 'active' : '')
                  }
                  key={file.path}
                >
                  {tab === 'changes' && (
                    <input
                      type="checkbox"
                      aria-label={'Выбрать ' + file.path}
                      checked={selected.includes(file.path)}
                      disabled={
                        locked ||
                        !!('blockedReason' in file && file.blockedReason)
                      }
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, file.path]
                            : previous.filter((path) => path !== file.path),
                        )
                      }
                    />
                  )}
                  <button
                    onClick={() => setActive(file.path)}
                    title={file.path}
                  >
                    <FileText size={15} />
                    <span>{file.path}</span>
                    <small className={'git-kind ' + file.kind}>
                      {labels[file.kind]}
                    </small>
                  </button>
                </div>
              ))}
            </div>
          </aside>
          <section className="git-diff" aria-label="Сравнение документа">
            <div className="git-diff-title">
              {active ?? 'Сравнение'}
              {tab === 'history' && commitHash && (
                <code>{commitHash.slice(0, 8)}</code>
              )}
            </div>
            {diff.isFetching && active ? (
              <div className="state">
                <LoaderCircle size={18} className="spin" />
                Загрузка сравнения…
              </div>
            ) : diff.isError && active ? (
              <div className="state error-state">
                <TriangleAlert />
                <span>{diff.error.message}</span>
              </div>
            ) : diff.data && active ? (
              <>
                {diff.data.blockedReason && (
                  <div className="git-warning">
                    <TriangleAlert size={15} />
                    {diff.data.blockedReason}
                  </div>
                )}
                <pre className="diff-code">
                  {diff.data.patch.split('\n').map((line, index) => (
                    <span
                      key={index}
                      className={
                        line.startsWith('+') && !line.startsWith('+++')
                          ? 'diff-add'
                          : line.startsWith('-') && !line.startsWith('---')
                            ? 'diff-remove'
                            : line.startsWith('@@')
                              ? 'diff-hunk'
                              : ''
                      }
                    >
                      {line || ' '}
                      {'\n'}
                    </span>
                  ))}
                </pre>
              </>
            ) : (
              <div className="state">
                <FileText />
                <span>Документ не выбран</span>
              </div>
            )}
          </section>
        </div>
      )}
      <div className="git-commit-footer">
        <label htmlFor="git-message">Описание версии</label>
        <textarea
          id="git-message"
          rows={2}
          maxLength={2000}
          value={description}
          disabled={locked || !status.data?.available}
          onChange={(event) => setDescription(event.target.value)}
        />
        <div className="git-commit-actions">
          <span>
            Выбрано: {selected.length} · Просмотрено: {reviewed}
          </span>
          {pending ? (
            <button
              className="save-button"
              disabled={busy}
              onClick={() => void execute(pending, true)}
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <RefreshCw size={15} />
              )}
              Проверить фиксацию
            </button>
          ) : (
            <button
              className="save-button"
              disabled={!canCommit}
              onClick={submit}
            >
              <GitCommitHorizontal size={16} />
              Зафиксировать
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
