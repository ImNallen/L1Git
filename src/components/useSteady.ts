import { useLayoutEffect, useState } from "react";

/** The newest value, or the one before it for as long as `isHeld`. */
export function useSteady<T>(newest: T, isHeld: () => boolean): T {
  const [steady, setSteady] = useState(newest);
  useLayoutEffect(() => {
    if (Object.is(steady, newest)) return;
    const settle = () => {
      if (!isHeld()) setSteady(newest);
    };
    settle();
    document.addEventListener("selectionchange", settle);
    return () => document.removeEventListener("selectionchange", settle);
  }, [steady, newest, isHeld]);
  return steady;
}
