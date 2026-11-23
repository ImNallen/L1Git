import { Fragment, useLayoutEffect, useRef } from "react";
import { FolderGit2, Info, TriangleAlert, X } from "lucide-react";
import {
  advancedText,
  describe,
  failureText,
  fetchedText,
  historyFailure,
  hookOutputTail,
  nextEntry,
  pulledText,
  steppedText,
} from "../domain/operations";
import type { Step } from "../domain/operations";
import { pushOutcomeText } from "../domain/push";
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
  switch (notice.kind) {
    case "failed":
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
    case "pushed": {
      const succeeded =
        notice.outcome.kind === "published" ||
        notice.outcome.kind === "pushed" ||
        notice.outcome.kind === "upToDate";
      return (
        <div
          ref={row}
          className={`notice ${succeeded ? "info-notice" : "error-notice"}`}
          role={succeeded ? "status" : "alert"}
        >
          <span className="workspace-action-icon push" aria-hidden="true" />
          <span>
            {pushOutcomeText(notice.outcome, notice.intent)}{" "}
            {notice.refreshProblem}
          </span>
          {dismiss}
        </div>
      );
    }
    case "pulled":
      return (
        <div ref={row} className="notice info-notice" role="status">
          <span className="workspace-action-icon pull" aria-hidden="true" />
          <span>{pulledText(notice)}</span>
          {dismiss}
        </div>
      );
    case "fetched":
      return (
        <div ref={row} className="notice info-notice" role="status">
          <span className="workspace-action-icon fetch" aria-hidden="true" />
          <span>{fetchedText(notice)}</span>
          {dismiss}
        </div>
      );
    case "advanced":
      return (
        <div ref={row} className="notice info-notice" role="status">
          <span className="workspace-action-icon pull" aria-hidden="true" />
          <span>{advancedText(notice)}</span>
          {dismiss}
        </div>
      );
    case "removedWorktree":
      return (
        <div ref={row} className="notice info-notice" role="status">
          <FolderGit2 size={14} />
          <span>Removed worktree {notice.name}. Removal cannot be undone.</span>
          {dismiss}
        </div>
      );
    case "wrote":
    case "stepped": {
      const step: Step =
        notice.kind === "stepped" && notice.step === "undo" ? "redo" : "undo";
      const entry = nextEntry(history, step);
      const unavailable =
        entry === null ||
        (notice.kind === "wrote" && entry.id !== notice.entry) ||
        running !== null;
      return (
        <div ref={row} className="notice info-notice" role="status">
          <Info size={14} />
          <span>
            {notice.kind === "wrote"
              ? `${describe(notice.operation, "past")}.`
              : steppedText(notice)}
          </span>
          <button
            aria-disabled={unavailable}
            onClick={() => {
              if (unavailable) return;
              handsOff.current = true;
              void writes[step]();
            }}
          >
            {step === "undo" ? "Undo" : "Redo"}
          </button>
          {dismiss}
        </div>
      );
    }
    default: {
      const exhaustive: never = notice;
      return exhaustive;
    }
  }
}
