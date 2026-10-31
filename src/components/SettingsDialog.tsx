import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Settings, Palette, Search, X } from "lucide-react";
import type { SettingsSection } from "../actions";
import { searchSettings } from "../settingsSearch";

const settingsSections = [
  { section: "general", label: "General", Icon: Settings },
  { section: "appearance", label: "Appearance", Icon: Palette },
] as const satisfies readonly {
  section: SettingsSection;
  label: string;
  Icon: typeof Palette;
}[];

type Props = {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  children: ReactNode;
};

export function SettingsDialog({
  section,
  onSectionChange,
  onClose,
  children,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [destination, setDestination] = useState<{ targetId: string } | null>(
    null,
  );
  const results = searchSettings(query);
  const searching = query.trim().length > 0;
  const pressedBackdrop = useRef(false);
  useLayoutEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    const target = destination
      ? dialog.current?.querySelector<HTMLElement>(`#${destination.targetId}`)
      : dialog.current?.querySelector<HTMLElement>(".settings-page h1");
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
  }, [section, destination]);

  const close = () => {
    dialog.current?.close();
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      aria-label="Settings"
      onKeyDown={(event) => {
        if (!(event.target instanceof HTMLElement)) return;
        if (event.target.closest("dialog") !== event.currentTarget) return;
        if (
          event.key === "/" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.target.closest(
            "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
          )
        ) {
          event.preventDefault();
          search.current?.focus();
        }
      }}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedBackdrop.current)
          close();
      }}
    >
      <aside className="settings-navigation">
        <div className="settings-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={search}
            type="search"
            aria-label="Search settings"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (
                ["ArrowDown", "ArrowUp", "Enter"].includes(event.key) &&
                searching
              ) {
                event.preventDefault();
                const buttons =
                  dialog.current?.querySelectorAll<HTMLButtonElement>(
                    ".settings-search-result",
                  );
                const first =
                  event.key === "ArrowUp"
                    ? buttons?.[buttons.length - 1]
                    : buttons?.[0];
                if (event.key === "Enter") first?.click();
                else first?.focus();
              }
            }}
          />
          {query ? (
            <button
              className="icon-button"
              aria-label="Clear settings search"
              onClick={() => {
                setQuery("");
                search.current?.focus();
              }}
            >
              <X size={12} />
            </button>
          ) : (
            <kbd aria-hidden="true">/</kbd>
          )}
        </div>
        <nav aria-label="Settings sections">
          {settingsSections.map(({ section: value, label, Icon }) => (
            <button
              key={value}
              className="settings-nav-item"
              aria-current={section === value ? "page" : undefined}
              onClick={() => {
                setQuery("");
                setDestination(null);
                onSectionChange(value);
              }}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
        {searching && (
          <div
            className="settings-search-results"
            role="region"
            aria-label="Settings search results"
            onKeyDown={(event) => {
              if (!(event.target instanceof HTMLButtonElement)) return;
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button",
                ),
              ];
              const index = buttons.indexOf(event.target);
              const next =
                event.key === "ArrowDown"
                  ? index + 1
                  : event.key === "ArrowUp"
                    ? index - 1
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? buttons.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                buttons[(next + buttons.length) % buttons.length]?.focus();
              }
            }}
          >
            <p role="status">
              {results.length
                ? `${results.length} ${results.length === 1 ? "result" : "results"}`
                : "No settings found"}
            </p>
            {results.map((entry) => (
              <button
                key={entry.targetId}
                className="settings-search-result"
                onClick={() => {
                  setQuery("");
                  setDestination({ targetId: entry.targetId });
                  onSectionChange(entry.section);
                }}
              >
                <span>{entry.label}</span>
                <small>
                  {entry.section === "general" ? "General" : "Appearance"} ·{" "}
                  {entry.description}
                </small>
              </button>
            ))}
          </div>
        )}
      </aside>
      <div className="settings-main">
        <header className="settings-header">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <span className="muted">Settings</span>
            <span className="settings-breadcrumb-slash" aria-hidden="true">
              /
            </span>
            <span aria-current="page">
              {
                settingsSections.find((entry) => entry.section === section)
                  ?.label
              }
            </span>
          </nav>
          <button
            className="icon-button"
            aria-label="Close settings"
            title="Close settings"
            onClick={close}
          >
            <X size={16} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
