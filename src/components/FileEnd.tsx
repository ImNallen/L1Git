import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { DIFFS_TAG_NAME } from "@pierre/diffs";
import { ChevronRight } from "lucide-react";
import { pathLabel } from "../domain/filesChanged";
import type { RangeFile } from "../domain/range";

const markLabel = (isViewed: boolean) =>
  isViewed ? "Mark unviewed" : "Mark viewed";

/** What to do at the end of the file, where one file shows at a time. */
export function EndOfOne({
  isViewed,
  onMark,
  onNextUnviewed,
  onNext,
}: {
  isViewed: boolean;
  onMark: (isViewed: boolean) => void;
  /** Null when no other file is left to view. */
  onNextUnviewed: (() => void) | null;
  onNext: (() => void) | null;
}) {
  return (
    <div className="files-next">
      {isViewed && onNextUnviewed === null && <span>All files viewed</span>}
      <button
        type="button"
        className={`button ${isViewed || onNextUnviewed ? "secondary" : "primary"}`}
        title={`${markLabel(isViewed)} (V)`}
        onClick={() => onMark(!isViewed)}
      >
        {markLabel(isViewed)}
      </button>
      {onNextUnviewed ? (
        <button
          type="button"
          className="button primary"
          onClick={() => {
            if (!isViewed) onMark(true);
            onNextUnviewed();
          }}
        >
          {isViewed ? "Next unviewed file" : "Mark viewed, next file"}
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      ) : (
        onNext && (
          <button
            type="button"
            className="button secondary"
            title="Next file (J)"
            onClick={onNext}
          >
            Next file
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        )
      )}
    </div>
  );
}

const SLOT = "file-end";

function roomForEnd() {
  const room = document.createElement("div");
  room.setAttribute("data-file-end", "");
  const slot = document.createElement("slot");
  slot.name = SLOT;
  room.append(slot);
  return room;
}

/** Makes room after the lines that Pierre draws of a file. */
export function holdEnd({ shadowRoot: root }: HTMLElement) {
  if (!root || root.lastElementChild?.hasAttribute("data-file-end")) return;
  root.append(root.querySelector("[data-file-end]") ?? roomForEnd());
}

/** The end of one of the files that show one after the other. */
export function EndOfEach({
  file,
  isCurrent,
  isViewed,
  onMark,
}: {
  file: RangeFile;
  isCurrent: boolean;
  isViewed: boolean;
  onMark: (isViewed: boolean) => void;
}) {
  const [drawn, setDrawn] = useState<Element | null>(null);
  const find = useCallback(
    (node: Element | null) => setDrawn(node?.closest(DIFFS_TAG_NAME) ?? null),
    [],
  );
  const label = pathLabel(file);
  const mark = markLabel(isViewed);
  return (
    <>
      <span hidden ref={find} />
      {drawn &&
        createPortal(
          <div className="files-end" slot={SLOT}>
            <span>End of</span>
            <span className="file-diff-path" title={label}>
              <bdi>{label}</bdi>
            </span>
            {isCurrent && <span aria-hidden="true">V</span>}
            <button
              type="button"
              className="button secondary"
              aria-label={`${mark}, ${label}`}
              title={isCurrent ? `${mark} (V)` : undefined}
              onClick={() => onMark(!isViewed)}
            >
              {mark}
            </button>
          </div>,
          drawn,
        )}
    </>
  );
}
