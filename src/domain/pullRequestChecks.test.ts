import { describe, expect, it } from "vitest";
import type { Check, PullRequest } from "./pullRequest";
import {
  checkDuration,
  checkGroups,
  checksLine,
  checksStarted,
  checksSummary,
  checkUrl,
} from "./pullRequestChecks";

const at = (minute: number) =>
  `2026-11-24T10:${String(minute).padStart(2, "0")}:00Z`;
const page = <T>(items: T[], total = items.length) => ({ items, total });
const check = (
  name: string,
  state: Check["state"],
  fields: Partial<Check> = {},
): Check => ({
  name,
  state,
  required: false,
  startedAt: null,
  completedAt: null,
  url: null,
  ...fields,
});

describe("checks", () => {
  const mixed = [
    check("a", "passed"),
    check("b", "skipped"),
    check("c", "failed"),
    check("d", "running"),
    check("e", "passed"),
    check("f", "failed"),
  ];

  it("groups the worst first", () => {
    expect(
      checkGroups(mixed).map(
        ({ state, checks }) =>
          `${state} ${checks.map(({ name }) => name).join("")}`,
      ),
    ).toEqual(["failed cf", "running d", "passed ae", "skipped b"]);
    expect(checksLine(mixed)).toBe("2 failing, 1 running, 2 passed, 1 skipped");
  });

  it.each<[PullRequest["checks"], string]>([
    [null, "No access"],
    [page([]), "None"],
    [page(mixed), "2 failing"],
    [page([check("a", "passed"), check("b", "running")]), "1 of 2 passed"],
    [page([check("a", "passed"), check("b", "skipped")]), "1 of 1 passed"],
    [page([check("b", "skipped")]), "All skipped"],
    [page([check("a", "passed")], 41), "1 passed, 40 not shown"],
  ])("sums up %#", (checks, label) => {
    expect(checksSummary(checks).label).toBe(label);
  });

  it.each([
    [0, 48, "48s"],
    [0, 252, "4m 12s"],
    [0, 362, "6m 02s"],
    [0, 3_840, "1h 04m"],
    [60, 0, null],
  ])("from %i to %i seconds took %s", (from, to, took) => {
    const time = (seconds: number) =>
      new Date(Date.UTC(2026, 10, 24) + seconds * 1_000).toISOString();
    expect(
      checkDuration(
        check("a", "passed", { startedAt: time(from), completedAt: time(to) }),
        0,
      ),
    ).toBe(took);
  });

  it("counts a running one until now, and says nothing without times", () => {
    const now = Date.parse(at(3)) / 1_000;
    const running = check("a", "running", { startedAt: at(1) });
    expect(checkDuration(running, now)).toBe("2m 00s");
    expect(checkDuration({ ...running, state: "passed" }, now)).toBeNull();
    expect(checkDuration(check("a", "passed"), now)).toBeNull();
  });

  it("finds the first start", () => {
    expect(
      checksStarted([
        check("a", "passed", { startedAt: at(4) }),
        check("b", "passed", { startedAt: at(2) }),
        check("c", "passed"),
      ]),
    ).toBe(at(2));
    expect(checksStarted([])).toBeNull();
  });

  it.each([
    ["https://github.com/octo/app/actions/runs/1", true],
    ["http://ci.example/1", false],
    ["javascript:alert(1)", false],
    [null, false],
  ])("opens %s: %s", (url, opens) => {
    expect(checkUrl(check("a", "passed", { url })) !== null).toBe(opens);
  });
});
