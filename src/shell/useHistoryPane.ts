import { useCallback, useMemo } from "react";
import { buildGraph } from "../domain/graph";
import type { Graph } from "../domain/graph";
import { trunkTips } from "../domain/highlight";
import type { BranchStatus } from "../domain/overview";
import { refLabels } from "../domain/refs";
import type { RefLabel } from "../domain/refs";
import type {
  Commit,
  Oid,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
import type { Selection } from "../domain/selection";
import { NO_RULE, visibleCommits } from "../domain/visibility";
import type { VisibilityRule } from "../domain/visibility";
import { historyRows } from "../domain/worktree";
import type { ChangesByWorktree, HistoryRow } from "../domain/worktree";
import type { ColumnId } from "../historyColumns";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { Focus } from "./useFocus";

/** Everything History draws. Each field keeps its own memo; History's hover reset keys on `rows` identity. */
export type HistoryModel = {
  snapshot: RepositorySnapshot;
  visibleCommits: readonly Commit[];
  visibleOids: ReadonlySet<Oid>;
  rows: readonly HistoryRow[];
  graph: Graph;
  rule: VisibilityRule;
  /** Tips of the default branch, which the highlight treats as trunk. */
  trunk: Oid[];
};

export type HistoryColumnsGroup = {
  visible: ReadonlySet<ColumnId>;
  toggle: (id: ColumnId) => void;
};

/** The selected commit's labels and lane, for the inspector header. */
export type CommitPlacement = {
  refs: readonly RefLabel[];
  /** Null when a rule hides the commit's row or it is outside the loaded history. */
  lane: number | null;
};

export type HistoryPane = {
  model: HistoryModel | null;
  rule: VisibilityRule;
  loaded: ReadonlySet<Oid>;
  visibleOids: ReadonlySet<Oid>;
  placement: CommitPlacement;
  shows: (oid: Oid) => boolean;
  actions: ActionSlice<
    "searchable",
    | "search"
    | "compareWithWorkingCopy"
    | "compareWithPick"
    | "pick"
    | "clearPick"
  >;
};

export function useHistoryPane({
  snapshot,
  ruleFor,
  changes,
  statuses,
  selection,
  focus: { historyRef },
}: {
  snapshot: RepositorySnapshot | null;
  ruleFor: (root: RepositoryRoot) => VisibilityRule;
  changes: ChangesByWorktree;
  /** The overview's branch statuses, for the trunk highlight. */
  statuses: readonly BranchStatus[] | undefined;
  selection: Selection | null;
  focus: Pick<Focus, "historyRef">;
}): HistoryPane {
  const rule = snapshot ? ruleFor(snapshot.root) : NO_RULE;
  const visible = useMemo(
    () => (snapshot ? visibleCommits(snapshot.commits, snapshot, rule) : []),
    [snapshot, rule],
  );
  const rows = useMemo(
    () => (snapshot ? historyRows(visible, snapshot.worktrees, changes) : []),
    [snapshot, visible, changes],
  );
  const loaded = useMemo(
    () => new Set(snapshot?.commits.map((commit) => commit.oid)),
    [snapshot],
  );
  const visibleOids = useMemo(
    () =>
      visible === snapshot?.commits
        ? loaded
        : new Set(visible.map((commit) => commit.oid)),
    [visible, snapshot, loaded],
  );
  const graph = useMemo(
    () =>
      buildGraph(
        rows,
        visible === snapshot?.commits
          ? snapshot.squashes
          : snapshot?.squashes.filter(
              (squash) =>
                visibleOids.has(squash.commit) && visibleOids.has(squash.tip),
            ),
      ),
    [rows, visible, visibleOids, snapshot],
  );
  const labels = useMemo(
    () => (snapshot ? refLabels(snapshot) : null),
    [snapshot],
  );
  const trunk = useMemo(
    () => (snapshot ? trunkTips(snapshot.branches, statuses ?? []) : []),
    [snapshot, statuses],
  );
  const shows = useCallback((oid: Oid) => visibleOids.has(oid), [visibleOids]);
  const selectedOid = selection?.kind === "commit" ? selection.oid : null;
  return {
    model: snapshot && {
      snapshot,
      visibleCommits: visible,
      visibleOids,
      rows,
      graph,
      rule,
      trunk,
    },
    rule,
    loaded,
    visibleOids,
    placement: {
      refs: selectedOid === null ? [] : (labels?.get(selectedOid) ?? []),
      lane:
        selectedOid === null
          ? null
          : (graph.rows.get(selectedOid)?.lane ?? null),
    },
    shows,
    actions: defineSlice({
      context: { searchable: snapshot !== null },
      commands: {
        search: () => historyRef.current?.openSearch(),
        compareWithWorkingCopy: () => {
          if (selection?.kind === "commit")
            historyRef.current?.compareWithWorkingCopy(selection.oid);
        },
        compareWithPick: () => {
          if (selection?.kind === "commit")
            historyRef.current?.compareWithPick(selection.oid);
        },
        pick: () => {
          if (selection?.kind === "commit")
            historyRef.current?.pick(selection.oid);
        },
        clearPick: () => historyRef.current?.pick(null),
      },
    }),
  };
}
