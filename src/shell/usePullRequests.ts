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
import type {
  PullRequest,
  PullRequestList,
  PullRequestSummary,
} from "../domain/pullRequest";
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
  ListedRepository,
  ListModel,
  Notice,
  ReadOf,
  SavedRepositories,
} from "../domain/pullRequestList";
import type { HostProblem } from "../domain/host";
import type { RecentRepository } from "../domain/recents";
import type { FetchInterval } from "../fetchSettings";
import type { Host } from "../host";
import type { OverviewView } from "../overview";
import { createReadQueue } from "../pullRequestQueue";
import type { DetailRequest, ListRequest } from "../pullRequestQueue";
import { createPullRequests, signIn, unread } from "../pullRequests";
import type { Read } from "../pullRequests";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { Focus } from "./useFocus";
import type { Layout } from "./useLayout";
import { useOpenedReads } from "./useOpenedReads";
import { usePullWriting } from "./usePullWriting";
import type { PullWriting } from "./usePullWriting";
import type { ScreenState } from "./useScreen";

const FOCUS_REFRESH_MS = 60_000;

export type PullRequestTab = "conversation" | "commits" | "files" | "checks";

export type OpenedPullRequest = {
  key: string;
  /** This pull request, as this sign-in reads it. */
  id: string;
  tab: PullRequestTab;
  repository: ListedRepository;
  number: number;
  /** What a list says of it, for as long as one does. */
  summary: PullRequestSummary | null;
  read: Read<PullRequest>;
  /** Whether a fresher read runs, or waits for its turn. */
  isComing: boolean;
  /** Its place among the rows on the list. */
  position: { at: number; of: number } | null;
  /** The login whose reads these are. */
  viewer: string;
  writing: PullWriting;
};

export type PullRequestsState = {
  /** Whether they were ever on screen. */
  visited: boolean;
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
  /** Null while the list shows, and while there is no sign-in. */
  opened: OpenedPullRequest | null;
  open: (pull: DetailRequest) => void;
  showTab: (tab: PullRequestTab) => void;
  /** The sidebar's way in and back. */
  entryRef: RefObject<HTMLButtonElement | null>;
  actions: ActionSlice<
    "pullRequestOpen",
    | "showPullRequests"
    | "showHistory"
    | "searchPullRequests"
    | "closePullRequest"
  >;
};

/** Reads, and answers with what the store then holds. */
async function answered<Request, T>(
  reads: {
    refresh: (request: Request) => Promise<void>;
    read: () => (request: Request) => Read<T>;
  },
  request: Request,
): Promise<Read<T>> {
  await reads.refresh(request);
  return reads.read()(request);
}

function openedOf(
  { repository, number }: DetailRequest,
  viewer: string,
  read: Read<PullRequest>,
  met: HostProblem | null,
  { body }: ListModel,
  readOf: ReadOf,
): Omit<OpenedPullRequest, "id" | "tab" | "isComing" | "writing"> {
  const key = `${repository.key}#${number}`;
  const rows =
    body.kind === "rows" ? body.groups.flatMap((group) => group.rows) : [];
  const at = rows.findIndex((row) => row.key === key) + 1;
  const listed = (list: PullRequestList) =>
    readOf(repository, list).value?.items.find(
      (pull) => pull.number === number,
    );
  return {
    key,
    repository,
    number,
    summary: listed("recentlyMerged") ?? listed("open") ?? null,
    read:
      // A read that a locked keychain or a spent limit keeps back never starts.
      read.value === null && read.problem === null && !read.reading
        ? { ...read, problem: met }
        : read,
    position: at > 0 ? { at, of: rows.length } : null,
    viewer,
  };
}

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
  const [{ lists, details, met }] = useState(() => createPullRequests(host));
  const look = useSyncExternalStore(lists.subscribe, lists.read);
  const lookInto = useSyncExternalStore(details.subscribe, details.read);
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = [lists.subscribe(listener), details.subscribe(listener)];
      return () => stops.forEach((stop) => stop());
    },
    [lists, details],
  );
  const problemMet = useSyncExternalStore(subscribe, met);
  const [asked, setAsked] = useState<DetailRequest | null>(null);
  const [chosen, setChosen] = useState<{
    id: string;
    tab: PullRequestTab;
  } | null>(null);
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
      ...createReadQueue(async (request) => {
        const { repository, ...of } = request;
        const github = { repository: repository.github };
        const { problem } =
          "list" in of
            ? await answered(lists, { ...github, ...of })
            : await answered(details, { ...github, ...of });
        return problem?.kind !== "keychain";
      }),
    }),
    [account, lists, details],
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
  function refreshAll() {
    if (opened) queue.addFirst(opened);
    refresh();
  }

  const github = host.status?.github;
  const viewer = github?.kind === "connected" ? github.login : null;
  // Its repository is no longer saved, or another of its saved clones now
  // comes first, as after its first one was removed.
  const now = asked && listed.find(({ key }) => key === asked.repository.key);
  if (asked !== null && !saved.opening && !now) setAsked(null);
  if (asked !== null && now && now.root !== asked.repository.root)
    setAsked({ ...asked, repository: now });
  const opened = viewer === null ? null : asked;
  const writing = usePullWriting({
    host,
    details,
    account,
    reread: ({ repository, number }) => {
      const key = `${repository.owner}/${repository.repo}`.toLowerCase();
      const listing = listed.find((each) => each.key === key);
      if (listing)
        queue.addFirst({ repository: listing, number }, { again: true });
    },
    opened:
      opened && viewer !== null
        ? {
            login: viewer,
            repository: opened.repository.github,
            number: opened.number,
          }
        : null,
  });
  const id = opened && `${account} ${opened.repository.key}#${opened.number}`;
  const tab = chosen !== null && chosen.id === id ? chosen.tab : "conversation";
  const openedRead = opened
    ? lookInto({ repository: opened.repository.github, number: opened.number })
    : unread;
  const isComing =
    openedRead.reading || (opened !== null && queue.waits(opened));
  const reads = [
    ...wanted.map(({ repository, list }) => readOf(repository, list)),
    openedRead,
  ];
  const problems = [problemMet, ...reads.map(({ problem }) => problem)];
  const limited = () =>
    problems.some(
      (problem) =>
        problem?.kind === "rateLimited" &&
        (problem.resetAt ?? 0) * 1_000 > Date.now(),
    );
  // Asking a locked keychain again takes the user's own step.
  const locked =
    problems.find((problem) => problem?.kind === "keychain") ?? null;
  const keptBack = locked ?? problemMet;
  const refreshOnVisit = useEffectEvent(() => {
    if (!limited()) refresh();
  });
  const refreshInBackground = useEffectEvent(() => {
    if (!limited() && locked === null) refresh();
  });
  const readUnread = useEffectEvent(() => {
    if (account === null || locked !== null || limited()) return;
    const missing = wanted.filter((_, index) => {
      const read = reads[index];
      return read?.value === null && read.problem === null && !read.reading;
    });
    if (missing.length > 0) refreshedAt.current = Date.now();
    queue.add(missing);
  });
  const refreshOnFocus = useEffectEvent(() => {
    if (Date.now() - refreshedAt.current >= FOCUS_REFRESH_MS)
      refreshInBackground();
  });

  const readMerged = useEffectEvent(() => {
    if (account !== null && !limited()) queue.add(requests("recentlyMerged"));
  });

  // Ahead of the list's, so a locked keychain asks for what is on screen.
  useOpenedReads({
    visit: shown ? id : null,
    opened: openedRead,
    read: () => {
      if (opened) queue.addFirst(opened);
    },
    limited,
    locked: locked !== null,
    intervalMinutes,
  });
  useEffect(() => {
    if (shown) refreshOnVisit();
  }, [shown]);
  useEffect(() => () => queue.close(), [queue]);
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

  const choose = (next: Partial<Choices>) => {
    setChoices((current) => ({ ...current, ...next }));
    if (next.view !== undefined) setAsked(null);
  };
  const model = useMemo(
    () => listModel(listed, readOf, choices),
    [listed, readOf, choices],
  );
  return {
    visited,
    saved,
    model,
    notices: useMemo(() => {
      const own = notices(listed, readOf, choices);
      return problemMet === null ||
        own.some(({ kind }) => kind === "connection")
        ? own
        : [...own, { kind: "connection", message: problemMet.message }];
    }, [listed, readOf, choices, problemMet]),
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
    refresh: account === null ? null : refreshAll,
    waiting: useMemo(() => waiting(listed, readOf), [listed, readOf]),
    opened: useMemo(
      () =>
        opened && id !== null && viewer !== null && writing !== null
          ? {
              id,
              tab,
              isComing,
              writing,
              ...openedOf(opened, viewer, openedRead, keptBack, model, readOf),
            }
          : null,
      [
        opened,
        id,
        tab,
        isComing,
        writing,
        viewer,
        openedRead,
        keptBack,
        model,
        readOf,
      ],
    ),
    open: (pull) => {
      flushSync(() => {
        setAsked(pull);
        setChosen(null);
      });
      pullRequestsRef.current?.focus();
    },
    showTab: (tab) => setChosen(id === null ? null : { id, tab }),
    entryRef,
    actions: defineSlice({
      context: { pullRequestOpen: opened !== null },
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
        closePullRequest: () => {
          flushSync(() => setAsked(null));
          pullRequestsRef.current?.focus();
        },
      },
    }),
  };
}
