import { vi } from "vitest";

/** What is near the view, and the frames, as a test says. */
export function installSight() {
  let look: IntersectionObserverCallback = () => {};
  const observed = new Set<Element>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        look = callback;
      }
      observe = (place: Element) => void observed.add(place);
      unobserve = (place: Element) => void observed.delete(place);
    },
  );
  const frames = new Map<number, FrameRequestCallback>();
  let asked = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    asked += 1;
    frames.set(asked, callback);
    return asked;
  });
  return {
    observed,
    see(isIntersecting: boolean, ...places: Element[]) {
      look(
        places.map(
          (target) => ({ target, isIntersecting }) as IntersectionObserverEntry,
        ),
        {} as IntersectionObserver,
      );
    },
    frame() {
      const now = [...frames.values()];
      frames.clear();
      for (const callback of now) callback(0);
      return now.length > 0;
    },
  };
}
