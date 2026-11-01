import type { MergeAction, MergeReport } from "./domain/merge";
import { useCallback, useEffect, useRef, useState } from "react";
import * as repositories from "./repositories";
import { beginDraftTask } from "./draftProtection";
import { restoreUndone } from "./commitDrafts";
import {
  describe,
  movesRefs,
  nextEntry,
  noticeLabel,
  rereadsRepository,
} from "./domain/operations";
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
  Operation,
  Problem,
  RepositoryRoot,
} from "./domain/repository";
import { oneReadPerKey } from "./oneReadPerKey";

export type Writes = {
  history: History;
  running: { action: "write" | "merge" | Step; label: string } | null;
  notice: WriteNotice | null;
};

const idle: Writes = {
  history: { kind: "unread" },
  running: null,
  notice: null,
};

export type Outcome =
  | { kind: "applied"; applied: Applied }
  | { kind: "failed"; problem: Problem }
  | { kind: "busy" };

const labelled = (applied: Applied | null): HistoryEntry | null =>
  applied && { ...applied, label: describe(applied.operation) };

export function useWrites(
  root: RepositoryRoot | null,
  reread: {
    worktree: (worktree: RepositoryRoot) => Promise<void>;
    repository: (repository: RepositoryRoot) => void;
    /** Rereads branches and history after a write moved a ref. */
    refs: (
      worktree: RepositoryRoot,
      repository: RepositoryRoot,
    ) => Promise<void>;
  },
  historyRoot: RepositoryRoot | null = root,
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
    if (historyRoot !== null) void readHistory(historyRoot);
  }, [historyRoot, readHistory]);
  useEffect(rereadHistory, [rereadHistory]);

  async function run(
    job: { action: "write" } | { action: Step; entry: EntryId },
    label: string,
    worktree: RepositoryRoot,
    operation: Operation,
    request: () => Promise<Applied>,
  ): Promise<Outcome> {
    const { action } = job;
    return task(action, label, async (repository) => {
      let outcome: Exclude<Outcome, { kind: "busy" }>;
      try {
        outcome = { kind: "applied", applied: await request() };
      } catch (error) {
        outcome = { kind: "failed", problem: problemFrom(error) };
      }
      const changed =
        outcome.kind === "applied" ? outcome.applied.root : worktree;
      if (outcome.kind === "failed" && rereadsRepository(outcome.problem))
        reread.repository(repository);
      if (
        outcome.kind === "applied" &&
        action === "undo" &&
        operation.kind === "commit"
      )
        restoreUndone(changed, operation.message);
      if (movesRefs(operation)) await reread.refs(changed, repository);
      await Promise.all([
        readHistory(historyRoot ?? worktree),
        reread.worktree(worktree),
        changed === worktree ? null : reread.worktree(changed),
      ]);
      const notice: WriteNotice | null =
        outcome.kind === "failed"
          ? job.action === "write"
            ? {
                kind: "failed",
                ...job,
                label,
                problem: outcome.problem,
                operation,
              }
            : { kind: "failed", ...job, label, problem: outcome.problem }
          : action === "write"
            ? null
            : {
                kind: "stepped",
                step: action,
                label: noticeLabel(action, operation, label),
              };
      update(repository, (writes) => ({ ...writes, running: null, notice }));
      return outcome;
    });
  }

  async function task<T>(
    action: "write" | "merge" | Step,
    label: string,
    work: (repository: RepositoryRoot) => Promise<T>,
  ): Promise<T | { kind: "busy" }> {
    if (root === null || inFlight.current.has(root)) return { kind: "busy" };
    const finishDraftTask = beginDraftTask();
    if (!finishDraftTask) return { kind: "busy" };
    const repository = root;
    inFlight.current.add(repository);
    update(repository, (writes) => ({ ...writes, running: { action, label } }));
    try {
      return await work(repository);
    } finally {
      update(repository, (writes) => ({ ...writes, running: null }));
      inFlight.current.delete(repository);
      finishDraftTask();
    }
  }

  async function merge(
    worktree: RepositoryRoot,
    action: MergeAction,
  ): Promise<MergeCommandOutcome> {
    return task(
      "merge",
      `${action.kind === "start" ? "Start" : action.kind === "finish" ? "Finish" : "Abort"} merge`,
      async (repository) => {
        let outcome: Exclude<MergeCommandOutcome, { kind: "busy" }>;
        try {
          outcome = {
            kind: "merged",
            report: await repositories.merge(worktree, action),
          };
        } catch (error) {
          outcome = { kind: "failed", problem: problemFrom(error) };
        }
        try {
          try {
            await reread.refs(worktree, repository);
          } finally {
            await Promise.all([
              readHistory(historyRoot ?? worktree),
              reread.worktree(worktree),
            ]);
          }
        } catch (error) {
          if (outcome.kind === "merged") {
            const result = outcome.report.outcome;
            if (
              result.kind === "fastForwarded" ||
              result.kind === "finished" ||
              result.kind === "started"
            ) {
              const problem = `Repository refresh failed: ${problemFrom(error).message}`;
              outcome = {
                ...outcome,
                report: {
                  ...outcome.report,
                  outcome: {
                    ...result,
                    problem: result.problem
                      ? `${result.problem} ${problem}`
                      : problem,
                  },
                },
              };
            }
          }
        }
        return outcome;
      },
    );
  }

  const current = (root === null ? undefined : byRoot.get(root)) ?? idle;
  const writes = {
    ...current,
    history:
      (historyRoot === null ? undefined : byRoot.get(historyRoot))?.history ??
      idle.history,
  };

  function step(action: Step) {
    const entry = nextEntry(writes.history, action);
    if (historyRoot === null || entry === null)
      return Promise.resolve<Outcome>({ kind: "busy" });
    const { id } = entry;
    return run(
      { action, entry: id },
      entry.label,
      entry.root,
      entry.operation,
      () => repositories[action](historyRoot, id),
    );
  }

  return {
    ...writes,
    merge,
    write: (worktree: RepositoryRoot, { operation, expect }: Write) =>
      run({ action: "write" }, describe(operation), worktree, operation, () =>
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

export type MergeCommandOutcome =
  | { kind: "merged"; report: MergeReport }
  | { kind: "failed"; problem: Problem }
  | { kind: "busy" };
