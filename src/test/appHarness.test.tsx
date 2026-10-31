// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { createBridge } from "./fakeBridge";
import {
  focused,
  get,
  installHarness,
  mountApp,
  selectedRow,
} from "./appHarness";
import { PIN } from "./fixtures";

installHarness();

function button(name: string, parent: HTMLElement = document.body) {
  const element = document.createElement("button");
  element.textContent = name;
  parent.append(element);
  return element;
}

it("mounts the restored fixture repository under StrictMode, with Ctrl shortcuts", async () => {
  const app = await mountApp();
  const repositories = await import("../repositories");
  expect(repositories.mac, "happy-dom does not report macOS").toBe(false);
  expect(get("grid", "Commits")).toBeTruthy();
  expect(selectedRow()).toBe("Topic work, Pin Author, 6666666");
  expect(app.bridge.unexpected).toEqual([]);
});

it("hides elements under [hidden] from layout and focus", async () => {
  await mountApp();
  const shown = button("Shown");
  const wrapper = document.createElement("div");
  wrapper.hidden = true;
  document.body.append(wrapper);
  const hidden = button("Hidden", wrapper);
  expect(shown.getClientRects().length, "a shown element has a box").toBe(1);
  expect(hidden.getClientRects().length, "a hidden element has no box").toBe(0);
  shown.focus();
  hidden.focus();
  expect(focused(), "a hidden element cannot take focus").toBe("button Shown");
  wrapper.hidden = false;
  hidden.focus();
  expect(focused()).toBe("button Hidden");
});

it("makes the page inert under a modal dialog, returns focus on close, and cancels on Escape", async () => {
  const app = await mountApp();
  const opener = button("Opener");
  opener.focus();
  const dialog = document.createElement("dialog");
  const inside = button("Inside", dialog);
  document.body.append(dialog);
  dialog.showModal();
  expect(focused(), "showModal focuses the first control").toBe(
    "button Inside",
  );
  opener.focus();
  expect(focused(), "the page behind a modal is inert").toBe("button Inside");
  let cancelled = 0;
  dialog.addEventListener("cancel", () => (cancelled += 1));
  await app.press("Escape", { target: inside });
  expect(cancelled).toBe(1);
  expect(dialog.open).toBe(false);
  expect(focused(), "closing returns focus to the opener").toBe(
    "button Opener",
  );
});

it("retargets a key event that leaves a shadow root, as browsers do", async () => {
  const app = await mountApp();
  const host = document.createElement("div");
  document.body.append(host);
  const input = document.createElement("input");
  host.attachShadow({ mode: "open" }).append(input);
  const seen: [EventTarget | null, EventTarget | undefined][] = [];
  const listener = (event: Event) =>
    seen.push([event.target, event.composedPath()[0]]);
  window.addEventListener("keydown", listener);
  await app.press("a", { target: input });
  window.removeEventListener("keydown", listener);
  expect(seen).toEqual([[host, input]]);
});

it("queues animation frames and controls the clock", async () => {
  const app = await mountApp();
  let ran = 0;
  requestAnimationFrame(() => (ran += 1));
  const cancelled = requestAnimationFrame(() => (ran += 10));
  cancelAnimationFrame(cancelled);
  expect(ran).toBe(0);
  await app.flushFrames();
  expect(ran).toBe(1);
  const before = performance.now();
  app.dom.clock.offset += 5_000;
  expect(performance.now() - before).toBeGreaterThanOrEqual(5_000);
});

it("answers through the transport and records requests it cannot answer", async () => {
  const bridge = createBridge();
  const post = (body: unknown) =>
    bridge.fetch("/api/run", { method: "POST", body: JSON.stringify(body) });
  const answer = await post({ op: "snapshot", path: PIN });
  expect(await answer.json()).toMatchObject({ ok: true, op: "snapshot" });
  await expect(post({ op: "blame", path: PIN })).rejects.toThrow(
    "no answer for blame",
  );
  expect(bridge.unexpected).toEqual(["blame /fixture/pin"]);
  const held = bridge.hold("refs", PIN);
  let done = false;
  const pending = post({ op: "refs", path: PIN }).then(() => (done = true));
  await held.arrived;
  await Promise.resolve();
  expect(done, "a held request waits").toBe(false);
  held.release();
  await pending;
  expect(bridge.lines()).toEqual([
    "snapshot /fixture/pin",
    "blame /fixture/pin",
    "refs /fixture/pin",
  ]);
  const restore = bridge.fail("snapshot", {
    kind: "timedOut",
    message: "Too slow.",
  });
  expect(await (await post({ op: "snapshot", path: PIN })).json()).toEqual({
    ok: false,
    error: { kind: "timedOut", message: "Too slow." },
  });
  restore();
  expect(
    await (await post({ op: "snapshot", path: PIN })).json(),
  ).toMatchObject({ ok: true });
});
