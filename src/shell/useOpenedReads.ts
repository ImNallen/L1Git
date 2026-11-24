import { useEffect, useEffectEvent, useRef } from "react";
import type { FetchInterval } from "../fetchSettings";
import type { PullRequest } from "../domain/pullRequest";
import type { Read } from "../pullRequests";

const FOCUS_REFRESH_MS = 30_000;
const RUNNING_REFRESH_MS = 30_000;
const UNKNOWN_REFRESH_MS = 3_000;
const UNKNOWN_READS = 3;

/**
 * When the open pull request is read. `visit` names one look at it by one
 * sign-in, and is null while none is on screen. `read` follows no rules;
 * `limited` and `locked` are the list's, which this asks by too.
 */
export function useOpenedReads({
  visit,
  opened: { value, at, reading },
  read,
  limited,
  locked,
  intervalMinutes,
}: {
  visit: string | null;
  opened: Read<PullRequest>;
  read: () => void;
  limited: () => boolean;
  locked: boolean;
  intervalMinutes: FetchInterval;
}) {
  const readAt = useRef(0);
  const unknownReads = useRef(0);
  const readNow = () => {
    readAt.current = Date.now();
    read();
  };
  const readOnVisit = useEffectEvent(() => {
    unknownReads.current = 0;
    if (value === null || !limited()) readNow();
  });
  const readInBackground = useEffectEvent(() => {
    if (document.visibilityState === "visible" && !limited() && !locked)
      readNow();
  });
  const readOnFocus = useEffectEvent(() => {
    if (Date.now() - readAt.current >= FOCUS_REFRESH_MS) readInBackground();
  });
  const readUnknown = useEffectEvent(() => {
    if (unknownReads.current >= UNKNOWN_READS) return;
    unknownReads.current += 1;
    readInBackground();
  });

  const visited = visit !== null;
  const running =
    visited &&
    value?.checks?.items.some(({ state }) => state === "running") === true;
  const unknown =
    visited &&
    !reading &&
    value?.state.kind === "open" &&
    value.mergeable === "unknown";
  useEffect(() => {
    if (visit !== null) readOnVisit();
  }, [visit]);
  useEffect(() => {
    if (!visited) return;
    const focused = () => readOnFocus();
    window.addEventListener("focus", focused);
    return () => window.removeEventListener("focus", focused);
  }, [visited]);
  useEffect(() => {
    if (!visited || intervalMinutes === 0) return;
    const timer = window.setInterval(
      () => readInBackground(),
      intervalMinutes * 60_000,
    );
    return () => window.clearInterval(timer);
  }, [visited, intervalMinutes]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(
      () => readInBackground(),
      RUNNING_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [running]);
  // GitHub works it out after it was asked, so the next answer has it.
  useEffect(() => {
    if (!unknown) return;
    const timer = window.setTimeout(() => readUnknown(), UNKNOWN_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [unknown, at]);
}
