export type ReadOutcome<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: unknown };

type Read<Key> = { key: Key; stalled: boolean };

export function latestReader<Key, Value>({
  read,
  deliver,
  same,
  stallMs,
  maxReads,
}: {
  read: (key: Key) => Promise<Value>;
  deliver: (key: Key, outcome: ReadOutcome<Value>) => void;
  same: (left: Key, right: Key) => boolean;
  stallMs: number;
  maxReads: number;
}): { want: (key: Key | null) => void } {
  let newest: Key | null = null;
  let settled = false;
  let latest: Read<Key> | null = null;
  const running = new Set<Read<Key>>();

  function pump() {
    const key = newest;
    if (key === null || settled) return;
    const newestInFlight =
      latest !== null && running.has(latest) && same(latest.key, key);
    const oneStillWorking = [...running].some((current) => !current.stalled);
    const atCap = running.size >= maxReads;
    if (newestInFlight || oneStillWorking || atCap) return;
    const current: Read<Key> = { key, stalled: false };
    latest = current;
    running.add(current);
    const timer = setTimeout(() => {
      current.stalled = true;
      pump();
    }, stallMs);
    const finish = (outcome: ReadOutcome<Value>) => {
      clearTimeout(timer);
      running.delete(current);
      const stillWanted =
        current === latest && newest !== null && same(newest, key);
      if (stillWanted) {
        settled = true;
        deliver(key, outcome);
      }
      pump();
    };
    read(key).then(
      (value) => finish({ ok: true, value }),
      (error: unknown) => finish({ ok: false, error }),
    );
  }

  return {
    want(key) {
      newest = key;
      settled = false;
      pump();
    },
  };
}
