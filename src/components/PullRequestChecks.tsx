import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  ExternalLink,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  checkDuration,
  checkGroups,
  checksLine,
  checksStarted,
  checkStates,
  checkUrl,
} from "../domain/pullRequestDetail";
import type { Check, PullRequest } from "../domain/pullRequest";
import { shortOid } from "../domain/shortOid";
import { Ago, OnGitHub } from "./PullRequestParts";

const icons: Record<Check["state"], LucideIcon> = {
  passed: CircleCheck,
  failed: CircleX,
  running: CircleDashed,
  skipped: CircleSlash,
};

export function CheckIcon({ state }: { state: Check["state"] }) {
  const Icon = icons[state];
  return (
    <Icon className={`check-icon ${state}`} size={14} aria-hidden="true" />
  );
}

export function CheckTime({ check }: { check: Check }) {
  const took = checkDuration(check, Date.now() / 1_000);
  return took && <span className="check-time">{took}</span>;
}

export function PullRequestChecks({
  pull: { checks, head },
  url,
}: {
  pull: PullRequest;
  url: string;
}) {
  if (checks === null || checks.items.length === 0)
    return (
      <div className="pull-groups">
        <p className="pull-groups-note">
          {checks === null
            ? "This sign-in can't read its checks."
            : "No checks."}
        </p>
      </div>
    );
  const started = checksStarted(checks.items);
  return (
    <div className="pull-groups">
      <p className="checks-line">
        <strong>{checksLine(checks.items)}</strong> on {shortOid(head.oid)}
        {started !== null && (
          <>
            {" "}
            <span className="entry-dot">·</span> started <Ago at={started} />
          </>
        )}
      </p>
      {checks.items.length < checks.total && (
        <p className="pull-groups-note">
          {checks.items.length.toLocaleString()} of{" "}
          {checks.total.toLocaleString()} checks.{" "}
          <OnGitHub url={`${url}/checks`} />
        </p>
      )}
      {checkGroups(checks.items).map(({ state, checks }) => (
        <section key={state} aria-label={checkStates[state].group}>
          <h3 className={`check-group ${state}`}>{checkStates[state].group}</h3>
          <ul className="pull-group-rows">
            {checks.map((check, index) => {
              const page = checkUrl(check);
              return (
                <li key={`${check.name} ${index}`}>
                  <CheckIcon state={state} />
                  <span className="check-name" title={check.name}>
                    {check.name}
                  </span>
                  {check.required && (
                    <span className="entry-pill">Required</span>
                  )}
                  <span className={`check-result ${state}`}>
                    {checkStates[state].result}
                  </span>
                  <CheckTime check={check} />
                  <span className="check-link">
                    {page !== null && (
                      <a
                        className="icon-button"
                        href={page}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${check.name}`}
                        title={page}
                      >
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
