import { useLayoutEffect, useMemo, useRef } from "react";
import { ArrowLeft, FileX2, LoaderCircle, TriangleAlert } from "lucide-react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { diffTheme } from "../themes/diffTheme";
import type { Appearance } from "../themes/palette";
import type { FilePatch, SubmoduleState } from "../domain/repository";
import { clampMessage, conflictLabels } from "../domain/worktree";
import type { ListSide } from "../domain/worktree";
import type { FileDiffState } from "../useWorkspace";

export type DiffStyle = "unified" | "split";

type Props = {
  state: Exclude<FileDiffState, { kind: "closed" }>;
  diffStyle: DiffStyle;
  theme: Appearance;
  /** Whether the theme paints its own palette, which L1 does not. */
  painted: boolean;
  onDiffStyle: (style: DiffStyle) => void;
  onBack: () => void;
  onRetry: () => void;
  onRefresh: () => void;
};

export function FileDiffPane({
  state,
  diffStyle,
  theme,
  painted,
  onDiffStyle,
  onBack,
  onRetry,
  onRefresh,
}: Props) {
  const backRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(function takeFocusFromHiddenHistory() {
    const focused = document.activeElement;
    if (
      focused === null ||
      focused === document.body ||
      focused.closest(".history")
    )
      backRef.current?.focus();
  }, []);
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
        <div className="diff-style" role="group" aria-label="Diff layout">
          {(["unified", "split"] as const).map((style) => (
            <button
              key={style}
              aria-pressed={diffStyle === style}
              onClick={() => onDiffStyle(style)}
            >
              {style === "unified" ? "Unified" : "Split"}
            </button>
          ))}
        </div>
      </header>
      {state.kind === "loading" ? (
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
            <Diff
              diff={state.patch.diff}
              diffStyle={diffStyle}
              theme={theme}
              painted={painted}
            />
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
        <Diff
          diff={state.patch.diff}
          diffStyle={diffStyle}
          theme={theme}
          painted={painted}
        />
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

function Diff({
  diff,
  diffStyle,
  theme,
  painted,
}: {
  diff: FilePatch;
  diffStyle: DiffStyle;
  theme: Appearance;
  painted: boolean;
}) {
  if (diff.kind !== "text")
    return (
      <div className="file-diff-empty">
        <FileX2 size={28} />
        <p>
          {diff.kind === "binary"
            ? "Binary file. L1 Git does not display binary changes."
            : `This change is ${(diff.bytes / 1024 / 1024).toFixed(1)} MiB, above the 1 MiB display limit.`}
        </p>
      </div>
    );
  return (
    <>
      {diff.lossy && (
        <div className="notice error-notice" role="status">
          <TriangleAlert size={14} />
          <span>
            This file is not valid UTF-8. Bytes that are not UTF-8 appear as �,
            so some changed lines can look identical.
          </span>
        </div>
      )}
      <Patch
        patch={diff.patch}
        diffStyle={diffStyle}
        theme={theme}
        painted={painted}
      />
    </>
  );
}

function Patch({
  patch,
  diffStyle,
  theme,
  painted,
}: {
  patch: string;
  diffStyle: DiffStyle;
  theme: Appearance;
  painted: boolean;
}) {
  const files = useMemo(
    () => parsePatchFiles(patch).flatMap((parsed) => parsed.files),
    [patch],
  );
  const options = useMemo(
    () =>
      ({
        theme: diffTheme(theme, painted),
        themeType: theme,
        diffStyle,
        disableFileHeader: true,
      }) as const,
    [diffStyle, theme, painted],
  );
  if (files.every((file) => file.hunks.length === 0)) {
    const moved = files.find(
      (file) => file.prevName !== undefined && file.prevName !== file.name,
    );
    return (
      <div className="file-diff-empty">
        <p>
          {moved
            ? `${/^copy from /m.test(patch) ? "Copied" : "Renamed"} from ${moved.prevName}. The content did not change.`
            : "No content changes. Only the file mode or an empty file changed."}
        </p>
      </div>
    );
  }
  return (
    <Virtualizer className="file-diff-scroll">
      {files.map((file, index) => (
        <FileDiff key={index} fileDiff={file} options={options} />
      ))}
    </Virtualizer>
  );
}
