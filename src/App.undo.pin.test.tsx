import { toolbarItem } from "./test/appHarness";
// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  dialogs,
  focused,
  get,
  historyRow,
  installHarness,
  mountApp,
  query,
  refRow,
  selectedRow,
} from "./test/appHarness";
import type { Bridge } from "./test/fakeBridge";
import { applied, C2, C6, history, PIN } from "./test/fixtures";
import { snapshotSchema } from "./domain/repository";
import type { Applied, RepositoryRoot } from "./domain/repository";

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

it("Undo in More restores its opener without jumping to the restored branch", async () => {
  const app = await mountApp({ bridge: restoreGoneOnUndo });
  await app.click(await toolbarItem(app, "More", "Undo Delete branch gone"));
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
  ).toBe("button More");
});

async function deleteTagV1(app: Awaited<ReturnType<typeof mountApp>>) {
  await app.click(get("button", "Tags1"));
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

/** Answers each write as the core does: the new entry tops the undo history. */
function journal(bridge: Bridge) {
  bridge.respond("write", (request, world, fallback) => {
    const entry = fallback() as Applied;
    world.histories.set(request.path as RepositoryRoot, history(entry));
    return entry;
  });
}

async function cherryPickRelease(app: Awaited<ReturnType<typeof mountApp>>) {
  await app.click(historyRow("Release,"));
  await app.runPaletteItem("Cherry-pick onto main…");
  await app.click(
    get("button", "Cherry-pick", get("dialog", "Cherry-pick this commit")),
  );
}

it("a clean cherry-pick shows a notice whose Undo takes it back", async () => {
  const app = await mountApp({ bridge: journal });
  await cherryPickRelease(app);
  const notice = get("status", /Cherry-picked/);
  expect(notice.textContent).toBe("Cherry-picked 3333333 onto main.Undo");
  expect(get("button", "Dismiss", notice)).toBeTruthy();
  await app.click(get("button", "Undo", notice));
  expect(app.bridge.lines((request) => request.op === "undo")).toEqual([
    "undo /fixture/pin",
  ]);
  expect(query("status", /Cherry-picked/)).toBeNull();
  expect(get("status", /Undid/).textContent).toBe(
    "Undid Cherry-pick “Picked subject”Redo",
  );
});

it("Dismiss closes a write notice and keyboard undo still takes the write back", async () => {
  const app = await mountApp({ bridge: journal });
  await cherryPickRelease(app);
  await app.click(get("button", "Dismiss", get("status", /Cherry-picked/)));
  expect(query("status", /Cherry-picked/)).toBeNull();
  await app.press("z", { ctrlKey: true });
  expect(app.bridge.count("undo")).toBe(1);
});

it("a write notice offers Undo only while its write is the next to undo", async () => {
  const app = await mountApp();
  await cherryPickRelease(app);
  const notice = get("status", /Cherry-picked/);
  expect(
    get("button", "Undo", notice).getAttribute("aria-disabled"),
    "the history still tops with an older entry",
  ).toBe("true");
});

it("Stage all posts no notice and leaves the write notice shown", async () => {
  const app = await mountApp({ bridge: journal });
  await cherryPickRelease(app);
  await app.click(historyRow("Uncommitted changes in pin,"));
  await app.runPaletteItem("Stage all");
  expect(app.bridge.lines((request) => request.op === "write")).toEqual([
    "write /fixture/pin replay",
    "write /fixture/pin stageFiles",
  ]);
  expect(query("status", /Staged/)).toBeNull();
  expect(
    get("button", "Undo", get("status", /Cherry-picked/)).getAttribute(
      "aria-disabled",
    ),
    "the stage is now the next write to undo",
  ).toBe("true");
});

it("Discard all replaces the write notice with its own Undo", async () => {
  const app = await mountApp({ bridge: journal });
  await cherryPickRelease(app);
  await app.click(historyRow("Uncommitted changes in pin,"));
  await app.runPaletteItem("Discard all changes…");
  await app.click(get("button", "Discard changes"));
  expect(query("status", /Cherry-picked/)).toBeNull();
  const discarded = get("status", /Discarded/);
  expect(discarded.textContent).toBe("Discarded notes.txt.Undo");
  expect(get("button", "Undo", discarded).getAttribute("aria-disabled")).toBe(
    "false",
  );
});

it.todo(
  "a lost-focus check and a step reveal in one commit keep today's winner: the write's idle update and the step's steppedRef never share a commit under act(), so the fixture cannot race them",
);

it("a branch an undo restores while the pull requests open is followed there, and they stay open", async () => {
  const app = await mountApp({ bridge: restoreGoneOnUndo });
  const refs = app.bridge.hold("snapshot", PIN);
  void app.press("z", { ctrlKey: true });
  await refs.arrived;
  await app.click(get("button", /^Pull requests/));
  await app.act(() => (document.activeElement as HTMLElement | null)?.blur());
  refs.release();
  await app.settle();
  await app.flushFrames();
  expect(query("region", "Pull requests")).not.toBeNull();
  await app.click(get("button", /^Back to history/));
  expect(refRow("refs/heads/gone")?.getAttribute("aria-current")).toBe("true");
  expect(selectedRow()).toBe("Second, Pin Author, 2222222");
});
