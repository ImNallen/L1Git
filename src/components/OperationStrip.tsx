import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import {
  Check,
  GitCommitHorizontal,
  GitMerge,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import { useCommitDraft } from "../commitDrafts";
import type { CommitDraft } from "../commitDrafts";
import {
  finishBlock,
  operationMessage,
  operationWords,
  progressLabel,
} from "../domain/inProgress";
import type { FinishBlock, InProgress, Running } from "../domain/inProgress";
import { useDraftImpact } from "../draftProtection";
import {
  discardConsentedResolutions,
  resolutionConsent,
} from "../resolutionDrafts";
import { ConfirmDialog } from "./ConfirmDialog";
import { shortOid } from "../domain/shortOid";

type Shown = Exclude<InProgress, { kind: "none" }>;

export function SideChip({
  side,
  children,
}: {
  side: "current" | "incoming";
  children: ReactNode;
}) {
  return (
    <span className={`side-chip ${side}`}>
      <span className="side-chip-dot" aria-hidden="true" />
      <span className="side-chip-name">{children}</span>
    </span>
  );
}

export function IncomingChip({ running }: { running: Running }) {
  const { incoming, subject } = running;
  return (
    <SideChip side="incoming">
      {subject === null || subject === ""
        ? incoming.name
        : `${incoming.name} ${subject}`}
    </SideChip>
  );
}

const finishReasons: Record<FinishBlock | "busy" | "frozen", string> = {
  busy: "Wait for the current operation to finish.",
  frozen: "Wait for L1 Git to restart.",
  unresolved: "Resolve every conflicted file first.",
  unsavedResults: "Save your unsaved conflict results first.",
  notStaged: "Stage the result first.",
  amending: "Turn off Amend in the commit message first.",
  noMessage: "Write a commit message first.",
};

export function OperationStrip({
  shown,
  busy,
  onInspect,
  onFinish,
  onAbort,
  children,
}: {
  shown: Shown;
  busy: boolean;
  onInspect: () => void;
  onFinish: (message: string, draft: CommitDraft) => Promise<unknown>;
  onAbort: () => Promise<boolean>;
  children?: ReactNode;
}) {
  return (
    <>
      {shown.kind === "running" ? (
        <RunningStrip
          running={shown}
          busy={busy}
          onInspect={onInspect}
          onFinish={onFinish}
          onAbort={onAbort}
        />
      ) : shown.kind === "attention" ? (
        <AttentionStrip message={shown.message} />
      ) : (
        <ExternalStrip message={shown.message} />
      )}
      {children}
    </>
  );
}

function ExternalStrip({ message }: { message: string }) {
  const [title = message, ...rest] = message.split(/(?<=\.)\s+/);
  const commands = rest.join(" ");
  return (
    <Strip
      tone="neutral"
      icon={<Terminal size={16} />}
      title={title.replace(/\.$/, "")}
      status={
        <>
          <p className="operation-status">
            Started outside L1 Git. You can resolve files here, then continue or
            abort in your terminal.
          </p>
          {commands.includes("git ") && (
            <p className="operation-status">{commands}</p>
          )}
        </>
      }
    />
  );
}

function Strip({
  tone,
  icon,
  title,
  status,
  children,
}: {
  tone: "warning" | "success" | "error" | "neutral";
  icon: ReactNode;
  title: ReactNode;
  status: ReactNode;
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className={`operation-strip ${tone}`} aria-labelledby={titleId}>
      <span className="operation-badge" aria-hidden="true">
        {icon}
      </span>
      <div className="operation-copy">
        <p className="operation-title" id={titleId}>
          {title}
        </p>
        {status}
      </div>
      {children}
    </section>
  );
}

function AttentionStrip({ message }: { message: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copied !== "copied") return;
    const timer = window.setTimeout(() => setCopied("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Strip
      tone="error"
      icon={<TriangleAlert size={16} />}
      title="Merge needs attention"
      status={
        <p className="operation-status" role="alert">
          {message}
        </p>
      }
    >
      <span className="operation-divider" aria-hidden="true" />
      <button
        className="button secondary"
        onClick={() =>
          navigator.clipboard.writeText(message).then(
            () => setCopied("copied"),
            () => setCopied("failed"),
          )
        }
      >
        {copied === "copied"
          ? "Copied"
          : copied === "failed"
            ? "Could not copy"
            : "Copy recovery steps"}
      </button>
    </Strip>
  );
}

function statusLine(running: Running): string {
  const { phase, progress, verb } = running;
  const { noun } = operationWords[verb];
  switch (phase) {
    case "empty":
      return `The staged result matches HEAD, so there is nothing to commit. Abort ends the ${noun} and keeps every commit.`;
    case "conflicted": {
      const left = progress.unresolved.length;
      return left === 1
        ? `1 file still has a conflict. Resolve it, then finish the ${noun}.`
        : `${left} files still have conflicts. Resolve them, then finish the ${noun}.`;
    }
    case "ready":
      return progress.total === 0
        ? "Review the result, then finish."
        : "All conflicts are resolved. Review the result, then finish.";
  }
}

function Progress({
  running,
  onInspect,
}: {
  running: Running;
  onInspect: () => void;
}) {
  const { progress } = running;
  const { resolved, total } = progress;
  return (
    <button
      className="operation-progress"
      title="Show the files in the inspector"
      onClick={onInspect}
    >
      {total !== null && total > 0 && (
        <span className="operation-segments" aria-hidden="true">
          {Array.from({ length: total }, (_, index) => (
            <span
              key={index}
              className={index < (resolved?.length ?? 0) ? "done" : undefined}
            />
          ))}
        </span>
      )}
      {progressLabel(progress)}
    </button>
  );
}

function RunningStrip({
  running,
  busy,
  onInspect,
  onFinish,
  onAbort,
}: {
  running: Running;
  busy: boolean;
  onInspect: () => void;
  onFinish: (message: string, draft: CommitDraft) => Promise<unknown>;
  onAbort: () => Promise<boolean>;
}) {
  const { root, verb, current, phase, footprint } = running;
  const words = operationWords[verb];
  const [draft] = useCommitDraft(root);
  const impact = useDraftImpact();
  const [aborting, setAborting] = useState<ReturnType<
    typeof resolutionConsent
  > | null>(null);
  const reasonId = useId();
  const { message } = operationMessage(running, draft.draft);
  const stopped = busy || impact.frozen;
  const block = busy
    ? "busy"
    : impact.frozen
      ? "frozen"
      : finishBlock(running, {
          unsavedResults: impact.resolutions.some(
            (shown) => shown.root === root,
          ),
          amending: draft.amend !== null,
          message,
        });
  const reason = block === null ? null : finishReasons[block];
  return (
    <Strip
      tone={
        phase === "conflicted"
          ? "warning"
          : phase === "ready"
            ? "success"
            : "neutral"
      }
      icon={
        phase === "ready" ? (
          <Check size={16} />
        ) : verb === "merge" ? (
          <GitMerge size={16} />
        ) : (
          <GitCommitHorizontal size={16} />
        )
      }
      title={
        <>
          <span>{words.doing}</span> <IncomingChip running={running} />{" "}
          <span>{words.onto}</span>{" "}
          <SideChip side="current">{current.name}</SideChip>
        </>
      }
      status={
        <>
          <p className="operation-status">{statusLine(running)}</p>
          {running.sourceMoved && (
            <p className="operation-status">
              The source branch has moved. This merge still uses the source
              commit you reviewed.
            </p>
          )}
        </>
      }
    >
      <Progress running={running} onInspect={onInspect} />
      <span className="operation-divider" aria-hidden="true" />
      <button
        className="button ghost"
        disabled={stopped}
        onClick={() => setAborting(resolutionConsent(root, footprint))}
      >
        Abort {words.noun}…
      </button>
      {phase !== "empty" && (
        <>
          <button
            className="button primary"
            aria-disabled={reason !== null}
            aria-describedby={reason === null ? undefined : reasonId}
            title={reason ?? undefined}
            onClick={() => {
              if (block === null) void onFinish(message, draft);
            }}
          >
            Finish {words.noun}
          </button>
          {reason !== null && (
            <span id={reasonId} className="visually-hidden">
              {reason}
            </span>
          )}
        </>
      )}
      {aborting && (
        <AbortDialog
          running={running}
          drafts={aborting.map(([, shown]) => shown.snapshot.path)}
          onClose={() => setAborting(null)}
          onConfirm={() => {
            if (stopped) return;
            void onAbort().then((aborted) => {
              if (aborted) discardConsentedResolutions(aborting);
            });
          }}
        />
      )}
    </Strip>
  );
}

function AbortDialog({
  running,
  drafts,
  onClose,
  onConfirm,
}: {
  running: Running;
  drafts: readonly string[];
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { verb, current, progress } = running;
  const { noun, doing } = operationWords[verb];
  const resolved = progress.resolved;
  return (
    <ConfirmDialog
      icon={verb === "merge" ? GitMerge : GitCommitHorizontal}
      title={`Abort this ${noun}?`}
      closeLabel={`Close abort ${noun}`}
      cancel={`Keep ${doing.toLowerCase()}`}
      confirm={`Abort ${noun}`}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p className="abort-lead">
        <SideChip side="current">{current.name}</SideChip> goes back to{" "}
        {current.oid === null ? (
          "where it was"
        ) : (
          <code>{shortOid(current.oid)}</code>
        )}{" "}
        exactly as before you started.
      </p>
      <section className="abort-list discarded" aria-label="Discarded">
        <h2>Discarded</h2>
        <ul>
          {resolved === null ? (
            <li>Saved resolutions in the {noun}&apos;s files</li>
          ) : (
            resolved.map((path) => (
              <li key={`saved:${path}`}>
                <code>{path}</code> <span>saved resolution</span>
              </li>
            ))
          )}
          {drafts.map((path) => (
            <li key={`draft:${path}`}>
              <code>{path}</code> <span>unsaved result draft</span>
            </li>
          ))}
          {resolved?.length === 0 && drafts.length === 0 && (
            <li>Nothing you have resolved yet.</li>
          )}
        </ul>
        {drafts.length > 0 && (
          <p>A draft you change after this opens is kept.</p>
        )}
      </section>
      <section className="abort-list kept" aria-label="Kept">
        <h2>Kept</h2>
        <p>Your commit message draft, untracked files and ignored files.</p>
      </section>
      <p className="abort-note">
        {verb === "merge"
          ? "Unrelated tracked changes block Abort."
          : `A staged change outside the ${noun}'s files blocks Abort.`}{" "}
        This cannot be undone.
      </p>
    </ConfirmDialog>
  );
}
