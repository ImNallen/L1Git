import { lazy, useEffect } from "react";

// Diffs, highlighting, and the conflict editor load after startup, since no file is open at launch.
const diffViews = () => import("../components/FileDiffPane");
const resolutionViews = () => import("../components/ConflictResolver");
export const FileDiffPane = lazy(() =>
  diffViews().then((m) => ({ default: m.FileDiffPane })),
);
export const RetainedResolution = lazy(() =>
  resolutionViews().then((m) => ({ default: m.RetainedResolution })),
);

export function usePrefetchLazyViews() {
  useEffect(() => {
    // Fetch them once launch has painted, so the first file opens without waiting.
    void diffViews();
    void resolutionViews();
  }, []);
}
