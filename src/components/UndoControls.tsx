import {
  Info,
  LoaderCircle,
  Redo2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { failureText } from "../domain/operations";
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
    { step: "undo", name: "Undo", Icon: Undo2, run: writes.undo },
    { step: "redo", name: "Redo", Icon: Redo2, run: writes.redo },
  ] as const;
  return buttons.map(({ step, name, Icon, run }) => {
    const entry = history?.[step];
    return (
      <button
        key={step}
        className="icon-button"
        aria-label={name}
        title={
          entry
            ? `${name} ${entry.label} (${shortcuts[step]})`
            : `Nothing to ${step}`
        }
        disabled={!entry || running !== null}
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
      <div className="notice error-notice" role="alert">
        <TriangleAlert size={14} />
        <span>
          {failureText(
            notice,
            notice.action !== "write" &&
              history?.[notice.action]?.id === notice.entry,
          )}
        </span>
        {dismiss}
      </div>
    );
  const again =
    notice.step === "undo"
      ? { label: "Redo", ready: history?.redo != null, run: writes.redo }
      : { label: "Undo", ready: history?.undo != null, run: writes.undo };
  return (
    <div className="notice info-notice" role="status">
      <Info size={14} />
      <span>
        {notice.step === "undo" ? "Undid" : "Redid"} {notice.label}
      </span>
      {again.ready && (
        <button disabled={running !== null} onClick={() => void again.run()}>
          {again.label}
        </button>
      )}
      {dismiss}
    </div>
  );
}
