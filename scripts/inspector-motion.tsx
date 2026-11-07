import { useRef, useState } from "react";
import { MotionBoundary } from "../src/components/MotionBoundary";
import { useInspectorMotion } from "../src/components/useInspectorMotion";

export function InspectorRegression() {
  const [commit, setCommit] = useState("A");
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const motion = useInspectorMotion(ref, "repo", commit);
  return (
    <>
      <button onClick={() => setCommit((x) => (x === "A" ? "B" : "A"))}>
        Next commit
      </button>
      <button onClick={() => setExpanded((x) => !x)}>Expand message</button>
      <aside ref={ref}>
        <MotionBoundary {...motion} />
        <div className="commit-information">
          <div
            className="commit-message-section"
            style={{ height: expanded || commit === "B" ? 200 : 40 }}
          >
            <h2>{commit}</h2>
            Message
          </div>
          <div className="commit-metadata">Metadata</div>
        </div>
        <div className="changed-files-section" style={{ height: 100 }}>
          Changed files
        </div>
      </aside>
    </>
  );
}

export async function verifyInspectorMotion() {
  const { flushSync } = await import("react-dom");
  const buttons = document.querySelectorAll("button");
  const section = document.querySelector(".changed-files-section")!;
  const y = () => section.getBoundingClientRect().y;
  const nextButton = buttons[0];
  const expandButton = buttons[1];
  if (!nextButton || !expandButton)
    throw new Error("Missing regression controls");
  const next = () => flushSync(() => nextButton.click());
  flushSync(() => expandButton.click());
  const expandedBefore = y();
  next();
  await Promise.resolve();
  const expandedAfter = y();
  flushSync(() => expandButton.click());
  next();
  await new Promise((resolve) => setTimeout(resolve, 300));
  next();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const reversalBefore = y();
  next();
  await Promise.resolve();
  const reversalAfter = y();
  if (
    Math.abs(expandedBefore - expandedAfter) > 1 ||
    Math.abs(reversalBefore - reversalAfter) > 1
  )
    throw new Error(
      `Inspector jumped: ${JSON.stringify({ expandedBefore, expandedAfter, reversalBefore, reversalAfter })}`,
    );
  return { expandedBefore, expandedAfter, reversalBefore, reversalAfter };
}
