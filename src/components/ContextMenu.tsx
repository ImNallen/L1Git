import { captureExit } from "../motionExit";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import { animate, cancelMotion } from "../motion";
import { createPortal } from "react-dom";

let exitingMenu: ReturnType<typeof captureExit> = null;

const ITEMS = "[role=menuitem], [role=menuitemcheckbox]";

export function opensMenu(event: ReactKeyboardEvent): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

export function ContextMenu({
  x,
  y,
  closeOnPointerLeave = false,
  label,
  className = "",
  ignoreScrollIn,
  onClose,
  children,
}: {
  closeOnPointerLeave?: boolean;
  x: number;
  y: number;
  label: string;
  className?: string;
  ignoreScrollIn?: RefObject<HTMLElement | null>;
  onClose: (options: { returnFocus: boolean }) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  const [position, setPosition] = useState({ top: y, left: x });
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useLayoutEffect(() => {
    const outgoing = exitingMenu;
    const reversal =
      outgoing?.layer.isConnected &&
      outgoing.paint.getAttribute("aria-label") === label
        ? {
            top: outgoing.paint.getBoundingClientRect().top,
            opacity:
              Number(getComputedStyle(outgoing.layer).opacity) *
              Number(getComputedStyle(outgoing.paint).opacity),
          }
        : null;
    outgoing?.dispose();
    exitingMenu = null;
    const menu = ref.current;
    if (!menu) return;
    const clamped = {
      top: Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4)),
      left: Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4)),
    };
    menu.style.top = `${clamped.top}px`;
    menu.style.left = `${clamped.left}px`;
    setPosition(clamped);
    menu.querySelector<HTMLElement>(ITEMS)?.focus();
    animate(
      menu,
      [
        {
          opacity: reversal?.opacity ?? 0,
          translate: `0px ${reversal ? Math.max(-4, Math.min(0, reversal.top - clamped.top)) : -4}px`,
        },
        { opacity: 1, translate: "0px 0px" },
      ],
      160,
    );
    return () => {
      exitingMenu = captureExit(menu, "menu");
      exitingMenu?.play(100);
      cancelMotion(new Map([["menu", menu]]));
    };
  }, [x, y, label]);
  useEffect(() => {
    const close = () => {
      onCloseRef.current({ returnFocus: true });
    };
    const scrolled = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !ignoreScrollIn?.current?.contains(event.target)
      )
        close();
    };
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    // Capture so the app's own Escape handling never sees this keypress.
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    const closeOnFocusLeave = (event: FocusEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target))
        onCloseRef.current({ returnFocus: false });
    };
    window.addEventListener("focusin", closeOnFocusLeave, true);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("focusin", closeOnFocusLeave, true);
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [ignoreScrollIn]);
  return createPortal(
    <div
      ref={ref}
      className={`context-menu ${className}`.trim()}
      role="menu"
      data-file-tree-context-menu-root="true"
      aria-label={label}
      style={position}
      onMouseEnter={() => window.clearTimeout(leaveTimer.current)}
      onMouseLeave={() => {
        if (!closeOnPointerLeave) return;
        window.clearTimeout(leaveTimer.current);
        leaveTimer.current = window.setTimeout(() => {
          onCloseRef.current({ returnFocus: true });
        }, 200);
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(ITEMS),
        ];
        const from = items.indexOf(document.activeElement as HTMLElement);
        const target = {
          ArrowDown: (from + 1) % items.length,
          ArrowUp: (from - 1 + items.length) % items.length,
          Home: 0,
          End: items.length - 1,
        }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        items[target]?.focus();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
