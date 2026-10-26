import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

type Props = {
  icon: LucideIcon;
  title: string;
  closeLabel: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
};

/** Asks before a destructive action. Cancel has focus first. */
export function ConfirmDialog({
  icon: Icon,
  title,
  closeLabel,
  confirm,
  onConfirm,
  onClose,
  children,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
  }, []);
  // Closing the native dialog before React removes it hands focus back to
  // whatever had it when the dialog opened.
  const close = () => {
    dialog.current?.close();
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      className="add-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="dialog-title">
        <div className="dialog-icon">
          <Icon size={20} />
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={close}
          aria-label={closeLabel}
        >
          <X size={17} />
        </button>
      </div>
      <h1 id={titleId}>{title}</h1>
      {children}
      <div className="dialog-actions">
        <button
          type="button"
          ref={cancel}
          className="button secondary"
          onClick={close}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button danger"
          onClick={() => {
            close();
            onConfirm();
          }}
        >
          {confirm}
        </button>
      </div>
    </dialog>
  );
}
