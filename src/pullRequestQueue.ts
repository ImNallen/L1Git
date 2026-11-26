import type { PullRequestList } from "./domain/pullRequest";
import type { ListedRepository } from "./domain/pullRequestList";

export type ListRequest = {
  repository: ListedRepository;
  list: PullRequestList;
};
export type DetailRequest = { repository: ListedRepository; number: number };
export type ReadRequest = ListRequest | DetailRequest;

const keyOf = (request: ReadRequest) =>
  `${request.repository.key} ${"list" in request ? request.list : request.number}`;

/** GitHub limits how much work one account asks of it at once. */
const atOnce = 4;

/**
 * Runs at most four reads at a time, in the order they were asked. The first
 * one runs alone, so a locked keychain asks once. `read` answers whether the
 * keychain let it through. While it has not, the rest are dropped instead of
 * asking again, except a write's reread, which waits for the next read.
 */
export function createReadQueue(
  read: (request: ReadRequest) => Promise<boolean>,
) {
  const waiting = new Map<string, ReadRequest>();
  const running = new Set<string>();
  /** Running reads to ask once more when they end. */
  const again = new Map<string, ReadRequest>();
  let unlocked = false;

  function first(request: ReadRequest) {
    const rest = [...waiting.values()];
    waiting.clear();
    add([request, ...rest]);
  }

  function add(requests: readonly ReadRequest[]) {
    for (const request of requests) {
      const key = keyOf(request);
      if (!running.has(key)) waiting.set(key, request);
    }
    pump();
  }

  function pump() {
    for (const [key, request] of waiting) {
      if (running.size >= (unlocked ? atOnce : 1)) return;
      waiting.delete(key);
      running.add(key);
      void read(request).then((passed) => {
        running.delete(key);
        unlocked = passed;
        const more = again.get(key);
        again.delete(key);
        if (!passed) {
          waiting.clear();
          // A write's reread still has to happen, after the next read gets
          // past the keychain.
          if (more) waiting.set(key, more);
        } else if (more) first(more);
        else pump();
      });
    }
  }

  return {
    add,
    /**
     * Ahead of everything that waits, for what the user is looking at. With
     * `again`, a read of it that already runs is asked once more when it
     * ends, so the answer is to a question asked after now, as a write's
     * reread needs.
     */
    addFirst(request: ReadRequest, options?: { again: boolean }) {
      if (options?.again && running.has(keyOf(request)))
        again.set(keyOf(request), request);
      else first(request);
    },
    waits: (request: ReadRequest) => waiting.has(keyOf(request)),
    /** Running reads finish, and the rest never start. */
    close: () => {
      waiting.clear();
      again.clear();
    },
  };
}
