import type { ReactNode } from "react";
import { FileDiff, LoaderCircle } from "lucide-react";

/** What the tab says while it has no file to show. */
export function FilesState({
  title,
  url,
  busy = false,
  onRetry = null,
  children,
}: {
  title: string;
  url: string;
  busy?: boolean;
  onRetry?: (() => void) | null;
  children?: ReactNode;
}) {
  return (
    <div className="pull-empty files-state">
      <span className="no-host-glyph">
        {busy ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <FileDiff size={16} />
        )}
      </span>
      <h3>{title}</h3>
      {children}
      <div className="pull-empty-actions">
        {onRetry && (
          <button type="button" className="button secondary" onClick={onRetry}>
            Try again
          </button>
        )}
        <a
          className="button secondary"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          Open on GitHub
        </a>
      </div>
    </div>
  );
}

const bones = [38, 52, 24, 61, 47, 33, 58, 20, 44, 55];

export function ReadingFiles() {
  return (
    <div className="detail-skeleton files-skeleton" aria-hidden="true">
      {bones.map((width, index) => (
        <i key={index} style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}
