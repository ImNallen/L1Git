import { paletteItems } from "../actions";
import { AddRepositoryDialog } from "../components/AddRepositoryDialog";
import { CommandPalette } from "../components/CommandPalette";
import { DiscardDialog, DiscardPartDialog } from "../components/DiscardDialog";
import { StashDialog } from "../components/StashDialog";
import type { RecentRepository } from "../domain/recents";
import type { RepositorySnapshot } from "../domain/repository";
import { mac } from "../repositories";
import type { WritesView } from "../useWrites";
import type { ComposedActions } from "./actionSlices";
import type { DiffPane } from "./useDiffPane";
import type { Navigation } from "./useNavigation";
import type { Palette } from "./usePalette";
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

export function PaletteHost({
  palette,
  actions,
  entries,
  snapshot,
}: {
  palette: Pick<Palette, "open" | "close" | "run">;
  actions: ComposedActions;
  entries: RecentRepository[];
  snapshot: RepositorySnapshot | null;
}) {
  if (!palette.open) return null;
  return (
    <CommandPalette
      items={paletteItems(
        actions.context,
        actions.commands,
        mac,
        entries,
        snapshot,
      )}
      onClose={palette.close}
      onRun={palette.run}
    />
  );
}

export function AddRepositoryHost({
  nav,
}: {
  nav: Pick<Navigation, "adding" | "closeAdd" | "addRepository">;
}) {
  if (!nav.adding) return null;
  return (
    <AddRepositoryDialog onAdd={nav.addRepository} onClose={nav.closeAdd} />
  );
}
