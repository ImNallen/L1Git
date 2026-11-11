// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  vi.useRealTimers();
});

function render(closeOnPointerLeave?: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onClose = vi.fn();
  act(() =>
    root.render(
      <ContextMenu
        x={10}
        y={10}
        label="Commands"
        closeOnPointerLeave={closeOnPointerLeave}
        onClose={onClose}
      >
        <button role="menuitem">First</button>
        <button role="menuitem">Second</button>
      </ContextMenu>,
    ),
  );
  const menu = document.querySelector('[role="menu"]')!;
  const leave = () =>
    act(() => {
      menu.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      vi.runAllTimers();
    });
  return { menu, onClose, leave };
}

it("keeps context menus open when the pointer leaves by default", () => {
  vi.useFakeTimers();
  const { leave, onClose } = render();
  leave();
  expect(onClose).not.toHaveBeenCalled();
});

it("dismisses menus that opt into pointer-leave closing", () => {
  vi.useFakeTimers();
  const { leave, onClose } = render(true);
  leave();
  expect(onClose).toHaveBeenCalledWith({ returnFocus: true });
});

it("focuses immediately and preserves arrow navigation and Escape", () => {
  const { onClose } = render();
  expect(document.activeElement?.textContent).toBe("First");
  const press = (key: string) =>
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    });
  press("ArrowDown");
  expect(document.activeElement?.textContent).toBe("Second");
  press("Escape");
  expect(onClose).toHaveBeenCalledWith({ returnFocus: true });
});
