import { describe as group, expect, it } from "vitest";
import {
  commitWrite,
  describe,
  discardChoice,
  failureText,
  movesRefs,
  rereadsRepository,
  shownPaths,
  stepButton,
  writeFor,
} from "./operations";
import type { History, HistoryEntry, StaleReason } from "./operations";
import {
  entryIdSchema,
  oidSchema,
  refSchema,
  rootSchema,
  stagedStampSchema,
} from "./repository";
import type {
  IndexObject,
  Operation,
  Problem,
  StatusEntry,
  WorktreeStatus,
} from "./repository";

const blob = (digit: string): IndexObject => ({
  mode: "100644",
  oid: oidSchema.parse(digit.repeat(40)),
});
const head = {
  kind: "attached" as const,
  reference: refSchema.parse("refs/heads/main"),
  oid: oidSchema.parse("c".repeat(40)),
};
const modified: StatusEntry = {
  kind: "ordinary",
  path: "README.md",
  submodule: null,
  sides: { kind: "unstaged", unstaged: "M" },
  index: blob("a"),
};
const untracked: StatusEntry = { kind: "untracked", path: "notes.txt" };
const renamed: StatusEntry = {
  kind: "renamed",
  path: "finder.ts",
  original: "search.ts",
  how: "renamed",
  submodule: null,
  side: { kind: "staged", unstaged: null, index: blob("b") },
};
const unmerged: StatusEntry = {
  kind: "unmerged",
  path: "clash.txt",
  conflict: "bothModified",
  submodule: null,
  stages: { base: blob("1"), ours: blob("2"), theirs: blob("3") },
};
const status: WorktreeStatus = {
  root: rootSchema.parse("/work/l1-demo"),
  head,
  entries: [modified, untracked, renamed, unmerged],
  stagedStamp: stagedStampSchema.parse("d".repeat(40)),
};

group("writeFor", () => {
  it("sends back the entries the inspector shows and the HEAD it read", () => {
    expect(writeFor("stageFiles", status, ["README.md"])).toEqual({
      operation: {
        kind: "stageFiles",
        entries: [
          {
            kind: "ordinary",
            path: "README.md",
            submodule: null,
            sides: { kind: "unstaged", unstaged: "M" },
            index: { mode: "100644", oid: "a".repeat(40) },
          },
        ],
      },
      expect: {
        head: {
          kind: "attached",
          reference: "refs/heads/main",
          oid: "c".repeat(40),
        },
      },
    });
    expect(writeFor("stageFiles", status, ["notes.txt"])?.operation).toEqual({
      kind: "stageFiles",
      entries: [{ kind: "untracked", path: "notes.txt" }],
    });
  });

  it("keeps a rename's original and a conflict's stages", () => {
    expect(writeFor("unstageFiles", status, ["finder.ts"])?.operation).toEqual({
      kind: "unstageFiles",
      entries: [
        {
          kind: "renamed",
          path: "finder.ts",
          original: "search.ts",
          how: "renamed",
          submodule: null,
          side: {
            kind: "staged",
            unstaged: null,
            index: { mode: "100644", oid: "b".repeat(40) },
          },
        },
      ],
    });
    expect(writeFor("stageFiles", status, ["clash.txt"])?.operation).toEqual({
      kind: "stageFiles",
      entries: [
        {
          kind: "unmerged",
          path: "clash.txt",
          conflict: "bothModified",
          submodule: null,
          stages: {
            base: { mode: "100644", oid: "1".repeat(40) },
            ours: { mode: "100644", oid: "2".repeat(40) },
            theirs: { mode: "100644", oid: "3".repeat(40) },
          },
        },
      ],
    });
  });

  it("answers null when the status lists none of the paths", () => {
    expect(writeFor("stageFiles", status, ["gone.txt"])).toBeNull();
  });
});

group("describe", () => {
  const stage = (...paths: string[]) =>
    describe({
      kind: "stageFiles",
      entries: paths.map((path) => ({ kind: "untracked", path })),
    });

  it("names one path, a count, and the folder the paths share", () => {
    expect(stage("README.md")).toBe("Stage README.md");
    expect(stage("README.md", "src/a.ts", "src/b.ts")).toBe("Stage 3 files");
    expect(stage("src/ui/a.ts", "src/ui/b.ts", "src/core/c.ts")).toBe(
      "Stage 3 files in src",
    );
    expect(
      describe({ kind: "unstageFiles", entries: [modified, untracked] }),
    ).toBe("Unstage 2 files");
  });

  it("names a stage of conflicts as marking them resolved", () => {
    expect(describe({ kind: "stageFiles", entries: [unmerged] })).toBe(
      "Mark clash.txt resolved",
    );
  });

  it("names a hunk or line write by its file and moves no ref", () => {
    const shown = "diff --git a/src/a.ts b/src/a.ts\n";
    const hunk = {
      kind: "stageHunk",
      path: "src/a.ts",
      hunk: 1,
      shown,
    } satisfies Operation;
    const lines = {
      kind: "discardLines",
      path: "src/a.ts",
      lines: [{ side: "additions", line: 4 }],
      shown,
    } satisfies Operation;
    expect(describe(hunk)).toBe("Stage a hunk of src/a.ts");
    expect(describe({ ...hunk, kind: "unstageHunk" })).toBe(
      "Unstage a hunk of src/a.ts",
    );
    expect(describe(lines)).toBe("Discard lines of src/a.ts");
    expect(movesRefs(hunk)).toBe(false);
    expect(movesRefs(lines)).toBe(false);
  });
});

group("discard", () => {
  it("names a discard by its files", () => {
    expect(describe({ kind: "discard", entries: [modified] })).toBe(
      "Discard README.md",
    );
    expect(describe({ kind: "discard", entries: [modified, untracked] })).toBe(
      "Discard 2 files",
    );
  });

  it("lists up to ten paths, then counts the rest", () => {
    const paths = (count: number) =>
      Array.from({ length: count }, (_, at) => `file-${at + 1}.txt`);
    expect(shownPaths(paths(3))).toEqual({
      shown: ["file-1.txt", "file-2.txt", "file-3.txt"],
      more: 0,
    });
    expect(shownPaths(paths(12))).toEqual({
      shown: [
        "file-1.txt",
        "file-2.txt",
        "file-3.txt",
        "file-4.txt",
        "file-5.txt",
        "file-6.txt",
        "file-7.txt",
        "file-8.txt",
        "file-9.txt",
        "file-10.txt",
      ],
      more: 2,
    });
  });

  it("leaves submodules, nested repositories, git add -N files, and conflicts", () => {
    const entries: StatusEntry[] = [
      modified,
      untracked,
      { kind: "untracked", path: "nested/" },
      {
        ...modified,
        path: "sub",
        submodule: { commitChanged: true, modified: false, untracked: false },
      },
      { ...modified, path: "added.txt", index: null },
      unmerged,
      {
        ...renamed,
        side: { kind: "staged", unstaged: "M", index: blob("b") },
      },
    ];
    expect(
      discardChoice({ ...status, entries }, [
        "README.md",
        "notes.txt",
        "nested/",
        "sub",
        "added.txt",
        "finder.ts",
      ]),
    ).toEqual({ paths: ["README.md", "notes.txt", "finder.ts"], skipped: 3 });
  });
});

const stale = (
  reason: Exclude<StaleReason, "pathNotChosen" | "unknown">,
): Problem => ({
  kind: "staleView",
  reason,
  message: "Core wording that the notice does not show.",
});
const notChosen = (...paths: string[]): Problem => ({
  kind: "staleView",
  reason: "pathNotChosen",
  paths,
  message: "Core wording that the notice does not show.",
});
const unknownReason: Problem = {
  kind: "staleView",
  reason: "unknown",
  message: "A newer core says what changed.",
};

group("failureText", () => {
  const blockedId = entryIdSchema.parse("18e1c91cc9cade98");
  const nextUndo = (id: string): History => ({
    kind: "read",
    undo: {
      id: entryIdSchema.parse(id),
      root: status.root,
      operation: { kind: "stageFiles", entries: [modified] },
      label: "Stage README.md",
    },
    redo: null,
  });
  const blocking = nextUndo("18e1c91cc9cade98");
  const movedOn = nextUndo("27f2d02dd0dbef09");
  const unreadable: History = {
    kind: "unreadable",
    problem: { kind: "unreadablePath", message: "Delete the log." },
  };
  const write = (problem: Problem) =>
    failureText(
      { kind: "failed", action: "write", label: "Stage README.md", problem },
      movedOn,
    );
  const undo = (problem: Problem, history: History) =>
    failureText(
      {
        kind: "failed",
        action: "undo",
        label: "Stage README.md",
        problem,
        entry: blockedId,
      },
      history,
    );

  it("reports a raced commit as landed, not as a failure", () => {
    const message =
      "Another process moved HEAD while Git committed, so the commit 1234567 landed on main after 89abcde instead of after what L1 Git showed. Undo moves main back to 89abcde.";
    expect(write({ kind: "raced", message })).toBe(message);
  });

  it("names a changed staged list for a commit", () => {
    expect(
      failureText(
        {
          kind: "failed",
          action: "write",
          label: "Commit “Fix”",
          problem: stale("stagedChanged"),
        },
        movedOn,
      ),
    ).toBe(
      "Could not commit “Fix”. The staged files changed since L1 Git showed them. L1 Git reread the worktree, so check the lists and try again.",
    );
  });

  it("names what changed from the reason and says the worktree was reread", () => {
    expect(write(stale("headMoved"))).toBe(
      "Could not stage README.md. HEAD moved since L1 Git read this worktree. L1 Git reread the worktree, so check the lists and try again.",
    );
  });

  it("names the files Git would also change", () => {
    expect(write(notChosen("z/x"))).toBe(
      "Could not stage README.md. Git would also change z/x, which was not chosen. L1 Git reread the worktree, so check the lists and try again.",
    );
    expect(write(notChosen("z/x", "z/y"))).toBe(
      "Could not stage README.md. Git would also change z/x and z/y, which were not chosen. L1 Git reread the worktree, so check the lists and try again.",
    );
    expect(write(notChosen("a", "b", "c", "d", "e"))).toBe(
      "Could not stage README.md. Git would also change a, b, and 3 more files, which were not chosen. L1 Git reread the worktree, so check the lists and try again.",
    );
    expect(undo(notChosen("z/x"), blocking)).toBe(
      "Could not undo Stage README.md. Git would also change z/x, which is outside this change, so L1 Git cannot undo it. Undo goes in order, so older changes stay blocked until this one can be undone.",
    );
  });

  it("shows the core's message for a stale reason it does not know", () => {
    expect(write(unknownReason)).toBe(
      "Could not stage README.md. A newer core says what changed.",
    );
    expect(undo(unknownReason, blocking)).toBe(
      "Could not undo Stage README.md. A newer core says what changed.",
    );
  });

  it("explains that a blocked undo holds back the older entries", () => {
    expect(undo(stale("headMoved"), blocking)).toBe(
      "Could not undo Stage README.md. HEAD moved after this change, so L1 Git cannot undo it exactly. Undo goes in order, so older changes stay blocked until this one can be undone.",
    );
  });

  it("names the changed file in the core's words", () => {
    const changed = (message: string): Problem => ({
      kind: "staleView",
      reason: "pathChanged",
      message,
    });
    expect(
      write(
        changed(
          "README.md changed since L1 Git read it. Refresh and try again.",
        ),
      ),
    ).toBe(
      "Could not stage README.md. README.md changed since L1 Git read it. Refresh and try again.",
    );
    expect(
      undo(
        changed(
          "exec.sh changed after this change, so L1 Git cannot undo or redo it without losing that edit. Refresh.",
        ),
        blocking,
      ),
    ).toBe(
      "Could not undo Stage README.md. exec.sh changed after this change, so L1 Git cannot undo or redo it without losing that edit. Refresh. Undo goes in order, so older changes stay blocked until this one can be undone.",
    );
  });

  it("names a reread history when another entry is now next", () => {
    expect(undo(stale("historyChanged"), movedOn)).toBe(
      "Could not undo Stage README.md. The undo history changed since L1 Git showed it. L1 Git reread the undo history.",
    );
  });

  it("claims no reread when the history cannot be read", () => {
    expect(undo(stale("headMoved"), unreadable)).toBe(
      "Could not undo Stage README.md. HEAD moved after this change, so L1 Git cannot undo it exactly.",
    );
    expect(undo(stale("historyChanged"), unreadable)).toBe(
      "Could not undo Stage README.md. The undo history changed since L1 Git showed it.",
    );
  });

  it("passes other errors through as the core wrote them", () => {
    expect(
      failureText(
        {
          kind: "failed",
          action: "redo",
          label: "Unstage 2 files",
          problem: { kind: "unchangedPath", message: "Any core message." },
          entry: blockedId,
        },
        movedOn,
      ),
    ).toBe("Could not redo Unstage 2 files. Any core message.");
  });
});

group("rereadsRepository", () => {
  it("rereads the repository only when HEAD moved", () => {
    expect(rereadsRepository(stale("headMoved"))).toBe(true);
    expect(rereadsRepository(stale("pathChanged"))).toBe(false);
    expect(rereadsRepository(stale("historyChanged"))).toBe(false);
    expect(rereadsRepository(notChosen("z/x"))).toBe(false);
    expect(rereadsRepository(unknownReason)).toBe(false);
    expect(
      rereadsRepository({ kind: "lockHeld", message: "Another Git process." }),
    ).toBe(false);
  });
});

group("stepButton", () => {
  const entry = (label: string): HistoryEntry => ({
    id: entryIdSchema.parse("18e1c91cc9cade98"),
    root: status.root,
    operation: { kind: "stageFiles", entries: [modified] },
    label,
  });

  it("names the entry in the accessible name and the tooltip", () => {
    const history: History = {
      kind: "read",
      undo: entry("Stage README.md"),
      redo: null,
    };
    expect(stepButton(history, "undo", "⌘Z")).toEqual({
      name: "Undo Stage README.md",
      title: "Undo Stage README.md (⌘Z)",
    });
    expect(stepButton(history, "redo", "⇧⌘Z")).toEqual({
      name: "Redo",
      title: "Nothing to redo",
    });
  });

  it("shows why the history cannot be read instead of an empty one", () => {
    const history: History = {
      kind: "unreadable",
      problem: {
        kind: "transport",
        message:
          "The development bridge is unavailable. Start pnpm dev and try again.",
      },
    };
    expect(stepButton(history, "undo", "⌘Z")).toEqual({
      name: "Undo",
      title:
        "Undo is unavailable. The development bridge is unavailable. Start pnpm dev and try again.",
    });
    expect(stepButton(history, "redo", "⇧⌘Z")).toEqual({
      name: "Redo",
      title:
        "Redo is unavailable. The development bridge is unavailable. Start pnpm dev and try again.",
    });
  });

  it("says the history is loading before the first read answers", () => {
    const history: History = { kind: "unread" };
    expect(stepButton(history, "undo", "⌘Z")).toEqual({
      name: "Undo",
      title: "Reading the undo history",
    });
    expect(stepButton(history, "redo", "⇧⌘Z")).toEqual({
      name: "Redo",
      title: "Reading the undo history",
    });
  });
});

group("commitWrite", () => {
  it("sends the staged stamp and the HEAD the box showed", () => {
    expect(commitWrite("commit", status, "Update readme\n")).toEqual({
      operation: {
        kind: "commit",
        message: "Update readme\n",
        staged: "d".repeat(40),
      },
      expect: { head },
    });
    expect(commitWrite("amend", status, "A\n").operation).toEqual({
      kind: "amend",
      message: "A\n",
      staged: "d".repeat(40),
    });
  });

  it("leaves the staged list out of a message edit", () => {
    expect(commitWrite("editMessage", status, "Reword\n")).toEqual({
      operation: { kind: "editMessage", message: "Reword\n" },
      expect: { head },
    });
  });

  it("names commits by their subject and marks them as ref moves", () => {
    const commit = commitWrite("commit", status, "Update readme\n\nBody\n");
    expect(describe(commit.operation)).toBe("Commit “Update readme”");
    expect(describe(commitWrite("amend", status, "Fix").operation)).toBe(
      "Amend “Fix”",
    );
    expect(
      describe(commitWrite("editMessage", status, "x".repeat(80)).operation),
    ).toBe(`Edit message to “${"x".repeat(59)}…”`);
    expect(movesRefs(commit.operation)).toBe(true);
    const stage = writeFor("stageFiles", status, ["README.md"]);
    expect(stage && movesRefs(stage.operation)).toBe(false);
  });
});
