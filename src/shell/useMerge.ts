import { useState } from "react";
import { z } from "zod";
import { shownBox } from "../domain/mergeBox";
import type { MergeProgress } from "../domain/mergeBox";
import type { PullRequest } from "../domain/pullRequest";
import { mergeChoices } from "../domain/pullRequestMerge";
import type {
  LocalDelete,
  MergeMethod,
  MergeWrite,
} from "../domain/pullRequestMerge";
import type { BranchTip, Problem } from "../domain/repository";
import { relativeTime } from "../domain/time";
import { browserStorage, readStored, writeStored } from "../persisted";
import type { Attempt } from "../pullRequestWrites";
import type { PullRequestCheckout } from "./usePullRequestCheckout";
import type { OpenedPullRequest } from "./usePullRequests";
import { usePullWrites } from "./usePullWriting";

const LAST_KEY = "l1git.mergeMethod.v1";
const methodSchema = z.enum(["merge", "squash", "rebase"]);
/** An entry L1 Git can't read drops only itself, so one repository's bad
 * entry doesn't take every other repository's method with it. */
const lastSchema = z.record(z.string(), z.unknown()).transform((saved) =>
  Object.fromEntries(
    Object.entries(saved).flatMap(([key, value]) => {
      const method = methodSchema.safeParse(value);
      return method.success ? [[key, method.data] as const] : [];
    }),
  ),
);

const savedMethods = () =>
  readStored(browserStorage(), LAST_KEY, lastSchema) ?? {};

const lastUsed = (repository: string): MergeMethod | null =>
  savedMethods()[repository] ?? null;

function rememberMethod(repository: string, method: MergeMethod) {
  writeStored(
    browserStorage(),
    LAST_KEY,
    { ...savedMethods(), [repository]: method },
    "",
  );
}

function progressOf(attempt: Attempt | undefined): MergeProgress {
  if (attempt === undefined || attempt.write.kind !== "merge")
    return { kind: "idle" };
  const { state, write } = attempt;
  switch (state.kind) {
    case "sending":
      return { kind: "sending", method: write.method };
    case "done":
      return {
        kind: "done",
        commit: state.echo.kind === "merged" ? state.echo.commit : null,
      };
    case "unknown":
      return { kind: "unknown", kept: state.kept };
    case "refused":
      return {
        kind: "refused",
        message: state.message,
        expectedHead: write.expectedHead,
      };
    case "notSent":
    case "notLanded":
      return state;
  }
}

/** What the popover asks for once the user confirms. */
export type MergeAsk = {
  write: MergeWrite;
  /** The head branch to delete on GitHub after it merged. */
  remote: string | null;
  local: BranchTip | null;
};

/** What happened to a branch L1 Git deleted after a merge. */
type Note = { text: string; failed: boolean };

const unsent = {
  busy: "another write for this pull request was still sending",
  unsaved: "a draft it carries wasn't saved",
  signedOut: "L1 Git isn't signed in to GitHub",
  restarting: "L1 Git is restarting to update",
  notInRead: "its latest read of this pull request doesn't match the merge",
};

/**
 * The opened pull request's merge: what the box shows, and the merge with the
 * branch deletions the user asked for, which run only once GitHub answered
 * that it merged. A merge that ends any other way, an unknown one that a read
 * later finds merged included, deletes nothing, and the box offers the head
 * branch's delete for the user to send.
 */
export function useMerge(
  opened: OpenedPullRequest,
  checkout: Pick<PullRequestCheckout, "local" | "deleteLocal">,
) {
  const { writing, viewer, repository, number, read } = opened;
  const writes = usePullWrites(opened);
  const pull = read.value;
  const [chosen, setChosen] = useState<MergeMethod | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** A merge L1 Git never saw end, with the head branch the user asked it to
   * delete once it did. */
  const [leftOnGitHub, setLeftOnGitHub] = useState<{
    write: MergeWrite;
    branch: string;
  } | null>(null);
  // The GitHub is part of the key, so one GitHub's owner/repo can't take
  // over another's. Only github.com is read today.
  const methodKey =
    `github.com/${repository.github.owner}/${repository.github.repo}`.toLowerCase();
  const lastMerge = writes.attempts.findLast(
    ({ write }) => write.kind === "merge",
  );
  const lastDelete = writes.attempts.findLast(
    ({ write }) => write.kind === "deleteHeadBranch",
  );
  const progress = progressOf(lastMerge);
  const local: LocalDelete = deleting ? { kind: "none" } : checkout.local;

  async function deleteLocal(branch: BranchTip) {
    setDeleting(true);
    setNote(null);
    const problem: Problem | null = await checkout.deleteLocal(branch);
    const name = branch.reference.replace(/^refs\/heads\//, "");
    setNote(
      problem
        ? { text: problem.message, failed: true }
        : {
            text: `Deleted ${name} on this computer. Undo brings it back.`,
            failed: false,
          },
    );
    setDeleting(false);
  }

  function deleteOnGitHub(write: MergeWrite, branch: string) {
    void writes
      .send({
        kind: "deleteHeadBranch",
        pull: write.pull,
        branch,
        expectedHead: write.expectedHead,
      })
      .then((started) => {
        if (started !== "started")
          setNote({
            text: `L1 Git didn't delete ${branch} on GitHub, because ${unsent[started]}.`,
            failed: true,
          });
      });
  }

  /** Waits outside React for the merge's answer, so the deletions run even
   * after the user leaves the pull request. */
  function afterMerge(write: MergeWrite, ask: MergeAsk) {
    const of = { repository: repository.github, number };
    const id = writing.writes
      .attempts(of)
      .findLast((attempt) => attempt.write === write)?.id;
    if (id === undefined) return;
    const stop = writing.writes.subscribe(() => {
      const attempt = writing.writes
        .attempts(of)
        .find((each) => each.id === id);
      if (attempt?.state.kind === "sending") return;
      stop();
      if (attempt?.state.kind !== "done") {
        // A merge whose answer was lost deletes nothing, so the branch the
        // user asked for stays on GitHub until they ask for it again.
        if (ask.remote !== null && attempt?.state.kind === "unknown")
          setLeftOnGitHub({ write, branch: ask.remote });
        return;
      }
      rememberMethod(methodKey, write.method);
      queueMicrotask(() => {
        if (ask.remote !== null) deleteOnGitHub(write, ask.remote);
        if (ask.local !== null) void deleteLocal(ask.local);
      });
    });
  }

  const headLeft =
    pull !== null && pull.head.ref !== null ? leftOnGitHub : null;
  const box =
    pull &&
    shownBox(
      pull,
      viewer,
      (at) => relativeTime(Date.parse(at) / 1_000),
      progress,
      local,
      headLeft?.branch ?? null,
    );
  const choices = pull && mergeChoices(pull, lastUsed(methodKey));
  return {
    box,
    progress,
    /** The method the box's button merges with. */
    method: chosen ?? choices?.chosen ?? null,
    choose: setChosen,
    lastUsed: () => lastUsed(methodKey),
    notes: [
      ...(lastDelete ? deletionNote(lastDelete, pull) : []),
      ...(note ? [note] : []),
    ],
    async merge(ask: MergeAsk) {
      const started = await writes.send(ask.write);
      if (started === "started") {
        setChosen(null);
        setNote(null);
        setLeftOnGitHub(null);
        afterMerge(ask.write, ask);
      }
      return started;
    },
    retry: () => {
      if (lastMerge) writes.dismiss(lastMerge.id);
    },
    deleteRemote: () => {
      if (headLeft === null) return;
      setLeftOnGitHub(null);
      deleteOnGitHub(headLeft.write, headLeft.branch);
    },
    deleteLocal: () => {
      if (local.kind === "offer") void deleteLocal(local.branch);
    },
    dismissNotes: () => {
      setNote(null);
      if (lastDelete) writes.dismiss(lastDelete.id);
    },
  };
}

function deletionNote(attempt: Attempt, pull: PullRequest | null): Note[] {
  if (attempt.write.kind !== "deleteHeadBranch") return [];
  const { branch } = attempt.write;
  const { state } = attempt;
  switch (state.kind) {
    case "sending":
      return [{ text: `Deleting ${branch} on GitHub…`, failed: false }];
    case "done":
      return pull?.head.ref === null
        ? []
        : [{ text: `Deleted ${branch} on GitHub.`, failed: false }];
    case "unknown":
      return [
        {
          text: `L1 Git can't tell yet whether GitHub deleted ${branch}.`,
          failed: true,
        },
      ];
    case "refused":
    case "notSent":
    case "notLanded":
      return [{ text: state.message, failed: true }];
  }
}
