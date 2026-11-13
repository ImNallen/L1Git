import { PublishDialog } from "../components/PublishDialog";
import { pushOutcomeText } from "../domain/push";
import type { PushState } from "../overview";
import type { SyncControls } from "./sync";
import type { Focus } from "./useFocus";
import type { WriteLoop } from "./useWriteLoop";

export function PushNotice({ push }: { push: PushState | undefined }) {
  if (!push?.notice) return null;
  const { notice } = push;
  const succeeded =
    notice.outcome.kind === "published" ||
    notice.outcome.kind === "pushed" ||
    notice.outcome.kind === "upToDate";
  return (
    <div
      className={`notice ${succeeded ? "info-notice" : "error-notice"}`}
      role={succeeded ? "status" : "alert"}
    >
      <span className="workspace-action-icon push" aria-hidden="true" />
      <span>
        {pushOutcomeText(notice.outcome, notice.intent)} {notice.refreshProblem}
      </span>
    </div>
  );
}

export function PublishHost({
  sync,
  loop,
  focus,
}: {
  sync: SyncControls;
  loop: Pick<WriteLoop, "remoteAdded">;
  focus: Pick<Focus, "fallback">;
}) {
  const root = sync.publishingRoot;
  if (!root) return null;
  return (
    <PublishDialog
      key={root}
      root={root}
      onRemoteAdded={() => loop.remoteAdded(root)}
      onPublish={(intent) => sync.publish(root, intent)}
      onClose={() => {
        sync.closePublish();
        focus.fallback();
      }}
    />
  );
}
