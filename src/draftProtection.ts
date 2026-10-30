import { useSyncExternalStore } from "react";
import type { RepositoryRoot } from "./domain/repository";

export type DraftImpact = {
  revision: number;
  frozen: boolean;
  tasks: number;
  drafts: { root: RepositoryRoot; messages: number; amending: boolean }[];
  resolutions: { root: RepositoryRoot; path: string }[];
};
let restart: DraftImpact = {
  revision: 0,
  frozen: false,
  tasks: 0,
  drafts: [],
  resolutions: [],
};
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify() {
  for (const listener of listeners) listener();
}
function change(
  next: Partial<Pick<DraftImpact, "drafts" | "resolutions" | "tasks">>,
) {
  restart = { ...restart, ...next, revision: restart.revision + 1 };
  notify();
}
export const publishCommitImpact = (drafts: DraftImpact["drafts"]) =>
  change({ drafts });
export const publishResolutionImpact = (
  resolutions: DraftImpact["resolutions"],
) => change({ resolutions });
export const draftImpact = () => restart;
export const useDraftImpact = () =>
  useSyncExternalStore(subscribe, draftImpact, draftImpact);

export function beginDraftTask(): (() => void) | null {
  if (restart.frozen) return null;
  change({ tasks: restart.tasks + 1 });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    change({ tasks: restart.tasks - 1 });
  };
}

export function freezeDrafts(
  revision: number,
): { kind: "changed" | "busy" } | { kind: "frozen"; release: () => void } {
  if (restart.frozen || restart.tasks > 0) return { kind: "busy" };
  if (revision !== restart.revision) return { kind: "changed" };
  restart = { ...restart, frozen: true };
  notify();
  let active = true;
  return {
    kind: "frozen",
    release: () => {
      if (!active) return;
      active = false;
      restart = { ...restart, frozen: false };
      notify();
    },
  };
}
