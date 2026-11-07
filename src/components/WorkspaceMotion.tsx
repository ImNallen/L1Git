import { MotionBoundary } from "./MotionBoundary";
import { useMemo, useRef } from "react";
import type { ReactNode } from "react";
import type { MotionSnapshot } from "./MotionBoundary";
import { animate, cancelMotion, motionAllowed } from "../motion";
import { captureExit } from "../motionExit";
import { useRepositoryMotion } from "./useRepositoryMotion";

type Pane = { root: string | null; fileOpen: boolean };
type Exit = NonNullable<ReturnType<typeof captureExit>>;

export function WorkspaceMotion({
  root,
  fileOpen,
  children,
}: Pane & {
  children: ReactNode;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const repository = useRepositoryMotion(pane, root);
  const identity = useMemo(() => ({ root, fileOpen }), [root, fileOpen]);
  const outgoing = useRef<{ fileOpen: boolean; exit: Exit } | null>(null);
  const capture = (previous: Pane): MotionSnapshot | null => {
    if (
      previous.root !== root ||
      previous.fileOpen === fileOpen ||
      !motionAllowed()
    )
      return null;
    const old = pane.current?.querySelector<HTMLElement>(
      previous.fileOpen ? ".file-diff" : ".history",
    );
    if (!old) return null;
    const prior = outgoing.current;
    const reversed =
      prior?.fileOpen === fileOpen && prior.exit.layer.isConnected;
    const opacity = reversed
      ? Number(getComputedStyle(prior.exit.layer).opacity) *
        Number(getComputedStyle(prior.exit.paint).opacity)
      : 0;
    const priorRows = reversed ? prior.exit.paint.querySelector("tbody") : null;
    const rowPose = priorRows
      ? getComputedStyle(priorRows).translate
      : "0px -32px";
    const exit = captureExit(old, "workspace-pane");
    if (!exit) return null;
    const record = { fileOpen: previous.fileOpen, exit };
    outgoing.current = record;
    const animated = new Map<string, HTMLElement>();
    let observer: MutationObserver | null = null;
    return {
      play() {
        exit.show();
        const enter = () => {
          const next = pane.current?.querySelector<HTMLElement>(
            fileOpen ? ".file-diff" : ".history",
          );
          if (!next) return;
          observer?.disconnect();
          exit.play(240);
          animate(next, [{ opacity }, { opacity: 1 }], 240);
          animated.set("pane", next);
          const rows = fileOpen
            ? exit.paint.querySelector<HTMLElement>("tbody")
            : next.querySelector<HTMLElement>("tbody");
          if (rows) {
            animate(
              rows,
              fileOpen
                ? [
                    { translate: getComputedStyle(rows).translate },
                    { translate: "0px -32px" },
                  ]
                : [{ translate: rowPose }, { translate: "0px 0px" }],
              240,
            );
            animated.set("rows", rows);
            const marker = (
              fileOpen ? exit.paint : next
            ).querySelector<HTMLElement>(".history-selection");
            if (marker) {
              animate(
                marker,
                fileOpen
                  ? [
                      { translate: getComputedStyle(marker).translate },
                      { translate: "0px -32px" },
                    ]
                  : [{ translate: rowPose }, { translate: "0px 0px" }],
                240,
              );
              animated.set("selection", marker);
            }
          }
        };
        enter();
        if (!animated.size && pane.current) {
          observer = new MutationObserver(enter);
          observer.observe(pane.current, { childList: true, subtree: true });
        }
      },
      dispose() {
        observer?.disconnect();
        exit.dispose();
        cancelMotion(animated);
        if (outgoing.current === record) outgoing.current = null;
      },
    };
  };
  return (
    <div ref={pane} className="workspace-panes">
      <MotionBoundary {...repository} />
      <MotionBoundary identity={identity} capture={capture} afterLayout />
      {children}
    </div>
  );
}
