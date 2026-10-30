import { useEffect, useRef, useState } from "react";
import { RotateCw, X } from "lucide-react";
import { draftImpact, useDraftImpact } from "../commitDrafts";
import type { DraftImpact } from "../commitDrafts";
import type { CandidateId, Updates } from "../updates";

type RestartConsent = {
  candidate: CandidateId;
  impact: DraftImpact;
  message: string | null;
};

export function useUpdateRestart(updates: Updates) {
  const [consent, setConsent] = useState<RestartConsent | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = useRef(false);
  const impact = useDraftImpact();
  const state = updates.snapshot.state;
  const candidate = state.kind === "downloaded" ? state.candidate.id : null;
  const currentConsent = consent?.candidate === candidate ? consent : null;

  useEffect(() => {
    setConsent((current) =>
      current?.candidate === candidate ? current : null,
    );
  }, [candidate]);

  function cancel() {
    setConsent(null);
  }

  function request(requested: CandidateId) {
    if (requested !== candidate) return;
    const current = draftImpact();
    if (current.tasks || current.frozen || pending.current) {
      setProblem(
        "Commit message work is still finishing. Wait for it to finish, then try again. Your drafts are intact.",
      );
      return;
    }
    setProblem(null);
    setConsent({ candidate: requested, impact: current, message: null });
  }

  async function confirm() {
    if (!currentConsent || pending.current) return;
    pending.current = true;
    try {
      const result = await updates.restart(
        currentConsent.candidate,
        currentConsent.impact.revision,
      );
      setConsent((current) => {
        if (current !== currentConsent) return current;
        if (result.kind === "accepted") return null;
        return {
          ...currentConsent,
          impact: draftImpact(),
          message:
            result.kind === "busy"
              ? "Commit message work is still finishing. Wait, then review and confirm again."
              : "Your drafts changed. Review the updated list and confirm again.",
        };
      });
    } finally {
      pending.current = false;
    }
  }

  return {
    request,
    cancel,
    problem,
    dialog: currentConsent && (
      <RestartDialog
        impact={currentConsent.impact}
        message={currentConsent.message}
        busy={impact.tasks > 0}
        pending={impact.frozen}
        onConfirm={() => void confirm()}
        onClose={cancel}
      />
    ),
  };
}

export type UpdateRestart = ReturnType<typeof useUpdateRestart>;

function RestartDialog({
  impact,
  message,
  busy,
  pending,
  onConfirm,
  onClose,
}: {
  impact: DraftImpact;
  message: string | null;
  busy: boolean;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
  }, []);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const count = impact.drafts.reduce(
    (total, draft) => total + draft.messages,
    0,
  );
  return (
    <dialog
      ref={dialog}
      className="add-dialog"
      aria-labelledby="restart-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="dialog-title">
        <div className="dialog-icon">
          <RotateCw size={20} />
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close restart confirmation"
          onClick={close}
        >
          <X size={17} />
        </button>
      </div>
      <h1 id="restart-title">Restart and install update?</h1>
      <p>
        L1 Git will close and restart. Files and commits on disk stay intact.
      </p>
      {impact.drafts.length > 0 ? (
        <>
          <p>
            All unsaved commit messages will be lost, including messages in
            inactive repositories and messages set aside while amending. This
            affects {count} {count === 1 ? "message" : "messages"} in{" "}
            {impact.drafts.length}{" "}
            {impact.drafts.length === 1 ? "repository" : "repositories"}.
          </p>
          <ul
            className="dialog-paths"
            aria-label="Repositories with unsaved drafts"
          >
            {impact.drafts.map(({ root, messages, amending }) => (
              <li key={root}>
                {root} ({messages} {messages === 1 ? "message" : "messages"}
                {amending ? ", amend in progress" : ""})
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>There are no unsaved commit drafts.</p>
      )}
      {(message || busy || pending) && (
        <p role="alert" className="settings-error">
          {pending
            ? "Installing update…"
            : busy
              ? "Commit message work is still finishing. Wait before confirming."
              : message}
        </p>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="button secondary"
          ref={cancel}
          onClick={close}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`button ${impact.drafts.length ? "danger" : "primary"}`}
          disabled={busy || pending}
          onClick={onConfirm}
        >
          {impact.drafts.length
            ? "Discard drafts and restart"
            : "Restart and install"}
        </button>
      </div>
    </dialog>
  );
}
