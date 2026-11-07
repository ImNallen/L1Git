import { useEffect, useState } from "react";
import { motionAllowed } from "../motion";
import type { ReactNode } from "react";

export function Collapse({
  open,
  children,
  className = "",
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [retained, setRetained] = useState(open);
  useEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }
    const timer = window.setTimeout(
      () => setRetained(false),
      motionAllowed() ? 220 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [open]);
  return (
    <div
      className={`motion-collapse ${className}`}
      data-open={open}
      inert={!open}
      aria-hidden={!open}
    >
      <div>{(open || retained) && children}</div>
    </div>
  );
}
