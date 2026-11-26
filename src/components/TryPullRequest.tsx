import { useId, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";
import { Folder, GitBranchPlus, LoaderCircle } from "lucide-react";
import { pushesWords } from "../domain/pullRequestCheckout";
import { shortBranch } from "../domain/refs";
import type { Problem } from "../domain/repository";
import type {
  PullRequestCheckout,
  TryOutcome,
} from "../shell/usePullRequestCheckout";
import { busyProblem, useModalDialog } from "./Dialog";

type Offer = NonNullable<PullRequestCheckout["offer"]>;
const WIDTH = 440;

function useBelow(anchor: RefObject<HTMLElement | null>) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      if (box)
        setAt({
          top: box.bottom + 6,
          right: Math.max(
            16,
            Math.min(
              window.innerWidth - box.right,
              window.innerWidth - 16 - WIDTH,
            ),
          ),
        });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  return at;
}

function TryPopover({
  anchor,
  number,
  offer,
  onCreate,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  number: number;
  offer: Offer;
  onCreate: (folder: string) => Promise<TryOutcome>;
  onClose: () => void;
}) {
  const id = useId();
  const [folder, setFolder] = useState(offer.plan.folder);
  const [form, setForm] = useState<
    { kind: "editing"; failure: Problem | null } | { kind: "creating" }
  >({ kind: "editing", failure: null });
  const { ref, close, onCancel } = useModalDialog(onClose);
  const at = useBelow(anchor);
  const failure = form.kind === "editing" ? form.failure : null;
  const ready = form.kind === "editing" && folder.trim() !== "";

  async function create() {
    if (!ready) return;
    setForm({ kind: "creating" });
    const outcome = await onCreate(folder);
    if (outcome.kind === "ready") close();
    else
      setForm({
        kind: "editing",
        failure: outcome.kind === "busy" ? busyProblem : outcome.problem,
      });
  }

  return (
    <dialog
      ref={ref}
      className="pull-try"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-about`}
      style={at ? { ...at, width: WIDTH } : undefined}
      onCancel={onCancel}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <section>
          <h1 id={`${id}-title`}>
            <GitBranchPlus size={15} aria-hidden="true" />
            Try #{number} locally
          </h1>
          <p id={`${id}-about`}>
            L1 Git checks the pull request out into its own folder, so you can
            run it. The branch you are on and your uncommitted changes stay as
            they are.
          </p>
        </section>
        <section>
          <label htmlFor={`${id}-folder`}>Folder</label>
          <div className="pull-try-field">
            <Folder size={14} aria-hidden="true" />
            <input
              id={`${id}-folder`}
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={folder}
              readOnly={form.kind === "creating"}
              onFocus={({ currentTarget: input }) => {
                const end = input.value.length;
                input.setSelectionRange(end, end);
                input.scrollLeft = input.scrollWidth;
              }}
              aria-invalid={failure !== null}
              aria-describedby={failure ? `${id}-error` : undefined}
              onChange={(event) => {
                setFolder(event.target.value);
                setForm({ kind: "editing", failure: null });
              }}
            />
          </div>
          <label htmlFor={`${id}-branch`}>Local branch</label>
          <div className="pull-try-field">
            <input
              id={`${id}-branch`}
              readOnly
              value={shortBranch(offer.branch)}
              aria-describedby={`${id}-pushes`}
            />
          </div>
          <p id={`${id}-pushes`} className="pull-try-pushes">
            {pushesWords(offer.plan.pushes, offer.head)}
          </p>
          {failure && (
            <p id={`${id}-error`} className="error-message" role="alert">
              {failure.message}
            </p>
          )}
        </section>
        <footer>
          <span>Remove it any time from this pull request.</span>
          <button type="button" className="button ghost" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            aria-disabled={!ready}
          >
            {form.kind === "creating" && (
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
            )}
            Create worktree
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function TryPullRequest({
  ref: button,
  number,
  offer,
  onCreate,
}: {
  ref: RefObject<HTMLButtonElement | null>;
  number: number;
  offer: Offer;
  onCreate: (folder: string) => Promise<TryOutcome>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="button secondary"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <GitBranchPlus size={14} aria-hidden="true" />
        Try it locally
      </button>
      {open && (
        <TryPopover
          anchor={button}
          number={number}
          offer={offer}
          onCreate={onCreate}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </>
  );
}
