import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
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
import type {
  Oid,
  RepositoryRoot,
  RepositorySnapshot,
  Worktree,
} from "../domain/repository";
import { clampMessage, worktreeGroups } from "../domain/worktree";
import type {
  ListSide,
  WorktreeChanges,
  WorktreeGroup,
} from "../domain/worktree";
import { sameSelection } from "../domain/selection";
import type { Selection } from "../domain/selection";
import { relativeTime } from "../domain/time";
import type { DetailState } from "../useWorkspace";
import { ChangedFileTree, changeStatuses } from "./ChangedFileTree";

type Props = {
  state: DetailState;
  root: RepositoryRoot;
  selection: Selection | null;
  snapshot: RepositorySnapshot;
  onSelect: (selection: Selection) => void;
  selectedFile: OpenedFile | null;
  onSelectFile: (path: string, side: ListSide | null) => void;
  toggleButton: ReactNode;
  onRetry: () => void;
  worktree: { worktree: Worktree; changes: WorktreeChanges | undefined } | null;
  onRefreshChanges: () => void;
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
  snapshot,
  onSelect,
  selectedFile,
  onSelectFile,
  toggleButton,
  onRetry,
  worktree,
  onRefreshChanges,
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
  const detail =
    state.kind === "ready" &&
    state.root === root &&
    sameSelection(state.selection, selection)
      ? state.detail
      : null;
  const handle = detail && githubHandle(detail.commit.email);
  const error =
    state.kind === "error" &&
    state.root === root &&
    sameSelection(state.selection, selection)
      ? state.error
      : null;

  async function copySha(oid: Oid) {
    try {
      await navigator.clipboard.writeText(oid);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  if (selection?.kind === "worktree")
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
          />
        ) : (
          <div className="inspector-empty">
            <p>This worktree is no longer listed.</p>
          </div>
        )}
      </InspectorFrame>
    );

  return (
    <InspectorFrame
      toggleButton={toggleButton}
      heading={
        detail && (
          <button
            className={`sha-chip ${copy}`}
            onClick={() => void copySha(detail.commit.oid)}
            aria-label={`Copy commit SHA ${detail.commit.oid}`}
            title={copy === "copied" ? "Copied" : `Copy ${detail.commit.oid}`}
          >
            <code>{detail.commit.oid.slice(0, 7)}</code>
            {copy === "copied" ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )
      }
    >
      {detail ? (
        <div className="inspector-content">
          <span className="visually-hidden" role="status">
            {copy === "copied" ? "Commit SHA copied" : ""}
          </span>
          {copy === "failed" && (
            <p className="copy-error">
              Could not copy. Select the SHA to copy it:{" "}
              <code>{detail.commit.oid}</code>
            </p>
          )}
          <h2>{detail.commit.subject || "(no subject)"}</h2>
          <CommitMessage
            key={`message:${detail.commit.oid}`}
            body={detail.message.slice(detail.message.indexOf("\n") + 1).trim()}
          />
          <div className="inspector-refs">
            {snapshot.branches
              .filter((branch) => branch.oid === detail.commit.oid)
              .map((branch) => (
                <span
                  className={`ref-badge ${branch.kind}`}
                  key={branch.reference}
                >
                  {branch.name}
                </span>
              ))}
          </div>
          <dl className="commit-metadata">
            <div className="meta-row">
              <dt className="visually-hidden">Author</dt>
              <dd>
                <span className="meta-icon avatar" aria-hidden="true">
                  {initials(detail.commit.author)}
                </span>
                <span className="meta-lines">
                  <span className="meta-primary">{detail.commit.author}</span>
                  <span className="meta-secondary" title={detail.commit.email}>
                    {handle ? `@${handle}` : detail.commit.email}
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
                    detail.commit.timestamp * 1000,
                  ).toISOString()}
                >
                  <span className="meta-primary">
                    {relativeTime(detail.commit.timestamp)}
                  </span>
                  <span className="meta-secondary">
                    {new Date(detail.commit.timestamp * 1000).toLocaleString(
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
                {detail.commit.parents.length === 1 ? "Parent" : "Parents"}
              </dt>
              <dd>
                <span className="meta-icon" aria-hidden="true">
                  <GitCommitHorizontal size={14} />
                </span>
                <span className="meta-lines">
                  <span className="meta-primary parents">
                    {detail.commit.parents.length === 0
                      ? "Root commit"
                      : detail.commit.parents.map((parent) => (
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
                    {detail.commit.parents.length === 0
                      ? "No parent"
                      : detail.commit.parents.length === 1
                        ? "Parent"
                        : `Merge of ${detail.commit.parents.length} parents`}
                  </span>
                </span>
              </dd>
            </div>
          </dl>
          <button
            className="changed-files-heading"
            aria-expanded={changesOpen}
            aria-controls="changed-files"
            onClick={() => setChangesOpen(!changesOpen)}
            title={`${detail.diffBase === "emptyTree" ? "Compared with the empty tree" : "Compared with the first parent"}. Renames appear as added and deleted paths.`}
          >
            <span className="changed-files-title">
              {changesOpen ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
              Changes
              <span className="count">{detail.files.length}</span>
            </span>
            <span className="change-summary">
              {changeKinds.flatMap(({ gitStatus, symbol, label }) => {
                const count = detail.files.filter(
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
          {changesOpen && (
            <div id="changed-files" className="changed-files">
              {detail.files.length > 0 ? (
                <ChangedFileTree
                  key={detail.commit.oid}
                  files={detail.files.map((file) => ({
                    path: file.path,
                    status: changeStatuses[file.status].gitStatus,
                  }))}
                  selectedPath={selectedFile?.path ?? null}
                  onSelectFile={(path) => onSelectFile(path, null)}
                />
              ) : (
                <p className="muted">No paths changed against this base.</p>
              )}
            </div>
          )}
        </div>
      ) : error ? (
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
              <p>Reading commit…</p>
            </>
          ) : (
            <>
              <GitCommitHorizontal size={30} />
              <p>Select a commit to inspect it.</p>
            </>
          )}
        </div>
      )}
    </InspectorFrame>
  );
}

type OpenedFile = { path: string; side: ListSide | null };

const GROUP_MAX_ROWS = 12;

function WorktreeFiles({
  group: { title, files, side },
  selectedFile,
  onSelectFile,
}: {
  group: WorktreeGroup;
  selectedFile: OpenedFile | null;
  onSelectFile: (path: string, side: ListSide) => void;
}) {
  return (
    <section className="worktree-group" aria-label={title}>
      <h3 className="changed-files-title">
        {title}
        <span className="count">{files.length}</span>
      </h3>
      <ChangedFileTree
        key={files.map((file) => `${file.status}:${file.path}`).join("\0")}
        files={files}
        selectedPath={selectedFile?.side === side ? selectedFile.path : null}
        onSelectFile={(path) => onSelectFile(path, side)}
        maxRows={GROUP_MAX_ROWS}
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
}: {
  worktree: Worktree;
  changes: WorktreeChanges | undefined;
  snapshot: RepositorySnapshot;
  onSelect: (selection: Selection) => void;
  selectedFile: OpenedFile | null;
  onSelectFile: (path: string, side: ListSide) => void;
  onRefresh: () => void;
}) {
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
        <div className="worktree-groups">
          {worktreeGroups(changes.status.entries)
            .filter((group) => group.files.length > 0)
            .map((group) => (
              <WorktreeFiles
                key={group.title}
                group={group}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
              />
            ))}
        </div>
      )}
    </div>
  );
}
