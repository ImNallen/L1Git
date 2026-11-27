import { use, useId, useRef, useState } from "react";
import { draftKey, draftText, mostDraftChars } from "../domain/drafts";
import { mac } from "../repositories";
import { usePullDrafts, usePullWrites } from "../shell/usePullWriting";
import { messageKeys } from "./CommitBox";
import {
  anchorOf,
  ConversationWritingContext,
  doneAt,
  useLasting,
  waitingAt,
  wordsOf,
} from "./conversationWriting";
import type { WritePlace } from "./conversationWriting";
import { Body } from "./PullRequestBody";
import { OnGitHub } from "./PullRequestParts";
import { sentNothing } from "./sentNothing";
import type { SentNothing } from "./sentNothing";
import { Problem, WriteNotice } from "./WriteNotice";

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
  const [refused, setRefused] = useState<SentNothing | null>(null);
  /** From the click until the writes store answers, while drafts save. */
  const [starting, setStarting] = useState(false);
  const status = useId();
  const words = useRef<HTMLTextAreaElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const home = () => words.current ?? group.current;
  const anchor = anchorOf(place);
  const key = draftKey(anchor, writing.head);
  const draft = drafts.drafts.find(
    (each) => draftKey(each.anchor, each.head) === key,
  );
  const waiting = waitingAt(writes.attempts, place);
  const sending = waiting?.state.kind === "sending";
  const kept =
    waiting !== null &&
    (sending || (waiting.state.kind === "unknown" && waiting.state.kept));
  const held = starting || kept;
  const text = kept ? wordsOf(waiting.write) : (draft?.text ?? "");
  const takes = draftText(text);
  const ready = !held && takes === "takes";
  const verb = verbs[place.kind];
  const done = doneAt(writes.attempts, place).at(-1);
  const posted = useLasting(done ? { id: done.id, text: "Posted." } : null);

  const { pull, head } = writing;
  async function send() {
    if (!ready) return;
    setRefused(null);
    posted.quiet();
    setStarting(true);
    // The last write's message goes, so it doesn't come back once this one posts.
    if (waiting !== null) writes.dismiss(waiting.id);
    const body = text;
    const write =
      place.kind === "comment"
        ? { kind: "comment" as const, pull, body }
        : { kind: "reply" as const, thread: place.thread, body };
    const answer = await writes
      .send(write, [{ anchor, head }])
      .finally(() => setStarting(false));
    if (answer === "started") onStarted?.();
    else setRefused(answer);
  }

  const save = draft?.save;
  const shortcut = `${mac ? "⌘" : "Ctrl+"}Enter to ${verb.button.toLowerCase()}`;
  const line =
    sending || starting
      ? "Sending…"
      : kept
        ? "May have posted."
        : posted.text !== null && takes === "blank"
          ? posted.text
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
      ref={group}
      className="comment-box"
      role="group"
      aria-label={label}
      aria-busy={sending || starting}
      tabIndex={-1}
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
          ref={words}
          className="comment-box-text"
          aria-label={verb.button}
          aria-describedby={status}
          placeholder={placeholder}
          rows={3}
          spellCheck
          autoFocus={autoFocus}
          value={text}
          readOnly={held}
          onChange={(event) => {
            posted.quiet();
            drafts.type(anchor, writing.head, event.target.value);
          }}
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
        {sending || starting ? verb.sending : (posted.text ?? "")}
      </span>
      {refused !== null && (
        <Problem
          text={sentNothing[refused]}
          onDismiss={() => setRefused(null)}
          home={home}
        />
      )}
      {waiting !== null && (
        <WriteNotice key={waiting.id} attempt={waiting} home={home} />
      )}
    </div>
  );
}
