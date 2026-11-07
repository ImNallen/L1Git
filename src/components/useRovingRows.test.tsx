// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useRovingRows } from "./useRovingRows";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => document.body.replaceChildren());

function Tree({ searching = false }: { searching?: boolean }) {
  const nav = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(true);
  useRovingRows(nav);
  return (
    <nav ref={nav}>
      <div className="repository-group" data-repository-root="demo">
        <div className="repository-row">
          <button className="repository-open" onClick={() => setOpen(true)}>
            demo
          </button>
        </div>
        {open && (
          <>
            <button aria-expanded="true">Local</button>
            <button aria-expanded="true" disabled={searching}>
              feat
            </button>
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

function render(searching = false) {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => createRoot(host).render(<Tree searching={searching} />));
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
const tabbable = (host: HTMLElement) =>
  [...host.querySelectorAll("button")]
    .filter((b) => b.tabIndex === 0)
    .map((b) => b.textContent);

it("leaves one Tab stop, on the current row", () => {
  expect(tabbable(render())).toEqual(["main"]);
});

it("steps through rows with the arrow keys, skipping visibility toggles", () => {
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

it("returns to the repository with Left and enters its refs with Right", () => {
  const host = render();
  act(() => button(host, "main").focus());
  press("ArrowLeft");
  expect(document.activeElement?.textContent).toBe("demo");
  press("ArrowLeft");
  expect(button(host, "Local").isConnected).toBe(true);
  press("ArrowRight");
  expect(document.activeElement?.textContent).toBe("Local");
});

it("steps over folders that search disables", () => {
  const host = render(true);
  act(() => button(host, "Local").focus());
  press("ArrowDown");
  expect(document.activeElement?.textContent).toBe("main");
  press("ArrowUp");
  expect(document.activeElement?.textContent).toBe("Local");
});

it("Right reaches refs below other repositories and Left returns to their owner", () => {
  const host = render();
  const group = host.querySelector(".repository-group")!;
  const other = document.createElement("button");
  other.className = "repository-open";
  other.textContent = "other";
  const otherGroup = document.createElement("div");
  otherGroup.dataset.repositoryRoot = "other";
  otherGroup.append(other);
  group.querySelector(".repository-row")!.after(otherGroup);
  act(() => button(host, "demo").focus());
  press("ArrowRight");
  expect(document.activeElement?.textContent).toBe("Local");
  act(() => button(host, "main").focus());
  press("ArrowLeft");
  expect(document.activeElement?.textContent).toBe("demo");
});
