import type { Oid } from "./repository";

export const SHORT_OID_MIN_LENGTH = 7;

function sharedLength(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) return 0;
  let length = 0;
  while (length < a.length && a[length] === b[length]) length++;
  return length;
}

export function uniqueShortOids(
  oids: readonly Oid[],
): ReadonlyMap<Oid, string> {
  const sorted = [...oids].sort();
  const lengths = new Map<Oid, number>();
  sorted.forEach((oid, index) => {
    const shared = Math.max(
      sharedLength(oid, sorted[index - 1]),
      sharedLength(oid, sorted[index + 1]),
    );
    lengths.set(oid, Math.max(SHORT_OID_MIN_LENGTH, shared + 1));
  });
  return new Map(
    oids.map((oid) => [
      oid,
      oid.slice(0, lengths.get(oid) ?? SHORT_OID_MIN_LENGTH),
    ]),
  );
}
