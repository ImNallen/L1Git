import { draftKey } from "../domain/drafts";
import type { Draft, DraftChange, PullDrafts } from "../domain/drafts";

const MOST_DRAFTS = 100;
const MOST_PULLS = 100;

/** The host's drafts op for one pull request, by drafts.rs's rules. */
export function draftsHandler(
  pull: string,
  change: DraftChange,
  books: Map<string, Draft[]>,
): PullDrafts {
  const drafts = books.get(pull) ?? [];
  const answer = (refused: PullDrafts["refused"]): PullDrafts => ({
    drafts: books.get(pull) ?? [],
    refused,
    setAside: null,
  });
  if (change.kind === "read") return answer(null);
  const slot = draftKey(change.anchor, change.head);
  const found = drafts.find(
    (draft) => draftKey(draft.anchor, draft.head) === slot,
  );
  if (change.kind === "delete") {
    if (found && found.savedAt !== change.at) return answer({ kind: "stale" });
    books.set(
      pull,
      drafts.filter((draft) => draft !== found),
    );
    return answer(null);
  }
  if ((found?.savedAt ?? null) !== change.at) return answer({ kind: "stale" });
  if (!found && drafts.length >= MOST_DRAFTS)
    return answer({ kind: "full", of: "drafts" });
  const others = [...books].filter(
    ([key, held]) => key !== pull && held.length > 0,
  );
  if (drafts.length === 0 && others.length >= MOST_PULLS)
    return answer({ kind: "full", of: "pullRequests" });
  const now = Date.now();
  const { anchor, head, text } = change;
  books.set(
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
      : [...drafts, { anchor, head, text, writtenAt: now, savedAt: now }],
  );
  return answer(null);
}
