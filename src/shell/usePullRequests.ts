import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import type { PullRequestList } from "../domain/pullRequest";
import {
  initialChoices,
  listModel,
  listOf,
  noFilters,
  notices,
  savedRepositories,
  waiting,
} from "../domain/pullRequestList";
import type {
  Choices,
  ListModel,
  Notice,
  ReadOf,
  SavedRepositories,
} from "../domain/pullRequestList";
import type { RecentRepository } from "../domain/recents";
import type { FetchInterval } from "../fetchSettings";
import type { Host } from "../host";
import type { OverviewView } from "../overview";
import { createReadQueue } from "../pullRequestQueue";
import type { ListRequest } from "../pullRequestQueue";
import { createPullRequests, signIn } from "../pullRequests";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { Focus } from "./useFocus";
import type { Layout } from "./useLayout";
import type { ScreenState } from "./useScreen";

const FOCUS_REFRESH_MS = 60_000;

export type PullRequestsState = {
  saved: SavedRepositories;
  model: ListModel;
  notices: readonly Notice[];
  choices: Choices;
  choose: (choices: Partial<Choices>) => void;
  clearFilters: () => void;
  reading: boolean;
  /** Null while there is no sign-in to read with. */
  refresh: (() => void) | null;
  /** Null until a list was read, so nothing claims that nobody waits. */
  waiting: number | null;
  /** The sidebar's way in and back. */
  entryRef: RefObject<HTMLButtonElement | null>;
  actions: ActionSlice<
    never,
    "showPullRequests" | "showHistory" | "searchPullRequests"
  >;
};

/**
 * The pull requests of every saved repository on GitHub. Nothing is read before
 * the first visit, because a read may open the system keychain. After it the
 * open lists stay fresh wherever the user is, so the sidebar's count is true.
 */
export function usePullRequests({
  host,
  entries,
  overview,
  intervalMinutes,
  screen: { place, goTo },
  focus: { pullRequestsRef },
  layout: { sidebarOpen, sidebarToggleRef },
}: {
  host: Host;
  entries: readonly RecentRepository[];
  overview: OverviewView;
  intervalMinutes: FetchInterval;
  screen: Pick<ScreenState, "place" | "goTo">;
  focus: Pick<Focus, "pullRequestsRef">;
  layout: Pick<Layout, "sidebarOpen" | "sidebarToggleRef">;
}): PullRequestsState {
  const [{ lists }] = useState(() => createPullRequests(host));
  const look = useSyncExternalStore(lists.subscribe, lists.read);
  const [visited, setVisited] = useState(false);
  const [choices, setChoices] = useState(initialChoices);
  const [, passMinute] = useReducer((minutes: number) => minutes + 1, 0);
  const entryRef = useRef<HTMLButtonElement>(null);
  const refreshedAt = useRef(0);

  const shown = place === "pullRequests";
  const account = signIn(host.status);
  const mergedShown = shown && listOf(choices.view) === "recentlyMerged";
  const saved = useMemo(
    () => savedRepositories(entries, overview),
    [entries, overview],
  );
  const { listed } = saved;
  const readOf: ReadOf = useCallback(
    (repository, list) => look({ repository: repository.github, list }),
    [look],
  );
  // A new sign-in starts over, so it never waits for a read of the last one.
  const queue = useMemo(
    () => ({
      account,
      ...createReadQueue(async ({ repository, list }) => {
        const request = { repository: repository.github, list };
        await lists.refresh(request);
        return lists.read()(request).problem?.kind !== "keychain";
      }),
    }),
    [account, lists],
  );

  const requests = (list: PullRequestList): ListRequest[] =>
    listed.map((repository) => ({ repository, list }));
  const wanted = [
    ...(mergedShown ? requests("recentlyMerged") : []),
    ...requests("open"),
  ];
  function refresh() {
    if (account === null) return;
    refreshedAt.current = Date.now();
    queue.add(wanted);
  }

  const reads = wanted.map(({ repository, list }) => readOf(repository, list));
  const refreshInBackground = useEffectEvent(() => {
    const limited = reads.some(
      ({ problem }) =>
        problem?.kind === "rateLimited" &&
        (problem.resetAt ?? 0) * 1_000 > Date.now(),
    );
    if (!limited) refresh();
  });
  const readUnread = useEffectEvent(() => {
    if (
      account === null ||
      reads.some(({ problem }) => problem?.kind === "keychain")
    )
      return;
    const unread = wanted.filter((_, index) => {
      const read = reads[index];
      return read?.value === null && read.problem === null && !read.reading;
    });
    if (unread.length > 0) refreshedAt.current = Date.now();
    queue.add(unread);
  });
  const refreshOnFocus = useEffectEvent(() => {
    if (Date.now() - refreshedAt.current >= FOCUS_REFRESH_MS)
      refreshInBackground();
  });

  const readMerged = useEffectEvent(() => {
    if (account !== null) queue.add(requests("recentlyMerged"));
  });

  useEffect(() => {
    if (shown) refreshInBackground();
  }, [shown]);
  useEffect(() => {
    if (mergedShown) readMerged();
  }, [mergedShown]);
  useEffect(() => {
    if (visited) readUnread();
  }, [visited, queue, listed]);
  useEffect(() => {
    if (!visited) return;
    const focused = () => refreshOnFocus();
    window.addEventListener("focus", focused);
    return () => window.removeEventListener("focus", focused);
  }, [visited]);
  useEffect(() => {
    if (!visited || intervalMinutes === 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshInBackground();
    }, intervalMinutes * 60_000);
    return () => window.clearInterval(timer);
  }, [visited, intervalMinutes]);
  useEffect(() => {
    if (!shown) return;
    const timer = window.setInterval(passMinute, 60_000);
    return () => window.clearInterval(timer);
  }, [shown]);

  const choose = (next: Partial<Choices>) =>
    setChoices((current) => ({ ...current, ...next }));
  return {
    saved,
    model: useMemo(
      () => listModel(listed, readOf, choices),
      [listed, readOf, choices],
    ),
    notices: useMemo(
      () => notices(listed, readOf, choices),
      [listed, readOf, choices],
    ),
    choices,
    choose,
    clearFilters: () =>
      choose({
        ...noFilters,
        unchecked: listed.every(({ key }) => choices.unchecked.has(key))
          ? new Set()
          : choices.unchecked,
      }),
    reading: reads.some(({ reading }) => reading),
    refresh: account === null ? null : refresh,
    waiting: useMemo(() => waiting(listed, readOf), [listed, readOf]),
    entryRef,
    actions: defineSlice({
      context: {},
      commands: {
        showPullRequests: () => {
          flushSync(() => {
            setVisited(true);
            goTo("pullRequests");
          });
          pullRequestsRef.current?.focus();
        },
        showHistory: () => {
          flushSync(() => goTo("repository"));
          (sidebarOpen ? entryRef : sidebarToggleRef).current?.focus();
        },
        searchPullRequests: () => pullRequestsRef.current?.search(),
      },
    }),
  };
}
