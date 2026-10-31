import { useState } from "react";
import type { Commands } from "../actions";
import { readyAdvances } from "../domain/overview";
import { pushControl } from "../domain/push";
import type { PushControl, PushIntent } from "../domain/push";
import type { RepositoryRoot } from "../domain/repository";
import type {
  OverviewStore,
  OverviewView,
  PushState,
  RepositoryState,
  RootState,
} from "../overview";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";

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
  push: PushState | undefined;
  publishControl: PushControl;
  fetching: boolean;
  /** Branches that can fast-forward. */
  ready: number;
  publishingRoot: RepositoryRoot | null;
  publish: (root: RepositoryRoot, intent: PushIntent) => void;
  closePublish: () => void;
  actions: ActionSlice<"push" | "repository", SyncCommand>;
};

type SyncCommand = "fetch" | "push" | "fastForward";
export type SyncCommands = Pick<Commands, SyncCommand>;

export function useSyncControls(
  store: OverviewStore,
  view: OverviewView,
  opened: OpenedRepository,
  writing: boolean,
): SyncControls {
  const [publishingRoot, setPublishingRoot] = useState<RepositoryRoot | null>(
    null,
  );
  const { root, state, repository } = opened;
  const push = root === null ? undefined : view.pushByRoot.get(root);
  const publishControl = pushControl(
    push?.availability,
    writing
      ? "Wait for the current local write to finish."
      : !repository
        ? state?.kind === "unavailable"
          ? state.problem.message
          : "Checking the current repository…"
        : repository.activity.kind !== "idle"
          ? "Wait for this repository's current operation to finish."
          : null,
  );
  const fetching = repository?.activity.kind === "fetching";
  const ready = repository ? readyAdvances(repository.overview).length : 0;
  return {
    opened,
    push,
    publishControl,
    fetching,
    ready,
    publishingRoot,
    publish: (target, intent) => {
      void store.push(target, intent);
    },
    closePublish: () => setPublishingRoot(null),
    actions: defineSlice({
      context: {
        push: root ? publishControl : null,
        repository: repository && {
          fetching,
          idle: repository.activity.kind === "idle",
          ready,
        },
      },
      commands: {
        fetch: () => {
          if (repository) void store.fetch(repository.commonDir);
        },
        push: () => {
          if (root && publishControl.kind === "ready")
            void store.push(root, publishControl.intent);
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
