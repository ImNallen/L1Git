import { draftKey } from "../domain/drafts";
import type {
  Anchor,
  Draft,
  DraftChange,
  PullDrafts,
  SentWrite,
  Waiting,
} from "../domain/drafts";
import type { Oid } from "../domain/repository";

const MOST_DRAFTS = 100;
const MOST_PULLS = 100;

/** A write the host keeps in drafts.json, and whether the fake GitHub has
 * it: "later" when it heard the write and shows it only after
 * `applyLater`. */
export type FakeSent = SentWrite & { applied: boolean | "later" };

/** drafts.json, by login and `pullKey`. */
export type Shelf = {
  drafts: Map<string, Draft[]>;
  sent: Map<string, FakeSent[]>;
  waiting: Map<string, Waiting[]>;
};

export function viewOf(
  shelf: Shelf,
  pull: string,
  refused: PullDrafts["refused"] = null,
): PullDrafts {
  return {
    drafts: shelf.drafts.get(pull) ?? [],
    refused,
    setAside: null,
    sent: (shelf.sent.get(pull) ?? []).map(
      ({ attempt, at, write, drafts, sending }) => ({
        attempt,
        at,
        write,
        drafts,
        sending,
      }),
    ),
    waiting: shelf.waiting.get(pull) ?? [],
  };
}

const at =
  (anchor: Anchor, head: Oid) => (draft: Pick<Draft, "anchor" | "head">) =>
    draftKey(draft.anchor, draft.head) === draftKey(anchor, head);

function unwait(shelf: Shelf, pull: string, anchor: Anchor, head: Oid) {
  shelf.waiting.set(
    pull,
    (shelf.waiting.get(pull) ?? []).filter(
      (waiting) => !at(anchor, head)(waiting),
    ),
  );
}

/** A write that carried `carried` ended, as waiting.rs's `ended`. */
function ended(shelf: Shelf, pull: string, carried: readonly Draft[]) {
  const now = Date.now();
  for (const draft of carried) {
    const waiting = (shelf.waiting.get(pull) ?? []).find(
      (each) => at(draft.anchor, draft.head)(each) && each.on === draft.savedAt,
    );
    if (!waiting) continue;
    unwait(shelf, pull, waiting.anchor, waiting.head);
    const drafts = shelf.drafts.get(pull) ?? [];
    const kept = drafts.find(at(waiting.anchor, waiting.head));
    const { anchor, head, text } = waiting;
    shelf.drafts.set(
      pull,
      kept
        ? drafts.map((each) =>
            each === kept
              ? {
                  ...kept,
                  head,
                  text,
                  writtenAt: now,
                  savedAt: Math.max(now, kept.savedAt + 1),
                }
              : each,
          )
        : [
            ...drafts,
            {
              anchor,
              head,
              text,
              writtenAt: now,
              savedAt: now,
              mayHavePosted: false,
            },
          ],
    );
  }
}

/** GitHub has a write the host kept, as drafts.rs's `landed`. */
export function landed(shelf: Shelf, pull: string, record: FakeSent) {
  shelf.sent.set(
    pull,
    (shelf.sent.get(pull) ?? []).filter((sent) => sent !== record),
  );
  ended(shelf, pull, record.drafts);
}

/** Gives a write's drafts back to typing, as drafts.rs's `give_back`. */
export function giveBack(
  shelf: Shelf,
  pull: string,
  attempt: string,
  mayHavePosted: boolean,
) {
  const records = shelf.sent.get(pull) ?? [];
  const record = records.find((sent) => sent.attempt === attempt);
  if (!record) return;
  shelf.sent.set(
    pull,
    records.filter((sent) => sent !== record),
  );
  shelf.drafts.set(pull, [
    ...(shelf.drafts.get(pull) ?? []),
    ...record.drafts.map((draft) => ({
      ...draft,
      mayHavePosted: draft.mayHavePosted || mayHavePosted,
    })),
  ]);
  ended(shelf, pull, record.drafts);
}

/** The host's drafts op for one pull request, by drafts.rs's rules. */
export function draftsHandler(
  pull: string,
  change: DraftChange,
  shelf: Shelf,
): PullDrafts {
  const drafts = shelf.drafts.get(pull) ?? [];
  const answer = (refused: PullDrafts["refused"] = null) =>
    viewOf(shelf, pull, refused);
  if (change.kind === "read") return answer();
  if (change.kind === "forget") {
    unwait(shelf, pull, change.anchor, change.head);
    return answer();
  }
  if (change.kind === "keep") {
    const record = shelf.sent
      .get(pull)
      ?.find(({ attempt }) => attempt === change.attempt);
    if (record?.sending) return answer({ kind: "sending" });
    giveBack(shelf, pull, change.attempt, true);
    return answer();
  }
  const found = drafts.find(at(change.anchor, change.head));
  if (change.kind === "delete") {
    if (found && found.savedAt !== change.at) return answer({ kind: "stale" });
    shelf.drafts.set(
      pull,
      drafts.filter((draft) => draft !== found),
    );
    unwait(shelf, pull, change.anchor, change.head);
    return answer();
  }
  const held = (shelf.sent.get(pull) ?? []).some(({ drafts }) =>
    drafts.some(at(change.anchor, change.head)),
  );
  if (held) {
    unwait(shelf, pull, change.anchor, change.head);
    const { anchor, head, text } = change;
    shelf.waiting.set(pull, [
      ...(shelf.waiting.get(pull) ?? []),
      { anchor, head, text, on: change.at },
    ]);
    return answer({ kind: "sent" });
  }
  if ((found?.savedAt ?? null) !== change.at) return answer({ kind: "stale" });
  if (!found && drafts.length >= MOST_DRAFTS)
    return answer({ kind: "full", of: "drafts" });
  const others = [...shelf.drafts].filter(
    ([key, kept]) => key !== pull && kept.length > 0,
  );
  if (drafts.length === 0 && others.length >= MOST_PULLS)
    return answer({ kind: "full", of: "pullRequests" });
  const now = Date.now();
  const { anchor, head, text } = change;
  shelf.drafts.set(
    pull,
    found
      ? drafts.map((draft) =>
          draft === found
            ? {
                ...found,
                head,
                text,
                savedAt: Math.max(now, found.savedAt + 1),
              }
            : draft,
        )
      : [
          ...drafts,
          {
            anchor,
            head,
            text,
            writtenAt: now,
            savedAt: now,
            mayHavePosted: false,
          },
        ],
  );
  unwait(shelf, pull, change.anchor, change.head);
  return answer();
}
