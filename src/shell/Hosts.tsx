import { DiscardPartDialog } from "../components/DiscardDialog";
import type { DiffPane } from "./useDiffPane";

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
