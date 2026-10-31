import { useState } from "react";
import type { FileView } from "../actions";
import { revisionOf } from "../components/revision";
import type { DiffStyle } from "../components/FileDiffPane";
import { useParts } from "../useParts";
import type { WritesView } from "../useWrites";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { ActiveWorktree } from "./useActiveWorktree";
import type { Focus } from "./useFocus";
import type { WorkspaceApi } from "./workspaceView";

export type Parts = ReturnType<typeof useParts>;

/** The open file's diff style and its hunk and line staging, busy during a merge on the file's root. */
export type DiffPane = {
  diffStyle: DiffStyle;
  setDiffStyle: (style: DiffStyle) => void;
  parts: Parts;
  actions: ActionSlice<"file", "closeFile" | "showFile" | "writeLines">;
};

export function useDiffPane({
  app: { fileDiff, changes, selectRange, closeFile },
  writes,
  active,
  focus,
}: {
  app: Pick<WorkspaceApi, "fileDiff" | "changes" | "selectRange" | "closeFile">;
  writes: Pick<WritesView, "running" | "write">;
  active: Pick<ActiveWorktree, "mergingIn">;
  focus: Pick<Focus, "fileDiffRef" | "checkLost">;
}): DiffPane {
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const parts = useParts({
    fileDiff,
    changes,
    diffStyle,
    busy:
      writes.running !== null ||
      active.mergingIn(fileDiff.kind !== "closed" ? fileDiff.root : null),
    write: writes.write,
    selectRange,
    lostFocus: () => focus.checkLost(),
  });
  return {
    diffStyle,
    setDiffStyle,
    parts,
    actions: defineSlice({
      context: {
        file:
          fileDiff.kind === "closed"
            ? null
            : {
                hasCommit: revisionOf(fileDiff) !== null,
                lineActions: parts.lineActions,
              },
      },
      commands: {
        closeFile,
        showFile: (view: FileView) => focus.fileDiffRef.current?.show(view),
        writeLines: parts.writeLines,
      },
    }),
  };
}
