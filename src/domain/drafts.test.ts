import { expect, it } from "vitest";
import { draftKey } from "./drafts";
import type { Anchor } from "./drafts";
import type { Oid } from "./repository";

const HEAD = "a".repeat(40) as Oid;

it("names a range the same whatever order its start point's fields arrive in", () => {
  const typed: Anchor = {
    kind: "line",
    path: "src/a.ts",
    side: "right",
    line: 9,
    start: { line: 2, side: "right" },
  };
  const fromHost = JSON.parse(
    '{"kind":"line","path":"src/a.ts","side":"right","line":9,"start":{"side":"right","line":2}}',
  ) as Anchor;
  expect(draftKey(typed, HEAD)).toBe(draftKey(fromHost, HEAD));
});
