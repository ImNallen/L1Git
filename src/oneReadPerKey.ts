export function oneReadPerKey<Key>(
  read: (key: Key) => Promise<unknown>,
): (key: Key) => void {
  const running = new Set<Key>();
  const again = new Set<Key>();
  function start(key: Key) {
    if (running.has(key)) {
      again.add(key);
      return;
    }
    running.add(key);
    const done = () => {
      running.delete(key);
      if (again.delete(key)) start(key);
    };
    read(key).then(done, done);
  }
  return start;
}
