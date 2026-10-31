// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  dialogs,
  focused,
  get,
  installHarness,
  mountApp,
  refRow,
  selectedRow,
} from "./test/appHarness";
import type { Bridge } from "./test/fakeBridge";
import { applied, C2, C6, history, PIN } from "./test/fixtures";
import { snapshotSchema } from "./domain/repository";

installHarness();

function restoreGoneOnUndo(bridge: Bridge) {
  bridge.respond("undo", (_request, world, fallback) => {
    const entry = fallback();
    const snapshot = world.snapshots.get(PIN)!;
    world.snapshots.set(
      PIN,
      snapshotSchema.parse({
        ...snapshot,
        branches: [
          ...snapshot.branches,
          {
            kind: "local",
            reference: "refs/heads/gone",
            name: "gone",
            oid: C2,
            upstream: null,
          },
        ],
      }),
    );
    return entry;
  });
}

it("keyboard undo of a branch delete waits for sidebar refs, jumps to the branch, and focuses its row", async () => {
  const app = await mountApp({ bridge: restoreGoneOnUndo });
  expect(refRow("refs/heads/gone")).toBeNull();
  expect(focused()).toBe("body");
  await app.press("z", { ctrlKey: true });
  const gone = refRow("refs/heads/gone");
  expect(gone?.getAttribute("aria-current")).toBe("true");
  expect(document.activeElement).toBe(gone);
  expect(selectedRow()).toBe("Second, Pin Author, 2222222");
});

it("keyboard undo leaves selection and focus alone while focus is on a shown control", async () => {
  const app = await mountApp({ bridge: restoreGoneOnUndo });
  const settings = get("button", "Settings");
  settings.focus();
  await app.press("z", { ctrlKey: true });
  expect(refRow("refs/heads/gone"), "the undo ran").not.toBeNull();
  expect(selectedRow()).toBe("Topic work, Pin Author, 6666666");
  expect(document.activeElement).toBe(settings);
});

it("keyboard undo of a checkout refocuses on the next frame when focus was lost", async () => {
  const app = await mountApp({
    world: (world) =>
      world.histories.set(
        PIN,
        history(
          applied(PIN, {
            kind: "checkout",
            target: {
              kind: "local",
              reference: "refs/heads/topic",
              oid: C6,
            },
          }),
        ),
      ),
  });
  await app.press("z", { ctrlKey: true });
  expect(app.bridge.count("undo")).toBe(1);
  expect(focused(), "nothing refocuses before the frame").toBe("body");
  await app.flushFrames();
  expect(focused()).toBe("grid Commits");
});

it("the toolbar Undo button does not reveal or refocus (pins current behavior)", async () => {
  const app = await mountApp({ bridge: restoreGoneOnUndo });
  await app.click(get("button", "Undo Delete branch gone"));
  await app.flushFrames();
  expect(refRow("refs/heads/gone"), "the undo ran").not.toBeNull();
  expect(
    refRow("refs/heads/gone")?.getAttribute("aria-current"),
    "no jump to the restored branch",
  ).toBeNull();
  expect(selectedRow()).toBe("Topic work, Pin Author, 6666666");
  expect(
    focused(),
    "WebKit leaves focus where it was when a button is clicked",
  ).toBe("body");
});

async function deleteTagV1(app: Awaited<ReturnType<typeof mountApp>>) {
  await app.contextMenu(refRow("refs/tags/v1")!);
  await app.click(get("menuitem", "Delete tag…"));
  expect(dialogs()).toEqual(["Delete tag v1?"]);
  await app.click(get("button", "Delete tag"));
  expect(dialogs()).toEqual([]);
  expect(app.bridge.lines((request) => request.op === "write")).toEqual([
    "write /fixture/pin deleteTag",
  ]);
}

it("deleting a tag refocuses once the tag leaves the sidebar refs", async () => {
  const app = await mountApp({
    bridge: (bridge) =>
      bridge.respond("write", (_request, world, fallback) => {
        const snapshot = world.snapshots.get(PIN)!;
        world.snapshots.set(PIN, { ...snapshot, tags: [] });
        return fallback();
      }),
  });
  await deleteTagV1(app);
  expect(refRow("refs/tags/v1")).toBeNull();
  expect(focused(), "without waiting for a frame").toBe("grid Commits");
});

it("after a tag delete, a lost focus waits until a later reread drops the tag from the sidebar", async () => {
  const app = await mountApp();
  await deleteTagV1(app);
  expect(
    refRow("refs/tags/v1"),
    "the reread still lists the tag",
  ).not.toBeNull();
  expect(focused(), "closing the dialog returned focus to the row").toBe(
    "button v1",
  );
  await app.act(() => (document.activeElement as HTMLElement).blur());
  await app.settle();
  expect(focused()).toBe("body");
  const snapshot = app.bridge.world.snapshots.get(PIN)!;
  app.bridge.world.snapshots.set(PIN, { ...snapshot, tags: [] });
  await app.refocusWindow();
  expect(refRow("refs/tags/v1")).toBeNull();
  expect(focused()).toBe("grid Commits");
});

it.todo(
  "a lost-focus check and a step reveal in one commit keep today's winner: the write's idle update and the step's steppedRef never share a commit under act(), so the fixture cannot race them",
);
