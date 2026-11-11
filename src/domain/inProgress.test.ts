import { describe, expect, it } from "vitest";
import { activeMerge, idleMerge, replayInProgress } from "../test/fixtures";
import {
  conflictLabel,
  finishBlock,
  inProgress,
  operationGroups,
  operationMessage,
} from "./inProgress";
import { mergeStateSchema } from "./merge";
import type { MergeState } from "./merge";
import {
  conflictVersionSchema,
  oidSchema,
  statusEntrySchema,
} from "./repository";
import type { RepositoryRoot } from "./repository";

const root = "/repo" as RepositoryRoot;

function merge(
  edit: (state: Extract<MergeState, { kind: "active" }>) => void,
): MergeState {
  const state = activeMerge(root, ["a.ts", "b.ts", "c.ts", "clean.ts"]);
  if (state.kind !== "active") throw new Error("expected an active merge");
  state.session.conflicted = ["a.ts", "b.ts", "c.ts"];
  edit(state);
  return mergeStateSchema.parse(state);
}

function running(state: MergeState) {
  const shown = inProgress(state);
  if (shown.kind !== "running") throw new Error(`got ${shown.kind}`);
  return shown;
}

describe("inProgress", () => {
  it("is none without state or when idle", () => {
    expect(inProgress(null)).toEqual({ kind: "none" });
    expect(inProgress(idleMerge())).toEqual({ kind: "none" });
  });

  it("names a merge's sides by short ref and splits its files", () => {
    const shown = running(
      merge((state) => {
        state.unresolved = ["b.ts", "c.ts"];
      }),
    );
    expect(shown).toMatchObject({
      verb: "merge",
      current: { name: "feature" },
      incoming: { name: "origin/feature" },
      subject: null,
      phase: "conflicted",
      progress: {
        unresolved: ["b.ts", "c.ts"],
        resolved: ["a.ts"],
        clean: ["clean.ts"],
        total: 3,
      },
    });
  });

  it("is ready once every conflicted path is resolved", () => {
    const shown = running(merge(() => {}));
    expect(shown.phase).toBe("ready");
    expect(shown.progress.resolved).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("knows only what is left for a session from before conflicts were recorded", () => {
    const shown = running(
      merge((state) => {
        state.session.conflicted = null;
        state.unresolved = ["b.ts"];
      }),
    );
    expect(shown.progress).toEqual({
      unresolved: ["b.ts"],
      resolved: null,
      clean: null,
      total: null,
    });
  });

  it("describes a cherry-pick by its commit and destination", () => {
    const state = replayInProgress(root, ["x.ts", "y.ts"], {
      conflicted: ["x.ts"],
      unresolved: ["x.ts"],
    });
    const shown = running(state);
    if (state.kind !== "replay") throw new Error("expected a replay");
    expect(shown).toMatchObject({
      verb: "cherryPick",
      key: `cherryPick:${state.progress.commit}`,
      current: { name: "main" },
      incoming: {
        name: state.progress.commit.slice(0, 7),
        oid: state.progress.commit,
      },
      subject: "Picked commit",
      phase: "conflicted",
      progress: { resolved: [], clean: ["y.ts"], total: 1 },
    });
  });

  it("marks a replay whose result matches HEAD as empty", () => {
    const shown = running(
      replayInProgress(root, ["x.ts"], { kind: "revert", empty: true }),
    );
    expect(shown.verb).toBe("revert");
    expect(shown.phase).toBe("empty");
  });

  it("names a detached destination", () => {
    const shown = running(
      replayInProgress(root, [], {
        destination: { kind: "detached", oid: oidSchema.parse("d".repeat(40)) },
      }),
    );
    expect(shown.current).toEqual({
      name: "Detached HEAD",
      oid: "d".repeat(40),
    });
  });

  it("separates operations started elsewhere from ones needing recovery", () => {
    expect(
      inProgress(
        mergeStateSchema.parse({
          kind: "attention",
          session: null,
          reason: "externalOperation",
          message: "A rebase is in progress.",
        }),
      ),
    ).toEqual({ kind: "external", message: "A rebase is in progress." });
    expect(
      inProgress(
        mergeStateSchema.parse({
          kind: "attention",
          session: null,
          reason: "recoveryRequired",
          message: "Recover first.",
        }),
      ),
    ).toEqual({ kind: "attention", message: "Recover first.", session: null });
  });
});

describe("finishBlock", () => {
  const ready = { unsavedResults: false, amending: false, message: "Merge" };

  it("allows Finish when everything is in place", () => {
    const shown = running(
      merge((state) => {
        state.tree = oidSchema.parse("e".repeat(40));
      }),
    );
    expect(finishBlock(shown, ready)).toBeNull();
  });

  it("reports blocks in the order to fix them", () => {
    const shown = running(
      merge((state) => {
        state.unresolved = ["a.ts"];
      }),
    );
    const all = { unsavedResults: true, amending: true, message: " " };
    expect(finishBlock(shown, all)).toBe("unresolved");
    const resolved = running(merge(() => {}));
    expect(finishBlock(resolved, all)).toBe("unsavedResults");
    expect(finishBlock(resolved, { ...all, unsavedResults: false })).toBe(
      "notStaged",
    );
  });

  it("blocks a replay while Amend is on, but not a merge", () => {
    const amending = { ...ready, amending: true };
    const replay = running(replayInProgress(root, []));
    expect(finishBlock(replay, amending)).toBe("amending");
    const staged = running(
      merge((state) => {
        state.tree = oidSchema.parse("e".repeat(40));
      }),
    );
    expect(finishBlock(staged, amending)).toBeNull();
    expect(finishBlock(staged, { ...ready, message: "\n" })).toBe("noMessage");
  });
});

describe("operationMessage", () => {
  const running = { suggestedMessage: "Merge topic into main\n\nWhy.\n" };

  it("stands a blank draft in for the suggested message", () => {
    expect(operationMessage(running, { summary: "", description: "" })).toEqual(
      {
        draft: { summary: "Merge topic into main", description: "Why." },
        message: "Merge topic into main\n\nWhy.\n",
        edited: false,
      },
    );
  });

  it("commits what the user typed once they edit", () => {
    expect(
      operationMessage(running, { summary: "Mine", description: "" }),
    ).toMatchObject({ message: "Mine\n", edited: true });
  });
});

describe("operationGroups", () => {
  const staged = (path: string, code: "A" | "M" | "D") =>
    statusEntrySchema.parse({
      kind: "ordinary",
      path,
      submodule: null,
      sides: { kind: "staged", staged: code },
      index: null,
    });
  const entries = [
    staged("a.ts", "M"),
    staged("clean.ts", "A"),
    statusEntrySchema.parse({
      kind: "ordinary",
      path: "b.ts",
      submodule: null,
      sides: { kind: "both", staged: "M", unstaged: "M" },
      index: null,
    }),
    statusEntrySchema.parse({ kind: "untracked", path: "notes.txt" }),
  ];

  it("queues what is left, then what was resolved, merged cleanly, and not staged", () => {
    const groups = operationGroups(
      {
        unresolved: ["c.ts"],
        resolved: ["a.ts", "b.ts"],
        clean: ["clean.ts"],
        total: 3,
      },
      entries,
    );
    expect(
      groups.map(({ kind, title, side, files }) => [
        kind,
        title,
        side,
        files.map((file) => `${file.path}:${file.status}`),
      ]),
    ).toEqual([
      ["unresolved", "Needs resolution", "conflict", ["c.ts:modified"]],
      ["resolved", "Resolved", "staged", ["a.ts:modified", "b.ts:modified"]],
      ["clean", "Merged cleanly", "staged", ["clean.ts:added"]],
      [
        "unstaged",
        "Not staged",
        "unstaged",
        ["b.ts:modified", "notes.txt:untracked"],
      ],
    ]);
  });

  it("drops empty groups and keeps one staged group without the recorded conflicts", () => {
    const groups = operationGroups(
      { unresolved: [], resolved: null, clean: null, total: null },
      [staged("a.ts", "M")],
    );
    expect(groups.map(({ kind, title }) => [kind, title])).toEqual([
      ["staged", "Staged"],
    ]);
  });
});

describe("conflictLabel", () => {
  const whole = (
    shape:
      | "deletedByThem"
      | "deletedByUs"
      | "addedByUs"
      | "addedByThem"
      | "binary"
      | "symlink",
  ) =>
    conflictLabel({
      kind: "wholeFile",
      path: "x",
      version: conflictVersionSchema.parse("f".repeat(40)),
      shape,
      current: null,
      incoming: null,
      disk: "unknown",
    });

  it("names what still stands between a path and Mark resolved", () => {
    expect(conflictLabel({ kind: "text", path: "x", conflicts: 2 })).toBe(
      "2 conflicts",
    );
    expect(conflictLabel({ kind: "text", path: "x", conflicts: 1 })).toBe(
      "1 conflict",
    );
    expect(conflictLabel({ kind: "text", path: "x", conflicts: 0 })).toBe(
      "Ready to mark resolved",
    );
    expect(whole("deletedByThem")).toBe("Deleted vs edited");
    expect(whole("deletedByUs")).toBe("Deleted vs edited");
    expect(whole("binary")).toBe("Binary file");
    expect(whole("symlink")).toBe("Symlink");
    expect(whole("addedByUs")).toBe("Added on one side");
    expect(whole("addedByThem")).toBe("Added on one side");
    expect(
      conflictLabel({ kind: "external", path: "x", reason: "structural" }),
    ).toBe("Resolve outside L1 Git");
  });
});
