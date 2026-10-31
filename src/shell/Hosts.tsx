import { DiscardDialog, DiscardPartDialog } from "../components/DiscardDialog";
import { StashDialog } from "../components/StashDialog";
import type { WritesView } from "../useWrites";
import type { DiffPane } from "./useDiffPane";
import type { Staging } from "./useStaging";

export function StashHost({
  staging,
  writes,
}: {
  staging: Pick<Staging, "stashing" | "closeStash">;
  writes: Pick<WritesView, "write" | "dismiss">;
}) {
  const { stashing } = staging;
  if (!stashing) return null;
  return (
    <StashDialog
      paths={stashing.paths}
      includeUntracked={stashing.untracked}
      head={stashing.head}
      onWrite={async (write) => {
        const outcome = await writes.write(stashing.root, write);
        if (outcome.kind === "failed") writes.dismiss();
        return outcome;
      }}
      onClose={staging.closeStash}
    />
  );
}

export function DiscardHost({
  staging,
  writes,
}: {
  staging: Pick<Staging, "discarding" | "closeDiscard">;
  writes: Pick<WritesView, "write">;
}) {
  const { discarding } = staging;
  if (!discarding) return null;
  return (
    <DiscardDialog
      paths={discarding.paths}
      skipped={discarding.skipped}
      onDiscard={() => void writes.write(discarding.root, discarding.write)}
      onClose={() => {
        staging.closeDiscard();
        discarding.returnFocus?.();
      }}
    />
  );
}

export function DiscardPartHost({ diff }: { diff: Pick<DiffPane, "parts"> }) {
  const { parts } = diff;
  if (!parts.discarding) return null;
  return (
    <DiscardPartDialog
      path={parts.discarding.path}
      choice={parts.discarding.choice}
      effect={parts.discarding.effect}
      onDiscard={parts.confirmDiscard}
      onClose={parts.closeDiscard}
    />
  );
}
