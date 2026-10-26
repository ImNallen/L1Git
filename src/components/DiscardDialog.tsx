import { Undo2 } from "lucide-react";
import { shownPaths } from "../domain/operations";
import { ConfirmDialog } from "./ConfirmDialog";

type Props = {
  paths: readonly string[];
  left: number;
  onDiscard: () => void;
  onClose: () => void;
};

export function DiscardDialog({ paths, left, onDiscard, onClose }: Props) {
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
      {left > 0 && (
        <p>
          L1 Git leaves {left.toLocaleString()} {left === 1 ? "item" : "items"}{" "}
          it cannot discard, such as nested repositories, submodules, and files
          added with git add -N.
        </p>
      )}
    </ConfirmDialog>
  );
}
