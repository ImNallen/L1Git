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
  const [active, setActive] = useState(0);
  const results = useMemo(() => filterPalette(items, query), [items, query]);
  const current = Math.min(active, results.length - 1);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useLayoutEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [current, results]);

  const move = (step: number) => {
    if (results.length === 0) return;
    setActive((current + step + results.length) % results.length);
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
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="command-palette-input">
        <Search size={15} />
        <input
          autoFocus
          role="combobox"
          aria-label="Search actions, repositories, and branches"
          aria-expanded="true"
          aria-controls="command-palette-results"
          aria-activedescendant={
            current >= 0 ? `command-palette-${current}` : undefined
          }
          placeholder="Search actions, repositories, and branches"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
            } else if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing
            ) {
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
                if (index !== current) setActive(index);
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

const TEXT_INPUTS = new Set(["text", "search", "url", "email", "password"]);

export function typingIn(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type)))
  );
}
