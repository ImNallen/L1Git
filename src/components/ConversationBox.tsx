import { use, useId, useState } from "react";
import { draftKey, draftText, mostDraftChars } from "../domain/drafts";
import { mac } from "../repositories";
import { usePullDrafts, usePullWrites } from "../shell/usePullWriting";
import { messageKeys } from "./CommitBox";
import {
  anchorOf,
  ConversationWritingContext,
  doneAt,
  waitingAt,
  wordsOf,
} from "./conversationWriting";
import type { WritePlace } from "./conversationWriting";
import { Body } from "./PullRequestBody";
import { OnGitHub } from "./PullRequestParts";
import { Problem, unsent, WriteNotice } from "./WriteNotice";
import type { Unsent } from "./WriteNotice";

type Place = Extract<WritePlace, { kind: "comment" | "reply" }>;

const verbs = {
  comment: { button: "Comment", sending: "Sending your comment…" },
  reply: { button: "Reply", sending: "Sending your reply…" },
};

/**
 * Words for the conversation or a thread, saved as a draft on this machine
 * while you type, and sent only by the button or Cmd/Ctrl+Enter. While they
 * are on their way the box can't change them.
 */
export function ConversationBox({
  place,
  label,
  placeholder,
  autoFocus = false,
  onCancel,
  onStarted,
}: {
  place: Place;
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  /** A reply box closes, and its draft goes. */
  onCancel?: () => void;
  onStarted?: () => void;
}) {
  const writing = use(ConversationWritingContext);
  if (writing === null) throw new Error("A comment box needs its writing.");
  const drafts = usePullDrafts(writing.opened);
  const writes = usePullWrites(writing.opened);
  const [preview, setPreview] = useState(false);
  const [refused, setRefused] = useState<Unsent | null>(null);
  const status = useId();
  const anchor = anchorOf(place);
  const key = draftKey(anchor, writing.head);
  const draft = drafts.drafts.find(
    (each) => draftKey(each.anchor, each.head) === key,
  );
  const waiting = waitingAt(writes.attempts, place);
  const sending = waiting?.state.kind === "sending";
  const held =
    waiting !== null &&
    (sending || (waiting.state.kind === "unknown" && waiting.state.kept));
  const text = held ? wordsOf(waiting.write) : (draft?.text ?? "");
  const takes = draftText(text);
  const ready = !held && takes === "takes";
  const verb = verbs[place.kind];
  const posted = doneAt(writes.attempts, place).length > 0;

  const { pull, head } = writing;
  async function send() {
    if (!ready) return;
    setRefused(null);
    const body = text;
    const write =
      place.kind === "comment"
        ? { kind: "comment" as const, pull, body }
        : { kind: "reply" as const, thread: place.thread, body };
    const answer = await writes.send(write, [{ anchor, head }]);
    if (answer === "started") onStarted?.();
    else setRefused(answer);
  }

  const save = draft?.save;
  const shortcut = `${mac ? "⌘" : "Ctrl+"}Enter to ${verb.button.toLowerCase()}`;
  const line = sending
    ? "Sending…"
    : held
      ? "May have posted."
      : save?.kind === "unsaved"
        ? `Not saved. ${save.why}`
        : takes === "tooLong"
          ? `Too long to save or send. GitHub takes at most ${mostDraftChars.toLocaleString()} characters.`
          : save?.kind === "changedElsewhere"
            ? "Another window changed this draft."
            : takes === "blank"
              ? shortcut
              : save?.kind === "saving"
                ? `${shortcut} · Saving…`
                : `${shortcut} · Saved as a draft on this machine`;

  return (
    <div
      className="comment-box"
      role="group"
      aria-label={label}
      aria-busy={sending}
    >
      <div className="comment-box-modes">
        <button
          type="button"
          aria-pressed={!preview}
          onClick={() => setPreview(false)}
        >
          Write
        </button>
        <button
          type="button"
          aria-pressed={preview}
          onClick={() => setPreview(true)}
        >
          Preview
        </button>
      </div>
      {preview ? (
        <div className="comment-box-preview">
          {takes === "blank" ? (
            <p className="entry-nothing">Nothing to preview.</p>
          ) : (
            <Body text={text} />
          )}
        </div>
      ) : (
        <textarea
          className="comment-box-text"
          aria-label={verb.button}
          aria-describedby={status}
          placeholder={placeholder}
          rows={3}
          spellCheck
          autoFocus={autoFocus}
          value={text}
          readOnly={held}
          onChange={(event) =>
            drafts.type(anchor, writing.head, event.target.value)
          }
          onKeyDown={messageKeys(() => void send())}
        />
      )}
      {draft?.mayHavePosted && !held && (
        <p className="comment-box-warning">
          These words may have posted already. Check before you send them again.{" "}
          <OnGitHub url={writing.url} />
        </p>
      )}
      <div className="comment-box-foot">
        <p id={status} className="comment-box-status">
          {line}
        </p>
        {save?.kind === "changedElsewhere" && draft && (
          <>
            <button
              type="button"
              className="button secondary"
              onClick={() => drafts.settle(draft.key, "mine")}
            >
              Keep mine
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => drafts.settle(draft.key, "theirs")}
            >
              Take theirs
            </button>
          </>
        )}
        {onCancel && (
          <button
            type="button"
            className="button secondary"
            aria-disabled={held}
            onClick={() => {
              if (!held) onCancel();
            }}
          >
            {takes === "blank" ? "Cancel" : "Discard"}
          </button>
        )}
        <button
          type="button"
          className="button primary"
          aria-disabled={!ready}
          title={ready ? `${verb.button} (${shortcut})` : undefined}
          onClick={() => void send()}
        >
          {verb.button}
        </button>
      </div>
      <span className="visually-hidden" role="status">
        {sending ? verb.sending : posted ? "Posted." : ""}
      </span>
      {refused !== null && (
        <Problem text={unsent[refused]} onDismiss={() => setRefused(null)} />
      )}
      {waiting !== null && <WriteNotice attempt={waiting} />}
    </div>
  );
}
