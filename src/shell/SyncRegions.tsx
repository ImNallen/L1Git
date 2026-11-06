import { LoaderCircle } from "lucide-react";
import { PublishDialog } from "../components/PublishDialog";
import { pushOutcomeText } from "../domain/push";
import type { PushState } from "../overview";
import type { SyncCommands, SyncControls } from "./sync";
import type { Focus } from "./useFocus";
import type { WriteLoop } from "./useWriteLoop";

export function SyncButtons({
  sync,
  commands,
}: {
  sync: SyncControls;
  commands: SyncCommands;
}) {
  const { root, repository } = sync.opened;
  const { fetching, ready, publishControl } = sync;
  return (
    <>
      {repository && (
        <button
          className="button secondary"
          disabled={fetching}
          onClick={commands.fetch}
          title="Download new commits from this repository's remotes."
        >
          {fetching ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <span className="workspace-action-icon fetch" aria-hidden="true" />
          )}
          <span>Fetch</span>
        </button>
      )}
      {repository && (
        <button
          className="button secondary"
          disabled={repository.activity.kind !== "idle" || ready === 0}
          onClick={commands.fastForward}
          title={`Fast-forward ${ready === 1 ? "1 branch that is" : `${ready} branches that are`} behind and clean. Never merges or rebases.`}
        >
          {repository.activity.kind === "updating" ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <span className="workspace-action-icon pull" aria-hidden="true" />
          )}
          <span>Fast-forward ({ready})</span>
        </button>
      )}
      {root && (
        <button
          className="button secondary"
          disabled={publishControl.kind === "disabled"}
          onClick={commands.push}
          title={publishControl.title}
        >
          {repository?.activity.kind === "pushing" ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <span className="workspace-action-icon push" aria-hidden="true" />
          )}
          <span>
            {repository?.activity.kind === "pushing"
              ? "Pushing…"
              : publishControl.label}
          </span>
        </button>
      )}
    </>
  );
}

export function PushNotice({ push }: { push: PushState | undefined }) {
  if (!push?.notice) return null;
  const { notice } = push;
  return (
    <div
      className={`notice ${notice.outcome.kind === "published" || notice.outcome.kind === "pushed" || notice.outcome.kind === "upToDate" ? "info-notice" : "error-notice"}`}
      role={
        notice.outcome.kind === "published" ||
        notice.outcome.kind === "pushed" ||
        notice.outcome.kind === "upToDate"
          ? "status"
          : "alert"
      }
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
