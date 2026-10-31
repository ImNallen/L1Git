import { useEffect, useId, useRef } from "react";
import { Download, LoaderCircle, RefreshCw, RotateCw } from "lucide-react";
import type { Updates, UpdateState } from "../updates";
import type { UpdateRestart } from "./UpdateRestart";
import { settingsDestinations } from "../settingsSearch";

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

export function UpdatesSettings({
  updates,
  restart,
}: {
  updates: Updates;
  restart: UpdateRestart;
}) {
  const { snapshot, problem } = updates;
  const { state, track } = snapshot;
  const locked = state.kind === "installing" || state.kind === "unavailable";
  const checking =
    state.kind === "checking" ||
    state.kind === "downloading" ||
    state.kind === "downloaded";
  const trackLabel = track === "stable" ? "Stable" : "Nightly";
  return (
    <section
      className="general-settings-group"
      aria-labelledby="updates-heading"
    >
      <h2 id="updates-heading" className="general-settings-title">
        Updates
      </h2>
      <div className="settings-row-group">
        <div
          className="settings-row"
          id={settingsDestinations.channel.targetId}
          tabIndex={-1}
        >
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
                    restart.cancel();
                    void updates.selectTrack(value);
                  }}
                />
                <span>{value === "stable" ? "Stable" : "Nightly"}</span>
              </label>
            ))}
          </div>
        </div>
        <div
          className="settings-row settings-update-version"
          id={settingsDestinations.updates.targetId}
          tabIndex={-1}
        >
          <div className="settings-update-status">
            <h3>Version {snapshot.installedVersion}</h3>
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
          </div>
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
                onClick={() => restart.request(state.candidate.id)}
              >
                <RotateCw size={14} />
                Restart and install
              </button>
            )}
          </div>
        </div>
      </div>
      {(state.kind === "available" || state.kind === "downloaded") &&
        state.message && (
          <p className="settings-error" role="alert">
            {state.message}
          </p>
        )}
      {(problem || snapshot.preferenceError || restart.problem) && (
        <p className="settings-error" role="alert">
          {problem ?? snapshot.preferenceError ?? restart.problem}
        </p>
      )}
      {"candidate" in state && state.candidate.notes && (
        <>
          <p className="settings-section-title">Release notes</p>
          <pre className="update-notes">{state.candidate.notes}</pre>
        </>
      )}
      <p className="settings-description">
        L1 Git checks at startup and hourly. Downloads and restart always need
        your action.{" "}
        <a href={releases} target="_blank" rel="noreferrer">
          Download releases manually
        </a>
      </p>
    </section>
  );
}

export function UpdateAffordance({
  updates,
  restart,
}: {
  updates: Updates;
  restart: UpdateRestart;
}) {
  const statusId = useId();
  const notesId = useId();
  const { state, track, preferenceError } = updates.snapshot;
  const notes =
    state.kind === "available" || state.kind === "downloaded"
      ? state.candidate.notes
      : null;
  const descriptionId = notes?.trim() ? `${statusId} ${notesId}` : statusId;
  if (state.kind === "unavailable" && state.reason === "development")
    return null;
  const progress =
    state.kind === "downloading" && state.total !== null
      ? `${Math.min(100, Math.floor((state.received / state.total) * 100))}%`
      : null;
  const action = (() => {
    switch (state.kind) {
      case "idle":
      case "current":
        return {
          label: "Check for updates",
          Icon: RefreshCw,
          run: updates.check,
        };
      case "failed":
        return { label: "Retry check", Icon: RefreshCw, run: updates.check };
      case "available":
        return {
          label: state.message ? "Retry download" : "Download update",
          Icon: Download,
          run: () => updates.download(state.candidate.id),
        };
      case "downloaded":
        return {
          label: "Restart and install",
          Icon: RotateCw,
          run: () => restart.request(state.candidate.id),
        };
      case "checking":
        return {
          label: "Checking for updates…",
          Icon: RefreshCw,
          run: null,
        };
      case "downloading":
        return {
          label: progress
            ? `Downloading update… ${progress}`
            : "Downloading update…",
          Icon: LoaderCircle,
          run: null,
        };
      case "installing":
        return { label: "Installing update…", Icon: LoaderCircle, run: null };
      case "unavailable":
        return {
          label: "In-app updates unavailable",
          Icon: RefreshCw,
          run: null,
        };
      default: {
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  })();
  const detail = [
    state.kind === "unavailable" ? null : action.label,
    statusText(state, track === "stable" ? "Stable" : "Nightly"),
    updates.problem,
    preferenceError,
    restart.problem,
    state.kind === "available" || state.kind === "downloaded"
      ? state.message
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  const { Icon } = action;
  return (
    <span
      className="sidebar-updater"
      role="group"
      tabIndex={action.run === null ? 0 : undefined}
      aria-label="App updates"
      aria-describedby={action.run === null ? statusId : undefined}
    >
      <button
        type="button"
        className="icon-button"
        aria-label={action.label}
        aria-describedby={descriptionId}
        disabled={action.run === null}
        onClick={() => void action.run?.()}
      >
        <Icon
          size={16}
          className={
            state.kind === "checking" || Icon === LoaderCircle
              ? "spin"
              : undefined
          }
          aria-hidden="true"
        />
      </button>
      <span className="update-tooltip">
        <span aria-hidden="true">{detail}</span>
        {notes?.trim() && (
          <span id={notesId} className="update-tooltip-changes">
            <span className="update-tooltip-title">What's changed</span>
            <span
              className="update-tooltip-notes"
              role="region"
              aria-label="What's changed"
              tabIndex={0}
            >
              {notes}
            </span>
          </span>
        )}
      </span>
      <span
        id={statusId}
        className="visually-hidden"
        role="status"
        aria-live="polite"
      >
        {detail}
      </span>
    </span>
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
