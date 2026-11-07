import { useEffect, useId, useRef } from "react";
import { Download, LoaderCircle, RotateCw } from "lucide-react";
import type { Updates, UpdateState } from "../updates";
import type { UpdateRestart } from "./UpdateRestart";
import { settingsDestinations } from "../settingsSearch";
import { releaseNotes } from "../domain/releaseNotes";
import { WorkspaceIcon } from "./WorkspaceIcon";

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
      return `No newer ${track} release`;
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
        About
      </h2>
      <div className="settings-row-group">
        <div
          className="settings-row"
          id={settingsDestinations.channel.targetId}
          tabIndex={-1}
        >
          <div>
            <h3 id="update-channel">
              Release channel
              {track !== "stable" && (
                <button
                  type="button"
                  className="settings-reset-small"
                  aria-label="Restore Release channel default"
                  disabled={locked}
                  onClick={() => {
                    restart.cancel();
                    void updates.selectTrack("stable");
                  }}
                >
                  <WorkspaceIcon name="SettingsResetSmall" />
                </button>
              )}
            </h3>
            <p id="update-channel-description">
              Switching channels waits for a newer build.
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
            <h3 role="status" aria-live="polite">
              {statusText(state, trackLabel)}
            </h3>
            <p className="settings-installed">
              Installed · {snapshot.installedVersion}
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
                <WorkspaceIcon name="SettingsRefresh" />
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
      {state.kind === "unavailable" && (
        <p className="settings-description">
          <a href={releases} target="_blank" rel="noreferrer">
            Download releases manually
          </a>
        </p>
      )}
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
  const notes = "candidate" in state ? state.candidate.notes : null;
  const formattedNotes = notes?.trim() ? releaseNotes(notes) : null;
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
          run: updates.check,
        };
      case "failed":
        return { label: "Retry check", run: updates.check };
      case "available":
        return {
          label: state.message ? "Retry download" : "Download update",
          run: () => updates.download(state.candidate.id),
        };
      case "downloaded":
        return {
          label: "Restart and install",
          run: () => restart.request(state.candidate.id),
        };
      case "checking":
        return {
          label: "Checking for updates…",
          run: null,
        };
      case "downloading":
        return {
          label: progress
            ? `Downloading update… ${progress}`
            : "Downloading update…",
          run: null,
        };
      case "installing":
        return { label: "Installing update…", run: null };
      case "unavailable":
        return {
          label: "In-app updates unavailable",
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
  return (
    <span
      className={`sidebar-updater${"candidate" in state ? " has-update" : ""}`}
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
        {"candidate" in state ? (
          <img
            className="update-state-asset"
            src={`/assets/updates/${state.kind === "available" ? "Available" : state.kind === "downloading" ? "Downloading" : "Ready"}.svg`}
            alt=""
          />
        ) : (
          <WorkspaceIcon
            name="UpdateCheck"
            className={`update-check-icon${state.kind === "checking" ? " spin" : ""}`}
          />
        )}
      </button>
      <span
        className={`update-tooltip${"candidate" in state ? " update-release-card" : state.kind === "idle" || state.kind === "current" || state.kind === "checking" ? " update-action-tooltip" : ""}${state.kind === "downloading" || state.kind === "installing" ? " with-progress" : ""}`}
      >
        {"candidate" in state ? (
          <span className="update-release-heading" aria-hidden="true">
            <span className="update-release-glyph">
              <WorkspaceIcon
                name={
                  state.kind === "downloaded" || state.kind === "installing"
                    ? "UpdateInstall"
                    : "UpdateDownload"
                }
              />
            </span>
            <span className="update-release-identity">
              <strong>
                {state.kind === "downloaded" || state.kind === "installing"
                  ? "Ready to install"
                  : "Update available"}
              </strong>
              <span title={state.candidate.version}>
                {state.candidate.version}
              </span>
            </span>
            <span className="update-release-track">
              {track === "stable" ? "Stable" : "Nightly"}
            </span>
          </span>
        ) : (
          <span aria-hidden="true">
            {state.kind === "idle" ||
            state.kind === "current" ||
            state.kind === "checking"
              ? action.label
              : detail}
          </span>
        )}
        {[
          updates.problem,
          preferenceError,
          restart.problem,
          state.kind === "available" || state.kind === "downloaded"
            ? state.message
            : null,
        ]
          .filter(Boolean)
          .map((message, index) => (
            <span className="settings-error" key={index}>
              {message}
            </span>
          ))}
        {notes?.trim() && (
          <span id={notesId} className="update-tooltip-changes">
            <span className="update-notes-heading">
              <span className="update-tooltip-title">What’s changed</span>
              <span className="update-notes-source">GitHub</span>
            </span>
            <span
              className="update-tooltip-notes"
              role="region"
              aria-label="What's changed"
              tabIndex={0}
            >
              {formattedNotes?.kind === "changes" ? (
                <span className="update-note-list" role="list">
                  {formattedNotes.changes.map(
                    ({ title, pullNumber }, index) => (
                      <span
                        className="update-note-row"
                        role="listitem"
                        key={index}
                      >
                        <WorkspaceIcon name="UpdateBullet" />
                        <span className="update-note-title" title={title}>
                          {title}
                        </span>
                        {pullNumber && (
                          <span className="update-note-reference">
                            #{pullNumber}
                          </span>
                        )}
                      </span>
                    ),
                  )}
                </span>
              ) : (
                notes
              )}
            </span>
          </span>
        )}
        {(state.kind === "downloading" || state.kind === "installing") && (
          <span className="update-release-progress">
            <span>
              {state.kind === "installing"
                ? "Restarting L1 Git…"
                : state.total !== null && state.received >= state.total
                  ? "Finishing download…"
                  : "Downloading update…"}
            </span>
            {state.kind === "downloading" && (
              <progress
                aria-label="Update download"
                value={state.total === null ? undefined : state.received}
                max={state.total ?? undefined}
              />
            )}
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
