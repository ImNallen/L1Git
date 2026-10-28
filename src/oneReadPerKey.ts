export function oneReadPerKey<Key>(
  read: (key: Key) => Promise<unknown>,
): (key: Key) => Promise<void> {
  const running = new Set<Key>();
  const again = new Map<Key, (() => void)[]>();
  function begin(key: Key, waiters: (() => void)[]) {
    running.add(key);
    const done = () => {
      running.delete(key);
      const queued = again.get(key);
      again.delete(key);
      if (queued) begin(key, queued);
      for (const resolve of waiters) resolve();
    };
    read(key).then(done, done);
  }
  return (key) =>
    new Promise((resolve) => {
      if (!running.has(key)) begin(key, [resolve]);
      else if (again.has(key)) again.get(key)?.push(resolve);
      else again.set(key, [resolve]);
    });
}
