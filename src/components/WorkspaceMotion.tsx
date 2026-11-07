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
  useRepositoryMotion(pane, root);
  useLayoutEffect(() => {
    const history = pane.current?.querySelector<HTMLElement>(".history");
    if (!fileOpen || !history || !motionAllowed()) return;
    const style = history.getAttribute("style");
    history.style.cssText =
      "display:flex;position:absolute;inset:0;pointer-events:none";
    history.inert = true;
    const animation = animate(
      history,
      [
        { translate: "0px 0px", opacity: 1 },
        { translate: "0px -64px", opacity: 0 },
      ],
      240,
    );
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
      restore();
      active = false;
    };
  }, [fileOpen]);
  return (
    <div ref={pane} className="workspace-panes">
      {children}
    </div>
  );
}
