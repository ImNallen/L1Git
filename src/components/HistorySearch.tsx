import type { RefObject } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

export function HistorySearch({
  inputRef,
  query,
  count,
  canStep,
  onQuery,
  onStep,
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  count: string;
  canStep: boolean;
  onQuery: (query: string) => void;
  onStep: (by: 1 | -1) => void;
  onClose: () => void;
}) {
  return (
    <div className="history-search" role="search">
      <Search size={14} />
      <input
        ref={inputRef}
        aria-label="Search loaded history"
        placeholder="Search subjects, authors, emails, and SHAs"
        spellCheck={false}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="history-search-count" role="status">
        {count}
      </span>
      <button
        className="icon-button"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!canStep}
        onClick={() => onStep(-1)}
      >
        <ChevronUp size={15} />
      </button>
      <button
        className="icon-button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!canStep}
        onClick={() => onStep(1)}
      >
        <ChevronDown size={15} />
      </button>
      <button
        className="icon-button"
        aria-label="Close history search"
        title="Close (Escape)"
        onClick={onClose}
      >
        <X size={15} />
      </button>
    </div>
  );
}
