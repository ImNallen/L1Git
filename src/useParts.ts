import { useState } from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import {
  deletesNewFile,
  parsedFiles,
  picksFor,
  shownText,
} from "./domain/lineSelection";
import type { DiffStyle } from "./domain/lineSelection";
import { partActions, partWrite } from "./domain/operations";
import type { PartAction, PartChoice, Write } from "./domain/operations";
import type { RepositoryRoot } from "./domain/repository";
import type { ChangesByWorktree } from "./domain/worktree";
import type { Parts } from "./components/FilePatchView";
import type { FileDiffState } from "./useWorkspace";
import type { Outcome } from "./useWrites";

export type PartDiscard = {
  root: RepositoryRoot;
  write: Write;
  path: string;
  choice: PartChoice;
  deletes: boolean;
};

export function useParts({
  fileDiff,
  changes,
  diffStyle,
  busy,
  write,
  selectRange,
  lostFocus,
}: {
  fileDiff: FileDiffState;
  changes: ChangesByWorktree;
  diffStyle: DiffStyle;
  busy: boolean;
  write: (root: RepositoryRoot, write: Write) => Promise<Outcome>;
  selectRange: (range: SelectedLineRange | null) => void;
  lostFocus: () => void;
}) {
  const [discarding, setDiscarding] = useState<PartDiscard | null>(null);
  const target = (() => {
    if (fileDiff.kind !== "ready" || fileDiff.side === null) return null;
    const read = changes.get(fileDiff.selection.root);
    if (read?.kind !== "ready") return null;
    const { path, side, range, patch } = fileDiff;
    const entry = read.status.entries.find((each) => each.path === path);
    const actions = partActions(patch, entry, side);
    const shown = shownText(patch);
    const [file] = shown === null ? [] : parsedFiles(shown);
    if (actions.length === 0 || shown === null || file === undefined)
      return null;
    const root = fileDiff.selection.root;
    return { root, path, shown, file, actions, range, status: read.status };
  })();
  const picks = target?.range
    ? picksFor(target.file, diffStyle, target.range)
    : [];

  async function run(root: RepositoryRoot, chosen: Write) {
    await write(root, chosen);
    selectRange(null);
    lostFocus();
  }

  function start(action: PartAction, choice: PartChoice) {
    if (target === null || busy) return;
    const { root, path, shown, file, status } = target;
    const chosen = partWrite(action, status, path, shown, choice);
    if (action !== "discard") {
      void run(root, chosen);
      return;
    }
    const deletes = deletesNewFile(
      file,
      choice.kind === "hunk" ? "hunk" : choice.lines,
    );
    setDiscarding({ root, write: chosen, path, choice, deletes });
  }

  const writeLines = (action: PartAction) => {
    if (picks.length > 0) start(action, { kind: "lines", lines: picks });
  };

  const view: Parts | null = target && {
    actions: target.actions,
    busy,
    range: target.range,
    picks,
    onSelectRange: selectRange,
    onHunk: (action, hunk) => start(action, { kind: "hunk", hunk }),
    onLines: writeLines,
    onGutterFirstAction: (range) => {
      const [first] = target.actions;
      const chosen = picksFor(target.file, diffStyle, range);
      if (first !== undefined && chosen.length > 0)
        start(first, { kind: "lines", lines: chosen });
    },
    onLostFocus: lostFocus,
  };

  return {
    view,
    lineActions: busy || picks.length === 0 ? [] : (target?.actions ?? []),
    writeLines,
    discarding,
    confirmDiscard: () => {
      if (discarding !== null) void run(discarding.root, discarding.write);
    },
    closeDiscard: () => setDiscarding(null),
  };
}
