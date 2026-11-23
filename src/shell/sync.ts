import { useState } from "react";
import {
  branchRefSchema,
  fastForwardOffer,
  fetchTarget,
  readyAdvances,
} from "../domain/overview";
import type { AdvanceOutcome, FetchSummary } from "../domain/overview";
import type { WriteNotice } from "../domain/operations";
import { explainBehindRejection, pushControl } from "../domain/push";
import { worktreeHead } from "../domain/worktree";
import type { PushIntent } from "../domain/push";
import type {
  Branch,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
import { reached } from "../overview";
import type {
  OverviewStore,
  OverviewView,
  RepositoryState,
  RootState,
} from "../overview";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { SidebarRefActions } from "./useRefWrites";

/** The overview entry of the repository on screen. */
export type OpenedRepository = {
  root: RepositoryRoot | null;
  state: RootState | undefined | null;
  repository: RepositoryState | null;
};

export function openedRepository(
  view: OverviewView,
  root: RepositoryRoot | null,
): OpenedRepository {
  const state = root === null ? null : view.roots.get(root);
  const repository =
    state?.kind === "open"
      ? (view.repositories.find(
          (repository) => repository.commonDir === state.commonDir,
        ) ?? null)
      : null;
  return { root, state, repository };
}

/** Fetch, push or publish, and fast-forward for the repository on screen. */
export type SyncControls = {
  opened: OpenedRepository;
  publishingRoot: RepositoryRoot | null;
  publish: (root: RepositoryRoot, intent: PushIntent) => void;
  closePublish: () => void;
  actions: ActionSlice<"push" | "repository", SyncCommand>;
  sidebar: SidebarRefActions["fastForward"];
};

type SyncCommand = "fetch" | "fetchAll" | "push" | "fastForward";

export const localBusyReason = (
  writing: boolean,
  repository: RepositoryState | null,
) =>
  writing
    ? "Wait for the current local write to finish."
    : repository && repository.activity.kind !== "idle"
      ? "Wait for this repository's current operation to finish."
      : null;

/**
 * A fetch that failed anywhere posts nothing. Its warning speaks for it, and the
 * notice already shown stays.
 */
function fetchedNotice(summary: FetchSummary | null): WriteNotice | null {
  if (!reached(summary)) return null;
  const remotes = summary.remotes.flatMap(({ remote, outcome }) =>
    outcome.kind === "fetched" ? [remote] : [],
  );
  return remotes.length === 0
    ? null
    : { kind: "fetched", remotes, moved: summary.moved };
}

/** Branches that did not move already show why in the repository warnings. */
function advancedNotice(
  outcomes: readonly AdvanceOutcome[],
): WriteNotice | null {
  const branches = outcomes.flatMap((outcome) =>
    outcome.kind === "advanced" ? [outcome.reference] : [],
  );
  return branches.length === 0 ? null : { kind: "advanced", branches };
}

/** The local branch checked out in `root`, null when it is on no branch. */
function checkedOut(
  snapshot: RepositorySnapshot | null,
  root: RepositoryRoot | null,
): Branch | null {
  const head = worktreeHead(snapshot?.worktrees, root);
  if (head?.kind !== "attached") return null;
  return (
    snapshot?.branches.find(
      (branch) =>
        branch.kind === "local" && branch.reference === head.reference,
    ) ?? null
  );
}

export function useSyncControls({
  store,
  view,
  opened,
  writing,
  snapshot,
  activeRoot,
  selectedBranch,
  post,
}: {
  store: OverviewStore;
  view: OverviewView;
  opened: OpenedRepository;
  writing: boolean;
  snapshot: RepositorySnapshot | null;
  /** The worktree whose checked-out branch Fetch falls back to. */
  activeRoot: RepositoryRoot | null;
  selectedBranch: Branch | null;
  post: (root: RepositoryRoot, notice: WriteNotice) => void;
}): SyncControls {
  const [publishingRoot, setPublishingRoot] = useState<RepositoryRoot | null>(
    null,
  );
  const { root, state, repository } = opened;
  const branches = repository?.overview.branches ?? [];
  const publishControl = pushControl(
    root === null ? undefined : view.pushByRoot.get(root),
    localBusyReason(writing, repository) ??
      (repository
        ? null
        : state?.kind === "unavailable"
          ? state.problem.message
          : "Checking the current repository…"),
    branches,
  );
  const fetching = repository?.activity.kind === "fetching";
  const ready = repository ? readyAdvances(repository.overview).length : 0;
  const fetch = fetchTarget(selectedBranch, checkedOut(snapshot, activeRoot));
  const busy = localBusyReason(writing, repository);
  const pushFrom = (target: RepositoryRoot, intent: PushIntent) =>
    void store.push(target, intent).then((result) => {
      if (result)
        post(target, {
          kind: "pushed",
          ...explainBehindRejection(result, branches),
        });
    });
  const postFound = (target: RepositoryRoot, notice: WriteNotice | null) => {
    if (notice) post(target, notice);
  };
  const fetchFrom = (
    target: RepositoryRoot,
    fetching: Promise<FetchSummary | null>,
  ) =>
    void fetching.then((summary) => postFound(target, fetchedNotice(summary)));
  const advanceIn = (
    target: RepositoryRoot,
    advancing: Promise<readonly AdvanceOutcome[]>,
  ) =>
    void advancing.then((outcomes) =>
      postFound(target, advancedNotice(outcomes)),
    );
  return {
    opened,
    sidebar:
      root && repository
        ? {
            root,
            offer(reference) {
              const local = branchRefSchema.safeParse(reference);
              const branch =
                local.success &&
                repository.overview.branches.find(
                  (status) => status.reference === local.data,
                );
              const offer = branch && fastForwardOffer(branch, root);
              if (!offer) return null;
              return offer.reason === null && busy
                ? { ...offer, reason: busy }
                : offer;
            },
            onSelect: (branch) =>
              advanceIn(root, store.updateAll(repository.commonDir, branch)),
          }
        : undefined,
    publishingRoot,
    publish: pushFrom,
    closePublish: () => setPublishingRoot(null),
    actions: defineSlice({
      context: {
        push: root ? publishControl : null,
        repository: repository && {
          fetching,
          idle: repository.activity.kind === "idle",
          ready,
          fetch,
        },
      },
      commands: {
        fetch: () => {
          if (root && repository && fetch.kind === "ready")
            fetchFrom(
              root,
              store.fetchBranch(repository.commonDir, fetch.branch),
            );
        },
        fetchAll: () => {
          if (root && repository)
            fetchFrom(root, store.fetch(repository.commonDir));
        },
        push: () => {
          if (root && publishControl.kind === "ready")
            pushFrom(root, publishControl.intent);
          else if (root && publishControl.kind === "publish")
            setPublishingRoot(root);
        },
        fastForward: () => {
          if (root && repository)
            advanceIn(root, store.updateAll(repository.commonDir));
        },
      },
    }),
  };
}
