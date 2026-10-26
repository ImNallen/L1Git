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
  const { history } = writes;
  return (
    <>
      <StepNotice writes={writes} />
      {history.kind === "unreadable" && (
        <div className="notice error-notice" role="alert">
          <TriangleAlert size={14} />
          <span>{historyFailure(history.problem)}</span>
        </div>
      )}
    </>
  );
}

function StepNotice({ writes }: { writes: WritesView }) {
  const { notice, history, running } = writes;
  const row = useRef<HTMLDivElement>(null);
  const handsOff = useRef(false);
  useLayoutEffect(() => {
    if (!handsOff.current || running !== null) return;
    handsOff.current = false;
    const focused = document.activeElement;
    if (focused === null || focused === document.body)
      row.current?.querySelector("button")?.focus();
  }, [running]);
  if (notice === null) return null;
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
        <span>{failureText(notice, history)}</span>
        {dismiss}
      </div>
    );
  const again =
    notice.step === "undo"
      ? { label: "Redo", entry: nextEntry(history, "redo"), run: writes.redo }
      : { label: "Undo", entry: nextEntry(history, "undo"), run: writes.undo };
  const unavailable = again.entry === null || running !== null;
  return (
    <div ref={row} className="notice info-notice" role="status">
      <Info size={14} />
      <span>
        {notice.step === "undo" ? "Undid" : "Redid"} {notice.label}
      </span>
      <button
        aria-disabled={unavailable}
        onClick={() => {
          if (unavailable) return;
          handsOff.current = true;
          void again.run();
        }}
      >
        {again.label}
      </button>
      {dismiss}
    </div>
  );
}
