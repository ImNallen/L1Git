import { describe, expect, it } from "vitest";
import { mergeAllows, mergeStateSchema } from "./merge";
import { operationSchema } from "./repository";

const oid = (digit: string) => digit.repeat(40);

const replay = mergeStateSchema.parse({
  kind: "replay",
  progress: {
    root: "/repo",
    kind: "cherryPick",
    commit: oid("a"),
    subject: "Picked",
    destination: {
      kind: "attached",
      reference: "refs/heads/main",
      oid: oid("b"),
    },
    footprint: ["inside.txt"],
    unresolved: ["inside.txt"],
    staged: "c".repeat(40),
    tree: null,
    empty: false,
    suggestedMessage: "Picked\n",
  },
});

const operation = (value: unknown) => operationSchema.parse(value);

const stageHunk = (path: string) =>
  operation({ kind: "stageHunk", path, hunk: 0, shown: "" });

const finish = operation({
  kind: "finishReplay",
  of: { kind: "cherryPick", commit: oid("a") },
  staged: "c".repeat(40),
  tree: oid("d"),
  message: "Picked",
});

const start = operation({
  kind: "replay",
  review: {
    root: "/repo",
    kind: "cherryPick",
    commit: oid("a"),
    subject: "Picked",
    destination: { reference: "refs/heads/main", oid: oid("b") },
    prediction: { kind: "clean", tree: oid("d") },
  },
});

describe("mergeAllows during a replay", () => {
  it("allows a new replay only while the worktree is idle", () => {
    expect(mergeAllows(mergeStateSchema.parse({ kind: "idle" }), start)).toBe(
      true,
    );
    expect(mergeAllows(replay, start)).toBe(false);
  });

  it("allows Finish only during a replay", () => {
    expect(mergeAllows(replay, finish)).toBe(true);
    expect(
      mergeAllows(
        mergeStateSchema.parse({
          kind: "attention",
          session: null,
          reason: "externalOperation",
          message: "A rebase is in progress.",
        }),
        finish,
      ),
    ).toBe(false);
  });

  it("allows index edits only inside the footprint", () => {
    expect(mergeAllows(replay, stageHunk("inside.txt"))).toBe(true);
    expect(mergeAllows(replay, stageHunk("outside.txt"))).toBe(false);
  });

  it("refuses a plain commit", () => {
    expect(
      mergeAllows(
        replay,
        operation({ kind: "commit", message: "m", staged: "c".repeat(40) }),
      ),
    ).toBe(false);
  });
});
