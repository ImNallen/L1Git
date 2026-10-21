import { useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { Ref } from "react";
import { ArrowLeft, FileX2, LoaderCircle, TriangleAlert } from "lucide-react";
import type { Appearance } from "../themes/palette";
import type { Oid, SubmoduleState } from "../domain/repository";
import { clampMessage, conflictLabels } from "../domain/worktree";
import type { ListSide } from "../domain/worktree";
import type { FileDiffState } from "../useWorkspace";
import { Diff } from "./FilePatchView";
import type { DiffStyle } from "./FilePatchView";
import { FileBlame, FileHistory } from "./FileRevisions";
import type { Revision } from "./FileRevisions";

export type { DiffStyle };

export type View = DiffStyle | "history" | "blame";

export type FileDiffHandle = {
  show: (view: View) => void;
  focus: () => void;
};

const VIEWS: { view: View; label: string }[] = [
  { view: "unified", label: "Unified" },
  { view: "split", label: "Split" },
  { view: "history", label: "History" },
  { view: "blame", label: "Blame" },
];

type Props = {
  ref?: Ref<FileDiffHandle>;
  state: Exclude<FileDiffState, { kind: "closed" }>;
  diffStyle: DiffStyle;
  theme: Appearance;
  /** Whether the theme paints its own palette, which L1 does not. */
  painted: boolean;
  onDiffStyle: (style: DiffStyle) => void;
  onBack: () => void;
  onRetry: () => void;
  onRefresh: () => void;
  selectable: (oid: Oid) => boolean;
  onSelectCommit: (oid: Oid) => void;
};

/** History and blame read the file in the target commit, which a worktree does not have. */
export function revisionOf(state: Props["state"]): Revision | null {
  if (state.side !== null || state.comparison.target.kind !== "commit")
    return null;
  return {
    root: state.root,
    oid: state.comparison.target.oid,
    path: state.path,
  };
}

export function FileDiffPane({
  ref,
  state,
  diffStyle,
  theme,
  painted,
  onDiffStyle,
  onBack,
  onRetry,
  onRefresh,
  selectable,
  onSelectCommit,
}: Props) {
  const backRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<"diff" | "history" | "blame">("diff");
  const revision = revisionOf(state);
  const view: View = revision === null || mode === "diff" ? diffStyle : mode;
  useLayoutEffect(function takeFocusFromHiddenHistory() {
    const focused = document.activeElement;
    if (
      focused === null ||
      focused === document.body ||
      focused.closest(".history")
    )
      backRef.current?.focus();
  }, []);
  const choose = (next: View) => {
    if (next === "history" || next === "blame") setMode(next);
    else {
      setMode("diff");
      onDiffStyle(next);
    }
  };
  useImperativeHandle(ref, () => ({
    show: choose,
    focus: () => backRef.current?.focus(),
  }));
  const look = { diffStyle, theme, painted };
  return (
    <section className="file-diff" aria-label={`Changes to ${state.path}`}>
      <header className="file-diff-toolbar">
        <button
          ref={backRef}
          className="button secondary"
          onClick={onBack}
          title="Back to history (Esc)"
        >
          <ArrowLeft size={14} />
          <span>Back to history</span>
        </button>
        <span className="file-diff-path" title={state.path}>
          {state.path}
        </span>
        {state.side !== null && (
          <span className="file-diff-side">{sideLabels[state.side]}</span>
        )}
        <div className="diff-style" role="group" aria-label="File view">
          {VIEWS.map(({ view: each, label }) => {
            const needsCommit =
              revision === null && (each === "history" || each === "blame");
            return (
              <button
                key={each}
                aria-pressed={view === each}
                disabled={needsCommit}
                title={
                  needsCommit
                    ? "History and blame need a commit. Select a commit to read this file's history."
                    : undefined
                }
                onClick={() => choose(each)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </header>
      {revision !== null && view === "history" ? (
        <FileHistory revision={revision} {...look} />
      ) : revision !== null && view === "blame" ? (
        <FileBlame
          revision={revision}
          theme={theme}
          painted={painted}
          selectable={selectable}
          onSelectCommit={onSelectCommit}
        />
      ) : state.kind === "loading" ? (
        <div className="file-diff-empty" role="status">
          <LoaderCircle size={23} className="spin" />
          <p>Reading changes…</p>
        </div>
      ) : state.kind === "error" ? (
        <div className="file-diff-empty">
          {state.error.kind === "gitFailed" ? (
            <pre className="problem-detail" role="alert">
              {clampMessage(state.error.message)}
            </pre>
          ) : (
            <p role="alert">{state.error.message}</p>
          )}
          {state.error.kind !== "unsupportedPath" && (
            <button
              className="button secondary"
              onClick={
                state.error.kind === "unreadablePath" ||
                state.error.kind === "unchangedPath"
                  ? onRefresh
                  : onRetry
              }
            >
              {state.error.kind === "unreadablePath" ||
              state.error.kind === "unchangedPath"
                ? "Refresh"
                : "Retry"}
            </button>
          )}
        </div>
      ) : state.patch.kind === "submodule" ? (
        <div className="file-diff-empty">
          <FileX2 size={28} />
          <p>{submoduleText(state.patch.submodule)}</p>
        </div>
      ) : state.patch.kind === "conflicted" ? (
        <>
          <div className="notice error-notice" role="status">
            <TriangleAlert size={14} />
            <span>
              {conflictLabels[state.patch.conflict]}. Resolve the conflict
              outside L1 Git, then refresh.
            </span>
          </div>
          {state.patch.diff ? (
            <Diff diff={state.patch.diff} {...look} />
          ) : (
            <div className="file-diff-empty">
              <p>
                No diff against HEAD. The file matches HEAD, is gone from the
                worktree, or is a submodule.
              </p>
            </div>
          )}
        </>
      ) : (
        <Diff diff={state.patch.diff} {...look} />
      )}
    </section>
  );
}

const sideLabels: Record<ListSide, string> = {
  staged: "Staged",
  unstaged: "Unstaged",
  conflict: "Conflict",
};

function submoduleText(submodule: SubmoduleState): string {
  const parts = [
    submodule.commitChanged && "its recorded commit changed",
    submodule.modified && "it has modified files",
    submodule.untracked && "it has untracked files",
  ].filter(Boolean);
  return `This is a submodule${parts.length > 0 ? `, and ${parts.join(", ")}` : ""}. L1 Git does not show the changes inside it.`;
}
