import type { RepositoryRoot } from "../domain/repository";
import type { OverviewView, RepositoryState, RootState } from "../overview";

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
