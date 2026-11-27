import { useState } from "react";
import { ExternalLink, TriangleAlert } from "lucide-react";
import type { PullWrite } from "../domain/pullRequestWrites";
import type { Attempt } from "../pullRequestWrites";
import { keptNothing, sentNothing } from "./sentNothing";
import type { SentNothing } from "./sentNothing";

/** What each choice does where the write was sent from. */
export type Choices = {
  keepAsDraft: (attempt: string) => Promise<boolean>;
  sendAnyway: (attempt: string) => "started" | SentNothing;
  dismiss: (attempt: string) => void;
};

/** GitHub takes these twice without harm, and a read settles them. */
const harmless: ReadonlySet<PullWrite["kind"]> = new Set([
  "resolve",
  "unresolve",
  "merge",
  "deleteHeadBranch",
]);

const twice = ({ kind }: PullWrite) =>
  kind === "submitReview" || kind === "submitPending"
    ? "Send anyway may post your review twice, with every comment in it."
    : "Send anyway may post it twice.";

/**
 * A write that may have posted, with its choices until L1 Git knows: Open on
 * GitHub, Keep as draft, and Send anyway, which says it may post twice. One
 * the host lost track of offers Dismiss instead. A choice that does nothing
 * says so here.
 */
export function MayHavePosted({
  attempt,
  url,
  choices,
  home,
}: {
  attempt: Attempt;
  url: string;
  choices: Choices;
  /** Where focus goes once a choice takes the choices away. */
  home?: () => HTMLElement | null;
}) {
  const [said, setSaid] = useState<string | null>(null);
  if (attempt.state.kind !== "unknown") return null;
  const { message, kept } = attempt.state;
  const { id, write } = attempt;
  const carriesWords = !harmless.has(write.kind);
  return (
    <div className="write-notice unknown" role="alert">
      <TriangleAlert size={14} aria-hidden="true" />
      <div>
        <p>{message}</p>
        {kept && carriesWords && <p>{twice(write)}</p>}
        {said !== null && <p>{said}</p>}
        <div className="write-choices">
          {/* WebKit's Tab skips a link or button with no tabIndex of its own. */}
          <a
            className="button secondary"
            tabIndex={0}
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={13} aria-hidden="true" />
            Open on GitHub
          </a>
          {kept && carriesWords && (
            <button
              type="button"
              className="button secondary"
              tabIndex={0}
              onClick={() =>
                void choices.keepAsDraft(id).then((done) => {
                  if (done) home?.()?.focus();
                  else setSaid(keptNothing);
                })
              }
            >
              Keep as draft
            </button>
          )}
          {kept ? (
            <button
              type="button"
              className="button secondary"
              tabIndex={0}
              onClick={() => {
                const answer = choices.sendAnyway(id);
                setSaid(answer === "started" ? null : sentNothing[answer]);
                if (answer === "started") home?.()?.focus();
              }}
            >
              Send anyway
            </button>
          ) : (
            <button
              type="button"
              className="button secondary"
              tabIndex={0}
              onClick={() => {
                choices.dismiss(id);
                home?.()?.focus();
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
