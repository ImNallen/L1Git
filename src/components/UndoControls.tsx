import { useLayoutEffect, useRef } from "react";
import type { ComponentProps } from "react";
import { FolderGit2, Info, TriangleAlert } from "lucide-react";
import {
  advancedText,
  describe,
  failureText,
  fetchedText,
  historyFailure,
  hookOutputTail,
  isConfirmation,
  nextEntry,
  pulledText,
  steppedText,
} from "../domain/operations";
import type { Step, WriteNotice } from "../domain/operations";
import { pushOutcomeText, pushSucceeded } from "../domain/push";
import type { WritesView } from "../useWrites";
import { Notification } from "./Notification";

const CONFIRMATION_MS = 4_500;

export function WriteNoticeRow({ writes }: { writes: WritesView }) {
  const { history } = writes;
  return (
    <>
      <StepNotice writes={writes} />
      {history.kind === "unreadable" && (
        <Notification tone="error" icon={<TriangleAlert size={16} />}>
          {historyFailure(history.problem)}
        </Notification>
      )}
    </>
  );
}

const shown = new WeakMap<WriteNotice, number>();
let shownCount = 0;

/** Each notice gets its own popup, so a later one restarts the countdown. */
function shownKey(notice: WriteNotice) {
  const key = shown.get(notice) ?? shownCount++;
  shown.set(notice, key);
  return key;
}

type Shown = Pick<
  ComponentProps<typeof Notification>,
  "tone" | "icon" | "children" | "output" | "actions"
>;

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
  const shownNotice = ((): Shown => {
    switch (notice.kind) {
      case "failed":
        return {
          tone: "error",
          icon: <TriangleAlert size={16} />,
          children: failureText(notice, history),
          output: hookOutputTail(notice.problem),
        };
      case "pushed":
        return {
          tone: pushSucceeded[notice.outcome.kind] ? "info" : "error",
          icon: <span className="workspace-action-icon push" aria-hidden />,
          children: `${pushOutcomeText(notice.outcome, notice.intent)} ${notice.refreshProblem ?? ""}`,
        };
      case "pulled":
        return {
          tone: "info",
          icon: <span className="workspace-action-icon pull" aria-hidden />,
          children: pulledText(notice),
        };
      case "fetched":
        return {
          tone: "info",
          icon: <span className="workspace-action-icon fetch" aria-hidden />,
          children: fetchedText(notice),
        };
      case "advanced":
        return {
          tone: "info",
          icon: <span className="workspace-action-icon pull" aria-hidden />,
          children: advancedText(notice),
        };
      case "removedWorktree":
        return {
          tone: "info",
          icon: <FolderGit2 size={16} />,
          children: `Removed worktree ${notice.name}. Removal cannot be undone.`,
        };
      case "wrote":
      case "stepped": {
        const step: Step =
          notice.kind === "stepped" && notice.step === "undo" ? "redo" : "undo";
        const entry = nextEntry(history, step);
        return {
          tone: "info",
          icon: <Info size={16} />,
          children:
            notice.kind === "wrote"
              ? `${describe(notice.operation, "past")}.`
              : steppedText(notice),
          actions: [
            {
              label: step === "undo" ? "Undo" : "Redo",
              unavailable:
                entry === null ||
                (notice.kind === "wrote" && entry.id !== notice.entry) ||
                running !== null,
              run: () => {
                handsOff.current = true;
                void writes[step]();
              },
            },
          ],
        };
      }
      default: {
        const exhaustive: never = notice;
        return exhaustive;
      }
    }
  })();
  return (
    <Notification
      key={shownKey(notice)}
      ref={row}
      {...shownNotice}
      onDismiss={writes.dismiss}
      expiresAfter={isConfirmation(notice) ? CONFIRMATION_MS : undefined}
    />
  );
}
