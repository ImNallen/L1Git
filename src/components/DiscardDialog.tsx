import { Undo2 } from "lucide-react";
import { shownPaths } from "../domain/operations";
import type { PartChoice } from "../domain/operations";
import { ConfirmDialog } from "./ConfirmDialog";

type Props = {
  paths: readonly string[];
  skipped: number;
  onDiscard: () => void;
  onClose: () => void;
};

export function DiscardDialog({ paths, skipped, onDiscard, onClose }: Props) {
  const { shown, more } = shownPaths(paths);
  const [only] = paths;
  return (
    <ConfirmDialog
      icon={Undo2}
      title={
        paths.length === 1
          ? `Discard changes to ${only}?`
          : `Discard changes to ${paths.length.toLocaleString()} files?`
      }
      closeLabel="Close discard changes"
      confirm={paths.length === 1 ? "Discard changes" : "Discard all"}
      onConfirm={onDiscard}
      onClose={onClose}
    >
      <p>
        Each file goes back to its staged or committed version, and new files
        are deleted. You can undo this.
      </p>
      <ul className="dialog-paths" aria-label="Files to discard">
        {shown.map((path) => (
          <li key={path}>{path}</li>
        ))}
        {more > 0 && (
          <li className="muted">and {more.toLocaleString()} more</li>
        )}
      </ul>
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

export function DiscardPartDialog({
  path,
  choice,
  deletes,
  onDiscard,
  onClose,
}: {
  path: string;
  choice: PartChoice;
  deletes: boolean;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const lines = choice.kind === "lines" ? choice.lines.length : 0;
  const what =
    choice.kind === "hunk"
      ? "a hunk"
      : `${lines.toLocaleString()} changed ${lines === 1 ? "line" : "lines"}`;
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
      <p>
        {deletes
          ? `${path} is untracked, and this discards all of it, so L1 Git deletes the file. You can undo this.`
          : "Those changes go back to the staged or committed version, and the rest of the file stays as it is. You can undo this."}
      </p>
    </ConfirmDialog>
  );
}
