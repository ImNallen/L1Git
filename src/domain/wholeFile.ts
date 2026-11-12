import { parseDiffFromFile } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  ConflictKeep,
  WholeFileConflict,
  WholeFileSide,
} from "./repository";

export type SideNames = { current: string; incoming: string };

export type Lead = string | { side: ConflictKeep };

export type WholePreview =
  | { kind: "diff"; diff: FileDiffMetadata }
  | { kind: "removed"; text: string }
  | { kind: "note"; text: string };

export type WholeCard = {
  keep: ConflictKeep;
  key: "1" | "2";
  icon: "file" | "delete";
  title: string;
  consequence: string;
  preview: WholePreview;
  action: string;
  onDisk: boolean;
};

export type WholeChoice = {
  title: string;
  lead: Lead[];
  cards: [WholeCard, WholeCard];
  editedOnDisk: boolean;
};

const C: Lead = { side: "current" };
const I: Lead = { side: "incoming" };

export function byteSize(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const lineCount = (text: string) =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? "" : "s"}`;

function changedLines(diff: FileDiffMetadata): number {
  return diff.hunks
    .flatMap((hunk) => hunk.hunkContent)
    .reduce(
      (sum, part) =>
        part.type === "change"
          ? sum + Math.max(part.additions, part.deletions)
          : sum,
      0,
    );
}

function holds(
  name: string,
  side: WholeFileSide,
  base: string | null,
  hasBase: boolean,
): { preview: WholePreview; changed: number | null } {
  if (side.mode === "120000")
    return {
      preview: {
        kind: "note",
        text:
          side.text === null
            ? `Symbolic link · ${byteSize(side.size)}`
            : `Link to ${side.text}`,
      },
      changed: null,
    };
  if (side.text !== null && (base !== null || !hasBase)) {
    const diff = parseDiffFromFile(
      { name, contents: base ?? "" },
      { name, contents: side.text },
    );
    return { preview: { kind: "diff", diff }, changed: changedLines(diff) };
  }
  const kind = side.text === null ? "Binary file" : "File";
  const executable = side.mode === "100755" ? " · executable" : "";
  return {
    preview: {
      kind: "note",
      text: `${kind} · ${byteSize(side.size)}${executable}`,
    },
    changed: null,
  };
}

function removed(name: string, side: WholeFileSide): WholePreview {
  const length =
    side.mode !== "120000" && side.text !== null
      ? plural(lineCount(side.text), "line")
      : byteSize(side.size);
  return { kind: "removed", text: `${name} (${length})` };
}

const editedIn = (changed: number | null) =>
  changed === null || changed === 0
    ? " changed it. "
    : ` changed ${plural(changed, "line")} in it. `;
const changes = (owner: string, changed: number | null) =>
  changed === null || changed === 0
    ? `${owner} changes`
    : `${owner} ${plural(changed, "changed line")}`;
const dropped = (owner: string, changed: number | null) =>
  `${changes(owner, changed)} ${changed === 1 ? "is" : "are"} dropped.`;

const noLines = "There are no lines to merge, so pick one outcome.";
const oneVersion = "There are no lines to merge, so pick one version.";

export function wholeChoice(
  conflict: WholeFileConflict,
  path: string,
  names: SideNames,
): WholeChoice {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const { shape, base, current, incoming, disk } = conflict;
  const hasBase = shape === "deletedByThem" || shape === "deletedByUs";
  const card = (
    keep: ConflictKeep,
    rest: Omit<WholeCard, "keep" | "key" | "onDisk">,
  ): WholeCard => ({
    keep,
    key: keep === "current" ? "1" : "2",
    onDisk:
      disk === (keep === "current" ? "matchesCurrent" : "matchesIncoming"),
    ...rest,
  });
  const choice = (
    title: string,
    lead: Lead[],
    first: Omit<WholeCard, "keep" | "key" | "onDisk">,
    second: Omit<WholeCard, "keep" | "key" | "onDisk">,
  ): WholeChoice => ({
    title,
    lead,
    cards: [card("current", first), card("incoming", second)],
    editedOnDisk: disk === "edited",
  });
  const disagree = "The two sides disagree about the whole file";
  if (current && !incoming) {
    const kept = holds(name, current, base, hasBase);
    if (shape === "deletedByThem")
      return choice(
        disagree,
        [I, " deleted it. ", C, `${editedIn(kept.changed)}${noLines}`],
        {
          icon: "file",
          title: "Keep the file with your changes",
          consequence: `${names.current} keeps ${name}, including ${changes("your", kept.changed)}. ${names.incoming}’s deletion is not applied.`,
          preview: kept.preview,
          action: "Keep file",
        },
        {
          icon: "delete",
          title: "Delete the file",
          consequence: `Matches ${names.incoming}, which deleted it. ${dropped("Your", kept.changed)}`,
          preview: removed(name, current),
          action: "Delete file",
        },
      );
    return choice(
      "Only one side has this file",
      [
        C,
        " has a file at this path and ",
        I,
        " has none. This happens when the two sides rename one file differently. Pick one outcome.",
      ],
      {
        icon: "file",
        title: "Keep the file",
        consequence: `${names.current}’s ${name} stays in the result.`,
        preview: kept.preview,
        action: "Keep file",
      },
      {
        icon: "delete",
        title: "Leave it out",
        consequence: `Matches ${names.incoming}. ${name} is deleted.`,
        preview: removed(name, current),
        action: "Leave out",
      },
    );
  }
  if (incoming && !current) {
    const kept = holds(name, incoming, base, hasBase);
    if (shape === "deletedByUs")
      return choice(
        disagree,
        [C, " deleted it. ", I, `${editedIn(kept.changed)}${noLines}`],
        {
          icon: "delete",
          title: "Keep it deleted",
          consequence: `Matches ${names.current}. ${dropped(`${names.incoming}’s`, kept.changed)}`,
          preview: removed(name, incoming),
          action: "Keep deleted",
        },
        {
          icon: "file",
          title: "Restore the file with their changes",
          consequence: `Brings ${name} back as ${names.incoming} has it, including ${changes("its", kept.changed)}. ${names.current}’s deletion is not applied.`,
          preview: kept.preview,
          action: "Restore file",
        },
      );
    return choice(
      "Only one side has this file",
      [
        I,
        " has a file at this path and ",
        C,
        " has none. This happens when the two sides rename one file differently. Pick one outcome.",
      ],
      {
        icon: "delete",
        title: "Leave it out",
        consequence: `Matches ${names.current}. ${names.incoming}’s ${name} is not added.`,
        preview: removed(name, incoming),
        action: "Leave out",
      },
      {
        icon: "file",
        title: "Add their file",
        consequence: `Adds ${name} as ${names.incoming} has it.`,
        preview: kept.preview,
        action: "Add file",
      },
    );
  }
  if (!current || !incoming)
    throw new Error(`A whole-file conflict on ${path} has no side`);
  const what = shape === "symlink" ? "symbolic link" : "binary file";
  const version = (keep: ConflictKeep, side: WholeFileSide) => {
    const [kept, dropped] =
      keep === "current"
        ? [names.current, names.incoming]
        : [names.incoming, names.current];
    return {
      icon: "file" as const,
      title: `Keep the ${keep} version`,
      consequence: `${name} becomes ${kept}’s version. ${dropped}’s version is dropped.`,
      preview: holds(name, side, base, hasBase).preview,
      action: `Keep ${keep} version`,
    };
  };
  return choice(
    disagree,
    [C, " and ", I, ` have different versions of this ${what}. ${oneVersion}`],
    version("current", current),
    version("incoming", incoming),
  );
}
