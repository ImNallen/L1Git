import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { beginDraftTask } from "../draftProtection";
import type { Anchor, DraftKey } from "../domain/drafts";
import type { PullWrite } from "../domain/pullRequestWrites";
import type { GitHubRepository, Oid } from "../domain/repository";
import { createDrafts } from "../drafts";
import type { DraftsOf } from "../drafts";
import type { Host } from "../host";
import type { createPullRequests } from "../pullRequests";
import { createPullRequestWrites } from "../pullRequestWrites";
import type { PullOf } from "../pullRequestWrites";

/** The review drafts and the writes to GitHub of one sign-in. */
export type PullWriting = {
  drafts: ReturnType<typeof createDrafts>;
  writes: ReturnType<typeof createPullRequestWrites>;
};

/** How often a window reads drafts.json while it shows a write as sending. */
const AGAIN_MS = 5_000;
const quiet = () => () => {};

/** An opened pull request, as the screens that write to it see it. */
type OpenedWriting = {
  writing: PullWriting;
  viewer: string;
  repository: { github: GitHubRepository };
  number: number;
};

/**
 * New stores for each sign-in, and none while signed out, so one account
 * never sees another's drafts or writes. Waiting drafts save when the window
 * loses focus, when it closes, and when the sign-in changes.
 */
export function usePullWriting({
  host: { ask, read, subscribe, write, sendAgain },
  details,
  account,
  reread,
  opened,
}: {
  host: Pick<Host, "ask" | "read" | "subscribe" | "write" | "sendAgain">;
  details: ReturnType<typeof createPullRequests>["details"];
  /** `signIn` of the host's status. */
  account: string | null;
  reread: (pull: PullOf) => void;
  opened: DraftsOf | null;
}): PullWriting | null {
  // A write's answer may come after the render that sent it.
  const rereadNow = useRef(reread);
  useEffect(() => {
    rereadNow.current = reread;
  });
  const writing = useMemo(() => {
    if (account === null) return null;
    const host = { ask, read, subscribe, write, sendAgain };
    const drafts = createDrafts(host);
    const writes = createPullRequestWrites({
      host,
      details,
      reread: (pull) => rereadNow.current(pull),
      drafts,
      task: beginDraftTask,
    });
    return { drafts, writes };
  }, [account, ask, read, subscribe, write, sendAgain, details]);

  useEffect(() => {
    if (writing === null) return;
    const flush = () => void writing.drafts.flush();
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [writing]);

  const load = useEffectEvent(() => {
    if (writing && opened) void writing.drafts.load(opened);
  });
  const openedId =
    opened &&
    `${opened.login} ${opened.repository.owner}/${opened.repository.repo}#${opened.number}`;
  useEffect(() => {
    if (openedId === null) return;
    load();
    const focused = () => load();
    window.addEventListener("focus", focused);
    return () => window.removeEventListener("focus", focused);
  }, [writing, openedId]);
  // Only drafts.json tells this window that another one's write ended.
  const sending = useSyncExternalStore(
    writing?.drafts.subscribe ?? quiet,
    () =>
      writing !== null &&
      opened !== null &&
      writing.drafts.read(opened).sent.some(({ sending }) => sending),
  );
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(load, AGAIN_MS);
    return () => clearInterval(timer);
  }, [sending, writing, openedId]);
  return writing;
}

/** The opened pull request's drafts, and the ways to change them. */
export function usePullDrafts({
  writing: { drafts },
  viewer,
  repository,
  number,
}: OpenedWriting) {
  const of: DraftsOf = { login: viewer, repository: repository.github, number };
  const view = useSyncExternalStore(drafts.subscribe, () => drafts.read(of));
  return {
    ...view,
    type: (anchor: Anchor, head: Oid, text: string) =>
      drafts.type(of, anchor, head, text),
    held: (anchor: Anchor, head: Oid) => drafts.held(of, anchor, head),
    remove: (anchor: Anchor, head: Oid) => drafts.remove(of, anchor, head),
    flush: () => drafts.flush(of),
    settle: (key: DraftKey, pick: "mine" | "theirs") =>
      drafts.settle(of, key, pick),
  };
}

/** The opened pull request's writes, and the ways to send them. */
export function usePullWrites({
  writing: { drafts, writes },
  viewer,
  repository,
  number,
}: OpenedWriting) {
  const pull: PullOf = { repository: repository.github, number };
  const attempts = useSyncExternalStore(writes.subscribe, () =>
    writes.attempts(pull),
  );
  return {
    attempts,
    /** Saves the drafts it carries first, so they go as the host keeps them. */
    send: async (
      write: PullWrite,
      carried: readonly { anchor: Anchor; head: Oid }[] = [],
    ) => {
      if (carried.length > 0) await drafts.flush({ login: viewer, ...pull });
      return writes.send(pull, write, carried);
    },
    sendAnyway: (id: string) => writes.sendAnyway(pull, id),
    keep: (id: string) => writes.keep(pull, id),
    dismiss: (id: string) => writes.dismiss(pull, id),
  };
}
