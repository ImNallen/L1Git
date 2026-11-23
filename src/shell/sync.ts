import { useState } from "react";
import {
  branchRefSchema,
  fastForwardOffer,
  fetchTarget,
  readyAdvances,
} from "../domain/overview";
import type { WriteNotice } from "../domain/operations";
import { explainBehindRejection, pushControl } from "../domain/push";
import { worktreeHead } from "../domain/worktree";
import type { PushIntent } from "../domain/push";
import type {
  Branch,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
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
              void store.updateAll(repository.commonDir, branch),
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
          if (repository && fetch.kind === "ready")
            void store.fetchBranch(repository.commonDir, fetch.branch);
        },
        fetchAll: () => {
          if (repository) void store.fetch(repository.commonDir);
        },
        push: () => {
          if (root && publishControl.kind === "ready")
            pushFrom(root, publishControl.intent);
          else if (root && publishControl.kind === "publish")
            setPublishingRoot(root);
        },
        fastForward: () => {
          if (repository) void store.updateAll(repository.commonDir);
        },
      },
    }),
  };
}
