// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useRovingRows } from "./useRovingRows";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => document.body.replaceChildren());

function Tree() {
  const nav = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(true);
  useRovingRows(nav);
  return (
    <nav ref={nav}>
      <div className="repository-group">
        <div className="repository-row">
          <button
            className="repository-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            chevron
          </button>
          <button className="repository-open">demo</button>
        </div>
        {open && (
          <>
            <button aria-expanded="true">Local</button>
            <div className="branch-item">
              <button aria-current="true">main</button>
              <button className="branch-visibility" tabIndex={-1}>
                Hide main
              </button>
            </div>
            <button>feature</button>
          </>
        )}
      </div>
    </nav>
  );
}

function render() {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => createRoot(host).render(<Tree />));
  return host;
}

const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === name)!;
const press = (key: string) =>
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
const expanded = (host: HTMLElement) =>
  host.querySelector(".repository-toggle")?.getAttribute("aria-expanded");
const tabbable = (host: HTMLElement) =>
  [...host.querySelectorAll("button")]
    .filter((b) => b.tabIndex === 0)
    .map((b) => b.textContent);

it("leaves one Tab stop, on the current row", () => {
  expect(tabbable(render())).toEqual(["main"]);
});

it("steps through rows with the arrow keys, skipping chevrons and visibility toggles", () => {
  const host = render();
  act(() => button(host, "main").focus());
  press("ArrowDown");
  expect(document.activeElement?.textContent).toBe("feature");
  expect(tabbable(host)).toEqual(["feature"]);
  press("Home");
  expect(document.activeElement?.textContent).toBe("demo");
  press("End");
  expect(document.activeElement?.textContent).toBe("feature");
  press("ArrowUp");
  expect(document.activeElement?.textContent).toBe("main");
});

it("collapses with Left, returns to the repository, and expands with Right", () => {
  const host = render();
  act(() => button(host, "main").focus());
  press("ArrowLeft");
  expect(document.activeElement?.textContent).toBe("demo");
  press("ArrowLeft");
  expect(expanded(host)).toBe("false");
  expect(tabbable(host)).toEqual(["demo"]);
  press("ArrowRight");
  expect(expanded(host)).toBe("true");
  press("ArrowRight");
  expect(document.activeElement?.textContent).toBe("Local");
});
