import { use, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { Attempt } from "../pullRequestWrites";
import { usePullWrites } from "../shell/usePullWriting";
import { ConversationWritingContext } from "./conversationWriting";

/** Why a click sent nothing, when the writes store said so before sending. */
export const unsent = {
  busy: "Another write to this pull request is still on its way, or may have posted, so L1 Git sent nothing. Send this once that one is done.",
  unsaved:
    "L1 Git couldn't save your words first, so it sent nothing. The line under the box says why.",
  signedOut: "L1 Git isn't signed in to GitHub, so it sent nothing.",
  restarting: "L1 Git is restarting for an update, so it sent nothing.",
  gone: "That write isn't waiting anymore, so L1 Git sent nothing.",
} as const;
export type Unsent = keyof typeof unsent;

/** A message that stays where you acted until you dismiss it. */
export function Problem({
  text,
  onDismiss,
  home,
}: {
  text: string;
  onDismiss: () => void;
  /** Where focus goes once the message is gone. */
  home: () => HTMLElement | null;
}) {
  return (
    <div className="write-notice" role="alert">
      <TriangleAlert size={14} aria-hidden="true" />
      <p>{text}</p>
      <button
        type="button"
        className="pull-link"
        onClick={() => {
          onDismiss();
          home()?.focus();
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * How a write that hasn't posted ended, where it was sent from. A write that
 * may have posted offers Open on GitHub, Keep as draft and Send anyway, and
 * never goes again by itself.
 */
export function WriteNotice({
  attempt,
  home,
}: {
  attempt: Attempt;
  home: () => HTMLElement | null;
}) {
  const writing = use(ConversationWritingContext);
  if (writing === null) throw new Error("A write notice needs its writing.");
  const writes = usePullWrites(writing.opened);
  const [failed, setFailed] = useState<string | null>(null);
  const { id, state, write } = attempt;
  if (state.kind === "sending" || state.kind === "done") return null;
  if (state.kind !== "unknown")
    return (
      <Problem
        text={state.message}
        onDismiss={() => writes.dismiss(id)}
        home={home}
      />
    );
  const harmless = write.kind === "resolve" || write.kind === "unresolve";
  return (
    <div className="write-notice unknown" role="alert">
      <TriangleAlert size={14} aria-hidden="true" />
      <div>
        <p>{state.message}</p>
        {state.kept && !harmless && <p>Send anyway may post it twice.</p>}
        {failed !== null && <p>{failed}</p>}
        <div className="write-choices">
          <a
            className="button secondary"
            href={writing.url}
            target="_blank"
            rel="noreferrer"
          >
            Open on GitHub
          </a>
          {state.kept && !harmless && (
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                void writes.keep(id).then((kept) => {
                  if (kept) home()?.focus();
                  else
                    setFailed(
                      "L1 Git couldn't keep it as a draft yet. Try again in a moment.",
                    );
                })
              }
            >
              Keep as draft
            </button>
          )}
          {state.kept ? (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                const sent = writes.sendAnyway(id);
                setFailed(sent === "started" ? null : unsent[sent]);
                if (sent === "started") home()?.focus();
              }}
            >
              Send anyway
            </button>
          ) : (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                writes.dismiss(id);
                home()?.focus();
              }}
            >
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
