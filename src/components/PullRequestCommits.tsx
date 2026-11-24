import { GitCommitHorizontal, RefreshCw } from "lucide-react";
import { commitDays, eventText, personName } from "../domain/pullRequestDetail";
import type { PullRequest } from "../domain/pullRequest";
import { shortOid } from "../domain/shortOid";
import { CopyButton } from "./CopyButton";
import { Ago, OnGitHub } from "./PullRequestParts";

export function PullRequestCommits({
  pull,
  viewer,
  url,
}: {
  pull: PullRequest;
  viewer: string;
  url: string;
}) {
  const { items, total } = pull.commits;
  return (
    <div className="pull-groups">
      {items.length < total && (
        <p className="pull-groups-note">
          Newest {items.length.toLocaleString()} of {total.toLocaleString()}{" "}
          commits. <OnGitHub url={`${url}/commits`} />
        </p>
      )}
      {total === 0 && <p className="pull-groups-note">No commits.</p>}
      {commitDays(pull).map(({ key, label, commits, items }) => (
        <section key={key} aria-label={label}>
          <h3>
            {label}
            {commits > 0 && (
              <span>
                {commits.toLocaleString()}{" "}
                {commits === 1 ? "commit" : "commits"}
              </span>
            )}
          </h3>
          <ul className="pull-group-rows">
            {items.map((item) =>
              item.kind === "forcePushed" ? (
                <li className="forced" key={item.event.id}>
                  <RefreshCw size={14} aria-hidden="true" />
                  <p>
                    <strong>{personName(item.event.by, viewer)}</strong>{" "}
                    {eventText(item.event, pull)}{" "}
                    <span className="entry-dot">·</span>{" "}
                    <Ago at={item.event.at} />
                  </p>
                </li>
              ) : (
                <li key={item.commit.oid}>
                  <GitCommitHorizontal size={14} aria-hidden="true" />
                  <div className="pull-group-summary">
                    <a
                      href={`${url}/commits/${item.commit.oid}`}
                      target="_blank"
                      rel="noreferrer"
                      dir="auto"
                      title={item.commit.headline}
                    >
                      {item.commit.headline || "(no message)"}
                    </a>
                    <p>
                      {personName(item.commit.by, viewer)} committed{" "}
                      <Ago at={item.commit.at} />
                    </p>
                  </div>
                  <code>{shortOid(item.commit.oid)}</code>
                  <CopyButton text={item.commit.oid} what="commit SHA" />
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
