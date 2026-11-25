import { shownPath, statusWord } from "../domain/filesChanged";
import type { RangeFile } from "../domain/range";
import { LineTotals } from "./LineTotals";

export function StatusPill({ file }: { file: RangeFile }) {
  const word = statusWord(file);
  return (
    word && <span className={`files-status ${word.tone}`}>{word.word}</span>
  );
}

/** Nothing for a file without changed lines. */
export function FileTotals({ file: { added, deleted } }: { file: RangeFile }) {
  return added !== null && added + (deleted ?? 0) > 0 ? (
    <LineTotals added={added} deleted={deleted} />
  ) : null;
}

export function ViewedBox({
  name = "Viewed",
  isCurrent,
  isViewed,
  onMark,
}: {
  name?: string;
  isCurrent: boolean;
  isViewed: boolean;
  onMark: (isViewed: boolean) => void;
}) {
  return (
    <label
      className="files-viewed"
      title={isCurrent ? "Viewed (V)" : undefined}
    >
      <input
        type="checkbox"
        aria-label={name}
        checked={isViewed}
        onChange={(event) => onMark(event.target.checked)}
      />
      <span>Viewed</span>
    </label>
  );
}

/** What changed besides lines. */
export function Moved({
  file: { from, similarity },
  mode,
}: {
  file: RangeFile;
  mode: string | null;
}) {
  if (from === null && mode === null) return null;
  return (
    <p className="files-moved">
      {from !== null && (
        <>
          Moved from{" "}
          <code>
            <bdi>{shownPath(from)}</bdi>
          </code>
          {similarity !== null && similarity < 100 && (
            <span> · {similarity}% the same.</span>
          )}{" "}
        </>
      )}
      {mode}
    </p>
  );
}
