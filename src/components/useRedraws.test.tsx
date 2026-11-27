// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRedraws } from "./useRedraws";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let drawn: unknown[];

function Viewer() {
  drawn.push(useRedraws());
  return null;
}

const errorEvent = (message: string, error: unknown) =>
  new ErrorEvent("error", { message, error });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  drawn = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Viewer />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const redraws = () => new Set(drawn).size - 1;

it("draws anew after an error in a frame of Pierre's", async () => {
  await act(async () => {
    dispatchEvent(errorEvent("split columns out of sync", new Error("split")));
  });
  expect(redraws()).toBe(1);
});

it("draws nothing anew for the notice of a ResizeObserver loop", async () => {
  await act(async () => {
    dispatchEvent(
      errorEvent(
        "ResizeObserver loop completed with undelivered notifications.",
        null,
      ),
    );
  });
  expect(redraws()).toBe(0);
  await act(async () => {
    dispatchEvent(
      errorEvent(
        "ResizeObserver loop completed with undelivered notifications.",
        new Error("thrown with the same words"),
      ),
    );
  });
  expect(redraws(), "an error thrown with the same words still counts").toBe(1);
});
