import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { filterPalette } from "../actions";
import type { PaletteItem } from "../actions";

type Props = {
  items: readonly PaletteItem[];
  onClose: () => void;
  onRun: (item: PaletteItem) => void;
};

const KIND_LABEL = {
  action: null,
  repository: "Repository",
  branch: "Branch",
} as const;

export function CommandPalette({ items, onClose, onRun }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const pressedBackdrop = useRef(false);
  const results = useMemo(() => filterPalette(items, query), [items, query]);
  const found = results.findIndex((item) => item.id === activeId);
  const current = found >= 0 ? found : results.length > 0 ? 0 : -1;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useLayoutEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [current, results]);

  const move = (step: number) => {
    const next = results[(current + step + results.length) % results.length];
    if (next) setActiveId(next.id);
  };

  return (
    <dialog
      ref={dialog}
      className="command-palette"
      aria-label="Command palette"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedBackdrop.current)
          onClose();
      }}
    >
      <div className="command-palette-input">
        <Search size={15} />
        <input
          autoFocus
          role="combobox"
          aria-label="Search actions, repositories, and branches"
          aria-expanded={results.length > 0}
          aria-controls={
            results.length > 0 ? "command-palette-results" : undefined
          }
          aria-activedescendant={
            current >= 0 ? `command-palette-${current}` : undefined
          }
          placeholder="Search actions, repositories, and branches"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveId(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const item = results[current];
              if (item) onRun(item);
            }
          }}
        />
      </div>
      {results.length === 0 ? (
        <p className="command-palette-empty" role="status">
          Nothing matches “{query.trim()}”.
        </p>
      ) : (
        <ul
          ref={list}
          id="command-palette-results"
          className="command-palette-results"
          role="listbox"
          aria-label="Results"
        >
          {results.map((item, index) => (
            <li
              key={item.id}
              id={`command-palette-${index}`}
              role="option"
              aria-selected={index === current}
              onMouseMove={() => {
                if (index !== current) setActiveId(item.id);
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onRun(item)}
            >
              <span className="command-palette-title">{item.title}</span>
              {item.detail && (
                <span className="command-palette-detail">{item.detail}</span>
              )}
              {KIND_LABEL[item.kind] && (
                <span className="command-palette-kind">
                  {KIND_LABEL[item.kind]}
                </span>
              )}
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}
