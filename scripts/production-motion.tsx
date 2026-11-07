import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CommitInspector } from "../src/components/CommitInspector";
import { ContextMenu } from "../src/components/ContextMenu";
import { MotionBoundary } from "../src/components/MotionBoundary";
import { useRepositoryMotion } from "../src/components/useRepositoryMotion";
import { pinSnapshot } from "../src/test/fixtures";
import { singleCommit } from "../src/domain/comparison";
import type { DetailState } from "../src/useWorkspace";
import type { UserSelection } from "../src/shell/navigation";
import "../src/styles/inspector.css";
import "../src/styles/menu.css";
import "../src/styles/motion.css";

const snapshot = pinSnapshot();
const commitAt = (index: number) => {
  const commit = snapshot.commits[index];
  if (!commit) throw new Error(`Missing fixture commit ${index}`);
  return commit;
};
const detail = (index: number): DetailState => ({
  kind: "ready",
  root: snapshot.root,
  comparison: singleCommit(commitAt(index).oid),
  targetStatusReads: 0,
  detail: {
    base: { kind: "firstParent" },
    target: {
      kind: "commit",
      commit: commitAt(index),
      message: `${commitAt(index).subject}\n\n${Array(index ? 12 : 1)
        .fill("Message body line")
        .join("\n")}`,
    },
    files: [],
  },
});

export function ProductionMotionRegression() {
  const [selected, setSelected] = useState(0);
  const [state, setState] = useState<DetailState>(() => detail(0));
  const [repository, setRepository] = useState("Repository A");
  const [menu, setMenu] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const motion = useRepositoryMotion(container, repository);
  const selecting: Pick<UserSelection, Extract<keyof UserSelection, string>> = {
    selection: { kind: "commit", oid: commitAt(selected).oid },
    compare: null,
    select: () => {},
    compareWith: () => {},
    endCompare: () => {},
    swapCompare: () => {},
  };
  return (
    <section id="production-motion">
      <button
        id="load-selection"
        onClick={() => {
          setSelected(1);
          setState({
            kind: "loading",
            root: snapshot.root,
            comparison: singleCommit(commitAt(1).oid),
            targetStatusReads: 0,
          });
        }}
      >
        Load another commit
      </button>
      <button id="finish-selection" onClick={() => setState(detail(selected))}>
        Finish loading
      </button>
      <button
        id="load-latest-selection"
        onClick={() => {
          setSelected(2);
          setState({
            kind: "loading",
            root: snapshot.root,
            comparison: singleCommit(commitAt(2).oid),
            targetStatusReads: 0,
          });
        }}
      >
        Load latest selection
      </button>
      <button
        id="load-first-selection"
        onClick={() => {
          setSelected(0);
          setState({
            kind: "loading",
            root: snapshot.root,
            comparison: singleCommit(commitAt(0).oid),
            targetStatusReads: 0,
          });
        }}
      >
        Load first selection
      </button>
      <button
        id="select-repository-a"
        onClick={() => setRepository("Repository A")}
      >
        Select A
      </button>
      <button
        id="select-repository-b"
        onClick={() => setRepository("Repository B")}
      >
        Select B
      </button>
      <button id="open-regression-menu" onClick={() => setMenu(true)}>
        Open menu
      </button>
      <button id="close-regression-menu" onClick={() => setMenu(false)}>
        Close menu
      </button>
      <div
        ref={container}
        style={{
          width: 300,
          height: 60,
          background: repository === "Repository A" ? "white" : "red",
        }}
      >
        <MotionBoundary {...motion} />
        {repository}
      </div>
      {menu && (
        <ContextMenu
          motion
          x={window.innerWidth - 10}
          y={window.innerHeight - 10}
          label="Regression menu"
          onClose={() => setMenu(false)}
        >
          <button role="menuitem" aria-disabled="true">
            Unavailable command
          </button>
          <button role="menuitem" onClick={() => setMenu(false)}>
            Available command
          </button>
        </ContextMenu>
      )}
      <div style={{ width: 420, height: 650 }}>
        <CommitInspector
          state={state}
          root={snapshot.root}
          comparison={singleCommit(commitAt(selected).oid)}
          selecting={selecting as UserSelection}
          snapshot={snapshot}
          placement={{ refs: [], lane: 0 }}
          selectedFile={null}
          onSelectFile={() => {}}
          toggleButton={null}
          onRetry={() => {}}
          worktree={null}
          onRefreshChanges={() => {}}
          writes={{
            busy: false,
            write: async () => {},
            commit: async () => ({ kind: "busy" }),
            confirmDiscard: () => {},
            confirmStash: () => {},
            lostFocus: () => {},
          }}
        />
      </div>
    </section>
  );
}

export async function verifyProductionMotion() {
  const root = document.querySelector("#production-motion")!;
  const click = (id: string) =>
    flushSync(() => root.querySelector<HTMLButtonElement>(`#${id}`)!.click());
  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const y = () =>
    root.querySelector(".changed-files-section")!.getBoundingClientRect().y;
  const near = (before: number, after: number, message: string) => {
    if (Math.abs(before - after) > 1)
      throw new Error(`${message}: ${before} != ${after}`);
  };
  const before = y();
  click("load-selection");
  await wait(80);
  click("finish-selection");
  await Promise.resolve();
  const first = y();
  near(before, first, "Async selection starts at the displayed outgoing pose");
  const title = root.querySelector(".commit-information h2")!;
  if (
    !title
      .getAnimations()
      .some(
        (animation) =>
          animation.effect instanceof KeyframeEffect &&
          animation.effect
            .getKeyframes()
            .some((frame) => frame.opacity === "0"),
      )
  )
    throw new Error("The production nested title must fade");
  await wait(100);
  const middle = y();
  await wait(200);
  const end = y();
  if (!(middle > Math.min(first, end) && middle < Math.max(first, end)))
    throw new Error("Async inspector layout must interpolate");

  click("load-latest-selection");
  await wait(40);
  click("load-first-selection");
  await wait(40);
  click("finish-selection");
  await Promise.resolve();
  const chainedFirst = y();
  near(
    end,
    chainedFirst,
    "Successive loading selections retain the last displayed pose",
  );
  await wait(260);
  click("select-repository-b");
  await wait(65);
  const outgoing = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-motion-exit="repository"]',
    ),
  ].find((layer) => layer.textContent === "Repository A")!;
  if (!outgoing) throw new Error("Missing outgoing repository");
  const outgoingOpacity = Number(getComputedStyle(outgoing).opacity);
  const outgoingAnimation = outgoing.getAnimations()[0];
  const outgoingTime = Number(outgoingAnimation?.currentTime);
  click("select-repository-a");
  if (!outgoing.isConnected)
    throw new Error("Repository reversal dropped visible outgoing paint");
  if (
    !outgoingAnimation ||
    !outgoing.getAnimations().includes(outgoingAnimation) ||
    Number(outgoingAnimation.currentTime) < outgoingTime
  )
    throw new Error(
      "Repository reversal must preserve the outgoing animation clock",
    );
  await wait(250);
  if (document.querySelector('[data-motion-exit="repository"]'))
    throw new Error("Repository exits must expire");

  click("open-regression-menu");
  await wait(250);
  click("close-regression-menu");
  await wait(50);
  const exiting = document.querySelector<HTMLElement>(
    '[data-motion-exit="menu"]',
  )!;
  const menuOpacity =
    Number(getComputedStyle(exiting).opacity) *
    Number(getComputedStyle(exiting.firstElementChild!).opacity);
  const oldItem = exiting.querySelector("button")!.getBoundingClientRect();
  click("open-regression-menu");
  const reopened = document.querySelector<HTMLElement>('[role="menu"]')!;
  const reopenedOpacity = Number(getComputedStyle(reopened).opacity);
  if (reopenedOpacity <= 0 || reopenedOpacity > menuOpacity + 0.01)
    throw new Error("Reopened menu must resume visible outgoing paint");
  const newItem = reopened.querySelector("button")!.getBoundingClientRect();
  const menuRect = reopened.getBoundingClientRect();
  if (newItem.x < menuRect.left || newItem.y < menuRect.top)
    throw new Error("Reopened menu items must stay inside the clamped menu");
  await wait(250);
  flushSync(() =>
    reopened
      .querySelector<HTMLButtonElement>('[aria-disabled="true"]')!
      .click(),
  );
  if (!reopened.isConnected)
    throw new Error("Disabled command closed the menu");
  flushSync(() =>
    reopened.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await Promise.resolve();
  const exit = document.querySelector('[data-motion-exit="menu"]')!;
  const effect = exit.getAnimations()[0]?.effect;
  if (
    !(effect instanceof KeyframeEffect) ||
    effect.getTiming().duration !== 160
  )
    throw new Error("Escape after a disabled click must retain its 160ms exit");
  await wait(220);
  if (document.querySelector("[data-motion-exit]"))
    throw new Error("Exit layers must be removed");
  return {
    before,
    first,
    middle,
    end,
    chainedFirst,
    outgoingOpacity,
    menuOpacity,
    reopenedOpacity,
    oldItem: { x: oldItem.x, y: oldItem.y },
    newItem: { x: newItem.x, y: newItem.y },
    escapeDuration: 160,
  };
}
