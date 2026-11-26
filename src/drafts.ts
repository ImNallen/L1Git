import { draftKey, draftText, mostDraftChars, placed } from "./domain/drafts";
import type {
  Anchor,
  Draft,
  DraftChange,
  DraftKey,
  PullDrafts,
  SentWrite,
} from "./domain/drafts";
import type { Carried } from "./domain/host";
import type { GitHubRepository, Oid } from "./domain/repository";
import type { HostClient } from "./host";

/** A crash loses at most this much typing. Saving every keystroke would
 * cross into Rust once per character. */
const SAVE_AFTER_MS = 400;

const fullMessage = {
  drafts:
    "This pull request already has 100 drafts on this computer. Send or delete one to save this.",
  pullRequests:
    "L1 Git keeps drafts for 100 pull requests on this computer. Send or delete the drafts of another pull request to save this.",
};
const waitMessage =
  "A write for this pull request carries the words saved here, so L1 Git saves these once it ends.";

/** One pull request, as one account sees it. */
export type DraftsOf = {
  login: string;
  repository: GitHubRepository;
  number: number;
};

/** What the box's footer says about its words. */
type DraftSave =
  | { kind: "saved" }
  | { kind: "saving" }
  /** The words are still here. The next edit or flush tries again. */
  | { kind: "unsaved"; why: string }
  /** More than GitHub takes, so nothing was sent. The words are only in
   * this window until an edit brings them under `most`. */
  | { kind: "tooLong"; most: number }
  /** Another window changed or deleted this draft after this one read it.
   * Nothing saves until `settle` picks one. */
  | { kind: "changedElsewhere"; theirs: Draft | null };

type ShownDraft = {
  key: DraftKey;
  anchor: Anchor;
  head: Oid;
  text: string;
  /** Null until the host has saved it once. */
  writtenAt: number | null;
  /** A write carried these words and its answer was lost: sending them again
   * may post them twice. */
  mayHavePosted: boolean;
  save: DraftSave;
};

type DraftsView = {
  read:
    | { kind: "unread" }
    | { kind: "ready" }
    | { kind: "unreadable"; why: string };
  drafts: readonly ShownDraft[];
  /** Writes that left, or may have, with the drafts each carried. The host
   * keeps them until their outcome is known. */
  sent: readonly SentWrite[];
  /** Where the host moved an unreadable drafts file, for every pull request,
   * since all of them were in it. */
  setAside: string | null;
};

type Entry = {
  anchor: Anchor;
  head: Oid;
  text: string;
  /** What this window last saw the host hold here. */
  base: Draft | null;
  save: DraftSave;
  /** Typed before this window learned that a write holds the place, on the
   * draft saved at `on`. Once the write ends they save over what it gives
   * back only if it `carried` that same draft; else both stay to pick from. */
  waits: { on: number | null; carried: number | null } | null;
};

type Pull = {
  of: DraftsOf;
  read: DraftsView["read"];
  entries: Map<DraftKey, Entry>;
  timers: Map<DraftKey, ReturnType<typeof setTimeout>>;
  sent: readonly SentWrite[];
  /** The places of the writes this window is sending, before the host's
   * answer lists them in `sent`. */
  holds: Set<Set<DraftKey>>;
  /** Every request for one pull request waits for the one before it. */
  queue: Promise<void>;
  view: DraftsView | null;
};

const saved: DraftSave = { kind: "saved" };
const saving: DraftSave = { kind: "saving" };

const pullId = ({ login, repository, number }: DraftsOf) =>
  `${login} ${repository.owner}/${repository.repo}#${number}`.toLowerCase();

const settled = (draft: Draft): Entry => ({
  anchor: draft.anchor,
  head: draft.head,
  text: draft.text,
  base: draft,
  save: saved,
  waits: null,
});

const isPending = ({ save }: Entry) =>
  save.kind === "saving" || save.kind === "unsaved";

/** The words typed for pull requests and not sent yet, kept by the host on
 * this computer. Typing saves a moment later; `flush` saves now. */
export function createDrafts(host: Pick<HostClient, "ask">) {
  const pulls = new Map<string, Pull>();
  const listeners = new Set<() => void>();
  let setAside: string | null = null;
  let unread: DraftsView = {
    read: { kind: "unread" },
    drafts: [],
    sent: [],
    setAside,
  };

  function pullOf(of: DraftsOf): Pull {
    const id = pullId(of);
    const known = pulls.get(id);
    if (known) return known;
    const pull: Pull = {
      of,
      read: { kind: "unread" },
      entries: new Map(),
      timers: new Map(),
      sent: [],
      holds: new Set(),
      queue: Promise.resolve(),
      view: null,
    };
    pulls.set(id, pull);
    return pull;
  }

  function changed(pull: Pull) {
    pull.view = null;
    listeners.forEach((listener) => listener());
  }

  /** The draft at `key` a write that left, or may have, carries. */
  const carriedAt = (pull: Pull, key: DraftKey) =>
    pull.sent
      .flatMap(({ drafts }) => drafts)
      .find((draft) => draftKey(draft.anchor, draft.head) === key);

  /** Whether a write that left, or may have, carries the draft at `key`. */
  function isHeld(pull: Pull, key: DraftKey) {
    for (const places of pull.holds) if (places.has(key)) return true;
    return carriedAt(pull, key) !== undefined;
  }

  function wait(pull: Pull, key: DraftKey, entry: Entry) {
    entry.save = { kind: "unsaved", why: waitMessage };
    entry.waits ??= {
      on: entry.base?.savedAt ?? null,
      carried: carriedAt(pull, key)?.savedAt ?? null,
    };
  }

  const ask = (pull: Pull, change: DraftChange) =>
    host.ask({ op: "drafts", ...pull.of, change });

  function enqueue(pull: Pull, task: () => Promise<void>) {
    pull.queue = pull.queue.then(task);
    return pull.queue;
  }

  /** Takes what the host holds, except over words this window has not saved. */
  function adopt(pull: Pull, answer: PullDrafts, skip: DraftKey | null) {
    pull.read = { kind: "ready" };
    pull.sent = answer.sent;
    if (answer.setAside) {
      setAside = answer.setAside;
      unread = { ...unread, setAside };
      pulls.forEach((other) => (other.view = null));
    }
    const held = new Map(
      answer.drafts.map((draft) => [draftKey(draft.anchor, draft.head), draft]),
    );
    for (const [key, entry] of pull.entries) {
      if (key === skip || held.has(key)) continue;
      if (entry.save.kind === "saved") pull.entries.delete(key);
      if (entry.save.kind === "changedElsewhere")
        entry.save = { kind: "changedElsewhere", theirs: null };
    }
    for (const [key, draft] of held) {
      const entry = pull.entries.get(key);
      if (key === skip) continue;
      if (!entry || entry.save.kind === "saved")
        pull.entries.set(key, settled(draft));
      else if (entry.save.kind === "changedElsewhere")
        entry.save = { kind: "changedElsewhere", theirs: draft };
    }
    for (const [key, entry] of pull.entries) {
      if (!entry.waits) continue;
      entry.waits.carried =
        carriedAt(pull, key)?.savedAt ?? entry.waits.carried;
      if (isHeld(pull, key)) continue;
      const { on, carried } = entry.waits;
      const theirs = held.get(key) ?? null;
      entry.waits = null;
      if (on === (carried ?? theirs?.savedAt ?? null)) {
        entry.base = theirs;
        entry.save = saving;
        void enqueue(pull, () => save(pull, key));
      } else entry.save = { kind: "changedElsewhere", theirs };
    }
  }

  async function save(pull: Pull, key: DraftKey) {
    const entry = pull.entries.get(key);
    if (!entry || !isPending(entry)) return;
    if (isHeld(pull, key)) {
      wait(pull, key, entry);
      return changed(pull);
    }
    const { anchor, head, text, base } = entry;
    const takes = draftText(text);
    if (takes === "tooLong") {
      entry.save = { kind: "tooLong", most: mostDraftChars };
      return changed(pull);
    }
    let change: DraftChange;
    if (takes === "takes") {
      if (base?.text === text && base.head === head) {
        entry.save = saved;
        return changed(pull);
      }
      change = { kind: "put", anchor, head, text, at: base?.savedAt ?? null };
    } else if (base)
      change = { kind: "delete", anchor, head, at: base.savedAt };
    else {
      pull.entries.delete(key);
      return changed(pull);
    }
    if (entry.save.kind !== "saving") {
      entry.save = saving;
      changed(pull);
    }
    const answer = await ask(pull, change);
    if (pull.entries.get(key) !== entry) return;
    if (!answer.ok) {
      entry.save = { kind: "unsaved", why: answer.problem.message };
      return changed(pull);
    }
    const { data } = answer.reply;
    const theirs =
      data.drafts.find((draft) => draftKey(draft.anchor, draft.head) === key) ??
      null;
    if (data.refused?.kind === "stale")
      entry.save = { kind: "changedElsewhere", theirs };
    else if (data.refused?.kind === "full")
      entry.save = { kind: "unsaved", why: fullMessage[data.refused.of] };
    else if (data.refused?.kind === "sent") wait(pull, key, entry);
    else if (entry.text === text && entry.head === head) {
      if (theirs) pull.entries.set(key, settled(theirs));
      else pull.entries.delete(key);
    } else entry.base = theirs;
    adopt(pull, data, key);
    changed(pull);
  }

  function flushPull(pull: Pull): Promise<boolean> {
    pull.timers.forEach((timer) => clearTimeout(timer));
    pull.timers.clear();
    for (const [key, entry] of pull.entries)
      if (isPending(entry)) void enqueue(pull, () => save(pull, key));
    return pull.queue.then(() =>
      [...pull.entries.values()].every(({ save }) => save.kind === "saved"),
    );
  }

  /** Blank text deletes the draft. "held" changes nothing: a write that
   * left, or may have, carries the words saved here, so the box reads only
   * until it ends. */
  function type(
    of: DraftsOf,
    given: Anchor,
    head: Oid,
    text: string,
  ): "typed" | "held" {
    const anchor = placed(given);
    const pull = pullOf(of);
    const key = draftKey(anchor, head);
    if (isHeld(pull, key)) return "held";
    const entry = pull.entries.get(key) ?? {
      anchor,
      head,
      text,
      base: null,
      save: saved,
      waits: null,
    };
    entry.text = text;
    entry.head = head;
    pull.entries.set(key, entry);
    if (entry.save.kind !== "changedElsewhere") {
      entry.save = saving;
      clearTimeout(pull.timers.get(key));
      pull.timers.set(
        key,
        setTimeout(() => {
          pull.timers.delete(key);
          void enqueue(pull, () => save(pull, key));
        }, SAVE_AFTER_MS),
      );
    }
    changed(pull);
    return "typed";
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The same object until something about this pull request changes. */
    read(of: DraftsOf): DraftsView {
      const pull = pulls.get(pullId(of));
      if (!pull) return unread;
      pull.view ??= {
        setAside,
        read: pull.read,
        sent: pull.sent,
        drafts: [...pull.entries].map(([key, entry]) => ({
          key,
          anchor: entry.anchor,
          head: entry.head,
          text: entry.text,
          writtenAt: entry.base?.writtenAt ?? null,
          mayHavePosted: entry.base?.mayHavePosted ?? false,
          save: entry.save,
        })),
      };
      return pull.view;
    },
    /** Asks the host what it holds, as on opening or focusing the pull
     * request, and keeps any words this window has not saved. */
    load(of: DraftsOf): Promise<void> {
      const pull = pullOf(of);
      return enqueue(pull, async () => {
        const answer = await ask(pull, { kind: "read" });
        if (answer.ok) adopt(pull, answer.reply.data, null);
        else pull.read = { kind: "unreadable", why: answer.problem.message };
        changed(pull);
      });
    },
    type,
    /** Deletes now, as the Delete button and a sent review do. A draft
     * another window changed goes with their words too. */
    remove(of: DraftsOf, anchor: Anchor, head: Oid): Promise<boolean> {
      const pull = pullOf(of);
      const key = draftKey(anchor, head);
      if (isHeld(pull, key)) return Promise.resolve(false);
      const entry = pull.entries.get(key);
      if (entry?.save.kind === "changedElsewhere") {
        entry.base = entry.save.theirs;
        entry.save = saving;
      }
      type(of, anchor, head, "");
      return flushPull(pull);
    },
    /** Saves every waiting draft now, on blur, close and before a submit.
     * True once every draft is saved. */
    async flush(of?: DraftsOf): Promise<boolean> {
      const chosen = of ? [pullOf(of)] : [...pulls.values()];
      const done = await Promise.all(chosen.map(flushPull));
      return done.every(Boolean);
    },
    /** True while a write that left, or may have, carries the draft at this
     * place: until it ends, or the user keeps it as a draft, the box reads
     * only and `type` answers held. */
    held(of: DraftsOf, anchor: Anchor, head: Oid): boolean {
      const pull = pulls.get(pullId(of));
      return pull ? isHeld(pull, draftKey(anchor, head)) : false;
    },
    /** Holds the places a write carries from when this window sends it until
     * the host's answer is taken. Call what it returns to let go. */
    hold(of: DraftsOf, places: readonly { anchor: Anchor; head: Oid }[]) {
      const pull = pullOf(of);
      const held = new Set(
        places.map(({ anchor, head }) => draftKey(anchor, head)),
      );
      pull.holds.add(held);
      changed(pull);
      return () => {
        if (pull.holds.delete(held)) changed(pull);
      };
    },
    /** Takes what a write's answer says the host holds now. */
    adopt(of: DraftsOf, answer: PullDrafts) {
      const pull = pullOf(of);
      adopt(pull, answer, null);
      changed(pull);
    },
    /** How a write carries the draft at `anchor`: as the host saved it. Null
     * while this window has words the host has not saved, so `flush` first. */
    carried(of: DraftsOf, anchor: Anchor, head: Oid): Carried | null {
      const entry = pulls.get(pullId(of))?.entries.get(draftKey(anchor, head));
      if (entry?.save.kind !== "saved" || !entry.base) return null;
      return {
        anchor: entry.base.anchor,
        head: entry.base.head,
        at: entry.base.savedAt,
      };
    },
    /** Keep as draft: the host gives back the drafts of a write that may have
     * posted, marked so, and the pull request is free to write again. False
     * while that write is still sending or the host can't be asked. */
    keep(of: DraftsOf, attempt: string): Promise<boolean> {
      const pull = pullOf(of);
      let kept = false;
      return enqueue(pull, async () => {
        const answer = await ask(pull, { kind: "keep", attempt });
        if (!answer.ok) return;
        adopt(pull, answer.reply.data, null);
        kept = answer.reply.data.refused === null;
        changed(pull);
      }).then(() => kept);
    },
    /** Ends `changedElsewhere`: keep this window's words over theirs, or
     * take theirs. */
    settle(of: DraftsOf, key: DraftKey, pick: "mine" | "theirs") {
      const pull = pullOf(of);
      const entry = pull.entries.get(key);
      if (entry?.save.kind !== "changedElsewhere") return;
      const { theirs } = entry.save;
      if (pick === "mine") {
        entry.base = theirs;
        entry.save = saving;
        void enqueue(pull, () => save(pull, key));
      } else if (theirs) pull.entries.set(key, settled(theirs));
      else pull.entries.delete(key);
      changed(pull);
    },
  };
}
