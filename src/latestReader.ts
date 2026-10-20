export type ReadOutcome<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: unknown };

/**
 * Reads only the newest wanted key, one read at a time. A read that runs past
 * `stallMs` stops holding the queue, so a hung read cannot block later keys.
 * `deliver` sees an outcome only while its key is still the newest.
 */
export function latestReader<Key, Value>({
  read,
  deliver,
  same,
  stallMs,
}: {
  read: (key: Key) => Promise<Value>;
  deliver: (key: Key, outcome: ReadOutcome<Value>) => void;
  same: (left: Key, right: Key) => boolean;
  stallMs: number;
}): { want: (key: Key | null) => void } {
  let newest: Key | null = null;
  let settled: Key | null = null;
  let running: { key: Key; stalled: boolean } | null = null;

  function pump() {
    const key = newest;
    if (key === null || (settled !== null && same(settled, key))) return;
    if (running && (same(running.key, key) || !running.stalled)) return;
    const current = { key, stalled: false };
    running = current;
    const timer = setTimeout(() => {
      current.stalled = true;
      pump();
    }, stallMs);
    const finish = (outcome: ReadOutcome<Value>) => {
      clearTimeout(timer);
      if (running === current) running = null;
      if (newest !== null && same(newest, key)) {
        settled = key;
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
      settled = null;
      pump();
    },
  };
}
