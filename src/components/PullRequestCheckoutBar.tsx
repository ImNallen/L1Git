import { Fragment, useState } from "react";
import type { Ref } from "react";
import {
  FolderGit2,
  GitBranchPlus,
  LoaderCircle,
  RefreshCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import { hookOutputTail } from "../domain/operations";
import {
  barWords,
  moveOf,
  removable,
  replaceWords,
} from "../domain/pullRequestCheckout";
import type { HeldCheckout } from "../domain/pullRequestCheckout";
import { shortBranch } from "../domain/refs";
import type { Oid } from "../domain/repository";
import type {
  CheckoutSaid,
  CheckoutWrite,
  PullRequestCheckout,
} from "../shell/usePullRequestCheckout";
import { ConfirmDialog } from "./ConfirmDialog";

const failed: Record<
  Extract<CheckoutSaid, { kind: "failed" }>["write"],
  (branch: string) => string
> = {
  update: (branch) => `Could not update ${branch}.`,
  replace: (branch) => `Could not replace ${branch} with the pull request.`,
  remove: () => "Could not remove the worktree.",
};

function Said({
  said,
  branch,
  onDismiss,
}: {
  said: CheckoutSaid;
  branch: string;
  onDismiss: (bar: HTMLElement | null) => void;
}) {
  const problem = said.kind === "removed" ? null : said.problem;
  return (
    <div
      className={`pull-checkout-said ${said.kind}`}
      role={said.kind === "failed" ? "alert" : "status"}
    >
      {said.kind === "removed" ? (
        <FolderGit2 size={14} aria-hidden="true" />
      ) : (
        <TriangleAlert size={14} aria-hidden="true" />
      )}
      <span>
        {said.kind === "removed" &&
          `Removed worktree ${said.name}. Removal cannot be undone.`}
        {said.kind === "failed" && `${failed[said.write](branch)} `}
        {problem?.message}
        {problem &&
          hookOutputTail(problem).map((line, index) => (
            <Fragment key={index}>
              <br />
              <code>{line}</code>
            </Fragment>
          ))}
      </span>
      <button
        type="button"
        className="notice-dismiss"
        aria-label="Dismiss"
        onClick={(event) =>
          onDismiss(event.currentTarget.closest(".pull-checkout-bar"))
        }
      >
        <X size={13} />
      </button>
    </div>
  );
}

function Action({
  write,
  running,
  waiting,
  className,
  onClick,
  children,
}: {
  write: CheckoutWrite;
  running: CheckoutWrite | null;
  waiting: boolean;
  className: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      className={`button ${className}`}
      aria-disabled={running !== null || waiting}
      onClick={() => {
        if (running === null) onClick();
      }}
    >
      {running === write && (
        <LoaderCircle size={14} className="spin" aria-hidden="true" />
      )}
      {children}
    </button>
  );
}

export function PullRequestCheckoutBar({
  ref,
  checkout,
  head,
}: {
  ref: Ref<HTMLDivElement>;
  checkout: PullRequestCheckout;
  head: Oid;
}) {
  const [replacing, setReplacing] = useState(false);
  const { known, running, waiting, said, home } = checkout;
  const dismiss = (bar: HTMLElement | null) => {
    checkout.dismiss();
    bar?.focus();
  };
  if (known.kind === "unreadable")
    return (
      <div ref={ref} className="pull-checkout-bar failed" tabIndex={-1}>
        <p className="pull-checkout-said failed" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>
            Could not read this pull request's local copy.{" "}
            {known.problem.message}
          </span>
          <button
            type="button"
            className="button secondary"
            onClick={checkout.reread}
          >
            Try again
          </button>
        </p>
      </div>
    );
  const held: HeldCheckout | null =
    known.kind === "read" && known.checkout.kind !== "absent"
      ? known.checkout
      : null;
  if (!held)
    return (
      said && (
        <div className="pull-checkout-bar">
          <Said
            said={said}
            branch={shortBranch(
              known.kind === "read" ? known.checkout.branch : "",
            )}
            onDismiss={() => checkout.dismiss()}
          />
        </div>
      )
    );
  const words = barWords(held, home);
  const move = moveOf(held);
  const branch = shortBranch(held.branch);
  const replace =
    move?.kind === "replace" ? replaceWords(held, move.leaving, head) : null;
  return (
    <div
      ref={ref}
      className="pull-checkout-bar"
      role="group"
      aria-label="Local copy"
      aria-busy={running !== null}
      tabIndex={-1}
    >
      <div className="pull-checkout-line">
        <GitBranchPlus size={14} aria-hidden="true" />
        <p role="status">
          {words.lead}{" "}
          <code>
            {words.place.split(/(?<=\/)/).map((part, index) => (
              <Fragment key={index}>
                {index > 0 && <wbr />}
                {part}
              </Fragment>
            ))}
          </code>{" "}
          <span className="pull-checkout-state">· {words.state}</span>
        </p>
        <div className="pull-checkout-actions">
          {move?.kind === "update" && (
            <Action
              write="update"
              running={running}
              waiting={waiting}
              className="primary"
              onClick={checkout.update}
            >
              Update
            </Action>
          )}
          {replace && (
            <Action
              write="replace"
              running={running}
              waiting={waiting}
              className="secondary"
              onClick={() => setReplacing(true)}
            >
              Replace with the pull request…
            </Action>
          )}
          <button
            type="button"
            className="button ghost"
            aria-disabled={running === "remove"}
            onClick={() => {
              if (running !== "remove") checkout.showInHistory();
            }}
          >
            Show in history
          </button>
          {removable(held) && (
            <Action
              write="remove"
              running={running}
              waiting={waiting}
              className="secondary"
              onClick={checkout.remove}
            >
              Remove worktree
            </Action>
          )}
        </div>
      </div>
      {said && <Said said={said} branch={branch} onDismiss={dismiss} />}
      {replacing && replace && (
        <ConfirmDialog
          icon={RefreshCcw}
          title={replace.title}
          closeLabel="Close replace"
          confirm="Replace"
          onConfirm={checkout.replace}
          onClose={() => setReplacing(false)}
        >
          <p>{replace.body}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
