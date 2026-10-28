import { describe as group, expect, it } from "vitest";
import {
  branchStep,
  branchWrite,
  checkoutWrite,
  commitWrite,
  describe,
  discardChoice,
  failureText,
  hookOutputTail,
  movesRefs,
  partActions,
  partWrite,
  rereadsRepository,
  shownPaths,
  stepButton,
  notMergedInto,
  startAt,
  writeFor,
} from "./operations";
import type { History, HistoryEntry, StaleReason } from "./operations";
import {
  entryIdSchema,
  localRefSchema,
  oidSchema,
  problemFrom,
  refSchema,
  rootSchema,
  stagedStampSchema,
} from "./repository";
import type {
  IndexObject,
  Operation,
  Problem,
  StatusEntry,
  WorktreePatch,
  WorktreeStatus,
} from "./repository";
import type { ListSide } from "./worktree";

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
  const stageReadme: Operation = { kind: "stageFiles", entries: [modified] };
  const write = (problem: Problem) =>
    failureText(
      {
        kind: "failed",
        action: "write",
        label: "Stage README.md",
        problem,
        operation: stageReadme,
      },
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
          operation: commitWrite("commit", status, "Fix").operation,
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

  it("says a hunk write reread the diff it refused", () => {
    expect(
      failureText(
        {
          kind: "failed",
          action: "write",
          label: "Stage a hunk of README.md",
          problem: stale("pathChanged"),
          operation: {
            kind: "stageHunk",
            path: "README.md",
            hunk: 0,
            shown: "",
          },
        },
        movedOn,
      ),
    ).toBe(
      "Could not stage a hunk of README.md. The file changed since L1 Git showed its diff. L1 Git reread the diff, so check it and try again.",
    );
  });

  it("passes the core's words through when a hunk write would change another path", () => {
    const message =
      "Git would also stage z/x along with part of z, so L1 Git changed nothing. Refresh and try again, or stage z with Git.";
    expect(
      failureText(
        {
          kind: "failed",
          action: "write",
          label: "Stage lines of z",
          problem: {
            kind: "staleView",
            reason: "pathNotChosen",
            paths: ["z/x"],
            message,
          },
          operation: {
            kind: "stageLines",
            path: "z",
            lines: [{ side: "additions", line: 1 }],
            shown: "",
          },
        },
        movedOn,
      ),
    ).toBe(`Could not stage lines of z. ${message}`);
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

group("partActions", () => {
  type Ordinary = Extract<StatusEntry, { kind: "ordinary" }>;
  const ordinary = (
    sides: Ordinary["sides"],
    index: IndexObject | null = blob("a"),
  ): Ordinary => ({
    kind: "ordinary",
    path: "a.txt",
    submodule: null,
    sides,
    index,
  });
  const both = ordinary({ kind: "both", staged: "M", unstaged: "M" });
  const submodule = { commitChanged: true, modified: false, untracked: false };
  const text = (patch: string): WorktreePatch => ({
    kind: "diff",
    diff: { kind: "text", patch, lossy: false },
  });
  const edited = `diff --git a/a.txt b/a.txt
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
${" "}
-two
+TWO
`;
  const edit = text(edited);
  const created = text(`diff --git a/notes.txt b/notes.txt
new file mode 100644
index 0000000000000000000000000000000000000000..3333333333333333333333333333333333333333
--- /dev/null
+++ b/notes.txt
@@ -0,0 +1,2 @@
+one
+two
`);
  const moved = text(`diff --git a/search.ts b/finder.ts
similarity index 90%
rename from search.ts
rename to finder.ts
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/search.ts
+++ b/finder.ts
@@ -1,2 +1,2 @@
 one
-two
+TWO
`);

  it("stages and discards an unstaged diff and unstages a staged one", () => {
    expect(partActions(edit, both, "unstaged")).toEqual(["stage", "discard"]);
    expect(partActions(edit, both, "staged")).toEqual(["unstage"]);
    expect(partActions(created, untracked, "unstaged")).toEqual([
      "stage",
      "discard",
    ]);
    expect(partActions(moved, renamed, "staged")).toEqual(["unstage"]);
  });

  it("only stages a file added with git add -N", () => {
    const intent = ordinary({ kind: "unstaged", unstaged: "A" }, null);
    expect(partActions(created, intent, "unstaged")).toEqual(["stage"]);
  });

  it("writes no part of a diff wherever the core refuses to", () => {
    const refusals: [
      string,
      WorktreePatch,
      StatusEntry | undefined,
      ListSide,
    ][] = [
      ["a conflict", edit, unmerged, "conflict"],
      ["a file in the conflict list", edit, both, "conflict"],
      [
        "a conflict's diff",
        {
          kind: "conflicted",
          conflict: "bothModified",
          diff: { kind: "text", patch: edited, lossy: false },
        },
        unmerged,
        "conflict",
      ],
      [
        "a binary file",
        { kind: "diff", diff: { kind: "binary" } },
        both,
        "unstaged",
      ],
      [
        "a diff too large to show",
        { kind: "diff", diff: { kind: "tooLarge", bytes: 2_000_000 } },
        both,
        "unstaged",
      ],
      [
        "a submodule's change",
        { kind: "submodule", submodule },
        both,
        "unstaged",
      ],
      ["a submodule entry", edit, { ...both, submodule }, "unstaged"],
      [
        "a move git add -N started",
        moved,
        { ...renamed, side: { kind: "unstaged", original: blob("b") } },
        "unstaged",
      ],
      [
        "a name that was not valid UTF-8",
        edit,
        { ...both, path: "odd\uFFFD.txt" },
        "unstaged",
      ],
      [
        "an untracked name that was not valid UTF-8",
        created,
        { ...untracked, path: "odd\uFFFD.txt" },
        "unstaged",
      ],
      [
        "a symbolic link",
        text(`diff --git a/link b/link
index 1de565933b05f74c75ff9a6520af5f9f8a5a2f1d..27fa34919ae70aa0d7eaccdfbf393cfc440e7d25 120000
--- a/link
+++ b/link
@@ -1 +1 @@
-target-one
\\ No newline at end of file
+target-two
\\ No newline at end of file
`),
        both,
        "unstaged",
      ],
      [
        "a gitlink",
        text(`diff --git a/sub b/sub
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 160000
--- a/sub
+++ b/sub
@@ -1 +1 @@
-Subproject commit 1111111111111111111111111111111111111111
+Subproject commit 2222222222222222222222222222222222222222
`),
        both,
        "unstaged",
      ],
      [
        "a copy",
        text(`diff --git a/old.txt b/copy.txt
similarity index 80%
copy from old.txt
copy to copy.txt
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/old.txt
+++ b/copy.txt
@@ -1,2 +1,2 @@
 one
-two
+TWO
`),
        both,
        "unstaged",
      ],
      [
        "a type change, which Git shows as two changes",
        text(`diff --git a/x b/x
deleted file mode 100644
index 1111111111111111111111111111111111111111..0000000000000000000000000000000000000000
--- a/x
+++ /dev/null
@@ -1 +0,0 @@
-t
diff --git a/x b/x
new file mode 120000
index 0000000000000000000000000000000000000000..2222222222222222222222222222222222222222
--- /dev/null
+++ b/x
@@ -0,0 +1 @@
+t
\\ No newline at end of file
`),
        both,
        "unstaged",
      ],
      [
        "a mode change with no hunk",
        text(`diff --git a/x.sh b/x.sh
old mode 100644
new mode 100755
`),
        both,
        "unstaged",
      ],
      [
        "lines that disagree with their hunk header",
        text(edited.replace("\n \n", "\n\n")),
        both,
        "unstaged",
      ],
      ["a path the status no longer lists", edit, undefined, "unstaged"],
    ];
    for (const [refusal, patch, entry, side] of refusals)
      expect(partActions(patch, entry, side), refusal).toEqual([]);
  });
});

group("partWrite", () => {
  const shown = "diff --git a/a.txt b/a.txt\n";
  it("sends the hunk or the lines with the shown patch and HEAD", () => {
    expect(
      partWrite("stage", status, "a.txt", shown, { kind: "hunk", hunk: 2 }),
    ).toEqual({
      operation: { kind: "stageHunk", path: "a.txt", hunk: 2, shown },
      expect: { head },
    });
    const lines = [{ side: "deletions" as const, line: 5 }];
    expect(
      partWrite("discard", status, "a.txt", shown, { kind: "lines", lines })
        .operation,
    ).toEqual({ kind: "discardLines", path: "a.txt", lines, shown });
    expect(
      partWrite("unstage", status, "a.txt", shown, { kind: "hunk", hunk: 0 })
        .operation.kind,
    ).toBe("unstageHunk");
  });
});

group("rereadsRepository", () => {
  it("rereads the repository only when HEAD or a branch moved", () => {
    expect(rereadsRepository(stale("headMoved"))).toBe(true);
    expect(rereadsRepository(stale("branchChanged"))).toBe(true);
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

group("branch writes", () => {
  const head = status.head;
  const topic = {
    reference: refSchema.parse("refs/heads/feat/topic"),
    oid: oidSchema.parse("a".repeat(40)),
  };

  it("names each branch write by its branch", () => {
    const create = branchWrite(
      {
        kind: "createBranch",
        name: "topic",
        at: { kind: "commit", oid: topic.oid },
      },
      head,
    );
    expect(create.expect).toEqual({ head });
    expect(describe(create.operation)).toBe("Create branch topic");
    expect(
      describe({ kind: "renameBranch", branch: topic, to: "feat/renamed" }),
    ).toBe("Rename branch feat/topic to feat/renamed");
    expect(describe({ kind: "deleteBranch", branch: topic })).toBe(
      "Delete branch feat/topic",
    );
    expect(movesRefs(create.operation)).toBe(true);
  });

  it("shows the core's words when a branch moved before the write or its undo", () => {
    const moved: Problem = {
      kind: "staleView",
      reason: "branchChanged",
      message: "topic is no longer at the commit L1 Git showed.",
    };
    expect(
      failureText(
        {
          kind: "failed",
          action: "write",
          label: "Delete branch topic",
          problem: moved,
          operation: { kind: "deleteBranch", branch: topic },
        },
        { kind: "unread" },
      ),
    ).toBe(
      "Could not delete branch topic. topic is no longer at the commit L1 Git showed.",
    );
  });

  it("names the branch an undo or redo leaves and the one it removes", () => {
    const moved = (
      operation: Parameters<typeof branchStep>[0],
      step: "undo" | "redo",
    ) => {
      const { left, gone } = branchStep(operation, step);
      return [left?.reference ?? null, gone];
    };
    const create = {
      kind: "createBranch" as const,
      name: "made",
      at: { kind: "commit" as const, oid: topic.oid },
    };
    const rename = {
      kind: "renameBranch" as const,
      branch: topic,
      to: "feat/renamed",
    };
    const remove = { kind: "deleteBranch" as const, branch: topic };
    expect(moved(create, "undo")).toEqual([null, "refs/heads/made"]);
    expect(moved(create, "redo")).toEqual(["refs/heads/made", null]);
    expect(moved(rename, "undo")).toEqual([
      "refs/heads/feat/topic",
      "refs/heads/feat/renamed",
    ]);
    expect(moved(rename, "redo")).toEqual([
      "refs/heads/feat/renamed",
      "refs/heads/feat/topic",
    ]);
    expect(moved(remove, "undo")).toEqual(["refs/heads/feat/topic", null]);
    expect(moved(remove, "redo")).toEqual([null, "refs/heads/feat/topic"]);
    expect(branchStep(rename, "undo").left?.oid).toBe(topic.oid);
  });

  it("says which of HEAD and the upstream a branch is not merged into", () => {
    const upstream = (merged: boolean) => ({
      reference: refSchema.parse("refs/remotes/origin/topic"),
      merged,
    });
    expect(
      notMergedInto(
        "topic",
        { head: false, upstream: upstream(false) },
        "HEAD (main)",
      ),
    ).toBe(
      "topic is not merged into HEAD (main) or its upstream origin/topic.",
    );
    expect(
      notMergedInto("topic", { head: true, upstream: upstream(false) }, "HEAD"),
    ).toBe("topic is not merged into its upstream origin/topic.");
    expect(
      notMergedInto("topic", { head: false, upstream: null }, "HEAD"),
    ).toBe("topic is not merged into HEAD.");
    expect(
      notMergedInto("topic", { head: true, upstream: upstream(true) }, "HEAD"),
    ).toBeNull();
  });
});

group("checkout", () => {
  const oid = oidSchema.parse(`1a2b3c4${"e".repeat(33)}`);

  it("names a checkout by its branch, its remote branch, or its short commit ID", () => {
    const reference = (name: string) => refSchema.parse(name);
    expect(
      describe({
        kind: "checkout",
        target: {
          kind: "local",
          reference: reference("refs/heads/feat/history"),
          oid,
        },
      }),
    ).toBe("Check out feat/history");
    expect(
      describe({
        kind: "checkout",
        target: {
          kind: "remote",
          reference: reference("refs/remotes/origin/feat/x"),
          oid,
        },
      }),
    ).toBe("Check out origin/feat/x");
    expect(
      describe({ kind: "checkout", target: { kind: "commit", oid } }),
    ).toBe("Check out 1a2b3c4");
  });

  it("sends the branch a sidebar row shows and the HEAD L1 Git read", () => {
    const write = checkoutWrite(
      startAt({
        kind: "remote",
        reference: refSchema.parse("refs/remotes/origin/feat/x"),
        name: "origin/feat/x",
        oid,
        remote: "origin",
      }),
      head,
    );
    expect(write).toEqual({
      operation: {
        kind: "checkout",
        target: {
          kind: "remote",
          reference: "refs/remotes/origin/feat/x",
          oid,
        },
      },
      expect: { head },
    });
    expect(movesRefs(write.operation)).toBe(true);
  });

  it("reports a landed checkout whose hook failed in the core's words, with the hook's last lines", () => {
    const wire = {
      kind: "afterHookFailed",
      message:
        "Git checked out feat/history, but the post-checkout hook failed. Undo puts back main.",
      output:
        "Switched to branch 'feat/history'\nlint: checking\n\nsrc/a.ts:1 unused import\r\nsrc/b.ts:9 missing semicolon\n2 problems\n\n",
    };
    const problem = problemFrom(wire);
    expect(problem).toEqual(wire);
    expect(
      failureText(
        {
          kind: "failed",
          action: "write",
          label: "Check out feat/history",
          problem,
          operation: {
            kind: "checkout",
            target: {
              kind: "local",
              reference: localRefSchema.parse("refs/heads/feat/history"),
              oid: oidSchema.parse("a".repeat(40)),
            },
          },
        },
        { kind: "unread" },
      ),
    ).toBe(wire.message);
    expect(
      failureText(
        {
          kind: "failed",
          action: "undo",
          label: "Check out feat/history",
          problem,
          entry: entryIdSchema.parse("18e1c91cc9cade98"),
        },
        { kind: "unread" },
      ),
    ).toBe(wire.message);
    expect(hookOutputTail(problem)).toEqual([
      "src/a.ts:1 unused import",
      "src/b.ts:9 missing semicolon",
      "2 problems",
    ]);
    expect(
      hookOutputTail({
        kind: "hookFailed",
        message: "The pre-commit hook failed.",
        output: "lint failed",
      }),
    ).toEqual([]);
  });
});
