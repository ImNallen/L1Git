import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FolderGit2,
  GitCommitHorizontal,
  LoaderCircle,
} from "lucide-react";
import { githubHandle, initials } from "../domain/author";
import { sameComparison } from "../domain/comparison";
import type { Compare, Comparison } from "../domain/comparison";
import type {
  ChangedFile,
  Commit,
  Oid,
  RepositoryRoot,
  RepositorySnapshot,
  Worktree,
} from "../domain/repository";
import { clampMessage, listWrites, worktreeGroups } from "../domain/worktree";
import type {
  ListSide,
  WorktreeChanges,
  WorktreeGroup,
} from "../domain/worktree";
import type { RefLabel } from "../domain/refs";
import type { Selection } from "../domain/selection";
import { relativeTime } from "../domain/time";
import { discardablePaths } from "../domain/operations";
import type { FileWrite, Write } from "../domain/operations";
import type { DetailState } from "../useWorkspace";
import { changedFileTreeInput, listsRow } from "../domain/changedFiles";
import type { Outcome } from "../useWrites";
import { ChangedFileTree, changeStatuses } from "./ChangedFileTree";
import { CommitBox } from "./CommitBox";
import type { RowAction } from "./ChangedFileTree";
import { RefBadge } from "./History";

type Props = {
  state: DetailState;
  root: RepositoryRoot;
  selection: Selection | null;
  compare: Compare | null;
  comparison: Comparison | null;
  snapshot: RepositorySnapshot;
  refs: readonly RefLabel[];
  /** The selected commit's graph lane, null when a rule hides its row or it is outside the loaded history. */
  lane: number | null;
  onSelect: (selection: Selection) => void;
  onSwap: () => void;
  selectedFile: OpenedFile | null;
  onSelectFile: (path: string, side: ListSide | null) => void;
  toggleButton: ReactNode;
  onRetry: () => void;
  worktree: { worktree: Worktree; changes: WorktreeChanges | undefined } | null;
  onRefreshChanges: () => void;
  writes: WorktreeWrites;
};

export type WorktreeWrites = {
  busy: boolean;
  write: (
    worktree: RepositoryRoot,
    kind: FileWrite,
    paths: readonly string[],
  ) => Promise<unknown>;
  commit: (worktree: RepositoryRoot, write: Write) => Promise<Outcome>;
  confirmDiscard: (
    worktree: RepositoryRoot,
    paths: readonly string[],
    returnFocus?: () => void,
  ) => void;
};

export function InspectorFrame({
  heading,
  toggleButton,
  children,
}: {
  heading?: ReactNode;
  toggleButton: ReactNode;
  children?: ReactNode;
}) {
  return (
    <aside className="inspector" aria-label="Commit inspector">
      <div className="inspector-heading">
        {heading ?? <span />}
        {toggleButton}
      </div>
      {children}
    </aside>
  );
}

const changeKinds = [
  { gitStatus: "added", symbol: "+", label: "added" },
  { gitStatus: "modified", symbol: "~", label: "modified" },
  { gitStatus: "deleted", symbol: "\u2212", label: "deleted" },
] as const;

/** Long bodies start clipped so the changed files stay in view. */
function CommitMessage({ body }: { body: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const message = ref.current;
    if (!message || expanded) return;
    const measure = () =>
      setOverflows(message.scrollHeight > message.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(message);
    return () => observer.disconnect();
  }, [expanded, body]);
  if (body === "") return null;
  return (
    <div className="commit-message-block">
      <pre
        ref={ref}
        className={`commit-message${expanded ? "" : " clipped"}${overflows && !expanded ? " fading" : ""}`}
      >
        {body}
      </pre>
      {(overflows || expanded) && (
        <button
          className="message-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export function CommitInspector({
  state,
  root,
  selection,
  compare,
  comparison,
  snapshot,
  refs,
  lane,
  onSelect,
  onSwap,
  selectedFile,
  onSelectFile,
  toggleButton,
  onRetry,
  worktree,
  onRefreshChanges,
  writes,
}: Props) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [changesOpen, setChangesOpen] = useState(true);
  useEffect(() => {
    setCopy("idle");
  }, [selection]);
  useEffect(() => {
    if (copy !== "copied") return;
    const timer = window.setTimeout(() => setCopy("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copy]);
  const current = (key: { root: RepositoryRoot; comparison: Comparison }) =>
    key.root === root &&
    comparison !== null &&
    sameComparison(key.comparison, comparison);
  const detail = state.kind === "ready" && current(state) ? state.detail : null;
  const error = state.kind === "error" && current(state) ? state.error : null;

  async function copySha(oid: Oid) {
    try {
      await navigator.clipboard.writeText(oid);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  if (selection?.kind === "worktree" && compare === null)
    return (
      <InspectorFrame toggleButton={toggleButton}>
        {worktree ? (
          <WorktreeInspector
            worktree={worktree.worktree}
            changes={worktree.changes}
            snapshot={snapshot}
            onSelect={onSelect}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            onRefresh={onRefreshChanges}
            writes={writes}
          />
        ) : (
          <div className="inspector-empty">
            <p>This worktree is no longer listed.</p>
          </div>
        )}
      </InspectorFrame>
    );

  const pending = error ? (
    <div className="inspector-empty">
      <p role="alert">{error.message}</p>
      <button className="button secondary" onClick={onRetry}>
        Retry details
      </button>
    </div>
  ) : (
    <div className="inspector-empty">
      {selection ? (
        <>
          <LoaderCircle size={23} className="spin" />
          <p>{compare ? "Reading comparison…" : "Reading commit…"}</p>
        </>
      ) : (
        <>
          <GitCommitHorizontal size={30} />
          <p>Select a commit to inspect it.</p>
        </>
      )}
    </div>
  );

  if (compare !== null)
    return (
      <InspectorFrame
        toggleButton={toggleButton}
        heading={
          <span className="compare-ends">
            <code>{compare.base.slice(0, 7)}</code>
            <ArrowRight size={12} aria-label="to" />
            <code>
              {compare.target.kind === "commit"
                ? compare.target.oid.slice(0, 7)
                : "Working copy"}
            </code>
            {compare.target.kind === "commit" && (
              <button
                className="button secondary compare-swap"
                onClick={onSwap}
                title="Swap the base and the target"
              >
                <ArrowLeftRight size={12} />
                <span>Swap</span>
              </button>
            )}
          </span>
        }
      >
        {detail ? (
          <div className="inspector-content">
            <h2>
              {detail.target.kind === "worktree"
                ? "Compared with the working copy"
                : "Compared commits"}
            </h2>
            <dl className="commit-metadata">
              {detail.base.kind === "commit" && (
                <CompareEnd
                  label="Base"
                  commit={detail.base.commit}
                  onSelect={onSelect}
                />
              )}
              {detail.target.kind === "commit" ? (
                <CompareEnd
                  label="Target"
                  commit={detail.target.commit}
                  onSelect={onSelect}
                />
              ) : (
                <div className="meta-row">
                  <dt className="visually-hidden">Target</dt>
                  <dd>
                    <span className="meta-icon" aria-hidden="true">
                      <FolderGit2 size={13} />
                    </span>
                    <span className="meta-lines">
                      <span className="meta-primary">
                        {snapshot.worktrees.find(
                          (listed) =>
                            detail.target.kind === "worktree" &&
                            listed.root === detail.target.root,
                        )?.name ?? "Working copy"}
                      </span>
                      <span
                        className="meta-secondary"
                        title={detail.target.root}
                      >
                        {detail.target.root}
                      </span>
                    </span>
                  </dd>
                </div>
              )}
            </dl>
            <ChangedFiles
              files={detail.files}
              treeKey={JSON.stringify(comparison)}
              title={`Compared ${compare.base} with ${compare.target.kind === "commit" ? compare.target.oid : "the working copy"}. Renames appear as added and deleted paths.`}
              empty={
                detail.target.kind === "worktree"
                  ? "No changes between this commit and the working copy."
                  : "No changes between these commits."
              }
              open={changesOpen}
              onToggle={() => setChangesOpen(!changesOpen)}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
            />
          </div>
        ) : (
          pending
        )}
      </InspectorFrame>
    );

  const target = detail?.target.kind === "commit" ? detail.target : null;
  const handle = target && githubHandle(target.commit.email);
  const stashed = target
    ? snapshot.stashes.filter((stash) => stash.oid === target.commit.oid)
    : [];
  // A stash's other parents hold its index and untracked files, not history.
  const parents =
    stashed.length > 0
      ? (target?.commit.parents.slice(0, 1) ?? [])
      : (target?.commit.parents ?? []);
  return (
    <InspectorFrame
      toggleButton={toggleButton}
      heading={
        target && (
          <button
            className={`sha-chip ${copy}`}
            onClick={() => void copySha(target.commit.oid)}
            aria-label={`Copy commit SHA ${target.commit.oid}`}
            title={copy === "copied" ? "Copied" : `Copy ${target.commit.oid}`}
          >
            <code>{target.commit.oid.slice(0, 7)}</code>
            {copy === "copied" ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )
      }
    >
      {detail && target ? (
        <div className="inspector-content">
          <span className="visually-hidden" role="status">
            {copy === "copied" ? "Commit SHA copied" : ""}
          </span>
          {copy === "failed" && (
            <p className="copy-error">
              Could not copy. Select the SHA to copy it:{" "}
              <code>{target.commit.oid}</code>
            </p>
          )}
          <h2>{target.commit.subject || "(no subject)"}</h2>
          <CommitMessage
            key={`message:${target.commit.oid}`}
            body={target.message.split("\n").slice(1).join("\n").trim()}
          />
          <div className="inspector-refs">
            {refs.map((label, index) => (
              <RefBadge key={index} label={label} lane={lane} />
            ))}
            {stashed.map((stash) => (
              <span className="ref-badge stash" key={stash.name}>
                {stash.name}
              </span>
            ))}
          </div>
          <dl className="commit-metadata">
            <div className="meta-row">
              <dt className="visually-hidden">Author</dt>
              <dd>
                <span className="meta-icon avatar" aria-hidden="true">
                  {initials(target.commit.author)}
                </span>
                <span className="meta-lines">
                  <span className="meta-primary">{target.commit.author}</span>
                  <span className="meta-secondary" title={target.commit.email}>
                    {handle ? `@${handle}` : target.commit.email}
                  </span>
                </span>
              </dd>
            </div>
            <div className="meta-row">
              <dt className="visually-hidden">Date</dt>
              <dd>
                <span className="meta-icon" aria-hidden="true">
                  <Clock size={13} />
                </span>
                <time
                  className="meta-lines"
                  dateTime={new Date(
                    target.commit.timestamp * 1000,
                  ).toISOString()}
                >
                  <span className="meta-primary">
                    {relativeTime(target.commit.timestamp)}
                  </span>
                  <span className="meta-secondary">
                    {new Date(target.commit.timestamp * 1000).toLocaleString(
                      undefined,
                      {
                        weekday: "short",
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      },
                    )}
                  </span>
                </time>
              </dd>
            </div>
            <div className="meta-row">
              <dt className="visually-hidden">
                {parents.length === 1 ? "Parent" : "Parents"}
              </dt>
              <dd>
                <span className="meta-icon" aria-hidden="true">
                  <GitCommitHorizontal size={14} />
                </span>
                <span className="meta-lines">
                  <span className="meta-primary parents">
                    {parents.length === 0
                      ? "Root commit"
                      : parents.map((parent) => (
                          <button
                            className="sha-chip"
                            key={parent}
                            title={`Open parent ${parent}`}
                            onClick={() =>
                              onSelect({ kind: "commit", oid: parent })
                            }
                          >
                            <code>{parent.slice(0, 7)}</code>
                            <ArrowUpRight size={12} />
                          </button>
                        ))}
                  </span>
                  <span className="meta-secondary">
                    {parents.length === 0
                      ? "No parent"
                      : stashed.length > 0
                        ? "Stashed on this commit"
                        : parents.length === 1
                          ? "Parent"
                          : `Merge of ${parents.length} parents`}
                  </span>
                </span>
              </dd>
            </div>
          </dl>
          <ChangedFiles
            files={detail.files}
            treeKey={target.commit.oid}
            title={`${detail.base.kind === "emptyTree" ? "Compared with the empty tree" : "Compared with the first parent"}. Renames appear as added and deleted paths.`}
            empty="No paths changed against this base."
            open={changesOpen}
            onToggle={() => setChangesOpen(!changesOpen)}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
          />
        </div>
      ) : (
        pending
      )}
    </InspectorFrame>
  );
}

function CompareEnd({
  label,
  commit,
  onSelect,
}: {
  label: "Base" | "Target";
  commit: Commit;
  onSelect: (selection: Selection) => void;
}) {
  return (
    <div className="meta-row">
      <dt className="visually-hidden">{label}</dt>
      <dd>
        <span className="meta-icon" aria-hidden="true">
          <GitCommitHorizontal size={14} />
        </span>
        <span className="meta-lines">
          <span className="meta-primary" title={commit.subject}>
            {commit.subject || "(no subject)"}
          </span>
          <span className="meta-secondary parents">
            <span aria-hidden="true">{label}</span>
            <button
              className="sha-chip"
              title={`Open ${commit.oid}`}
              onClick={() => onSelect({ kind: "commit", oid: commit.oid })}
            >
              <code>{commit.oid.slice(0, 7)}</code>
              <ArrowUpRight size={12} />
            </button>
          </span>
        </span>
      </dd>
    </div>
  );
}

function ChangedFiles({
  files,
  treeKey,
  title,
  empty,
  open,
  onToggle,
  selectedFile,
  onSelectFile,
}: {
  files: ChangedFile[];
  treeKey: string;
  title: string;
  empty: string;
  open: boolean;
  onToggle: () => void;
  selectedFile: OpenedFile | null;
  onSelectFile: (path: string, side: ListSide | null) => void;
}) {
  return (
    <>
      <button
        className="changed-files-heading"
        aria-expanded={open}
        aria-controls="changed-files"
        onClick={onToggle}
        title={title}
      >
        <span className="changed-files-title">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          Changes
          <span className="count">{files.length}</span>
        </span>
        <span className="change-summary">
          {changeKinds.flatMap(({ gitStatus, symbol, label }) => {
            const count = files.filter(
              (file) => changeStatuses[file.status].gitStatus === gitStatus,
            ).length;
            return count === 0
              ? []
              : [
                  <span
                    key={gitStatus}
                    className={`change-stat ${gitStatus}`}
                    title={`${count} ${label}`}
                    aria-label={`${count} ${label}`}
                  >
                    {symbol}
                    {count}
                  </span>,
                ];
          })}
        </span>
      </button>
      {open && (
        <div id="changed-files" className="changed-files">
          {files.length > 0 ? (
            <ChangedFileTree
              key={`${treeKey}\0${files.map((file) => `${file.status}:${file.path}`).join("\0")}`}
              files={files.map((file) => ({
                path: file.path,
                status: changeStatuses[file.status].gitStatus,
              }))}
              selectedPath={selectedFile?.path ?? null}
              onSelectFile={(path) => onSelectFile(path, null)}
            />
          ) : (
            <p className="muted">{empty}</p>
          )}
        </div>
      )}
    </>
  );
}

type OpenedFile = { path: string; side: ListSide | null };

const GROUP_MAX_ROWS = 12;

type RowFocus = { row: string; side: ListSide };

function WorktreeFiles({
  group: { title, files, side },
  selectedFile,
  onSelectFile,
  busy,
  onWrite,
  discardable,
  onDiscard,
  onRowFocus,
  refocusPath,
  onFocused,
}: {
  group: WorktreeGroup;
  selectedFile: OpenedFile | null;
  onSelectFile: (path: string, side: ListSide) => void;
  busy: boolean;
  onWrite: (
    kind: FileWrite,
    side: ListSide,
    paths: string[],
    row?: string,
  ) => void;
  discardable: ReadonlySet<string>;
  onDiscard: (paths: string[], row?: string) => void;
  onRowFocus: (focus: RowFocus) => void;
  refocusPath: string | null;
  onFocused: () => void;
}) {
  const { kind, row, all } = listWrites[side];
  const actions: RowAction[] = [
    {
      label: row,
      disabled: busy,
      run: (paths, target) => onWrite(kind, side, paths, target),
    },
  ];
  const discarding = side === "unstaged";
  if (discarding)
    actions.push({
      label: "Discard changes…",
      disabled: busy,
      run: onDiscard,
      appliesTo: discardable,
    });
  const discardAll =
    discarding && files.some((file) => discardable.has(file.path));
  return (
    <section className="worktree-group" aria-label={title}>
      <header className="worktree-group-header">
        <h3 className="changed-files-title">
          {title}
          <span className="count">{files.length}</span>
        </h3>
        {all !== null && (
          <button
            className="button secondary list-action"
            aria-disabled={busy}
            onClick={() => {
              if (!busy)
                onWrite(
                  kind,
                  side,
                  files.map((file) => file.path),
                );
            }}
          >
            {all}
          </button>
        )}
        {discardAll && (
          <button
            className="button secondary list-action"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onDiscard(files.map((file) => file.path));
            }}
          >
            Discard all…
          </button>
        )}
      </header>
      <ChangedFileTree
        key={files.map((file) => `${file.status}:${file.path}`).join("\0")}
        files={files}
        selectedPath={selectedFile?.side === side ? selectedFile.path : null}
        onSelectFile={(path) => onSelectFile(path, side)}
        maxRows={GROUP_MAX_ROWS}
        actions={actions}
        refocusPath={refocusPath}
        onFocused={onFocused}
        onRowFocus={(row) => onRowFocus({ row, side })}
      />
    </section>
  );
}

function WorktreeInspector({
  worktree,
  changes,
  snapshot,
  onSelect,
  selectedFile,
  onSelectFile,
  onRefresh,
  writes,
}: {
  worktree: Worktree;
  changes: WorktreeChanges | undefined;
  snapshot: RepositorySnapshot;
  onSelect: (selection: Selection) => void;
  selectedFile: OpenedFile | null;
  onSelectFile: (path: string, side: ListSide) => void;
  onRefresh: () => void;
  writes: WorktreeWrites;
}) {
  const [focusAfter, setFocusAfter] = useState<RowFocus | null>(null);
  const clearFocus = useCallback(() => setFocusAfter(null), []);
  const lastRow = useRef<RowFocus | null>(null);
  const resume = useRef<RowFocus | null>(null);
  const lists = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (writes.busy) {
      resume.current ??= lists.current?.contains(document.activeElement)
        ? lastRow.current
        : null;
      return;
    }
    if (resume.current !== null) setFocusAfter(resume.current);
    resume.current = null;
  }, [writes.busy]);
  const groups =
    changes?.kind === "ready"
      ? worktreeGroups(changes.status.entries).filter(
          (group) => group.files.length > 0,
        )
      : [];
  const discardable =
    changes?.kind === "ready"
      ? discardablePaths(changes.status)
      : new Set<string>();
  const listsFocus = (group: WorktreeGroup) =>
    focusAfter !== null && listsRow(group.files, focusAfter.row);
  const focusTarget =
    groups.find(
      (group) => listsFocus(group) && group.side === focusAfter?.side,
    ) ?? groups.find(listsFocus);
  const unlisted = focusAfter !== null && focusTarget === undefined;
  useEffect(() => {
    if (unlisted) clearFocus();
  }, [unlisted, clearFocus]);
  const onWrite = (
    kind: FileWrite,
    side: ListSide,
    paths: string[],
    row?: string,
  ) => {
    const files = groups.find((group) => group.side === side)?.files ?? [];
    const last = lastRow.current;
    const first = changedFileTreeInput(files).paths.at(0);
    resume.current =
      row !== undefined
        ? { row, side }
        : last?.side === side && listsRow(files, last.row)
          ? last
          : first === undefined
            ? null
            : { row: first, side };
    void writes.write(worktree.root, kind, paths);
  };
  const { head } = worktree;
  const branch =
    head.kind === "detached"
      ? null
      : (snapshot.branches.find(
          (candidate) => candidate.reference === head.reference,
        )?.name ?? head.reference.replace(/^refs\/heads\//, ""));
  return (
    <div className="inspector-content">
      <h2>Uncommitted changes</h2>
      <dl className="commit-metadata">
        <div className="meta-row">
          <dt className="visually-hidden">Worktree</dt>
          <dd>
            <span className="meta-icon" aria-hidden="true">
              <FolderGit2 size={13} />
            </span>
            <span className="meta-lines">
              <span className="meta-primary">{worktree.name}</span>
              <span className="meta-secondary" title={worktree.root}>
                {worktree.root}
              </span>
            </span>
          </dd>
        </div>
        <div className="meta-row">
          <dt className="visually-hidden">HEAD</dt>
          <dd>
            <span className="meta-icon" aria-hidden="true">
              <GitCommitHorizontal size={14} />
            </span>
            <span className="meta-lines">
              <span className="meta-primary parents">
                {head.kind === "unborn" ? (
                  "No commits yet"
                ) : (
                  <button
                    className="sha-chip"
                    title={`Open HEAD ${head.oid}`}
                    onClick={() => onSelect({ kind: "commit", oid: head.oid })}
                  >
                    <code>{head.oid.slice(0, 7)}</code>
                    <ArrowUpRight size={12} />
                  </button>
                )}
              </span>
              <span className="meta-secondary">
                {branch === null ? "Detached HEAD" : `On ${branch}`}
              </span>
            </span>
          </dd>
        </div>
      </dl>
      {changes === undefined ? (
        <div className="inspector-empty" role="status">
          <LoaderCircle size={23} className="spin" />
          <p>Reading changes…</p>
        </div>
      ) : changes.kind === "error" ? (
        <div className="inspector-empty">
          {changes.error.kind === "gitFailed" ? (
            <pre className="problem-detail" role="alert">
              {clampMessage(changes.error.message)}
            </pre>
          ) : (
            <p role="alert">{changes.error.message}</p>
          )}
          <button className="button secondary" onClick={onRefresh}>
            Refresh
          </button>
        </div>
      ) : changes.status.entries.length === 0 ? (
        <p className="muted">No uncommitted changes.</p>
      ) : (
        <div className="worktree-groups" ref={lists}>
          {groups.map((group) => (
            <WorktreeFiles
              key={group.title}
              group={group}
              selectedFile={selectedFile}
              onSelectFile={onSelectFile}
              busy={writes.busy}
              onWrite={onWrite}
              discardable={discardable}
              onDiscard={(paths, row) =>
                writes.confirmDiscard(
                  worktree.root,
                  paths,
                  row === undefined
                    ? undefined
                    : () => setFocusAfter({ row, side: "unstaged" }),
                )
              }
              onRowFocus={(focus) => (lastRow.current = focus)}
              refocusPath={
                group === focusTarget ? (focusAfter?.row ?? null) : null
              }
              onFocused={clearFocus}
            />
          ))}
        </div>
      )}
      {changes?.kind === "ready" && (
        <CommitBox
          status={changes.status}
          staged={
            groups.find((group) => group.side === "staged")?.files.length ?? 0
          }
          busy={writes.busy}
          onCommit={writes.commit}
        />
      )}
    </div>
  );
}
