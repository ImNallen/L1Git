import type { Check, PullRequest } from "./pullRequest";

const seconds = (at: string) => Date.parse(at) / 1_000;

export const checkStates = {
  failed: { group: "Failing", result: "Failed" },
  running: { group: "Running", result: "Running" },
  passed: { group: "Passed", result: "Passed" },
  skipped: { group: "Skipped", result: "Skipped" },
} as const;
export type CheckState = keyof typeof checkStates;
/** The worst first. */
const severity = Object.keys(checkStates) as CheckState[];

export const checkGroups = (checks: readonly Check[]) =>
  severity.flatMap((state) => {
    const own = checks.filter((check) => check.state === state);
    return own.length > 0 ? [{ state, checks: own }] : [];
  });

export const countsOf = (checks: readonly Check[]) => {
  const count = (state: CheckState) =>
    checks.filter((check) => check.state === state).length;
  const passed = count("passed");
  const failed = count("failed");
  const running = count("running");
  // Skipped checks neither pass nor fail, so they don't count.
  return { passed, failed, running, total: passed + failed + running };
};

/** The inspector's one phrase. */
export function checksSummary(checks: PullRequest["checks"]): {
  kind: CheckState | "none";
  label: string;
} {
  if (checks === null) return { kind: "none", label: "No access" };
  const { passed, failed, running, total } = countsOf(checks.items);
  if (failed > 0)
    return { kind: "failed", label: `${failed.toLocaleString()} failing` };
  const unseen = checks.total - checks.items.length;
  if (unseen > 0)
    return {
      kind: "none",
      label: `${passed.toLocaleString()} passed, ${unseen.toLocaleString()} not shown`,
    };
  if (total > 0)
    return {
      kind: running > 0 ? "running" : "passed",
      label: `${passed.toLocaleString()} of ${total.toLocaleString()} passed`,
    };
  return checks.items.length > 0
    ? { kind: "skipped", label: "All skipped" }
    : { kind: "none", label: "None" };
}

/** "2 failing, 1 running, 11 passed". */
export const checksLine = (checks: readonly Check[]) =>
  checkGroups(checks)
    .map(
      ({ state, checks: own }) =>
        `${own.length.toLocaleString()} ${checkStates[state].group.toLowerCase()}`,
    )
    .join(", ");

/** When the first check began. */
export const checksStarted = (checks: readonly Check[]) =>
  checks
    .flatMap(({ startedAt }) => startedAt ?? [])
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;

/** "48s", "6m 02s", "1h 04m". Null when GitHub gave no times that make sense. */
export function checkDuration(
  { startedAt, completedAt, state }: Check,
  now: number,
): string | null {
  if (startedAt === null || (completedAt === null && state !== "running"))
    return null;
  const end = completedAt === null ? now : seconds(completedAt);
  const took = Math.round(end - seconds(startedAt));
  if (took < 0) return null;
  const padded = (value: number) => String(value).padStart(2, "0");
  if (took < 60) return `${took}s`;
  const minutes = Math.floor(took / 60);
  if (minutes < 60) return `${minutes}m ${padded(took % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${padded(minutes % 60)}m`;
}

/** A check's page, when it is one that may open. */
export const checkUrl = ({ url }: Check) =>
  url !== null && /^https:\/\//i.test(url) ? url : null;
