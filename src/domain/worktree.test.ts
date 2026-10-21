import { describe, expect, it } from "vitest";
import type { StatusEntry } from "./repository";
import {
  changeSummary,
  clampMessage,
  firstWorktreeFile,
  openDiffAfter,
  worktreeGroups,
} from "./worktree";

const ordinary = (
  path: string,
  sides: Extract<StatusEntry, { kind: "ordinary" }>["sides"],
): StatusEntry => ({ kind: "ordinary", path, submodule: null, sides });

function worktreeLists(entries: StatusEntry[]) {
  const groups = worktreeGroups(entries);
  const files = (title: string) =>
    groups.find((group) => group.title === title)?.files;
  return {
    staged: files("Staged"),
    unstaged: files("Unstaged"),
    conflicts: files("Conflicts"),
  };
}

describe("worktree lists", () => {
  it("orders the groups Conflicts, Unstaged, Staged, and opens conflicts from their own list", () => {
    expect(
      worktreeGroups([]).map(({ title, side }) => `${title}:${side}`),
    ).toEqual(["Conflicts:conflict", "Unstaged:unstaged", "Staged:staged"]);
  });

  it("lists each side of an ordinary change where it was made", () => {
    expect(
      worktreeLists([
        ordinary("staged.txt", { kind: "staged", staged: "A" }),
        ordinary("edited.txt", { kind: "unstaged", unstaged: "M" }),
        ordinary("both.txt", { kind: "both", staged: "M", unstaged: "D" }),
        ordinary("kind.txt", { kind: "unstaged", unstaged: "T" }),
      ]),
    ).toEqual({
      staged: [
        { path: "staged.txt", status: "added" },
        { path: "both.txt", status: "modified" },
      ],
      unstaged: [
        { path: "edited.txt", status: "modified" },
        { path: "both.txt", status: "deleted" },
        { path: "kind.txt", status: "modified" },
      ],
      conflicts: [],
    });
  });

  it("lists a staged rename as staged, and its later edit as an unstaged change to the new path", () => {
    const renamed = (unstaged: "M" | null): StatusEntry => ({
      kind: "renamed",
      path: "new.txt",
      original: "old.txt",
      how: "renamed",
      submodule: null,
      side: { kind: "staged", unstaged },
    });
    expect(worktreeLists([renamed(null)])).toEqual({
      staged: [{ path: "new.txt", status: "renamed" }],
      unstaged: [],
      conflicts: [],
    });
    expect(worktreeLists([renamed("M")]).unstaged).toEqual([
      { path: "new.txt", status: "modified" },
    ]);
  });

  it("lists an unstaged move, a copy, and an untracked file as unstaged", () => {
    expect(
      worktreeLists([
        {
          kind: "renamed",
          path: "moved.txt",
          original: "intent.txt",
          how: "renamed",
          submodule: null,
          side: { kind: "unstaged" },
        },
        {
          kind: "renamed",
          path: "copy.txt",
          original: "source.txt",
          how: "copied",
          submodule: null,
          side: { kind: "staged", unstaged: null },
        },
        { kind: "untracked", path: "new.txt" },
      ]),
    ).toEqual({
      staged: [{ path: "copy.txt", status: "added" }],
      unstaged: [
        { path: "moved.txt", status: "renamed" },
        { path: "new.txt", status: "untracked" },
      ],
      conflicts: [],
    });
  });

  it("keeps conflicts out of both lists", () => {
    expect(
      worktreeLists([
        {
          kind: "unmerged",
          path: "clash.txt",
          conflict: "bothModified",
          submodule: null,
        },
      ]),
    ).toEqual({
      staged: [],
      unstaged: [],
      conflicts: [{ path: "clash.txt", status: "modified" }],
    });
  });

  it("opens the first listed path, conflicts first, then unstaged, then staged", () => {
    const staged = ordinary("a/staged.txt", { kind: "staged", staged: "M" });
    const edited = ordinary("z/edited.txt", {
      kind: "unstaged",
      unstaged: "M",
    });
    expect(firstWorktreeFile(worktreeGroups([staged, edited]))).toEqual({
      path: "z/edited.txt",
      side: "unstaged",
    });
    expect(firstWorktreeFile(worktreeGroups([staged]))).toEqual({
      path: "a/staged.txt",
      side: "staged",
    });
    expect(firstWorktreeFile(worktreeGroups([]))).toBeNull();
  });
});

describe("worktree row summary", () => {
  it("counts each changed path once by kind", () => {
    expect(
      changeSummary([
        ordinary("a.txt", { kind: "unstaged", unstaged: "M" }),
        ordinary("b.txt", { kind: "both", staged: "A", unstaged: "M" }),
        { kind: "untracked", path: "c.txt" },
        {
          kind: "unmerged",
          path: "d.txt",
          conflict: "bothAdded",
          submodule: null,
        },
      ]),
    ).toBe("1 conflicted, 2 modified, 1 untracked");
  });
});

describe("an open worktree diff after a status change", () => {
  const entries: StatusEntry[] = [
    ordinary("edited.txt", { kind: "unstaged", unstaged: "M" }),
    ordinary("staged.txt", { kind: "staged", staged: "M" }),
    {
      kind: "unmerged",
      path: "clash.txt",
      conflict: "bothModified",
      submodule: null,
    },
  ];

  it("rereads a path that its side still lists", () => {
    expect(openDiffAfter(entries, "edited.txt", "unstaged")).toBe("reread");
    expect(openDiffAfter(entries, "staged.txt", "staged")).toBe("reread");
    expect(openDiffAfter(entries, "clash.txt", "conflict")).toBe("reread");
  });

  it("closes a path that its side no longer lists", () => {
    expect(openDiffAfter(entries, "gone.txt", "unstaged")).toBe("close");
    expect(openDiffAfter(entries, "clash.txt", "unstaged")).toBe("close");
    expect(openDiffAfter(entries, "staged.txt", "unstaged")).toBe("close");
    expect(openDiffAfter(entries, "edited.txt", "staged")).toBe("close");
  });
});

describe("error messages", () => {
  it("keeps short messages whole", () => {
    expect(clampMessage("fatal: a.req: clean filter 'req' failed\n")).toBe(
      "fatal: a.req: clean filter 'req' failed",
    );
  });

  it("keeps the first lines of a long message and marks the cut", () => {
    const long = Array.from({ length: 40 }, (_, line) => `line ${line}`).join(
      "\n",
    );
    const clamped = clampMessage(long);
    expect(clamped.split("\n")).toHaveLength(13);
    expect(clamped.endsWith("line 11\n…")).toBe(true);
    expect(clampMessage("x".repeat(5000))).toHaveLength(2002);
  });
});
