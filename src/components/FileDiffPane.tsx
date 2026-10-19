import { useMemo } from "react";
import { ArrowLeft, FileX2, LoaderCircle, TriangleAlert } from "lucide-react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { diffTheme } from "../themes/diffTheme";
import type { Appearance } from "../themes/palette";
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
};

export function FileDiffPane({
  state,
  diffStyle,
  theme,
  painted,
  onDiffStyle,
  onBack,
  onRetry,
}: Props) {
  return (
    <section className="file-diff" aria-label={`Changes to ${state.path}`}>
      <header className="file-diff-toolbar">
        <button
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
          <p role="alert">{state.error.message}</p>
          <button className="button secondary" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : state.patch.kind === "text" ? (
        <>
          {state.patch.lossy && (
            <div className="notice error-notice" role="status">
              <TriangleAlert size={14} />
              <span>
                This file is not valid UTF-8. Bytes that are not UTF-8 appear as
                �, so some changed lines can look identical.
              </span>
            </div>
          )}
          <Patch
            patch={state.patch.patch}
            diffStyle={diffStyle}
            theme={theme}
            painted={painted}
          />
        </>
      ) : (
        <div className="file-diff-empty">
          <FileX2 size={28} />
          <p>
            {state.patch.kind === "binary"
              ? "Binary file. L1 Git does not display binary changes."
              : `This patch is ${(state.patch.bytes / 1024 / 1024).toFixed(1)} MiB, above the 1 MiB display limit.`}
          </p>
        </div>
      )}
    </section>
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
  if (files.every((file) => file.hunks.length === 0))
    return (
      <div className="file-diff-empty">
        <p>No content changes. Only the file mode or an empty file changed.</p>
      </div>
    );
  return (
    <Virtualizer className="file-diff-scroll">
      {files.map((file, index) => (
        <FileDiff key={index} fileDiff={file} options={options} />
      ))}
    </Virtualizer>
  );
}
