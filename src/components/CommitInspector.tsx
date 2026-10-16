import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  GitCommitHorizontal,
  LoaderCircle,
  X,
} from "lucide-react";
import type {
  Oid,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
import type { DetailState } from "../useWorkspace";
import { ChangedFileTree, changeStatuses } from "./ChangedFileTree";

type Props = {
  state: DetailState;
  root: RepositoryRoot;
  selectedOid: Oid | null;
  snapshot: RepositorySnapshot;
  onSelect: (oid: Oid) => void;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  onClose: () => void;
  onRetry: () => void;
};

export function CommitInspector({
  state,
  root,
  selectedOid,
  snapshot,
  onSelect,
  selectedFile,
  onSelectFile,
  onClose,
  onRetry,
}: Props) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    setCopy("idle");
  }, [selectedOid]);
  const detail =
    state.kind === "ready" && state.root === root && state.oid === selectedOid
      ? state.detail
      : null;
  const error =
    state.kind === "error" && state.root === root && state.oid === selectedOid
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
    <aside className="inspector" aria-label="Commit inspector">
      <div className="inspector-heading">
        <span>Commit details</span>
        <button
          className="icon-button"
          aria-label="Hide inspector"
          title="Hide inspector"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      {detail ? (
        <div className="inspector-content">
          <div className="inspector-sha">
            <code>{detail.commit.oid}</code>
            <button
              className="icon-button"
              onClick={() => void copySha(detail.commit.oid)}
              aria-label="Copy commit SHA"
              title={copy === "copied" ? "Copied" : "Copy commit SHA"}
            >
              {copy === "copied" ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          {copy !== "idle" && (
            <p
              className={copy === "failed" ? "copy-error" : "copy-status"}
              role="status"
            >
              {copy === "copied"
                ? "Commit SHA copied"
                : "Could not copy. Select the SHA above to copy it."}
            </p>
          )}
          <h2>{detail.commit.subject || "(no subject)"}</h2>
          <pre className="commit-message">
            {detail.message.slice(detail.message.indexOf("\n") + 1).trim()}
          </pre>
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
            <dt>Author</dt>
            <dd>
              {detail.commit.author}
              <span className="author-email">{detail.commit.email}</span>
            </dd>
            <dt>Date</dt>
            <dd>
              {new Date(detail.commit.timestamp * 1000).toLocaleString(
                undefined,
                { dateStyle: "medium", timeStyle: "short" },
              )}
            </dd>
            <dt>{detail.commit.parents.length === 1 ? "Parent" : "Parents"}</dt>
            <dd>
              {detail.commit.parents.length === 0 ? (
                <span className="muted">Root commit</span>
              ) : (
                detail.commit.parents.map((parent) => (
                  <button
                    className="parent-link"
                    key={parent}
                    title={parent}
                    onClick={() => onSelect(parent)}
                  >
                    {parent.slice(0, 7)}
                  </button>
                ))
              )}
            </dd>
          </dl>
          <div className="changed-files-heading">
            <span>
              {detail.files.length}{" "}
              {detail.files.length === 1 ? "file" : "files"} changed
            </span>
            <span className="change-summary">
              {Object.entries(changeStatuses)
                .flatMap(([status, { label }]) => {
                  const count = detail.files.filter(
                    (file) => file.status === status,
                  ).length;
                  return count === 0 ? [] : [`${count} ${label}`];
                })
                .join(" · ")}
            </span>
          </div>
          <p className="diff-policy">
            {detail.diffBase === "emptyTree"
              ? "Compared with the empty tree"
              : "Compared with the first parent"}
            . Renames appear as added and deleted paths.
          </p>
          {detail.files.length > 0 && (
            <ChangedFileTree
              key={detail.commit.oid}
              files={detail.files}
              selectedPath={selectedFile}
              onSelectFile={onSelectFile}
            />
          )}
          {detail.files.length === 0 && (
            <p className="muted">No paths changed against this base.</p>
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
          {selectedOid ? (
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
    </aside>
  );
}
