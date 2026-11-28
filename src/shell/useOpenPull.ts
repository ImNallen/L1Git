import { useState } from "react";
import {
  NOT_ON_GITHUB,
  SIGN_IN_FIRST,
  headOf,
  remoteOf,
} from "../domain/openPull";
import type { OpenHead, OpenOffer } from "../domain/openPull";
import type {
  Branch,
  GitHubRepository,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
import type { Host } from "../host";
import { defineSlice } from "./actionSlices";
import type { ActionSlice } from "./actionSlices";
import type { OpenedRepository } from "./sync";
import type { PullRequestsState } from "./usePullRequests";

/** The popover's question: which branch, in which repository on GitHub. */
export type OpenPullAsk = {
  root: RepositoryRoot;
  github: GitHubRepository;
  remote: string;
  login: string;
  head: OpenHead;
  /** The row it opens beside. Null puts it near the top of the window. */
  anchor: HTMLElement | null;
};

/** What the notification says once GitHub opened it. */
export type OpenedPull = {
  root: RepositoryRoot;
  github: GitHubRepository;
  number: number;
  head: string;
  base: string;
};

export type OpenPull = {
  /** The sidebar branch menu's first item, for the repository on screen. */
  sidebar: {
    root: RepositoryRoot;
    offer: (branch: Branch) => OpenOffer;
    onSelect: (branch: Branch, anchor: HTMLElement) => void;
  } | null;
  asking: OpenPullAsk | null;
  close: () => void;
  /** The popover's Done, or a Check GitHub that found it. */
  opened: (pull: OpenedPull) => void;
  /** The pull request's screen. */
  view: (github: GitHubRepository, number: number) => void;
  notice: OpenedPull | null;
  dismissNotice: () => void;
  actions: ActionSlice<"openPullRequest", "openPullRequest">;
};

/** The checked-out branch's row in the sidebar, when it shows. */
const headRow = () =>
  document.querySelector<HTMLElement>(".repository-tree .branch-row.head");

/**
 * Opening a pull request from a branch: the menu item that offers it, the
 * popover it opens, and the notification after. It reads what it shows from
 * the snapshot and the pull request list, and asks GitHub only once the
 * popover opens.
 */
export function useOpenPull({
  host,
  snapshot,
  opened: { repository },
  pulls,
}: {
  host: Pick<Host, "status">;
  snapshot: RepositorySnapshot | null;
  opened: Pick<OpenedRepository, "repository">;
  pulls: Pick<PullRequestsState, "show" | "visited" | "refresh">;
}): OpenPull {
  const [asking, setAsking] = useState<OpenPullAsk | null>(null);
  const [notice, setNotice] = useState<OpenedPull | null>(null);
  const github = repository?.overview.github ?? null;
  const signedIn = host.status?.github;
  const login = signedIn?.kind === "connected" ? signedIn.login : null;
  const remote = snapshot && github ? remoteOf(snapshot.remotes, github) : null;
  const into =
    repository?.overview.branches.find((branch) => branch.role === "default")
      ?.name ?? null;

  function offer(branch: Branch): OpenOffer {
    if (login === null) return SIGN_IN_FIRST;
    if (github === null || remote === null) return NOT_ON_GITHUB;
    const head = headOf(branch, remote);
    if (head === null)
      return {
        kind: "off",
        short: `Not on ${remote}`,
        reason: `${branch.name} is on another remote. A pull request opens from a branch on ${remote}.`,
      };
    if (head.name === into)
      return {
        kind: "off",
        short: "Default branch",
        reason: `${head.name} is the branch pull requests merge into.`,
      };
    return { kind: "open", into };
  }

  function open(branch: Branch, anchor: HTMLElement | null) {
    if (!snapshot || !github || !remote || login === null) return;
    const head = headOf(branch, remote);
    if (head)
      setAsking({ root: snapshot.root, github, remote, login, head, anchor });
  }

  const checkedOut =
    snapshot?.head.kind === "attached"
      ? (snapshot.branches.find(
          (branch) =>
            branch.kind === "local" &&
            snapshot.head.kind === "attached" &&
            branch.reference === snapshot.head.reference,
        ) ?? null)
      : null;
  const paletteOffer = checkedOut && offer(checkedOut);

  return {
    sidebar: snapshot && {
      root: snapshot.root,
      offer,
      onSelect: open,
    },
    asking: asking?.root === snapshot?.root ? asking : null,
    close: () => setAsking(null),
    opened: (pull) => {
      setAsking(null);
      setNotice(pull);
      if (pulls.visited) pulls.refresh?.();
    },
    view: pulls.show,
    notice: notice?.root === snapshot?.root ? notice : null,
    dismissNotice: () => setNotice(null),
    actions: defineSlice({
      context: {
        openPullRequest:
          checkedOut && paletteOffer?.kind === "open"
            ? { branch: checkedOut.name }
            : null,
      },
      commands: {
        openPullRequest: () => {
          if (checkedOut) open(checkedOut, headRow());
        },
      },
    }),
  };
}
