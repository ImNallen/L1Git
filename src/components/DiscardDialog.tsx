import { Undo2 } from "lucide-react";
import type { DiscardEffect } from "../domain/lineSelection";
import type { PartChoice } from "../domain/operations";
import { ConfirmDialog } from "./ConfirmDialog";
import { PathList } from "./Dialog";

type Props = {
  paths: readonly string[];
  untracked: number;
  skipped: number;
  onDiscard: () => void;
  onClose: () => void;
};

function discardWords(paths: readonly string[], untracked: number) {
  const [only, ...rest] = paths;
  const one = only !== undefined && rest.length === 0;
  const files = `${paths.length.toLocaleString()} files`;
  if (untracked === paths.length)
    return one
      ? {
          title: `Delete ${only}?`,
          confirm: "Delete file",
          outcome: outcomes.deleteFile(only),
        }
      : {
          title: `Delete ${files}?`,
          confirm: "Delete files",
          outcome: "These files are untracked, so L1 Git deletes them.",
        };
  const title = one
    ? `Discard changes to ${only}?`
    : `Discard changes to ${files}?`;
  const confirm = one ? "Discard changes" : "Discard all";
  if (untracked > 0)
    return {
      title,
      confirm,
      outcome: `Each tracked file goes back to its staged or committed version, and L1 Git deletes ${untracked.toLocaleString()} untracked ${untracked === 1 ? "file" : "files"}.`,
    };
  return {
    title,
    confirm,
    outcome: `${one ? "The file goes" : "Each file goes"} back to its staged or committed version.`,
  };
}

export function DiscardDialog({
  paths,
  untracked,
  skipped,
  onDiscard,
  onClose,
}: Props) {
  const { title, confirm, outcome } = discardWords(paths, untracked);
  return (
    <ConfirmDialog
      icon={Undo2}
      title={title}
      closeLabel="Close discard changes"
      confirm={confirm}
      onConfirm={onDiscard}
      onClose={onClose}
    >
      <p>{`${outcome} You can undo this.`}</p>
      <PathList paths={paths} label="Files to discard" />
      {skipped > 0 && (
        <p>
          L1 Git leaves {skipped.toLocaleString()}{" "}
          {skipped === 1 ? "item" : "items"} it cannot discard, such as nested
          repositories, submodules, and files added with git add -N.
        </p>
      )}
    </ConfirmDialog>
  );
}

const outcomes: Record<DiscardEffect, (path: string) => string> = {
  deleteFile: (path) =>
    `${path} is untracked, and this discards all of it, so L1 Git deletes the file.`,
  removeLines: (path) =>
    `${path} is untracked, so L1 Git removes those lines from it, and the rest of the file stays as it is.`,
  restoreLines: () =>
    "Those changes go back to the staged or committed version, and the rest of the file stays as it is.",
};

export function DiscardPartDialog({
  path,
  choice,
  effect,
  onDiscard,
  onClose,
}: {
  path: string;
  choice: PartChoice;
  effect: DiscardEffect;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const lines = choice.kind === "lines" ? choice.lines.length : 0;
  const what =
    choice.kind === "hunk"
      ? "a hunk"
      : `${lines.toLocaleString()} changed ${lines === 1 ? "line" : "lines"}`;
  const deletes = effect === "deleteFile";
  return (
    <ConfirmDialog
      icon={Undo2}
      title={deletes ? `Delete ${path}?` : `Discard ${what} of ${path}?`}
      closeLabel="Close discard changes"
      confirm={
        deletes
          ? "Delete file"
          : choice.kind === "hunk"
            ? "Discard hunk"
            : "Discard lines"
      }
      onConfirm={onDiscard}
      onClose={onClose}
    >
      <p>{`${outcomes[effect](path)} You can undo this.`}</p>
    </ConfirmDialog>
  );
}
