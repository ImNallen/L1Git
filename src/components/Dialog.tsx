import { useEffect, useEffectEvent, useRef } from "react";
import type { ReactNode, SyntheticEvent } from "react";
import { X } from "lucide-react";
import type { Problem } from "../domain/repository";

export const busyProblem: Problem = {
  kind: "transport",
  message: "Another change is still running. Try again when it ends.",
};

export function useModalDialog(onClose: () => void, onOpen?: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const opened = useEffectEvent(() => onOpen?.());
  useEffect(() => {
    ref.current?.showModal();
    opened();
  }, []);
  // Closing the native dialog before React removes it hands focus back to
  // whatever had it when the dialog opened.
  const close = () => {
    ref.current?.close();
    onClose();
  };
  const onCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    close();
  };
  return { ref, close, onCancel };
}

export function DialogHeader({
  icon,
  titleId,
  title,
  closeLabel,
  closeDisabled,
  onClose,
}: {
  icon: ReactNode;
  titleId: string;
  title: ReactNode;
  closeLabel: string;
  closeDisabled?: boolean;
  onClose: () => void;
}) {
  return (
    <>
      <div className="dialog-title">
        <div className="dialog-icon">{icon}</div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          disabled={closeDisabled}
          aria-label={closeLabel}
        >
          <X size={17} />
        </button>
      </div>
      <h1 id={titleId}>{title}</h1>
    </>
  );
}
