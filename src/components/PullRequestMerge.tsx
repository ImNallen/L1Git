import { useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  Eye,
  GitCompareArrows,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MergeBox } from "../domain/mergeBox";
import {
  mergeChoices,
  mergeLabel,
  mergingLabel,
} from "../domain/pullRequestMerge";
import type { MergeMethod } from "../domain/pullRequestMerge";
import type { PullRequest } from "../domain/pullRequest";
import { useMerge } from "../shell/useMerge";
import type { PullRequestCheckout } from "../shell/usePullRequestCheckout";
import type { OpenedPullRequest } from "../shell/usePullRequests";
import { ContextMenu } from "./ContextMenu";
import { MergePopover } from "./MergePopover";
import { Bars } from "./PullRequestParts";

const MENU_WIDTH = 300;
const MENU_HEIGHT = 156;

const mergeIcons: Record<MergeBox["kind"], [LucideIcon, string]> = {
  merged: [GitMerge, "merged"],
  merging: [LoaderCircle, "waiting spin"],
  failed: [CircleX, "bad"],
  checking: [CircleHelp, "waiting"],
  closed: [GitPullRequestClosed, "bad"],
  draft: [GitPullRequestDraft, ""],
  readOnly: [Eye, ""],
  conflicts: [CircleX, "bad"],
  changesRequested: [CircleX, "bad"],
  reviewRequired: [Eye, "waiting"],
  requiredFailing: [CircleX, "bad"],
  behind: [GitCompareArrows, "waiting"],
  blocked: [CircleAlert, "waiting"],
  failing: [CircleX, "bad"],
  running: [CircleDashed, "waiting"],
  ready: [CircleCheck, "good"],
  unknown: [CircleHelp, ""],
};

/** The primary merge button, and a menu that picks the method it uses. */
function SplitButton({
  pull,
  method,
  anyway,
  last,
  onChoose,
  onMerge,
}: {
  pull: PullRequest;
  method: MergeMethod;
  anyway: boolean;
  last: MergeMethod | null;
  onChoose: (method: MergeMethod) => void;
  onMerge: () => void;
}) {
  const chevron = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const close = () => {
    setMenu(null);
    chevron.current?.focus();
  };
  const tone = anyway ? "danger" : "primary";
  return (
    <div className={`merge-split ${tone}`}>
      <button
        type="button"
        className={`button ${tone}`}
        aria-haspopup="dialog"
        onClick={onMerge}
      >
        {mergeLabel(method, anyway)}
      </button>
      <button
        ref={chevron}
        type="button"
        className={`button ${tone}`}
        aria-label="Choose how to merge"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => {
          const rect = chevron.current?.getBoundingClientRect();
          // Above the button, which sits at the bottom of the window.
          if (rect)
            setMenu({ x: rect.right - MENU_WIDTH, y: rect.top - MENU_HEIGHT });
        }}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {menu && (
        <ContextMenu
          className="merge-menu"
          x={menu.x}
          y={menu.y}
          label="Merge method"
          onClose={({ returnFocus }) => (returnFocus ? close() : setMenu(null))}
        >
          {mergeChoices(pull, last).methods.map((choice) => (
            <button
              key={choice.method}
              type="button"
              role="menuitemradio"
              aria-checked={choice.method === method}
              aria-disabled={choice.off}
              onClick={() => {
                if (choice.off) return;
                close();
                onChoose(choice.method);
              }}
            >
              <Check
                size={14}
                visibility={choice.method === method ? "visible" : "hidden"}
                aria-hidden="true"
              />
              <span>
                {choice.label}
                <small>{choice.note}</small>
              </span>
            </button>
          ))}
        </ContextMenu>
      )}
    </div>
  );
}

export function PullRequestMerge({
  opened,
  checkout,
  url,
  onShowCommits,
}: {
  opened: OpenedPullRequest;
  checkout: Pick<PullRequestCheckout, "local" | "deleteLocal">;
  url: string;
  onShowCommits: () => void;
}) {
  const merge = useMerge(opened, checkout);
  const { box, method, notes, progress } = merge;
  const pull = opened.read.value;
  const section = useRef<HTMLElement>(null);
  const [asking, setAsking] = useState(false);
  // Each action replaces the button it started from.
  const stay = () => section.current?.focus({ preventScroll: true });
  if (pull === null || box === null)
    return (
      opened.read.problem === null && (
        <div className="merge-box">
          <Bars count={2} />
        </div>
      )
    );
  const [Icon, tone] = mergeIcons[box.kind];
  const { action } = box;
  const moved =
    progress.kind === "refused" && progress.expectedHead !== pull.head.oid;
  return (
    <section
      ref={section}
      className="merge-box"
      aria-label="Merging"
      tabIndex={-1}
    >
      <Icon className={`merge-icon ${tone}`} size={16} aria-hidden="true" />
      <p className="visually-hidden" role="status">
        {progress.kind === "idle" ? "" : box.title}
        {notes.map((note) => ` ${note.text}`).join("")}
      </p>
      <div className="merge-said">
        <h3>{box.title}</h3>
        <p>{box.text}</p>
        {notes.map((note) => (
          <p
            key={note.text}
            className={note.failed ? "merge-note bad" : "merge-note"}
          >
            {note.text}
          </p>
        ))}
      </div>
      {notes.some((note) => note.failed) && (
        <button
          type="button"
          className="pull-link merge-dismiss"
          onClick={() => {
            merge.dismissNotes();
            stay();
          }}
        >
          Dismiss
        </button>
      )}
      {action.kind === "openOnGitHub" && (
        <a
          className="button secondary"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          Open on GitHub
        </a>
      )}
      {action.kind === "merge" && method !== null && (
        <SplitButton
          pull={pull}
          method={method}
          anyway={action.anyway}
          last={merge.lastUsed()}
          onChoose={merge.choose}
          onMerge={() => setAsking(true)}
        />
      )}
      {action.kind === "merging" && progress.kind === "sending" && (
        <button type="button" className="button secondary" aria-disabled="true">
          <LoaderCircle size={14} className="spin" aria-hidden="true" />
          {mergingLabel(progress.method)}
        </button>
      )}
      {action.kind === "retry" && (
        <button
          type="button"
          className="button primary"
          onClick={() => {
            merge.retry();
            if (moved) onShowCommits();
            else stay();
          }}
        >
          Review and try again
        </button>
      )}
      {action.kind === "deleteLocal" && (
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            merge.deleteLocal();
            stay();
          }}
        >
          Delete local branch
        </button>
      )}
      {asking && method !== null && (
        <MergePopover
          anchor={section}
          pull={pull}
          method={method}
          anyway={action.kind === "merge" && action.anyway}
          last={merge.lastUsed()}
          local={checkout.local}
          onMerge={merge.merge}
          onClose={(merged) => {
            setAsking(false);
            if (merged) stay();
          }}
        />
      )}
    </section>
  );
}
