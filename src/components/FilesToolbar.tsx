import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, File, Rows2 } from "lucide-react";
import { lineTotals, pathLabel } from "../domain/filesChanged";
import type { DiffStyle } from "../domain/lineSelection";
import { counted } from "../domain/pullRequestDetail";
import type { RangeFile } from "../domain/range";
import { viewedCount } from "../domain/viewedFiles";
import type { FilesChangedState, FilesView } from "../shell/useFilesChanged";
import { FileTotals, StatusPill, ViewedBox } from "./FileParts";
import { LineTotals } from "./LineTotals";

const styles: { style: DiffStyle; label: string }[] = [
  { style: "unified", label: "Unified" },
  { style: "split", label: "Split" },
];
const views = [
  { view: "one", label: "One file", Icon: File },
  { view: "all", label: "All files", Icon: Rows2 },
] as const satisfies { view: FilesView; label: string; Icon: typeof File }[];

function OneFile({
  file,
  at,
  count,
  isViewed,
  onGo,
  onMark,
}: {
  file: RangeFile;
  at: number;
  count: number;
  isViewed: boolean;
  onGo: (at: number) => void;
  onMark: (isViewed: boolean) => void;
}) {
  const label = pathLabel(file);
  return (
    <>
      <div className="files-steps" role="group" aria-label="Files">
        <button
          type="button"
          aria-label="Previous file"
          title="Previous file (K)"
          aria-disabled={at === 0}
          onClick={() => onGo(at - 1)}
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <span className="files-position">
          {(at + 1).toLocaleString()} of {count.toLocaleString()}
        </span>
        <button
          type="button"
          aria-label="Next file"
          title="Next file (J)"
          aria-disabled={at === count - 1}
          onClick={() => onGo(at + 1)}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      <span className="file-diff-path" title={label}>
        <bdi>{label}</bdi>
      </span>
      <StatusPill file={file} />
      <FileTotals file={file} />
      <ViewedBox isCurrent isViewed={isViewed} onMark={onMark} />
    </>
  );
}

export function FilesToolbar({
  files,
  contentMissing,
  at,
  state: { diffStyle, view, setLook, viewed, mark, go },
  children,
}: {
  files: readonly RangeFile[];
  contentMissing: boolean;
  at: number;
  state: FilesChangedState;
  /** At its end. */
  children?: ReactNode;
}) {
  const file = files[at];
  return (
    <header className="file-diff-toolbar files-toolbar">
      {view === "all" ? (
        <span className="files-all">
          <strong>{counted(files.length, "file")}</strong>
          {!contentMissing && <LineTotals {...lineTotals(files)} />}
          <span className="files-viewed-count">
            · Viewed {viewedCount(viewed.size, files.length)}
          </span>
        </span>
      ) : (
        file && (
          <OneFile
            file={file}
            at={at}
            count={files.length}
            isViewed={viewed.has(file)}
            onGo={go}
            onMark={(isViewed) => mark(file, isViewed)}
          />
        )
      )}
      <div
        className="diff-style"
        data-view={diffStyle}
        role="group"
        aria-label="Diff layout"
      >
        {styles.map(({ style, label }) => (
          <button
            key={style}
            type="button"
            aria-pressed={diffStyle === style}
            onClick={() => setLook({ diffStyle: style })}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="files-views" role="group" aria-label="Files shown">
        {views.map(({ view: each, label, Icon }) => (
          <button
            key={each}
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={view === each}
            onClick={() => setLook({ view: each })}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>
      {children}
    </header>
  );
}
