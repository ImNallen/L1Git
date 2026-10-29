import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, RotateCw, X } from "lucide-react";
import { draftImpact, useDraftImpact } from "../commitDrafts";
import type { DraftImpact } from "../commitDrafts";
import type { CandidateId, Updates, UpdateState } from "../updates";

const releases = "https://github.com/ImNallen/L1Git/releases";
const unavailable = {
  browser:
    "In-app updates are unavailable in the browser preview. Use a packaged L1 Git app, or download a release manually.",
  development:
    "In-app updates are unavailable in development builds. Use a packaged release to update, or download one manually.",
  manualLinux:
    "This Linux installation is not an AppImage. Update it with your package manager or download a release manually.",
  unsupported:
    "In-app updates are unavailable on this platform. Download a release manually.",
};
function statusText(state: UpdateState, track: string): string {
  switch (state.kind) {
    case "unavailable":
      return unavailable[state.reason];
    case "idle":
      return "Ready to check for updates.";
    case "checking":
      return "Checking for updates…";
    case "current":
      return `No newer ${track} release. Your current build will stay installed.`;
    case "available":
      return `L1 Git ${state.candidate.version} is available.`;
    case "downloading":
      return `Downloading L1 Git ${state.candidate.version}…`;
    case "downloaded":
      return `L1 Git ${state.candidate.version} is verified and ready to install.`;
    case "installing":
      return `Installing L1 Git ${state.candidate.version} and restarting…`;
    case "failed":
      return state.message;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

export function UpdatesSettings({ updates }: { updates: Updates }) {
  const { snapshot, problem } = updates;
  const { state, track } = snapshot;
  const heading = useRef<HTMLHeadingElement>(null);
  const [consent, setConsent] = useState<{
    candidate: CandidateId;
    impact: DraftImpact;
    message: string | null;
  } | null>(null);
  const [restartProblem, setRestartProblem] = useState<string | null>(null);
  const impact = useDraftImpact();
  useEffect(() => heading.current?.focus(), []);

  function requestRestart(candidate: CandidateId) {
    const current = draftImpact();
    if (current.tasks || current.frozen) {
      setRestartProblem(
        "Commit message work is still finishing. Wait for it to finish, then try again. Your drafts are intact.",
      );
      return;
    }
    setRestartProblem(null);
    setConsent({ candidate, impact: current, message: null });
  }
  async function confirmRestart() {
    if (!consent) return;
    const result = await updates.restart(
      consent.candidate,
      consent.impact.revision,
    );
    if (result.kind !== "accepted") {
      setConsent({
        ...consent,
        impact: draftImpact(),
        message:
          result.kind === "busy"
            ? "Commit message work is still finishing. Wait, then review and confirm again."
            : "Your drafts changed. Review the updated list and confirm again.",
      });
      return;
    }
    setConsent(null);
  }

  const locked = state.kind === "installing" || state.kind === "unavailable";
  const checking =
    state.kind === "checking" ||
    state.kind === "downloading" ||
    state.kind === "downloaded";
  const trackLabel = track === "stable" ? "Stable" : "Nightly";
  return (
    <section className="settings-page" aria-labelledby="updates-heading">
      <div className="settings-content">
        <h1 id="updates-heading" ref={heading} tabIndex={-1}>
          Updates
        </h1>
        <p className="settings-description">
          Installed version {snapshot.installedVersion}. Downloads and restart
          always need your action.
        </p>
        <h2 className="settings-section-title">Release channel</h2>
        <div className="settings-row">
          <div>
            <h3 id="update-channel">Update channel</h3>
            <p id="update-channel-description">
              Stable releases or early Nightly builds. Switching channels waits
              for a newer version and never downgrades.
            </p>
          </div>
          <div
            className="settings-options"
            role="radiogroup"
            aria-labelledby="update-channel"
            aria-describedby="update-channel-description"
          >
            {(["stable", "nightly"] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="update-channel"
                  checked={track === value}
                  disabled={locked}
                  onChange={() => {
                    setConsent(null);
                    void updates.selectTrack(value);
                  }}
                />
                <span>{value === "stable" ? "Stable" : "Nightly"}</span>
              </label>
            ))}
          </div>
        </div>
        <h2 className="settings-section-title">App updates</h2>
        <p role="status" aria-live="polite">
          {statusText(state, trackLabel)}
        </p>
        {state.kind === "downloading" && (
          <div className="update-progress">
            <progress
              aria-label="Update download"
              value={state.total === null ? undefined : state.received}
              max={state.total ?? undefined}
            />
            <span>
              {state.received.toLocaleString()} bytes
              {state.total === null
                ? ""
                : ` of ${state.total.toLocaleString()}`}
            </span>
          </div>
        )}
        <div className="update-actions">
          <button
            type="button"
            className="button secondary"
            disabled={locked || checking}
            onClick={() => void updates.check()}
          >
            {state.kind === "checking" ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <RotateCw size={14} />
            )}{" "}
            {state.kind === "failed" ? "Retry check" : "Check for updates"}
          </button>
          {state.kind === "available" && (
            <button
              type="button"
              className="button primary"
              onClick={() => void updates.download(state.candidate.id)}
            >
              <Download size={14} />
              {state.message ? "Retry download" : "Download update"}
            </button>
          )}
          {state.kind === "downloaded" && (
            <button
              type="button"
              className="button primary"
              onClick={() => requestRestart(state.candidate.id)}
            >
              <RotateCw size={14} />
              Restart and install
            </button>
          )}
        </div>
        {(state.kind === "available" || state.kind === "downloaded") &&
          state.message && (
            <p className="settings-error" role="alert">
              {state.message}
            </p>
          )}
        {(problem || snapshot.preferenceError || restartProblem) && (
          <p className="settings-error" role="alert">
            {problem ?? snapshot.preferenceError ?? restartProblem}
          </p>
        )}
        {"candidate" in state && state.candidate.notes && (
          <>
            <h2 className="settings-section-title">Release notes</h2>
            <pre className="update-notes">{state.candidate.notes}</pre>
          </>
        )}
        <p className="settings-description">
          L1 Git checks at startup and hourly.{" "}
          <a href={releases} target="_blank" rel="noreferrer">
            Download releases manually
          </a>
        </p>
      </div>
      {consent && (
        <RestartDialog
          impact={consent.impact}
          message={consent.message}
          busy={impact.tasks > 0}
          onConfirm={() => void confirmRestart()}
          onClose={() => setConsent(null)}
        />
      )}
    </section>
  );
}

function RestartDialog({
  impact,
  message,
  busy,
  onConfirm,
  onClose,
}: {
  impact: DraftImpact;
  message: string | null;
  busy: boolean;
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
      {(message || busy) && (
        <p role="alert" className="settings-error">
          {busy
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
          disabled={busy}
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

export function UpdateAffordance({
  state,
  onOpen,
}: {
  state: UpdateState;
  onOpen: () => void;
}) {
  if (
    state.kind !== "available" &&
    state.kind !== "downloaded" &&
    state.kind !== "downloading"
  )
    return null;
  return (
    <button
      type="button"
      className="update-affordance settings-back"
      onClick={onOpen}
    >
      <Download size={14} />
      <span>
        {state.kind === "downloaded"
          ? "Update ready to install"
          : state.kind === "downloading"
            ? "Downloading update…"
            : "Update available"}
      </span>
    </button>
  );
}

export function InstallingBlocker({ state }: { state: UpdateState }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (state.kind === "installing") dialog.current?.showModal();
    else dialog.current?.close();
  }, [state.kind]);
  return (
    <dialog
      ref={dialog}
      className="add-dialog installing-blocker"
      onKeyDown={(event) => event.stopPropagation()}
      aria-labelledby="installing-title"
      onCancel={(event) => event.preventDefault()}
    >
      <LoaderCircle size={24} className="spin" />
      <h1 id="installing-title">Installing update</h1>
      <p role="status" aria-live="assertive">
        L1 Git is installing and restarting. Please wait.
      </p>
    </dialog>
  );
}
