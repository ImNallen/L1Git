import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  GitCommitHorizontal,
  LoaderCircle,
} from "lucide-react";
import { githubHandle, initials } from "../domain/author";
import type {
  Oid,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
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
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  toggleButton: ReactNode;
  onRetry: () => void;
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
                  files={detail.files}
                  selectedPath={selectedFile}
                  onSelectFile={onSelectFile}
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
