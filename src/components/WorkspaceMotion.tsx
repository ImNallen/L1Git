import { MotionBoundary } from "./MotionBoundary";
import { useRef, useLayoutEffect } from "react";
import type { ReactNode } from "react";
import { animate, motionAllowed } from "../motion";
import { useRepositoryMotion } from "./useRepositoryMotion";

export function WorkspaceMotion({
  root,
  fileOpen,
  children,
}: {
  root: string | null;
  fileOpen: boolean;
  children: ReactNode;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const motion = useRepositoryMotion(pane, root);
  useLayoutEffect(() => {
    const history = pane.current?.querySelector<HTMLElement>(".history");
    if (!fileOpen || !history || !motionAllowed()) return;
    const style = history.getAttribute("style");
    history.style.cssText =
      "display:flex;position:absolute;inset:0;pointer-events:none";
    history.inert = true;
    const animation = animate(history, [{ opacity: 1 }, { opacity: 0 }], 240);
    const rows = history.querySelector<HTMLElement>("tbody");
    const rowAnimation = rows
      ? animate(
          rows,
          [{ translate: "0px 0px" }, { translate: "0px -32px" }],
          240,
        )
      : undefined;
    let active = true;
    const restore = () => {
      if (!active) return;
      if (style === null) history.removeAttribute("style");
      else history.setAttribute("style", style);
      history.inert = false;
    };
    animation?.finished.then(restore, restore);
    return () => {
      animation?.cancel();
      rowAnimation?.cancel();
      restore();
      active = false;
    };
  }, [fileOpen]);
  return (
    <div ref={pane} className="workspace-panes">
      <MotionBoundary {...motion} />
      {children}
    </div>
  );
}
