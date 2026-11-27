import type { Draft } from "../domain/drafts";
import type { PullRequest } from "../domain/pullRequest";
import { oidSchema } from "../domain/repository";
import { get, query, queryAll } from "./appHarness";
import type { Harness } from "./appHarness";
import { pullKey } from "./fakeBridge";
import type { Bridge, World } from "./fakeBridge";
import { open, pull, tab, visit } from "./pullRequests";

export const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
export const head = oid("1");
export const book = "octo octo/pin#1";
const patch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@
 one
-two
+TWO
+and
 three
`;

function answer(bridge: Bridge) {
  bridge.respond("rangeFiles", () => ({
    kind: "ready",
    mergeBase: oid("a"),
    files: [
      {
        path: "src/a.ts",
        status: "M",
        from: null,
        similarity: null,
        added: 2,
        deleted: 1,
        oldBlob: oid("1"),
        newBlob: oid("2"),
        oldMode: "100644",
        newMode: "100644",
        submodule: false,
      },
    ],
    contentMissing: false,
    shallow: false,
  }));
  bridge.respond("rangePatches", () => [
    { path: "src/a.ts", patch: { kind: "text", patch, lossy: false } },
  ]);
}

export const draft = (
  line: number,
  text: string,
  fields: Partial<Draft> = {},
) => ({
  anchor: {
    kind: "line" as const,
    path: "src/a.ts",
    side: "right" as const,
    line,
    start: null,
  },
  head,
  text,
  writtenAt: 1,
  savedAt: 1,
  mayHavePosted: false,
  ...fields,
});

/** Files changed of pull request 1, with one file to comment on. */
export async function openFiles({
  fields = {},
  world,
}: {
  fields?: Partial<PullRequest>;
  world?: (world: World) => void;
} = {}): Promise<Harness> {
  const app = await visit({
    bridge: answer,
    world: (each) => {
      each.host.details.set(pullKey("octo/pin", 1), pull(1, fields));
      world?.(each);
    },
  });
  await open(app, 1);
  await app.click(tab("Files changed"));
  return app;
}

export const panel = () => get("tabpanel", /^Files changed/);
const diff = () => panel().querySelector("diffs-container")!.shadowRoot!;
const number = (line: number, type = "change-addition") =>
  diff().querySelector<HTMLElement>(
    `[data-column-number="${line}"][data-line-type="${type}"]`,
  )!;
const pointer = (target: EventTarget, kind: string, init: PointerEventInit) =>
  target.dispatchEvent(
    new PointerEvent(kind, {
      bubbles: true,
      composed: true,
      pointerType: "mouse",
      button: 0,
      pointerId: 1,
      ...init,
    }),
  );
/** A click on a line number, and a Shift-click on another to extend it. */
export async function choose(
  app: Harness,
  from: number,
  to = from,
  type?: string,
) {
  await app.act(() => {
    pointer(number(from, type), "pointerdown", {});
    pointer(document, "pointerup", {});
  });
  if (to === from) return;
  await app.act(() => {
    pointer(number(to), "pointerdown", { shiftKey: true });
    pointer(document, "pointerup", {});
  });
}
export const box = () => query("region", /^Comment on /);
export const words = () =>
  get("textbox", /^Comment on /) as HTMLTextAreaElement;
/** The pending comments, once their words are drawn. */
export async function pending(app: Harness) {
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
  return queryAll("region", "Pending comment").map((each) => each.textContent);
}
export const kept = (bridge: Bridge) =>
  (bridge.world.host.drafts.get(book) ?? []).map(({ text }) => text);
export const writes = (bridge: Bridge) =>
  bridge.hostLog.filter(({ op }) => op === "write").length;
