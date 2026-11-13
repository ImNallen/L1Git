import { useEffect } from "react";
import { animate } from "./motion";

/** A slow first read falls through to the history placeholder instead of holding the splash. */
const LONGEST_SPLASH_MS = 1500;

export function useLaunchSplash(settled: boolean) {
  useEffect(() => {
    if (settled) dismissSplash();
  }, [settled]);
  useEffect(() => {
    const timer = window.setTimeout(dismissSplash, LONGEST_SPLASH_MS);
    return () => window.clearTimeout(timer);
  }, []);
}

function dismissSplash() {
  const splash = document.getElementById("splash");
  if (splash === null || splash.dataset.leaving !== undefined) return;
  splash.dataset.leaving = "";
  splash.style.pointerEvents = "none";
  splash.style.opacity = "0";
  const fade = animate(splash, [{ opacity: 1 }, { opacity: 0 }], 180);
  if (fade === undefined) splash.remove();
  else void fade.finished.finally(() => splash.remove());
}
