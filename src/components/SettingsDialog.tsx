import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Settings, Palette, X } from "lucide-react";
import type { SettingsSection } from "../actions";

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
  const pressedBackdrop = useRef(false);
  useLayoutEffect(() => {
    dialog.current?.showModal();
  }, []);

  const close = () => {
    dialog.current?.close();
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      aria-label="Settings"
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
      <nav className="settings-navigation" aria-label="Settings sections">
        {settingsSections.map(({ section: value, label, Icon }) => (
          <button
            key={value}
            className="settings-nav-item"
            aria-current={section === value ? "page" : undefined}
            onClick={() => onSectionChange(value)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>
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
