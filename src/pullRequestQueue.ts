import type { PullRequestList } from "./domain/pullRequest";
import type { ListedRepository } from "./domain/pullRequestList";

export type ListRequest = {
  repository: ListedRepository;
  list: PullRequestList;
};

const keyOf = ({ repository, list }: ListRequest) =>
  `${repository.key} ${list}`;

/** GitHub limits how much work one account asks of it at once. */
const atOnce = 4;

/**
 * Runs at most four reads at a time, in the order they were asked. The first
 * one runs alone, so a locked keychain asks once. `read` answers whether the
 * keychain let it through. While it has not, the rest are dropped instead of
 * asking again.
 */
export function createReadQueue(
  read: (request: ListRequest) => Promise<boolean>,
) {
  const waiting = new Map<string, ListRequest>();
  const running = new Set<string>();
  let unlocked = false;

  function pump() {
    for (const [key, request] of waiting) {
      if (running.size >= (unlocked ? atOnce : 1)) return;
      waiting.delete(key);
      running.add(key);
      void read(request).then((passed) => {
        running.delete(key);
        unlocked = passed;
        if (!passed) waiting.clear();
        pump();
      });
    }
  }

  return {
    add(requests: readonly ListRequest[]) {
      for (const request of requests) {
        const key = keyOf(request);
        if (!running.has(key)) waiting.set(key, request);
      }
      pump();
    },
    /** Running reads finish, and the rest never start. */
    close: () => waiting.clear(),
  };
}
