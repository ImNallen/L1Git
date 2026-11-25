import { lazy, useEffect } from "react";

// Diffs, highlighting, and the conflict editor load after startup, since no file is open at launch.
const diffViews = () => import("../components/FileDiffPane");
const resolutionViews = () => import("../components/ConflictResolver");
const code = () => import("../components/Code");
const hunk = () => import("../components/Hunk");
export const FileDiffPane = lazy(() =>
  diffViews().then((m) => ({ default: m.FileDiffPane })),
);
export const RetainedResolution = lazy(() =>
  resolutionViews().then((m) => ({ default: m.RetainedResolution })),
);
export const Code = lazy(() => code().then((m) => ({ default: m.Code })));
export const Hunk = lazy(() => hunk().then((m) => ({ default: m.Hunk })));

export function usePrefetchLazyViews() {
  useEffect(() => {
    // Fetch them once launch has painted, so the first file opens without waiting.
    void diffViews();
    void resolutionViews();
    void code();
    void hunk();
  }, []);
}
