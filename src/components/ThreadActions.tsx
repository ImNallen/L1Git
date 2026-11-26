import {
  use,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CircleCheck, CornerDownLeft, LoaderCircle } from "lucide-react";
import { draftKey, draftText } from "../domain/drafts";
import type { ReviewThread } from "../domain/pullRequest";
import { usePullWrites } from "../shell/usePullWriting";
import { ConversationBox } from "./ConversationBox";
import {
  anchorOf,
  ConversationWritingContext,
  doneAt,
  madeId,
  waitingAt,
  wordsOf,
} from "./conversationWriting";
import type { ConversationWriting } from "./conversationWriting";
import { Body } from "./PullRequestBody";
import { Avatar, OnGitHub } from "./PullRequestParts";
import { Problem, unsent, WriteNotice } from "./WriteNotice";
import type { Unsent } from "./WriteNotice";

type Props = {
  thread: ReviewThread;
  /** "Resolve" instead of "Resolve conversation", where a row is narrow. */
  short?: boolean;
  onShowInDiff?: (path: string) => void;
  /** A reply, a resolve or an unresolve was sent from here. */
  onAct?: (kind: "reply" | "resolve" | "unresolve") => void;
};

/** Reply, Resolve and Show in diff under a thread, and the replies that
 * posted until a read has them. Nothing where nothing writes. */
export function ThreadActions(props: Props) {
  const writing = use(ConversationWritingContext);
  return writing && <Actions writing={writing} {...props} />;
}

function Actions({
  writing,
  thread,
  short = false,
  onShowInDiff,
  onAct,
}: Props & { writing: ConversationWriting }) {
  const { id, resolved, can, comments } = thread;
  const writes = usePullWrites(writing.opened);
  const reply = { kind: "reply", thread: id } as const;
  const resolve = { kind: "resolve", thread: id } as const;
  const { drafts } = writing.opened.writing;
  const key = draftKey(anchorOf(reply), writing.head);
  const of = {
    login: writing.opened.viewer,
    repository: writing.opened.repository.github,
    number: writing.opened.number,
  };
  const drafted = useSyncExternalStore(drafts.subscribe, () =>
    drafts
      .read(of)
      .drafts.some(
        (each) =>
          draftKey(each.anchor, each.head) === key &&
          draftText(each.text) !== "blank",
      ),
  );
  const [asked, setAsked] = useState(false);
  const [refused, setRefused] = useState<Unsent | null>(null);
  const replyButton = useRef<HTMLButtonElement>(null);
  const resolving = waitingAt(writes.attempts, resolve);
  const replying = waitingAt(writes.attempts, reply);
  const boxShown = can.reply && (asked || drafted || replying !== null);
  const cancelled = useRef(false);
  useLayoutEffect(() => {
    if (boxShown || !cancelled.current) return;
    cancelled.current = false;
    replyButton.current?.focus();
  }, [boxShown]);

  // A thread GitHub cut short gets a reply at its end, past what was read.
  const whole = comments.items.length >= comments.total;
  const read = new Set(comments.items.map((comment) => comment.id));
  const posted = doneAt(writes.attempts, reply);
  const sent = posted.filter((attempt) => !read.has(madeId(attempt) ?? ""));
  const [seen, setSeen] = useState<string | null>(null);
  const [postedPast, setPostedPast] = useState(false);
  const last = posted.at(-1);
  if (last && last.id !== seen) {
    setSeen(last.id);
    if (!whole) setPostedPast(true);
  }

  const canFlip = resolved ? can.unresolve : can.resolve;
  const flipping = resolving?.state.kind === "sending";
  async function flip() {
    if (flipping) return;
    setRefused(null);
    const kind = resolved ? "unresolve" : "resolve";
    const answer = await writes.send({ kind, thread: id });
    if (answer === "started") onAct?.(kind);
    else setRefused(answer);
  }

  return (
    <>
      {whole && sent.length > 0 && (
        <ul className="thread-comments thread-sent">
          {sent.map(({ id: attempt, write }) => (
            <li key={attempt}>
              <Avatar login={writing.opened.viewer} />
              <div className="thread-comment">
                <p className="thread-by">
                  <strong>You</strong> <span className="entry-pill">Sent</span>
                </p>
                <Body text={wordsOf(write)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {postedPast && !boxShown && (
        <p className="thread-posted" role="status">
          Posted. GitHub shows it in the full thread.{" "}
          <OnGitHub url={writing.url} />
        </p>
      )}
      <div className="thread-actions">
        {boxShown ? (
          <ConversationBox
            place={reply}
            label="Reply"
            placeholder="Reply. Markdown works here."
            autoFocus={asked}
            onStarted={() => {
              setAsked(false);
              onAct?.("reply");
            }}
            onCancel={() => {
              cancelled.current = true;
              setAsked(false);
              void drafts.remove(of, anchorOf(reply), writing.head);
            }}
          />
        ) : (
          can.reply && (
            <button
              ref={replyButton}
              type="button"
              className="thread-reply"
              onClick={() => {
                setAsked(true);
                setPostedPast(false);
              }}
            >
              <CornerDownLeft size={13} aria-hidden="true" />
              Reply…
            </button>
          )
        )}
        <div className="thread-buttons">
          {onShowInDiff && (
            <button
              type="button"
              className="button secondary"
              onClick={() => onShowInDiff(thread.path)}
            >
              Show in diff
            </button>
          )}
          {canFlip && (
            <button
              type="button"
              className="button secondary"
              aria-disabled={flipping}
              onClick={() => void flip()}
            >
              {flipping ? (
                <LoaderCircle size={13} className="spin" aria-hidden="true" />
              ) : (
                <CircleCheck size={13} aria-hidden="true" />
              )}
              {resolved ? "Unresolve" : "Resolve"}
              {short ? "" : " conversation"}
            </button>
          )}
        </div>
      </div>
      <span className="visually-hidden" role="status">
        {flipping ? (resolved ? "Unresolving…" : "Resolving…") : ""}
      </span>
      {refused !== null && (
        <Problem text={unsent[refused]} onDismiss={() => setRefused(null)} />
      )}
      {resolving !== null && <WriteNotice attempt={resolving} />}
    </>
  );
}
