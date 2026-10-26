import { useCallback, useEffect, useRef, useState } from "react";
import * as repositories from "./repositories";
import { describe, nextEntry, rereadsRepository } from "./domain/operations";
import type {
  History,
  HistoryEntry,
  Step,
  Write,
  WriteNotice,
} from "./domain/operations";
import { problemFrom } from "./domain/repository";
import type {
  Applied,
  EntryId,
  Problem,
  RepositoryRoot,
} from "./domain/repository";
import { oneReadPerKey } from "./oneReadPerKey";

export type Writes = {
  history: History;
  running: { action: "write" | Step; label: string } | null;
  notice: WriteNotice | null;
};

const idle: Writes = {
  history: { kind: "unread" },
  running: null,
  notice: null,
};

const labelled = (applied: Applied | null): HistoryEntry | null =>
  applied && { ...applied, label: describe(applied.operation) };

export function useWrites(
  root: RepositoryRoot | null,
  reread: {
    worktree: (worktree: RepositoryRoot) => Promise<void>;
    repository: () => void;
  },
) {
  const [byRoot, setByRoot] = useState<ReadonlyMap<RepositoryRoot, Writes>>(
    new Map(),
  );
  const inFlight = useRef(new Set<RepositoryRoot>());
  const update = useCallback(
    (repository: RepositoryRoot, change: (writes: Writes) => Writes) =>
      setByRoot((previous) =>
        new Map(previous).set(
          repository,
          change(previous.get(repository) ?? idle),
        ),
      ),
    [],
  );
  const [readHistory] = useState(() =>
    oneReadPerKey((repository: RepositoryRoot) =>
      repositories
        .undoHistory(repository)
        .then(
          ({ undo, redo }): History => ({
            kind: "read",
            undo: labelled(undo),
            redo: labelled(redo),
          }),
          (error): History => ({
            kind: "unreadable",
            problem: problemFrom(error),
          }),
        )
        .then((history) =>
          update(repository, (writes) => ({ ...writes, history })),
        ),
    ),
  );
  const rereadHistory = useCallback(() => {
    if (root !== null) void readHistory(root);
  }, [root, readHistory]);
  useEffect(rereadHistory, [rereadHistory]);

  async function run(
    job: { action: "write" } | { action: Step; entry: EntryId },
    label: string,
    worktree: RepositoryRoot,
    request: () => Promise<Applied>,
  ): Promise<boolean> {
    const { action } = job;
    if (root === null || inFlight.current.has(root)) return false;
    const repository = root;
    inFlight.current.add(repository);
    update(repository, (writes) => ({
      ...writes,
      running: { action, label },
    }));
    let outcome: { applied: Applied } | { problem: Problem };
    try {
      outcome = { applied: await request() };
    } catch (error) {
      outcome = { problem: problemFrom(error) };
    }
    const changed = "applied" in outcome ? outcome.applied.root : worktree;
    if ("problem" in outcome && rereadsRepository(outcome.problem))
      reread.repository();
    await Promise.all([
      readHistory(repository),
      reread.worktree(worktree),
      changed === worktree ? null : reread.worktree(changed),
    ]);
    inFlight.current.delete(repository);
    const notice: WriteNotice | null =
      "problem" in outcome
        ? { kind: "failed", ...job, label, problem: outcome.problem }
        : action === "write"
          ? null
          : { kind: "stepped", step: action, label };
    update(repository, (writes) => ({ ...writes, running: null, notice }));
    return "applied" in outcome;
  }

  const writes = (root === null ? undefined : byRoot.get(root)) ?? idle;

  function step(action: Step) {
    const entry = nextEntry(writes.history, action);
    if (root === null || entry === null) return Promise.resolve(false);
    const { id } = entry;
    return run({ action, entry: id }, entry.label, entry.root, () =>
      repositories[action](root, id),
    );
  }

  return {
    ...writes,
    write: (worktree: RepositoryRoot, { operation, expect }: Write) =>
      run({ action: "write" }, describe(operation), worktree, () =>
        repositories.write(worktree, operation, expect),
      ),
    undo: () => step("undo"),
    redo: () => step("redo"),
    dismiss: () => {
      if (root !== null) update(root, (shown) => ({ ...shown, notice: null }));
    },
    rereadHistory,
  };
}

export type WritesView = ReturnType<typeof useWrites>;
