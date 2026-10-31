import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { Compare } from "../domain/comparison";
import { swapEnds } from "../domain/comparison";
import type { RefStep } from "../domain/operations";
import type {
  FullRef,
  Oid,
  Problem,
  RepositoryRoot,
  Stash,
} from "../domain/repository";
import type { Selection } from "../domain/selection";
import { branchVisibility, NO_RULE, toggleRule } from "../domain/visibility";
import type { VisibilityRule } from "../domain/visibility";
import type { RefsState } from "../useRepositoryRefs";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import { focusedElement, shownElement } from "./dom";
import { isBranch, jumpView, listedRef } from "./navigation";
import type { Jump, JumpTarget, JumpView, UserSelection } from "./navigation";
import type { Focus } from "./useFocus";
import type { HistoryPane } from "./useHistoryPane";
import type { Layout } from "./useLayout";
import type { SettingsScreen } from "./useSettingsScreen";
import type { WorkspaceApi, WorkspaceView } from "./workspaceView";

export type RefStepTarget = RefStep & { root: RepositoryRoot };

/** RepositoryTree's navigation props. */
export type SidebarNavigation = {
  highlighted: { root: RepositoryRoot; reference: FullRef } | null;
  selectedStash: { root: RepositoryRoot; oid: Oid } | null;
  onSelect: (root: RepositoryRoot) => void;
  onJump: (root: RepositoryRoot, target: JumpTarget) => void;
  onStash: (root: RepositoryRoot, stash: Stash) => void;
  ruleFor: (root: RepositoryRoot) => VisibilityRule;
  onRule: (root: RepositoryRoot, rule: VisibilityRule) => void;
  onRemove: (root: RepositoryRoot) => void;
  onAdd: () => void;
};

/**
 * Which repository and ref the user is looking at, and every selection that
 * waits for a settled snapshot. The sidebar jump has all its writers here.
 */
export type Navigation = {
  selecting: UserSelection;
  /** Bumped after a jump's select, so History reveals the row on the next render. */
  revealSeq: number;
  jump: JumpView;
  /** Checked-out branch references, by worktree name. */
  checkedOut: ReadonlyMap<FullRef, string>;
  sidebar: SidebarNavigation;
  adding: boolean;
  closeAdd: () => void;
  addRepository: (path: string, signal: AbortSignal) => Promise<Problem | null>;
  jumpTo: (root: RepositoryRoot, target: JumpTarget) => void;
  showInGraph: (root: RepositoryRoot, target: JumpTarget) => void;
  /** After Edit message: select the new HEAD once the settled snapshot has it. */
  selectHeadAfter: (root: RepositoryRoot) => void;
  /** After an undo, redo, or tag delete moved a ref: wait for the sidebar refs, then jump to it and focus its row. */
  followRefStep: (step: RefStepTarget | null) => void;
  actions: ActionSlice<
    | "adding"
    | "selection"
    | "compare"
    | "sidebarBranch"
    | "sidebarTag"
    | "rule",
    | "addRepository"
    | "openRepository"
    | "jumpToRef"
    | "showStash"
    | "toggleHide"
    | "toggleSolo"
    | "showAllBranches"
    | "swapCompare"
    | "endCompare"
  >;
};

export function useNavigation({
  app,
  view: { snapshot, settled },
  history: { rule, loaded, visibleOids },
  visibility,
  expansion,
  sidebarRefs,
  settings,
  focus: { historyRef, fallback, focusNamedBranch },
  layout: { sidebarToggleRef },
  paletteOpen,
}: {
  app: WorkspaceApi;
  view: Pick<WorkspaceView, "snapshot" | "settled">;
  history: Pick<HistoryPane, "rule" | "loaded" | "visibleOids">;
  visibility: {
    ruleFor: (root: RepositoryRoot) => VisibilityRule;
    setRule: (root: RepositoryRoot, rule: VisibilityRule) => void;
    reveal: (root: RepositoryRoot, reference: FullRef) => void;
  };
  expansion: { setExpanded: (root: RepositoryRoot, expanded: boolean) => void };
  sidebarRefs: ReadonlyMap<RepositoryRoot, RefsState>;
  settings: Pick<SettingsScreen, "toRepository">;
  focus: Pick<Focus, "historyRef" | "fallback" | "focusNamedBranch">;
  layout: Pick<Layout, "sidebarToggleRef">;
  paletteOpen: boolean;
}): Navigation {
  const [adding, setAdding] = useState(false);
  const [headOf, setHeadOf] = useState<RepositoryRoot | null>(null);
  const [steppedRef, setSteppedRef] = useState<RefStepTarget | null>(null);
  const focusJumpedRow = useRef(false);
  const [jump, setJump] = useState<Jump | null>(null);
  // The branch or tag last selected in each repository, so it stays highlighted after a round trip.
  const [lastBranch, setLastBranch] = useState<
    ReadonlyMap<RepositoryRoot, FullRef>
  >(new Map());
  const gridFocus = useRef<{
    root: RepositoryRoot;
    from: Element | null;
    cancel: AbortController;
  } | null>(null);
  // A stash clicked in another repository, selected once its snapshot loads.
  const [pendingStash, setPendingStash] = useState<{
    root: RepositoryRoot;
    oid: Oid;
  } | null>(null);
  const [sidebarJump, setSidebarJump] = useState<{
    root: RepositoryRoot;
    reference: FullRef;
  } | null>(null);
  const { selection, workspace } = app;
  const shownJump = jumpView({
    snapshot,
    jump,
    lastBranch,
    sidebarJump,
    selection,
    loaded,
    visibleOids,
  });
  const { jumped, highlighted, hiddenJump, ruledBranch, sidebarTag } =
    shownJump;
  const checkedOut = useMemo(
    () =>
      new Map(
        snapshot?.worktrees.flatMap(({ head, name }) =>
          head.kind === "attached" ? [[head.reference, name] as const] : [],
        ),
      ),
    [snapshot],
  );
  function cancelGridFocus() {
    gridFocus.current?.cancel.abort();
    gridFocus.current = null;
  }
  function showRepository(root: RepositoryRoot) {
    cancelGridFocus();
    setSidebarJump(null);
    settings.toRepository();
    expansion.setExpanded(root, true);
    if (root !== snapshot?.root) void app.selectRepository(root);
  }
  function jumpTo(root: RepositoryRoot, target: JumpTarget) {
    app.closeFile();
    const pending = root !== snapshot?.root;
    if (pending) showRepository(root);
    else if (visibleOids.has(target.oid))
      app.select({ kind: "commit", oid: target.oid });
    setSidebarJump({ root, reference: target.reference });
    setLastBranch((previous) => new Map(previous).set(root, target.reference));
    setJump((previous) => ({
      root,
      reference: target.reference,
      seq: (previous?.seq ?? 0) + 1,
      pending,
    }));
  }
  function select(next: Selection) {
    setSidebarJump(null);
    app.select(next);
  }
  function compareWith(next: Compare) {
    setSidebarJump(null);
    app.compareWith(next);
  }
  function endCompare() {
    setSidebarJump(null);
    app.endCompare();
  }
  function setRule(root: RepositoryRoot, next: VisibilityRule) {
    setSidebarJump(null);
    visibility.setRule(root, next);
  }
  function showStash(root: RepositoryRoot, stash: Stash) {
    app.closeFile();
    if (root === snapshot?.root) select({ kind: "commit", oid: stash.oid });
    else {
      showRepository(root);
      setPendingStash({ root, oid: stash.oid });
    }
  }
  function showInGraph(root: RepositoryRoot, target: JumpTarget) {
    setSidebarJump(null);
    if (isBranch(target)) visibility.reveal(root, target.reference);
    else visibility.setRule(root, NO_RULE);
    app.select({ kind: "commit", oid: target.oid });
    setJump((previous) => ({
      root,
      reference: target.reference,
      seq: (previous?.seq ?? 0) + 1,
      pending: false,
    }));
    historyRef.current?.focus();
  }
  async function addRepository(path: string, signal: AbortSignal) {
    const added = await app.addRepository(path, signal);
    if (added.kind === "opened") {
      setSidebarJump(null);
      expansion.setExpanded(added.root, true);
    }
    return added.kind === "failed" ? added.problem : null;
  }
  const jumpToStepped = useEffectEvent(jumpTo);
  const focusJumpedBranch = useEffectEvent(focusNamedBranch);
  useEffect(() => {
    if (steppedRef === null) return;
    const { root, left, gone } = steppedRef;
    const state = sidebarRefs.get(root);
    const listed = (reference: FullRef) =>
      state?.kind === "ready" ? listedRef(state.refs, reference) : null;
    const target = left === null ? null : listed(left);
    if ((left !== null && target === null) || (gone && listed(gone))) return;
    setSteppedRef(null);
    if (shownElement(focusedElement())) return;
    if (target === null) return fallback();
    focusJumpedRow.current = true;
    jumpToStepped(root, target);
  }, [steppedRef, sidebarRefs, fallback]);
  useEffect(() => {
    if (!focusJumpedRow.current) return;
    focusJumpedRow.current = false;
    focusJumpedBranch();
  }, [sidebarJump]);
  useEffect(() => {
    const pending = gridFocus.current;
    if (pending === null) return;
    if (snapshot?.root === pending.root) {
      const focused = focusedElement();
      if (
        !paletteOpen &&
        (focused === pending.from ||
          focused === document.body ||
          focused === sidebarToggleRef.current ||
          focused?.closest(".history-table"))
      )
        historyRef.current?.focus();
    } else if (workspace.kind !== "error") return;
    cancelGridFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the opened repository arrives or fails; the palette only gates the focus
  }, [snapshot?.root, workspace.kind, sidebarToggleRef, historyRef]);
  const { activeRoot, select: appSelect } = app;
  useEffect(() => {
    if (jump === null) return;
    if (activeRoot !== jump.root) setJump(null);
    else if (jump.pending && settled?.root === jump.root) {
      const target = listedRef(settled, jump.reference);
      if (target && visibleOids.has(target.oid))
        appSelect({ kind: "commit", oid: target.oid });
      setJump({ ...jump, pending: false, seq: jump.seq + 1 });
    }
  }, [jump, settled, visibleOids, activeRoot, appSelect]);
  useEffect(() => {
    if (headOf === null || settled === null) return;
    if (settled.root === headOf && settled.head.kind !== "unborn")
      appSelect({ kind: "commit", oid: settled.head.oid });
    setHeadOf(null);
  }, [headOf, settled, appSelect]);
  useEffect(() => {
    if (pendingStash === null) return;
    if (activeRoot !== pendingStash.root) setPendingStash(null);
    else if (settled?.root === pendingStash.root) {
      if (settled.stashes.some((stash) => stash.oid === pendingStash.oid))
        appSelect({ kind: "commit", oid: pendingStash.oid });
      setPendingStash(null);
    }
  }, [pendingStash, settled, activeRoot, appSelect]);
  return {
    selecting: {
      selection,
      compare: app.compare,
      select,
      compareWith,
      endCompare,
      swapCompare: app.swapCompare,
    } as UserSelection,
    revealSeq: jump?.seq ?? 0,
    jump: shownJump,
    checkedOut,
    sidebar: {
      highlighted:
        snapshot && jumped && highlighted
          ? { root: snapshot.root, reference: jumped.reference }
          : null,
      selectedStash:
        snapshot &&
        selection?.kind === "commit" &&
        snapshot.stashes.some((stash) => stash.oid === selection.oid)
          ? { root: snapshot.root, oid: selection.oid }
          : null,
      onSelect: showRepository,
      onJump: jumpTo,
      onStash: showStash,
      ruleFor: visibility.ruleFor,
      onRule: setRule,
      onRemove: (root) => {
        app.removeRepository(root);
        expansion.setExpanded(root, false);
        visibility.setRule(root, NO_RULE);
        setLastBranch((previous) => {
          const next = new Map(previous);
          next.delete(root);
          return next;
        });
      },
      onAdd: () => setAdding(true),
    },
    adding,
    closeAdd: () => setAdding(false),
    addRepository,
    jumpTo,
    showInGraph,
    selectHeadAfter: setHeadOf,
    followRefStep: setSteppedRef,
    actions: defineSlice({
      context: {
        adding,
        selection,
        compare: app.compare && { swappable: swapEnds(app.compare) !== null },
        sidebarBranch: ruledBranch && {
          name: ruledBranch.name,
          visibility: branchVisibility(rule, ruledBranch.reference),
          outOfView: hiddenJump !== null,
          local: ruledBranch.kind === "local",
          checkedOut: checkedOut.has(ruledBranch.reference),
        },
        sidebarTag: sidebarTag && { name: sidebarTag.name },
        rule: rule.kind,
      },
      commands: {
        addRepository: () => setAdding(true),
        openRepository: (root: RepositoryRoot) => {
          showRepository(root);
          if (root === snapshot?.root) return;
          const cancel = new AbortController();
          for (const type of ["pointerdown", "keydown"])
            window.addEventListener(type, cancelGridFocus, {
              capture: true,
              signal: cancel.signal,
            });
          gridFocus.current = { root, from: focusedElement(), cancel };
        },
        jumpToRef: (reference: FullRef) => {
          const target = snapshot && listedRef(snapshot, reference);
          if (snapshot && target) jumpTo(snapshot.root, target);
        },
        showStash: (stash: Stash) => {
          if (snapshot) showStash(snapshot.root, stash);
        },
        toggleHide: () => {
          if (snapshot && hiddenJump) showInGraph(snapshot.root, hiddenJump);
          else if (snapshot && ruledBranch)
            setRule(
              snapshot.root,
              toggleRule(rule, "hide", ruledBranch.reference),
            );
        },
        toggleSolo: () => {
          if (snapshot && ruledBranch)
            setRule(
              snapshot.root,
              toggleRule(rule, "solo", ruledBranch.reference),
            );
        },
        showAllBranches: () => {
          if (snapshot) setRule(snapshot.root, NO_RULE);
        },
        swapCompare: app.swapCompare,
        endCompare,
      },
    }),
  };
}
