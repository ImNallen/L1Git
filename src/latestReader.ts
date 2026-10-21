type ReadOutcome<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: unknown };

type InFlight<Key> = { key: Key; stalled: boolean };

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
  // A stalled read keeps its slot because backend reads cannot be cancelled, and
  // that bounds the reads a hung backend can pile up. `delivered` marks the newest
  // key as answered so the pump after delivery does not start another read.
  let delivered = false;
  let latest: InFlight<Key> | null = null;
  const running = new Set<InFlight<Key>>();

  function pump() {
    const key = newest;
    if (key === null || delivered) return;
    const newestInFlight =
      latest !== null && running.has(latest) && same(latest.key, key);
    const oneStillWorking = [...running].some((current) => !current.stalled);
    const atCap = running.size >= maxReads;
    if (newestInFlight || oneStillWorking || atCap) return;
    const current: InFlight<Key> = { key, stalled: false };
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
        delivered = true;
        deliver(key, outcome);
      }
      pump();
    };
    let reading: Promise<Value>;
    try {
      reading = read(key);
    } catch (error: unknown) {
      reading = Promise.reject(error);
    }
    reading.then(
      (value) => finish({ ok: true, value }),
      (error: unknown) => finish({ ok: false, error }),
    );
  }

  return {
    want(key) {
      newest = key;
      delivered = false;
      pump();
    },
  };
}
