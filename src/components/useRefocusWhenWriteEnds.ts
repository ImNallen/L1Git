import { useEffect, useEffectEvent, useRef } from "react";
import { focusIsShown } from "../shell/dom";

export function useRefocusWhenWriteEnds(
  running: string | null,
  isShown: boolean,
  target: () => HTMLElement | null,
) {
  const was = useRef<string | null>(null);
  const refocus = useEffectEvent(() => {
    if (isShown && !focusIsShown()) target()?.focus();
  });
  useEffect(() => {
    const ended = was.current !== null && running === null;
    was.current = running;
    if (ended) refocus();
  }, [running]);
}
