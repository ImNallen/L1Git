import { describe as group, expect, it } from "vitest";
import { describe, failureText, writeFor } from "./operations";
import { entryIdSchema, oidSchema, refSchema, rootSchema } from "./repository";
import type { IndexObject, StatusEntry, WorktreeStatus } from "./repository";

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
});

group("failureText", () => {
  const blockedId = entryIdSchema.parse("18e1c91cc9cade98");
  const stale = (message: string) => ({
    kind: "staleView" as const,
    message,
  });

  it("says the worktree was reread instead of asking for a refresh", () => {
    expect(
      failureText(
        {
          kind: "failed",
          action: "write",
          label: "Stage README.md",
          problem: stale(
            "README.md changed since L1 Git read it. Refresh and try again.",
          ),
        },
        false,
      ),
    ).toBe(
      "Could not stage README.md. README.md changed since L1 Git read it. L1 Git reread the worktree, so check the lists and try again.",
    );
  });

  it("explains that a blocked undo holds back the older entries", () => {
    expect(
      failureText(
        {
          kind: "failed",
          action: "undo",
          label: "Stage README.md",
          problem: stale(
            "HEAD moved after this change, so L1 Git cannot undo or redo it exactly. Refresh.",
          ),
          entry: blockedId,
        },
        true,
      ),
    ).toBe(
      "Could not undo Stage README.md. HEAD moved after this change, so L1 Git cannot undo or redo it exactly. Undo goes in order, so older changes stay blocked until this one can be undone.",
    );
  });

  it("names a reread history when another entry is now next", () => {
    expect(
      failureText(
        {
          kind: "failed",
          action: "undo",
          label: "Stage README.md",
          problem: stale(
            "The undo history changed since L1 Git showed it. Refresh and try again.",
          ),
          entry: blockedId,
        },
        false,
      ),
    ).toBe(
      "Could not undo Stage README.md. The undo history changed since L1 Git showed it. L1 Git reread the undo history.",
    );
  });

  it("passes other errors through without the refresh advice", () => {
    expect(
      failureText(
        {
          kind: "failed",
          action: "redo",
          label: "Unstage 2 files",
          problem: {
            kind: "unchangedPath",
            message:
              "Git made no change to the index. Refresh the worktree status.",
          },
          entry: blockedId,
        },
        false,
      ),
    ).toBe("Could not redo Unstage 2 files. Git made no change to the index.");
  });
});
