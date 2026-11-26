import {
  memo,
  Suspense,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  counted,
  excerpt,
  lineLabel,
  personName,
} from "../domain/pullRequestDetail";
import type { Excerpt } from "../domain/pullRequestDetail";
import type { ReviewThread } from "../domain/pullRequest";
import { turnsIn } from "../markdown/runs";
import { Hunk } from "../shell/lazyViews";
import { Body, Plainly } from "./PullRequestBody";
import { Ago, Avatar, OnGitHub } from "./PullRequestParts";
import { ThreadActions } from "./ThreadActions";
import { useTurn } from "./useTurn";

const LINE = 20;
/** What is above, below, and around its lines. */
const EDGES = 18;

function ThreadHunk({ path, of }: { path: string; of: Excerpt }) {
  const place = useRef<HTMLDivElement>(null);
  const text =
    of.kind === "text" ? of.text : of.patch.split("\n").slice(3, -1).join("\n");
  const isShown = useTurn(place, text.length / 20 + 2 * turnsIn(text));
  const plain = <pre className="thread-plain">{text}</pre>;
  return (
    <div
      ref={place}
      className="pull-code thread-hunk"
      style={{ minHeight: text.split("\n").length * LINE + EDGES }}
    >
      {isShown &&
        (of.kind === "text" ? (
          plain
        ) : (
          <Plainly key={of.patch} fallback={plain}>
            <Suspense fallback={plain}>
              <Hunk path={path} patch={of.patch} before={plain} />
            </Suspense>
          </Plainly>
        ))}
    </div>
  );
}

/** The end of a path says more. A longer one has no place to be shown. */
const endOf = (path: string) =>
  path.length > 100 ? `…${path.slice(-100)}` : path;

const comments = (count: number) => counted(count, "comment");

export function ThreadComments({
  thread: { comments: said },
  viewer,
  url,
}: {
  thread: ReviewThread;
  viewer: string;
  url: string;
}) {
  return (
    <>
      <ul className="thread-comments">
        {said.items.map(({ id, by, at, body }) => (
          <li key={id}>
            <Avatar login={by} />
            <div className="thread-comment">
              <p className="thread-by">
                <strong>{personName(by, viewer)}</strong> <Ago at={at} />
              </p>
              <Body text={body} />
            </div>
          </li>
        ))}
      </ul>
      {said.items.length < said.total && (
        <p className="thread-more">
          {comments(said.total - said.items.length)} more.{" "}
          <OnGitHub url={url} />
        </p>
      )}
    </>
  );
}

/** Its lines, its comments, and what can be done with it. */
export function ThreadBody({
  thread,
  viewer,
  url,
  short,
  onShowInDiff,
  onAct,
}: { thread: ReviewThread; viewer: string; url: string } & Parameters<
  typeof ThreadActions
>[0]) {
  const cut = excerpt(thread);
  return (
    <>
      {cut && <ThreadHunk path={thread.path} of={cut} />}
      <ThreadComments thread={thread} viewer={viewer} url={url} />
      <ThreadActions
        thread={thread}
        short={short}
        onShowInDiff={onShowInDiff}
        onAct={onAct}
      />
    </>
  );
}

/**
 * Whether a thread shows whole: a resolved one starts as one row, and folds
 * when it is resolved. Resolving it here gives focus to that row.
 */
export function useFold(resolved: boolean) {
  const [expanded, setExpanded] = useState(!resolved);
  const [was, setWas] = useState(resolved);
  if (was !== resolved) {
    setWas(resolved);
    setExpanded(!resolved);
  }
  const toggle = useRef<HTMLButtonElement>(null);
  const resolving = useRef(false);
  useLayoutEffect(() => {
    if (!resolved || !resolving.current) return;
    resolving.current = false;
    toggle.current?.focus({ preventScroll: true });
  }, [resolved]);
  return {
    expanded,
    setExpanded,
    toggle,
    onAct: (kind: "reply" | "resolve" | "unresolve") => {
      resolving.current = kind === "resolve";
    },
  };
}

/** A resolved thread starts as one row. */
export const Thread = memo(function Thread({
  thread,
  viewer,
  url,
}: {
  thread: ReviewThread;
  viewer: string;
  url: string;
}) {
  const { path, outdated, resolved, comments: said } = thread;
  const { expanded, setExpanded, toggle, onAct } = useFold(resolved);
  const open = expanded || !resolved;
  const content = useId();
  return (
    <section className="thread" aria-label={`Thread on ${path}`}>
      <div className="thread-heading">
        <span className="thread-path" title={path}>
          <bdi>{endOf(path)}</bdi>
        </span>
        <span className="thread-line">{lineLabel(thread)}</span>
        {outdated && <span className="thread-outdated">Outdated</span>}
        {resolved && (
          <button
            ref={toggle}
            type="button"
            className="thread-toggle"
            aria-expanded={open}
            aria-controls={content}
            onClick={() => setExpanded(!expanded)}
          >
            <span className="thread-resolved">Resolved</span>
            <span>{comments(said.total)}</span>
            <span className="pull-link">{open ? "Hide" : "Show"}</span>
          </button>
        )}
      </div>
      <div id={content} hidden={!open}>
        {open && (
          <ThreadBody thread={thread} viewer={viewer} url={url} onAct={onAct} />
        )}
      </div>
    </section>
  );
});
