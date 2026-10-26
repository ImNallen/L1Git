import { useLayoutEffect, useRef } from "react";
import {
  Info,
  LoaderCircle,
  Redo2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import {
  failureText,
  historyFailure,
  nextEntry,
  stepButton,
} from "../domain/operations";
import type { WritesView } from "../useWrites";

export function UndoButtons({
  writes,
  shortcuts,
}: {
  writes: WritesView;
  shortcuts: { undo: string; redo: string };
}) {
  const { history, running } = writes;
  const buttons = [
    { step: "undo", Icon: Undo2, run: writes.undo },
    { step: "redo", Icon: Redo2, run: writes.redo },
  ] as const;
  return buttons.map(({ step, Icon, run }) => {
    const { name, title } = stepButton(history, step, shortcuts[step]);
    return (
      <button
        key={step}
        className="icon-button"
        aria-label={name}
        title={title}
        aria-disabled={nextEntry(history, step) === null || running !== null}
        onClick={() => void run()}
      >
        {running?.action === step ? (
          <LoaderCircle size={15} className="spin" />
        ) : (
          <Icon size={15} />
        )}
      </button>
    );
  });
}

export function WriteNoticeRow({ writes }: { writes: WritesView }) {
  const { notice, history, running } = writes;
  const row = useRef<HTMLDivElement>(null);
  const heldFocus = row.current?.contains(document.activeElement) ?? false;
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (heldFocus && (focused === null || focused === document.body))
      row.current?.querySelector("button")?.focus();
  });
  if (notice === null) {
    if (history.kind !== "unreadable") return null;
    return (
      <div className="notice error-notice" role="alert">
        <TriangleAlert size={14} />
        <span>{historyFailure(history.problem)}</span>
      </div>
    );
  }
  const dismiss = (
    <button
      className="notice-dismiss"
      aria-label="Dismiss"
      onClick={writes.dismiss}
    >
      <X size={13} />
    </button>
  );
  if (notice.kind === "failed")
    return (
      <div ref={row} className="notice error-notice" role="alert">
        <TriangleAlert size={14} />
        <span>
          {failureText(
            notice,
            notice.action !== "write" &&
              nextEntry(history, notice.action)?.id === notice.entry,
          )}
        </span>
        {dismiss}
      </div>
    );
  const again =
    notice.step === "undo"
      ? { label: "Redo", ready: nextEntry(history, "redo"), run: writes.redo }
      : { label: "Undo", ready: nextEntry(history, "undo"), run: writes.undo };
  return (
    <div ref={row} className="notice info-notice" role="status">
      <Info size={14} />
      <span>
        {notice.step === "undo" ? "Undid" : "Redid"} {notice.label}
      </span>
      <button
        aria-disabled={again.ready === null || running !== null}
        onClick={() => void again.run()}
      >
        {again.label}
      </button>
      {dismiss}
    </div>
  );
}
