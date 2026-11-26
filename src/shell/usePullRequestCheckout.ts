import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { busyProblem } from "../components/Dialog";
import { beginDraftTask } from "../draftProtection";
import type { PullRequest } from "../domain/pullRequest";
import { pullHead, standing } from "../domain/pullRequestCheckout";
import { localDelete } from "../domain/pullRequestMerge";
import type { LocalDelete } from "../domain/pullRequestMerge";
import type {
  HeldCheckout,
  Plan,
  PullCheckout,
  PullHead,
  PullKey,
} from "../domain/pullRequestCheckout";
import { problemFrom } from "../domain/repository";
import type {
  BranchTip,
  FullRef,
  Problem,
  RepositoryRoot,
} from "../domain/repository";
import type { OverviewView } from "../overview";
import * as repositories from "../repositories";
import type { WritesView } from "../useWrites";
import type { Focus } from "./useFocus";
import type { Navigation } from "./useNavigation";
import type { OpenedPullRequest } from "./usePullRequests";
import type { ScreenState } from "./useScreen";
import type { WorkspaceApi } from "./workspaceView";
import type { WriteLoop } from "./useWriteLoop";

const FOCUS_REREAD_MS = 1_000;

export type CheckoutWrite = "try" | "update" | "replace" | "remove";

type KnownCheckout =
  | { kind: "unread" }
  | { kind: "unreadable"; problem: Problem }
  | { kind: "read"; checkout: PullCheckout };

/** A note under the bar, kept while the copy still stands as it describes. */
export type CheckoutSaid =
  | {
      kind: "failed";
      write: Exclude<CheckoutWrite, "try">;
      problem: Problem;
      /** `standing` of the copy read after the failure. */
      about: string | null;
    }
  | { kind: "removed"; name: string };

function holds(said: CheckoutSaid, checkout: PullCheckout) {
  switch (said.kind) {
    case "failed":
      return said.about === null || said.about === standing(checkout);
    case "removed":
      return checkout.kind !== "ready";
  }
}

type Copy = {
  key: string | null;
  known: KnownCheckout;
  running: CheckoutWrite | null;
  said: CheckoutSaid | null;
};

export type TryOutcome =
  | { kind: "ready" }
  | { kind: "failed"; problem: Problem }
  | { kind: "busy" };

export type PullRequestCheckout = Omit<Copy, "key"> & {
  offer: { plan: Plan; branch: FullRef; head: PullRequest["head"] } | null;
  /** Another pull request's copy is changing, so this one's writes wait. */
  waiting: boolean;
  /** The home folder, which the bar and the popover write as `~`. */
  home: string | null;
  tryLocally: (folder: string) => Promise<TryOutcome>;
  update: () => void;
  replace: () => void;
  remove: () => void;
  showInHistory: () => void;
  reread: () => void;
  dismiss: () => void;
  /** The local branch that tracks the pull request. */
  local: LocalDelete;
  /** Deletes `branch` while it is still at its tip, as an undoable write.
   * Null once deleted. */
  deleteLocal: (branch: BranchTip) => Promise<Problem | null>;
};

const fresh = (key: string | null): Copy => ({
  key,
  known: { kind: "unread" },
  running: null,
  said: null,
});

export function usePullRequestCheckout({
  opened,
  screen: { place },
  overview,
  historyRoot,
  saved,
  writes,
  loop,
  nav,
  focus,
}: {
  opened: OpenedPullRequest | null;
  screen: Pick<ScreenState, "place">;
  overview: Pick<OverviewView, "roots" | "repositories">;
  historyRoot: RepositoryRoot | null;
  saved: Pick<WorkspaceApi, "catalog" | "keepRepository" | "selectRepository">;
  writes: Pick<WritesView, "post">;
  loop: Pick<WriteLoop, "rereadRefs">;
  nav: Pick<Navigation, "showBranch" | "sidebar">;
  focus: Pick<Focus, "refocusIfLost">;
}): PullRequestCheckout {
  const pull = opened?.read.value ?? null;
  const head = useMemo(() => (pull ? pullHead(pull) : null), [pull]);
  const root = opened?.repository.root ?? null;
  const at =
    opened && head && root
      ? {
          root,
          pull: { github: opened.repository.github, number: opened.number },
          head,
        }
      : null;
  const key = opened && root ? `${root} #${opened.number}` : null;
  const visit = place === "pullRequests" ? (opened?.id ?? null) : null;
  const [stored, setStored] = useState<Copy>(() => fresh(key));
  const copy = stored.key === key ? stored : fresh(key);
  const current = useRef(key);
  useEffect(() => {
    current.current = key;
  }, [key]);
  const turns = useRef(new Map<string, number>());
  const turn = (of: string) => {
    const next = (turns.current.get(of) ?? 0) + 1;
    turns.current.set(of, next);
    return next;
  };
  const writing = useRef<string | null>(null);
  const [writingKey, setWritingKey] = useState<string | null>(null);
  const rereadAfterWrite = useRef(false);
  const [asked, setAsked] = useState(0);
  const askRead = () => setAsked((count) => count + 1);
  const [home, setHome] = useState<string | null>(null);

  const change = (of: string, next: (copy: Copy) => Copy) => {
    if (of !== current.current) return;
    setStored((previous) => next(previous.key === of ? previous : fresh(of)));
  };
  const settle = (of: string, checkout: PullCheckout) =>
    change(of, (was) => ({
      ...was,
      known: { kind: "read", checkout },
      said: was.said && holds(was.said, checkout) ? was.said : null,
    }));

  const read = useEffectEvent(() => {
    if (at === null || key === null) return;
    if (writing.current === key) {
      rereadAfterWrite.current = true;
      return;
    }
    const of = key;
    const mine = turn(of);
    const latest = () => mine === turns.current.get(of);
    repositories.pullCheckout(at.root, at.pull, at.head).then(
      (checkout) => {
        if (latest()) settle(of, checkout);
      },
      (error: unknown) => {
        if (latest())
          change(of, (was) => ({
            ...was,
            known: { kind: "unreadable", problem: problemFrom(error) },
          }));
      },
    );
  });
  useEffect(() => {
    if (visit !== null) read();
  }, [visit, root, pull, asked]);
  const visited = visit !== null;
  useEffect(() => {
    if (!visited) return;
    let last = 0;
    const reread = () => {
      if (performance.now() - last < FOCUS_REREAD_MS) return;
      last = performance.now();
      read();
    };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [visited]);
  const homeAsked = useRef(false);
  useEffect(() => {
    if (!visited || homeAsked.current) return;
    homeAsked.current = true;
    repositories.home().then(setHome, () => {});
  }, [visited]);

  /** Drops the sidebar row of a worktree that `after` no longer has, and
   * opens the pull request's repository in place of it. When that worktree
   * was the pull request's repository, another saved worktree of it stands
   * in, or none does. */
  const forget = (
    before: KnownCheckout,
    after: PullCheckout,
    target: RepositoryRoot,
  ) => {
    if (before.kind !== "read" || before.checkout.kind !== "ready") return null;
    const { worktree } = before.checkout;
    if (after.kind === "ready" && after.worktree.root === worktree.root)
      return null;
    const commonDir = (of: RepositoryRoot) => {
      const state = overview.roots.get(of);
      return state?.kind === "open" ? state.commonDir : null;
    };
    const shared = commonDir(worktree.root);
    const home =
      target !== worktree.root
        ? target
        : (saved.catalog.entries.find(
            ({ root }) =>
              root !== worktree.root &&
              shared !== null &&
              commonDir(root) === shared,
          )?.root ?? null);
    nav.sidebar.onRemove(worktree.root);
    if (home !== null) {
      if (historyRoot === worktree.root) void saved.selectRepository(home);
      writes.post(home, { kind: "removedWorktree", name: worktree.name });
    }
    return { name: worktree.name, home };
  };

  async function write(
    kind: CheckoutWrite,
    run: (target: {
      root: RepositoryRoot;
      pull: PullKey;
      head: PullHead;
    }) => Promise<PullCheckout>,
  ): Promise<TryOutcome> {
    const finish =
      at !== null && key !== null && writing.current === null
        ? beginDraftTask()
        : null;
    if (!finish || at === null || key === null) {
      if (key !== null && kind !== "try")
        change(key, (was) => ({
          ...was,
          said: {
            kind: "failed",
            write: kind,
            problem: busyProblem,
            about: null,
          },
        }));
      return { kind: "busy" };
    }
    const of = key;
    const target = at;
    writing.current = of;
    setWritingKey(of);
    turn(of);
    const before = copy.known;
    let reread: RepositoryRoot | null = target.root;
    change(of, (was) => ({ ...was, running: kind, said: null }));
    try {
      const checkout = await run(target);
      if (kind === "try" && checkout.kind === "ready")
        saved.keepRepository({
          root: checkout.worktree.root,
          name: checkout.worktree.name,
        });
      const removed = forget(before, checkout, target.root);
      if (removed) reread = removed.home;
      change(of, (was) => ({
        ...was,
        known: { kind: "read", checkout },
        running: null,
        said: removed && { kind: "removed", name: removed.name },
      }));
      return { kind: "ready" };
    } catch (error) {
      const problem = problemFrom(error);
      const after = await repositories
        .pullCheckout(target.root, target.pull, target.head)
        .catch(() => null);
      const removed = after && forget(before, after, target.root);
      if (removed) reread = removed.home;
      change(of, (was) => ({
        ...was,
        known: after ? { kind: "read", checkout: after } : was.known,
        running: null,
        said:
          kind === "try"
            ? null
            : {
                kind: "failed",
                write: kind,
                problem,
                about: after && standing(after),
              },
      }));
      return { kind: "failed", problem };
    } finally {
      writing.current = null;
      setWritingKey(null);
      if (rereadAfterWrite.current) {
        rereadAfterWrite.current = false;
        askRead();
      }
      finish();
      if (reread !== null) loop.rereadRefs(reread);
    }
  }

  const known = copy.known;
  const held: HeldCheckout | null =
    known.kind === "read" && known.checkout.kind !== "absent"
      ? known.checkout
      : null;
  const move = (replace: boolean) => {
    if (held)
      void write(replace ? "replace" : "update", ({ root, pull, head }) =>
        repositories.updatePullRequest(root, pull, head, held.tip, replace),
      );
  };
  const checkout = known.kind === "read" ? known.checkout : null;
  const branches =
    overview.repositories.find(
      (each) => root !== null && each.roots.includes(root),
    )?.overview.branches ?? [];
  return {
    known,
    running: copy.running,
    said: copy.said,
    waiting: writingKey !== null && writingKey !== key,
    home,
    offer:
      pull?.state.kind === "open" &&
      (checkout?.kind === "absent" || checkout?.kind === "parked")
        ? { plan: checkout.plan, branch: checkout.branch, head: pull.head }
        : null,
    tryLocally: (folder) =>
      write("try", ({ root, pull, head }) =>
        repositories.tryPullRequest(root, pull, head, folder),
      ),
    update: () => move(false),
    replace: () => move(true),
    remove: () => {
      if (held)
        void write("remove", ({ root, pull, head }) =>
          repositories.removePullRequest(root, pull, head, held.tip),
        );
    },
    showInHistory: () => {
      if (!held || root === null) return;
      const commonDir = (of: RepositoryRoot) => {
        const state = overview.roots.get(of);
        return state?.kind === "open" ? state.commonDir : null;
      };
      const shared =
        historyRoot !== null &&
        commonDir(root) !== null &&
        commonDir(historyRoot) === commonDir(root);
      nav.showBranch(shared ? historyRoot : root, {
        reference: held.branch,
        oid: held.tip,
      });
      focus.refocusIfLost();
    },
    reread: askRead,
    dismiss: () => {
      if (key !== null) change(key, (was) => ({ ...was, said: null }));
    },
    local: localDelete(checkout, branches),
    deleteLocal: async (branch) => {
      if (root === null) return null;
      const finish = beginDraftTask();
      if (!finish) return busyProblem;
      try {
        const { head } = await repositories.refs(root);
        await repositories.write(
          root,
          { kind: "deleteBranch", branch },
          { head },
        );
        return null;
      } catch (error) {
        return problemFrom(error);
      } finally {
        finish();
        loop.rereadRefs(root);
        askRead();
      }
    },
  };
}
