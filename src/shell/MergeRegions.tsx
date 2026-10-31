import { Suspense } from "react";
import type { AppearanceState } from "../appearance";
import { resolutionKey } from "../resolutionDrafts";
import type { WritesView } from "../useWrites";
import { RetainedResolution } from "./lazyViews";
import type { ResolutionDrafts } from "./useMergePanel";
import type { WorkspaceApi } from "./workspaceView";

export function ResolutionDraftList({ drafts }: { drafts: ResolutionDrafts }) {
  if (drafts.resolutions.length === 0) return null;
  return (
    <div
      className="resolution-draft-list"
      aria-label="Unsaved conflict results"
    >
      <span>Unsaved conflict results</span>
      {drafts.resolutions.map(({ root, path }) => (
        <button
          className="button secondary"
          key={resolutionKey(root, path)}
          title={`${root}/${path}`}
          onClick={() => drafts.openRetained(root, path)}
        >
          {path}
        </button>
      ))}
    </div>
  );
}

export function RetainedResolutionHost({
  drafts,
  changes,
  appearance,
  writes,
}: {
  drafts: ResolutionDrafts;
  changes: WorkspaceApi["changes"];
  appearance: AppearanceState;
  writes: WritesView;
}) {
  const { retained } = drafts;
  if (!retained) return null;
  return (
    <Suspense>
      <RetainedResolution
        {...retained}
        refresh={changes.get(retained.root)}
        theme={appearance.variant.appearance}
        painted={Object.keys(appearance.variant.palette).length > 0}
        writes={writes}
        onClose={drafts.closeRetained}
        onResolved={drafts.closeRetained}
      />
    </Suspense>
  );
}
