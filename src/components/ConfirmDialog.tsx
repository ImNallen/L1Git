import { useId, useRef } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { DialogHeader, useModalDialog } from "./Dialog";

type Props = {
  icon: LucideIcon;
  title: string;
  closeLabel: string;
  confirm: string;
  cancel?: string;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
};

export function ConfirmDialog({
  icon: Icon,
  title,
  closeLabel,
  confirm,
  cancel = "Cancel",
  onConfirm,
  onClose,
  children,
}: Props) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const { ref, close, onCancel } = useModalDialog(onClose, () =>
    cancelButton.current?.focus(),
  );

  return (
    <dialog
      ref={ref}
      className="add-dialog"
      aria-labelledby={titleId}
      onCancel={onCancel}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <DialogHeader
        icon={<Icon size={20} />}
        titleId={titleId}
        title={title}
        closeLabel={closeLabel}
        onClose={close}
      />
      {children}
      <div className="dialog-actions">
        <button
          type="button"
          ref={cancelButton}
          className="button secondary"
          onClick={close}
        >
          {cancel}
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
