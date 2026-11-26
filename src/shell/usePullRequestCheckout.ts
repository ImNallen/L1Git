import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { beginDraftTask } from "../draftProtection";
import { pullHead } from "../domain/pullRequestCheckout";
import type {
  HeldCheckout,
  Plan,
  PullCheckout,
  PullHead,
  PullKey,
} from "../domain/pullRequestCheckout";
import { problemFrom } from "../domain/repository";
import type { FullRef, Problem, RepositoryRoot } from "../domain/repository";
import type { OverviewView } from "../overview";
import * as repositories from "../repositories";
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

export type CheckoutSaid =
  | { kind: "failed"; write: Exclude<CheckoutWrite, "try">; problem: Problem }
  | { kind: "trouble"; problem: Problem };

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
  offer: { plan: Plan; branch: FullRef; head: PullHead } | null;
  tryLocally: (folder: string) => Promise<TryOutcome>;
  update: () => void;
  replace: () => void;
  remove: () => void;
  showInHistory: () => void;
  dismiss: () => void;
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
  loop,
  nav,
  focus,
}: {
  opened: OpenedPullRequest | null;
  screen: Pick<ScreenState, "place">;
  overview: Pick<OverviewView, "roots">;
  historyRoot: RepositoryRoot | null;
  saved: Pick<WorkspaceApi, "keepRepository">;
  loop: Pick<WriteLoop, "rereadRefs">;
  nav: Pick<Navigation, "jumpTo" | "sidebar">;
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
  const turn = useRef(0);
  const writing = useRef(false);
  const rereadAfterWrite = useRef(false);
  const [asked, setAsked] = useState(0);
  const askRead = () => setAsked((count) => count + 1);

  const change = (of: string | null, next: (copy: Copy) => Copy) => {
    if (of !== current.current) return;
    setStored((previous) => next(previous.key === of ? previous : fresh(of)));
  };

  const read = useEffectEvent(() => {
    if (writing.current) rereadAfterWrite.current = true;
    if (at === null || writing.current) return;
    const mine = ++turn.current;
    const of = key;
    repositories.pullCheckout(at.root, at.pull, at.head).then(
      (checkout) => {
        if (mine === turn.current)
          change(of, (was) => ({ ...was, known: { kind: "read", checkout } }));
      },
      (error: unknown) => {
        if (mine === turn.current)
          change(of, (was) => ({
            ...was,
            known: { kind: "unreadable", problem: problemFrom(error) },
          }));
      },
    );
  });
  const headOid = head?.oid ?? null;
  useEffect(() => {
    if (visit !== null) read();
  }, [visit, root, headOid, asked]);
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

  async function write(
    kind: CheckoutWrite,
    run: (target: {
      root: RepositoryRoot;
      pull: PullKey;
      head: PullHead;
    }) => Promise<PullCheckout>,
  ): Promise<TryOutcome> {
    if (at === null || writing.current) return { kind: "busy" };
    const finish = beginDraftTask();
    if (!finish) return { kind: "busy" };
    writing.current = true;
    turn.current += 1;
    const of = key;
    const before = copy.known;
    change(of, (was) => ({ ...was, running: kind, said: null }));
    try {
      const checkout = await run(at);
      if (kind === "try" && checkout.kind === "ready")
        saved.keepRepository({
          root: checkout.worktree.root,
          name: checkout.worktree.name,
        });
      if (
        before.kind === "read" &&
        before.checkout.kind === "ready" &&
        (checkout.kind !== "ready" ||
          checkout.worktree.root !== before.checkout.worktree.root)
      )
        nav.sidebar.onRemove(before.checkout.worktree.root);
      const trouble =
        checkout.kind === "ready" ? checkout.worktree.trouble : null;
      change(of, (was) => ({
        ...was,
        known: { kind: "read", checkout },
        running: null,
        said: trouble && { kind: "trouble", problem: trouble },
      }));
      return { kind: "ready" };
    } catch (error) {
      const problem = problemFrom(error);
      change(of, (was) => ({
        ...was,
        running: null,
        said: kind === "try" ? null : { kind: "failed", write: kind, problem },
      }));
      rereadAfterWrite.current = true;
      return { kind: "failed", problem };
    } finally {
      writing.current = false;
      if (rereadAfterWrite.current) {
        rereadAfterWrite.current = false;
        askRead();
      }
      finish();
      loop.rereadRefs(at.root);
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
  return {
    known,
    running: copy.running,
    said: copy.said,
    offer:
      pull?.state.kind === "open" &&
      head &&
      (checkout?.kind === "absent" || checkout?.kind === "parked")
        ? { plan: checkout.plan, branch: checkout.branch, head }
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
      nav.jumpTo(shared ? historyRoot : root, {
        reference: held.branch,
        oid: held.tip,
      });
      focus.refocusIfLost();
    },
    dismiss: () => change(key, (was) => ({ ...was, said: null })),
  };
}
