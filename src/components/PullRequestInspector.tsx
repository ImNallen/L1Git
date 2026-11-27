import type { ReactNode } from "react";
import { checkGroups, checksSummary } from "../domain/pullRequestChecks";
import { headName, reviewers } from "../domain/pullRequestDetail";
import { pullRequestUrl } from "../domain/pullRequestList";
import type { OpenedPullRequest } from "../shell/usePullRequests";
import type { FilesChangedState } from "../shell/useFilesChanged";
import type { PullRequestCheckout } from "../shell/usePullRequestCheckout";
import { ChangedFilesSection } from "./ChangedFilesSection";
import { CheckIcon, CheckTime } from "./PullRequestChecks";
import { PullRequestMerge } from "./PullRequestMerge";
import { Ago, Avatar, Bars } from "./PullRequestParts";

const FEW_CHECKS = 4;

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="pull-fact">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const moment = (at: string) =>
  new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

function ChecksAndDetails({
  opened: { repository, number, summary, read },
  onShowChecks,
}: {
  opened: OpenedPullRequest;
  onShowChecks: () => void;
}) {
  const { value: pull, problem } = read;
  const of = pull ?? summary;
  const url = pullRequestUrl(repository.github, number);
  const loading = pull === null && problem === null;
  const bones = (count: number) => (loading ? <Bars count={count} /> : "–");
  const checks = pull?.checks ?? null;
  const ordered = checkGroups(checks?.items ?? []).flatMap(
    (group) => group.checks,
  );
  const few = ordered.slice(0, FEW_CHECKS);
  const sum = pull && checksSummary(pull.checks);
  return (
    <>
      <section aria-label="Checks">
        <h3>
          Checks
          {sum && (
            <span className={`check-result ${sum.kind}`}>{sum.label}</span>
          )}
        </h3>
        {pull === null && bones(3)}
        {pull?.checks === null && (
          <p className="pull-inspector-none">
            This sign-in can&apos;t read its checks.
          </p>
        )}
        {few.length > 0 && (
          <ul>
            {few.map((check, index) => (
              <li key={`${check.name} ${index}`}>
                <CheckIcon state={check.state} />
                <span className="pull-inspector-name" title={check.name}>
                  {check.name}
                </span>
                <CheckTime check={check} />
              </li>
            ))}
          </ul>
        )}
        {checks !== null && few.length < checks.total && (
          <button type="button" className="pull-link" onClick={onShowChecks}>
            Show {(checks.total - few.length).toLocaleString()} more
          </button>
        )}
      </section>
      <section aria-label="Details">
        <h3>Details</h3>
        <dl>
          <Fact name="Repository">
            <span
              title={`${repository.github.owner}/${repository.github.repo}`}
            >
              {repository.name}
            </span>
          </Fact>
          <Fact name="Merges into">
            {of ? <code title={of.base}>{of.base}</code> : bones(1)}
          </Fact>
          <Fact name="From">
            {pull ? (
              <code
                title={
                  pull.head.repository === null
                    ? `${pull.head.branch}, whose repository is gone`
                    : headName(pull)
                }
              >
                {headName(pull)}
              </code>
            ) : summary ? (
              <code title={summary.head}>{summary.head}</code>
            ) : (
              bones(1)
            )}
          </Fact>
          <Fact name="Labels">
            {of === null ? (
              bones(1)
            ) : of.labels.items.length === 0 ? (
              "None"
            ) : (
              <span className="pull-inspector-labels">
                {of.labels.items.map(({ name }) => (
                  <span className="pull-label" key={name} title={name}>
                    {name}
                  </span>
                ))}
                {of.labels.total > of.labels.items.length &&
                  `+${of.labels.total - of.labels.items.length}`}
              </span>
            )}
          </Fact>
          <Fact name="Changes">
            {pull ? (
              <a
                className="pull-link"
                href={`${url}/files`}
                target="_blank"
                rel="noreferrer"
              >
                <span className="change-stat added">
                  +{pull.additions.toLocaleString()}
                </span>{" "}
                <span className="change-stat deleted">
                  {"−"}
                  {pull.deletions.toLocaleString()}
                </span>{" "}
                in {pull.changedFiles.toLocaleString()}{" "}
                {pull.changedFiles === 1 ? "file" : "files"}
              </a>
            ) : (
              bones(1)
            )}
          </Fact>
          <Fact name="Opened">
            {of ? (
              <time dateTime={of.createdAt}>{moment(of.createdAt)}</time>
            ) : (
              bones(1)
            )}
          </Fact>
          <Fact name="Updated">
            {of ? <Ago at={of.updatedAt} /> : bones(1)}
          </Fact>
        </dl>
      </section>
    </>
  );
}

export function PullRequestInspector({
  opened,
  files,
  checkout,
  onShowChecks,
  onShowCommits,
}: {
  opened: OpenedPullRequest;
  files: Pick<
    FilesChangedState,
    "held" | "viewed" | "choose" | "show" | "showRebased"
  >;
  checkout: Pick<PullRequestCheckout, "local" | "deleteLocal">;
  onShowChecks: () => void;
  onShowCommits: () => void;
}) {
  const { repository, number, tab, read, viewer } = opened;
  const { value: pull, problem } = read;
  const url = pullRequestUrl(repository.github, number);
  const loading = pull === null && problem === null;
  const people = pull && reviewers(pull, viewer);
  return (
    <aside
      className="inspector pull-inspector"
      aria-label="Pull request details"
    >
      <div className="inspector-heading">
        <span>Pull request details</span>
      </div>
      <div className="pull-inspector-content" data-tab={tab}>
        <section aria-label="Reviewers">
          <h3>Reviewers</h3>
          {people === null ? (
            loading ? (
              <Bars count={3} />
            ) : (
              "–"
            )
          ) : people.length === 0 ? (
            <p className="pull-inspector-none">Nobody yet</p>
          ) : (
            <ul>
              {people.map(({ login, name, state, label }, index) => (
                <li key={index}>
                  <Avatar login={login ?? "team"} />
                  <span className="pull-inspector-name" title={name}>
                    {name}
                  </span>
                  <span className={`reviewer-state ${state}`}>{label}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        {tab === "files" ? (
          <ChangedFilesSection
            held={files.held}
            viewed={files.viewed}
            pull={pull}
            url={`${url}/files`}
            onGo={files.choose}
            onShowRebased={files.showRebased}
            onOpenInAll={(file) => {
              const all =
                files.held?.read.kind === "ready" ? files.held.read.files : [];
              files.show("all");
              files.choose(all.indexOf(file));
            }}
          />
        ) : (
          <ChecksAndDetails opened={opened} onShowChecks={onShowChecks} />
        )}
      </div>
      <PullRequestMerge
        key={opened.id}
        opened={opened}
        checkout={checkout}
        url={url}
        onShowCommits={onShowCommits}
      />
    </aside>
  );
}
