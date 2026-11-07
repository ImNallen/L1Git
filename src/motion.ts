export type MotionElements = Map<string, HTMLElement>;

type Pose = {
  rect: DOMRect;
  width: string;
  opacity: string;
  background: string;
};
const running = new WeakMap<HTMLElement, Animation>();

export const motionAllowed = () =>
  typeof window.matchMedia === "function" &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function animate(
  element: HTMLElement,
  frames: Keyframe[],
  duration: number,
) {
  running.get(element)?.cancel();
  if (!motionAllowed() || typeof element.animate !== "function") return;
  const animation = element.animate(frames, { duration, easing: "ease-out" });
  running.set(element, animation);
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const stop = () => {
    if (preference.matches) animation.cancel();
  };
  preference.addEventListener("change", stop);
  const release = () => {
    preference.removeEventListener("change", stop);
    if (running.get(element) === animation) running.delete(element);
  };
  animation.finished.then(release, release);
  return animation;
}

/** Only mounted elements participate; layout and scroll metrics stay with their renderer. */
export function captureLayout(
  elements: MotionElements,
  { animateWidth = true }: { animateWidth?: boolean } = {},
) {
  const before = new Map<string, Pose>();
  for (const [key, element] of elements) {
    const style = getComputedStyle(element);
    before.set(key, {
      rect: element.getBoundingClientRect(),
      width: style.width,
      opacity: style.opacity,
      background: style.backgroundColor,
    });
  }
  for (const element of elements.values()) running.get(element)?.cancel();
  return (after: MotionElements, duration: number) => {
    for (const [key, element] of after) {
      const old = before.get(key);
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (!old) {
        animate(element, [{ opacity: 0 }, { opacity: 1 }], duration);
        continue;
      }
      const x = old.rect.x - rect.x;
      const y = old.rect.y - rect.y;
      const style = getComputedStyle(element);
      if (
        x ||
        y ||
        (animateWidth && old.rect.width !== rect.width) ||
        old.background !== style.backgroundColor ||
        old.opacity !== style.opacity
      )
        animate(
          element,
          [
            {
              translate: `${x}px ${y}px`,
              ...(animateWidth ? { width: old.width } : {}),
              opacity: old.opacity,
              backgroundColor: old.background,
            },
            {
              translate: "0px 0px",
              ...(animateWidth ? { width: style.width } : {}),
              opacity: 1,
              backgroundColor: style.backgroundColor,
            },
          ],
          duration,
        );
    }
  };
}

export function cancelMotion(elements: MotionElements) {
  for (const element of elements.values()) running.get(element)?.cancel();
}
