import { PublishDialog } from "../components/PublishDialog";
import type { SyncControls } from "./sync";
import type { Focus } from "./useFocus";
import type { WriteLoop } from "./useWriteLoop";

export function PublishHost({
  sync,
  loop,
  focus,
}: {
  sync: SyncControls;
  loop: Pick<WriteLoop, "rereadRefs">;
  focus: Pick<Focus, "fallback">;
}) {
  const root = sync.publishingRoot;
  if (!root) return null;
  return (
    <PublishDialog
      key={root}
      root={root}
      onRemoteAdded={() => loop.rereadRefs(root)}
      onPublish={(intent) => sync.publish(root, intent)}
      onClose={() => {
        sync.closePublish();
        focus.fallback();
      }}
    />
  );
}
