import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { WorkspaceIcon } from "./WorkspaceIcon";
import type { SettingsSection } from "../actions";
import { searchSettings } from "../settingsSearch";

const settingsSections = [
  { section: "general", label: "General", icon: "SettingsGeneral" },
  { section: "appearance", label: "Appearance", icon: "SettingsPalette" },
] as const satisfies readonly {
  section: SettingsSection;
  label: string;
  icon: string;
}[];

type Props = {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  children: ReactNode;
  restore?: { disabled: boolean; run: () => void };
};

export function SettingsDialog({
  section,
  onSectionChange,
  onClose,
  children,
  restore,
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
          <WorkspaceIcon name="SettingsSearch" />
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
          ) : null}
        </div>
        <nav aria-label="Settings sections">
          {settingsSections.map(({ section: value, label, icon }) => (
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
              <WorkspaceIcon name={icon} />
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
          {restore && (
            <button
              type="button"
              className="icon-button settings-restore"
              aria-label="Restore defaults"
              disabled={restore.disabled}
              onClick={restore.run}
            >
              <WorkspaceIcon name="SettingsReset" />
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Close settings"
            title="Close settings"
            onClick={close}
          >
            <WorkspaceIcon name="SettingsClose" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
