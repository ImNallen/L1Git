import { use, useEffect, useState } from "react";
import type { RefObject } from "react";
import { TurnsContext } from "./turns";

/** Whether it is time to show what belongs at a place, of about that weight. */
export function useTurn(
  place: RefObject<Element | null>,
  weight: number,
  load?: () => Promise<unknown>,
): boolean {
  const turns = use(TurnsContext);
  const [isShown, setShown] = useState(false);
  useEffect(() => {
    if (!place.current) return;
    let state: "far" | "loading" | "ready" | "shown" = load ? "far" : "ready";
    const loaded = () => {
      state = "ready";
      turns.wake();
    };
    return turns.join({
      place: place.current,
      next: (isNear) => {
        if (isNear && state === "far") {
          state = "loading";
          load?.().then(loaded, loaded);
        }
        if (state !== "ready" || (load && !isNear)) return null;
        return {
          weight,
          show: () => {
            state = "shown";
            setShown(true);
          },
        };
      },
      putAway: () => {
        state = "ready";
        setShown(false);
      },
    });
  }, [place, turns, weight, load]);
  return isShown;
}
