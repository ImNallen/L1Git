import { memo, Suspense, useId, useState } from "react";
import { excerpt, lineLabel, personName } from "../domain/pullRequestDetail";
import type { Excerpt } from "../domain/pullRequestDetail";
import type { ReviewThread } from "../domain/pullRequest";
import { Hunk } from "../shell/lazyViews";
import { Body, Plainly } from "./PullRequestBody";
import { Ago, Avatar, OnGitHub } from "./PullRequestParts";

function ThreadHunk({ path, of }: { path: string; of: Excerpt }) {
  const plain = (
    <pre className="thread-plain">
      {of.kind === "text" ? of.text : of.patch.split("\n").slice(3).join("\n")}
    </pre>
  );
  if (of.kind === "text") return plain;
  const lines = of.patch.split("\n").length - 4;
  return (
    <div
      className="pull-code thread-hunk"
      style={{ minHeight: `${lines * 20}px` }}
    >
      <Plainly key={of.patch} fallback={plain}>
        <Suspense>
          <Hunk path={path} patch={of.patch} />
        </Suspense>
      </Plainly>
    </div>
  );
}

const comments = (count: number) =>
  `${count.toLocaleString()} ${count === 1 ? "comment" : "comments"}`;

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
  const [open, setOpen] = useState(!resolved);
  const content = useId();
  const cut = excerpt(thread);
  return (
    <section className="thread" aria-label={`Thread on ${path}`}>
      <div className="thread-heading">
        <span className="thread-path" title={path}>
          <bdi>{path}</bdi>
        </span>
        <span className="thread-line">{lineLabel(thread)}</span>
        {outdated && <span className="thread-outdated">Outdated</span>}
        {resolved && (
          <button
            type="button"
            className="thread-toggle"
            aria-expanded={open}
            aria-controls={content}
            onClick={() => setOpen(!open)}
          >
            <span className="thread-resolved">Resolved</span>
            <span>{comments(said.total)}</span>
            <span className="pull-link">{open ? "Hide" : "Show"}</span>
          </button>
        )}
      </div>
      <div id={content} hidden={!open}>
        {open && (
          <>
            {cut && <ThreadHunk path={path} of={cut} />}
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
        )}
      </div>
    </section>
  );
});
