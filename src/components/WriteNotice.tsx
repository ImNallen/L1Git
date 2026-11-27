import { use } from "react";
import { TriangleAlert } from "lucide-react";
import type { Attempt } from "../pullRequestWrites";
import { usePullWrites } from "../shell/usePullWriting";
import { ConversationWritingContext } from "./conversationWriting";
import { MayHavePosted } from "./MayHavePosted";

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
 * may have posted offers the choices every write offers, and never goes again
 * by itself.
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
  const { id, state } = attempt;
  if (state.kind === "sending" || state.kind === "done") return null;
  if (state.kind !== "unknown")
    return (
      <Problem
        text={state.message}
        onDismiss={() => writes.dismiss(id)}
        home={home}
      />
    );
  return (
    <MayHavePosted
      attempt={attempt}
      url={writing.url}
      choices={{
        keepAsDraft: writes.keep,
        sendAnyway: writes.sendAnyway,
        dismiss: writes.dismiss,
      }}
      home={home}
    />
  );
}
