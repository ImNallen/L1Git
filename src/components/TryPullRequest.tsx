import { useId, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Folder, GitBranchPlus, LoaderCircle } from "lucide-react";
import { pushesWords, underHome } from "../domain/pullRequestCheckout";
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
  home,
  onCreate,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  number: number;
  offer: Offer;
  home: string | null;
  onCreate: (folder: string) => Promise<TryOutcome>;
  onClose: () => void;
}) {
  const id = useId();
  const [folder, setFolder] = useState(underHome(offer.plan.folder, home));
  const [form, setForm] = useState<
    { kind: "editing"; failure: Problem | null } | { kind: "creating" }
  >({ kind: "editing", failure: null });
  const creating = form.kind === "creating";
  const { ref, close, onCancel } = useModalDialog(onClose);
  const field = useRef<HTMLInputElement>(null);
  const at = useBelow(anchor);
  useLayoutEffect(() => {
    const input = field.current;
    if (input && at) input.scrollLeft = input.scrollWidth;
  }, [at]);
  const failure = form.kind === "editing" ? form.failure : null;
  const fetchable = !(
    offer.plan.pushes.kind === "nowhere" && offer.plan.pushes.why === "noRemote"
  );
  const ready = fetchable && !creating && folder.trim() !== "";

  async function create() {
    if (!ready) return;
    setForm({ kind: "creating" });
    const outcome = await onCreate(folder);
    if (outcome.kind === "ready") return close();
    setForm({
      kind: "editing",
      failure: outcome.kind === "busy" ? busyProblem : outcome.problem,
    });
    field.current?.focus();
  }

  return (
    <dialog
      ref={ref}
      className="pull-try"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-about`}
      aria-busy={creating}
      style={at ? { ...at, width: WIDTH } : undefined}
      onCancel={(event) => {
        if (creating) event.preventDefault();
        else onCancel(event);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !creating) close();
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
              ref={field}
              id={`${id}-folder`}
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={folder}
              readOnly={creating}
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
          <button
            type="button"
            className="button ghost"
            aria-disabled={creating}
            onClick={() => {
              if (!creating) close();
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            aria-disabled={!ready}
            aria-describedby={fetchable ? undefined : `${id}-pushes`}
          >
            {creating && (
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
  home,
  onCreate,
}: {
  ref: RefObject<HTMLButtonElement | null>;
  number: number;
  offer: Offer;
  home: string | null;
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
          home={home}
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
