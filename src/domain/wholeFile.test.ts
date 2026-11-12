import { describe, expect, it } from "vitest";
import { byteSize, wholeChoice } from "./wholeFile";
import type { Lead, WholeChoice, WholePreview } from "./wholeFile";
import { wholeFileConflictSchema } from "./repository";
import type { WholeFileConflict } from "./repository";

const names = { current: "feat/replay-core", incoming: "origin/main" };
const base = "a\nb\nc\n";
const edited = "a\nb\nc\nd\ne\n";

function conflict(fields: Partial<WholeFileConflict>): WholeFileConflict {
  return wholeFileConflictSchema.unwrap().parse({
    head: { kind: "detached", oid: "a".repeat(40) },
    version: "b".repeat(40),
    shape: "deletedByThem",
    base,
    current: null,
    incoming: null,
    disk: "unknown",
    ...fields,
  });
}
const file = (text: string | null, mode = "100644" as const) => ({
  mode,
  size: text?.length ?? 2048,
  text,
});

const lead = (choice: WholeChoice) =>
  choice.lead
    .map((part: Lead) =>
      typeof part === "string" ? part : `[${names[part.side]}]`,
    )
    .join("");
const card = (choice: WholeChoice, index: 0 | 1) => {
  const { keep, key, title, consequence, action, onDisk, preview } =
    choice.cards[index];
  return {
    keep,
    key,
    title,
    consequence,
    action,
    onDisk,
    preview: shown(preview),
  };
};
function shown(preview: WholePreview) {
  if (preview.kind !== "diff") return `${preview.kind}: ${preview.text}`;
  const added = preview.diff.hunks.reduce(
    (sum, hunk) => sum + hunk.additionLines,
    0,
  );
  const removed = preview.diff.hunks.reduce(
    (sum, hunk) => sum + hunk.deletionLines,
    0,
  );
  return `diff: +${added} -${removed}`;
}

describe("whole-file choice", () => {
  it("keeps or deletes a file one side deleted and the other edited", () => {
    const choice = wholeChoice(
      conflict({
        shape: "deletedByThem",
        current: file(edited),
        disk: "matchesCurrent",
      }),
      "src/sync/legacy-retry.ts",
      names,
    );
    expect(choice.title).toBe("The two sides disagree about the whole file");
    expect(lead(choice)).toBe(
      "[origin/main] deleted it. [feat/replay-core] changed 2 lines in it. There are no lines to merge, so pick one outcome.",
    );
    expect(card(choice, 0)).toEqual({
      keep: "current",
      key: "1",
      title: "Keep the file with your changes",
      consequence:
        "feat/replay-core keeps legacy-retry.ts, including your 2 changed lines. origin/main’s deletion is not applied.",
      action: "Keep file",
      onDisk: true,
      preview: "diff: +2 -0",
    });
    expect(card(choice, 1)).toEqual({
      keep: "incoming",
      key: "2",
      title: "Delete the file",
      consequence:
        "Matches origin/main, which deleted it. Your 2 changed lines are dropped.",
      action: "Delete file",
      onDisk: false,
      preview: "removed: legacy-retry.ts (5 lines)",
    });
    expect(choice.editedOnDisk).toBe(false);
  });

  it("keeps a deletion or restores the other side's edited file", () => {
    const choice = wholeChoice(
      conflict({
        shape: "deletedByUs",
        incoming: file("a\nB\nc\n"),
        disk: "edited",
      }),
      "f.txt",
      names,
    );
    expect(lead(choice)).toBe(
      "[feat/replay-core] deleted it. [origin/main] changed 1 line in it. There are no lines to merge, so pick one outcome.",
    );
    expect(card(choice, 0)).toMatchObject({
      keep: "current",
      title: "Keep it deleted",
      consequence:
        "Matches feat/replay-core. origin/main’s 1 changed line is dropped.",
      action: "Keep deleted",
      preview: "removed: f.txt (3 lines)",
    });
    expect(card(choice, 1)).toMatchObject({
      keep: "incoming",
      title: "Restore the file with their changes",
      consequence:
        "Brings f.txt back as origin/main has it, including its 1 changed line. feat/replay-core’s deletion is not applied.",
      action: "Restore file",
      preview: "diff: +1 -1",
    });
    expect(choice.editedOnDisk).toBe(true);
  });

  it("says a side changed a file without counting lines it cannot read", () => {
    const choice = wholeChoice(
      conflict({ shape: "deletedByThem", base: null, current: file(null) }),
      "logo.png",
      names,
    );
    expect(lead(choice)).toContain("[feat/replay-core] changed it. ");
    expect(card(choice, 0).consequence).toContain("including your changes.");
    expect(card(choice, 0).preview).toBe("note: Binary file · 2.0 KB");
    expect(card(choice, 1).consequence).toContain("Your changes are dropped.");
    expect(card(choice, 1).preview).toBe("removed: logo.png (2.0 KB)");
  });

  it("keeps or leaves out a file only one side has", () => {
    const ours = wholeChoice(
      conflict({ shape: "addedByUs", base: null, current: file("x\n") }),
      "c.txt",
      names,
    );
    expect(ours.title).toBe("Only one side has this file");
    expect(lead(ours)).toBe(
      "[feat/replay-core] has a file at this path and [origin/main] has none. This happens when the two sides rename one file differently. Pick one outcome.",
    );
    expect(
      ours.cards.map(({ keep, title, action }) => [keep, title, action]),
    ).toEqual([
      ["current", "Keep the file", "Keep file"],
      ["incoming", "Leave it out", "Leave out"],
    ]);
    expect(card(ours, 0).preview).toBe("diff: +1 -0");
    expect(card(ours, 1).consequence).toBe(
      "Matches origin/main. c.txt is deleted.",
    );

    const theirs = wholeChoice(
      conflict({ shape: "addedByThem", base: null, incoming: file("x\n") }),
      "b.txt",
      names,
    );
    expect(lead(theirs)).toMatch(
      /^\[origin\/main\] has a file at this path and \[feat\/replay-core\] has none\./,
    );
    expect(
      theirs.cards.map(({ keep, title, action, consequence }) => [
        keep,
        title,
        action,
        consequence,
      ]),
    ).toEqual([
      [
        "current",
        "Leave it out",
        "Leave out",
        "Matches feat/replay-core. origin/main’s b.txt is not added.",
      ],
      [
        "incoming",
        "Add their file",
        "Add file",
        "Adds b.txt as origin/main has it.",
      ],
    ]);
  });

  it("picks one version of a binary file and shows its size and mode", () => {
    const choice = wholeChoice(
      conflict({
        shape: "binary",
        base: null,
        current: { mode: "100755", size: 512, text: null },
        incoming: { mode: "100644", size: 3 * 1024 * 1024, text: null },
        disk: "matchesIncoming",
      }),
      "bin/tool",
      names,
    );
    expect(lead(choice)).toBe(
      "[feat/replay-core] and [origin/main] have different versions of this binary file. There are no lines to merge, so pick one version.",
    );
    expect(card(choice, 0)).toMatchObject({
      title: "Keep the current version",
      action: "Keep current version",
      consequence:
        "tool becomes feat/replay-core’s version. origin/main’s version is dropped.",
      preview: "note: Binary file · 512 bytes · executable",
      onDisk: false,
    });
    expect(card(choice, 1)).toMatchObject({
      title: "Keep the incoming version",
      action: "Keep incoming version",
      preview: "note: Binary file · 3.0 MB",
      onDisk: true,
    });
  });

  it("shows where each version of a symlink points", () => {
    const choice = wholeChoice(
      conflict({
        shape: "symlink",
        base: "old",
        current: { mode: "120000", size: 6, text: "../ours" },
        incoming: { mode: "120000", size: 300, text: null },
      }),
      "link",
      names,
    );
    expect(lead(choice)).toContain("different versions of this symbolic link.");
    expect(card(choice, 0).preview).toBe("note: Link to ../ours");
    expect(card(choice, 1).preview).toBe("note: Symbolic link · 300 bytes");
  });

  it("names each choice for Undo by what it does to the file", () => {
    const labels = (fields: Partial<WholeFileConflict>, path: string) =>
      wholeChoice(conflict(fields), path, names).cards.map(
        ({ label }) => label,
      );
    expect(
      labels(
        { shape: "deletedByThem", current: file(edited) },
        "src/sync/legacy-retry.ts",
      ),
    ).toEqual(["Keep legacy-retry.ts", "Delete legacy-retry.ts"]);
    expect(
      labels({ shape: "deletedByUs", incoming: file(edited) }, "src/f.txt"),
    ).toEqual(["Delete f.txt", "Restore f.txt"]);
    expect(
      labels({ shape: "addedByUs", base: null, current: file("x\n") }, "c.txt"),
    ).toEqual(["Keep c.txt", "Delete c.txt"]);
    expect(
      labels(
        { shape: "addedByThem", base: null, incoming: file("x\n") },
        "b.txt",
      ),
    ).toEqual(["Delete b.txt", "Add b.txt"]);
    expect(
      labels(
        {
          shape: "binary",
          base: null,
          current: file(null),
          incoming: file(null),
        },
        "assets/logo.png",
      ),
    ).toEqual([
      "Keep the current version of logo.png",
      "Keep the incoming version of logo.png",
    ]);
  });
});

it("writes sizes in bytes, KB and MB", () => {
  expect([1, 1023, 1536, 5 * 1024 * 1024].map(byteSize)).toEqual([
    "1 byte",
    "1023 bytes",
    "1.5 KB",
    "5.0 MB",
  ]);
});
