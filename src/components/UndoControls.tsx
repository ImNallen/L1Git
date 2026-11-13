import { Fragment, useLayoutEffect, useRef } from "react";
import { Info, TriangleAlert, X } from "lucide-react";
import {
  failureText,
  historyFailure,
  hookOutputTail,
  nextEntry,
  steppedText,
} from "../domain/operations";
import type { WritesView } from "../useWrites";

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
        <span>
          {failureText(notice, history)}
          {hookOutputTail(notice.problem).map((line, index) => (
            <Fragment key={index}>
              <br />
              <code>{line}</code>
            </Fragment>
          ))}
        </span>
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
      <span>{steppedText(notice)}</span>
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
