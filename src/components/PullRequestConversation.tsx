import { use, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  CircleCheck,
  CircleDot,
  CircleX,
  Eye,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquareCode,
  MessageSquareX,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  conversation,
  eventText,
  leftOut,
  personName,
  reviewStateLabels,
  threadsLeftOut,
} from "../domain/pullRequestDetail";
import { threadsView } from "../domain/threadStanding";
import type { Entry } from "../domain/pullRequestDetail";
import type { PullRequest } from "../domain/pullRequest";
import { shortOid } from "../domain/shortOid";
import type { ThreadFilter } from "../domain/threadStanding";
import { usePullWrites } from "../shell/usePullWriting";
import type { OpenedPullRequest } from "../shell/usePullRequests";
import { ConversationBox } from "./ConversationBox";
import {
  ConversationWritingContext,
  doneAt,
  madeId,
  wordsOf,
} from "./conversationWriting";
import { Body } from "./PullRequestBody";
import { Ago, Avatar, OnGitHub } from "./PullRequestParts";
import { Thread } from "./PullRequestThread";
import { PullRequestThreads, ThreadFilters } from "./PullRequestThreads";
import { Turns, TurnsContext } from "./turns";

type EventEntry = Extract<Entry, { kind: "event" }>;

function eventIcon({ event }: EventEntry): [LucideIcon, string] {
  switch (event.kind) {
    case "review":
      switch (event.state) {
        case "approved":
          return [CircleCheck, "good"];
        case "changesRequested":
          return [CircleX, "bad"];
        case "dismissed":
          return [MessageSquareX, ""];
        default:
          return [Eye, ""];
      }
    case "forcePushed":
      return [RefreshCw, ""];
    case "merged":
      return [GitMerge, "merged"];
    case "closed":
      return [GitPullRequestClosed, "bad"];
    case "reopened":
      return [CircleDot, "good"];
    case "branchDeleted":
      return [Trash2, ""];
    case "readyForReview":
      return [Eye, ""];
    case "convertedToDraft":
      return [GitPullRequestDraft, ""];
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function Rail({ icon: Icon, tone = "" }: { icon: LucideIcon; tone?: string }) {
  return (
    <span className={`entry-icon ${tone}`} aria-hidden="true">
      <Icon size={14} />
    </span>
  );
}

function Line({
  icon,
  tone,
  who,
  at,
  children,
}: {
  icon: LucideIcon;
  tone?: string;
  who: string;
  at: string;
  children: string;
}) {
  return (
    <>
      <Rail icon={icon} tone={tone} />
      <p className="entry-line">
        <strong>{who}</strong> <span dir="auto">{children}</span>{" "}
        <span className="entry-dot">·</span> <Ago at={at} />
      </p>
    </>
  );
}

function Card({
  by,
  viewer,
  at,
  verb,
  pill,
  children,
}: {
  by: string | null;
  viewer: string;
  at: string;
  verb: string;
  pill: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <Avatar login={by} />
      <article className="entry-card">
        <header>
          <h3>
            <strong>{personName(by, viewer)}</strong> {verb}{" "}
            <span className="entry-dot">·</span> <Ago at={at} />
          </h3>
          {pill}
        </header>
        <div className="entry-body">{children}</div>
      </article>
    </>
  );
}

const AuthorPill = () => <span className="entry-pill">Author</span>;

function Shown({
  entry,
  pull,
  viewer,
  url,
}: {
  entry: Entry;
  pull: PullRequest;
  viewer: string;
  url: string;
}) {
  const { by, at } = entry;
  const who = personName(by, viewer);
  const author = by !== null && by === pull.author ? <AuthorPill /> : null;
  switch (entry.kind) {
    case "commits": {
      const { length } = entry.commits;
      return (
        <>
          <Line icon={GitCommitHorizontal} who={who} at={at}>
            {`added ${length.toLocaleString()} ${length === 1 ? "commit" : "commits"}`}
          </Line>
          <ul className="entry-commits">
            {entry.commits.map(({ oid, headline }) => (
              <li key={oid}>
                <GitCommitHorizontal size={13} aria-hidden="true" />
                <span dir="auto" title={headline}>
                  {headline || "(no message)"}
                </span>
                <code>{shortOid(oid)}</code>
              </li>
            ))}
          </ul>
        </>
      );
    }
    case "comment":
      return (
        <Card by={by} viewer={viewer} at={at} verb="commented" pill={author}>
          <Body text={entry.body} />
        </Card>
      );
    case "review":
      return (
        <Card
          by={by}
          viewer={viewer}
          at={at}
          verb="reviewed"
          pill={
            <span className={`entry-pill ${entry.state}`}>
              {reviewStateLabels[entry.state]}
            </span>
          }
        >
          {entry.body.trim() !== "" && <Body text={entry.body} />}
          {entry.threads.map((thread) => (
            <Thread key={thread.id} thread={thread} viewer={viewer} url={url} />
          ))}
        </Card>
      );
    case "thread":
      return (
        <>
          <Rail icon={MessageSquareCode} />
          <Thread thread={entry.thread} viewer={viewer} url={url} />
        </>
      );
    case "event": {
      const [icon, tone] = eventIcon(entry);
      return (
        <Line icon={icon} tone={tone} who={who} at={at}>
          {eventText(entry.event, pull)}
        </Line>
      );
    }
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

function LeftOut({ text, url }: { text: string; url: string }) {
  return (
    <li className="entry-note">
      {text} <OnGitHub url={url} />
    </li>
  );
}

/** Comments GitHub took that no read has shown yet. */
function Sent({ pull, viewer }: { pull: PullRequest; viewer: string }) {
  const writing = use(ConversationWritingContext);
  if (writing === null) throw new Error("Sent comments need their writing.");
  const { attempts } = usePullWrites(writing.opened);
  const read = new Set(pull.timeline.items.map(({ id }) => id));
  return doneAt(attempts, { kind: "comment" })
    .filter((attempt) => !read.has(madeId(attempt) ?? ""))
    .map((attempt) => (
      <li className="entry" key={attempt.id}>
        <Card
          by={viewer}
          viewer={viewer}
          at={new Date(
            attempt.state.kind === "done" ? attempt.state.answeredAt : 0,
          ).toISOString()}
          verb="commented"
          pill={<span className="entry-pill">Sent</span>}
        >
          <Body text={wordsOf(attempt.write)} />
        </Card>
      </li>
    ));
}

type View = "timeline" | "threads";

export function PullRequestConversation({
  pull,
  opened: { writing, viewer, repository, number },
  url,
  onShowInDiff,
}: {
  pull: PullRequest;
  opened: Pick<
    OpenedPullRequest,
    "writing" | "viewer" | "repository" | "number"
  >;
  url: string;
  onShowInDiff: (path: string) => void;
}) {
  const earlier = leftOut(pull);
  const threads =
    pull.threads === null
      ? "Review threads didn't load. GitHub couldn't answer for a pull request this large."
      : threadsLeftOut(pull);
  const [turns] = useState(() => new Turns());
  const [view, setView] = useState<View>("timeline");
  const [filter, setFilter] = useState<ThreadFilter>("open");
  const { github } = repository;
  const { id, head } = pull;
  const writes = useMemo(
    () => ({
      opened: { writing, viewer, repository: { github }, number },
      pull: id,
      head: head.oid,
      url,
    }),
    [writing, viewer, github, number, id, head.oid, url],
  );
  const items = pull.threads?.items ?? [];
  const open = items.filter(({ resolved }) => !resolved).length;
  const counts = threadsView(items, viewer, filter, new Set()).counts;
  return (
    <ConversationWritingContext value={writes}>
      <TurnsContext value={turns}>
        <div className="conversation-bar">
          <div className="conversation-views" role="group" aria-label="Show">
            {(["timeline", "threads"] as const).map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={view === each}
                onClick={() => setView(each)}
              >
                {each === "timeline" ? "Timeline" : "Threads"}
                {each === "threads" && pull.threads !== null && (
                  <>
                    {" "}
                    <span className="conversation-views-count">
                      {open.toLocaleString()} open
                    </span>
                  </>
                )}
              </button>
            ))}
          </div>
          {view === "threads" && pull.threads !== null && (
            <>
              <ThreadFilters
                counts={counts}
                filter={filter}
                onFilter={setFilter}
              />
              <span className="conversation-sorted">Sorted by file</span>
            </>
          )}
        </div>
        {view === "threads" ? (
          <>
            {threads !== null && <p className="threads-note">{threads}</p>}
            {pull.threads !== null && (
              <PullRequestThreads
                key={filter}
                threads={items}
                viewer={viewer}
                url={url}
                filter={filter}
                onFilter={setFilter}
                onShowInDiff={onShowInDiff}
              />
            )}
          </>
        ) : (
          <Timeline
            pull={pull}
            viewer={viewer}
            url={url}
            earlier={earlier}
            threads={threads}
          />
        )}
      </TurnsContext>
    </ConversationWritingContext>
  );
}

function Timeline({
  pull,
  viewer,
  url,
  earlier,
  threads,
}: {
  pull: PullRequest;
  viewer: string;
  url: string;
  earlier: string | null;
  threads: string | null;
}) {
  return (
    <>
      <ol className="conversation" aria-label="Conversation">
        <li className="entry">
          <Card
            by={pull.author}
            viewer={viewer}
            at={pull.createdAt}
            verb="opened this pull request"
            pill={<AuthorPill />}
          >
            {pull.body.trim() === "" ? (
              <p className="entry-nothing">No description.</p>
            ) : (
              <Body text={pull.body} />
            )}
          </Card>
        </li>
        {earlier !== null && <LeftOut text={earlier} url={url} />}
        {threads !== null && <LeftOut text={threads} url={url} />}
        {conversation(pull).map((entry) => (
          <li className="entry" key={entry.key}>
            <Shown entry={entry} pull={pull} viewer={viewer} url={url} />
          </li>
        ))}
        <Sent pull={pull} viewer={viewer} />
      </ol>
      <div className="conversation-compose">
        <Avatar login={viewer} />
        <ConversationBox
          place={{ kind: "comment" }}
          label="Comment on this pull request"
          placeholder="Leave a comment. Markdown works here."
        />
      </div>
    </>
  );
}
