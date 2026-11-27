import type { Draft } from "../domain/drafts";
import type { PullRequest, ReviewThread } from "../domain/pullRequest";
import { oidSchema } from "../domain/repository";
import { get, query } from "./appHarness";
import type { Harness } from "./appHarness";
import { pullKey } from "./fakeBridge";
import type { Bridge, World } from "./fakeBridge";
import { at, open, page, pull, tab, visit } from "./pullRequests";

export const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
export const head = oid("1");
export const book = "octo octo/pin#1";
const patchOf = (path: string) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -10,3 +10,4 @@
 one
-two
+TWO
+and
 three
`;
const paths = ["src/a.ts", "src/b.ts"];

function answer(bridge: Bridge) {
  bridge.respond("rangeFiles", () => ({
    kind: "ready",
    mergeBase: oid("a"),
    files: paths.map((path) => ({
      path,
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
    })),
    contentMissing: false,
    shallow: false,
  }));
  bridge.respond("rangePatches", () =>
    paths.map((path) => ({
      path,
      patch: { kind: "text", patch: patchOf(path), lossy: false },
    })),
  );
}

export const draft = (
  line: number,
  text: string,
  fields: Partial<Draft> = {},
  path = "src/a.ts",
): Draft => ({
  anchor: { kind: "line", path, side: "right", line, start: null },
  head,
  text,
  writtenAt: 1,
  savedAt: 1,
  mayHavePosted: false,
  ...fields,
});
export const thread = (id: string, by: string): ReviewThread => ({
  id,
  review: null,
  path: "src/a.ts",
  line: 11,
  startLine: null,
  originalLine: 11,
  originalStartLine: null,
  side: "right",
  outdated: false,
  resolved: false,
  hunk: "",
  can: { reply: true, resolve: true, unresolve: false },
  comments: page([{ id: `${id}-1`, by, at: at(2), body: "Why?" }]),
});

export async function openFiles({
  fields = {},
  drafts = [],
  world,
}: {
  fields?: Partial<PullRequest>;
  drafts?: Draft[];
  world?: (world: World) => void;
} = {}): Promise<Harness> {
  const app = await visit({
    bridge: answer,
    world: (each) => {
      each.host.details.set(pullKey("octo/pin", 1), pull(1, fields));
      each.host.drafts.set(book, drafts);
      world?.(each);
    },
  });
  await open(app, 1);
  await app.click(tab("Files changed"));
  return app;
}

export const finish = () => get("button", /^Finish review/);
export const panel = () => get("tabpanel", /^Files changed/);
export const popover = () => query("dialog", "Finish your review");
export const mutations = (app: Harness) => app.bridge.world.host.mutations;
export const kept = (app: Harness) =>
  (app.bridge.world.host.drafts.get(book) ?? []).map(({ text }) => text);
export const submit = () => get("button", /^Submit/, popover()!);
export async function openPopover(app: Harness) {
  await app.click(finish());
  return popover()!;
}
