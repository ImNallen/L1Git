import { settingsDestinations } from "../settingsSearch";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { fetchIntervals } from "../fetchSettings";
import type { FetchInterval } from "../fetchSettings";

export type FetchSettingsProps = {
  intervalMinutes: FetchInterval;
  onIntervalChange: (value: FetchInterval) => void;
  persistenceError: string | null;
};

export function FetchSettings({
  intervalMinutes,
  onIntervalChange,
  persistenceError,
}: FetchSettingsProps) {
  return (
    <section
      className="general-settings-group"
      aria-labelledby="fetching-heading"
    >
      <h2 id="fetching-heading" className="general-settings-title">
        Fetching
      </h2>
      <div
        className="settings-row settings-fetch-row"
        id={settingsDestinations.fetch.targetId}
        tabIndex={-1}
      >
        <div>
          <h3 id="interval-label">
            Background fetch
            {intervalMinutes !== 15 && (
              <button
                type="button"
                className="settings-reset-small"
                aria-label="Restore Background fetch default"
                onClick={() => onIntervalChange(15)}
              >
                <WorkspaceIcon name="SettingsResetSmall" />
              </button>
            )}
          </h3>
          <p id="interval-description">
            Runs while the window is visible. L1 Git also fetches at launch and
            whenever you click Fetch.
          </p>
        </div>
        <div
          className="settings-options"
          role="radiogroup"
          aria-labelledby="interval-label"
          aria-describedby="interval-description"
        >
          {fetchIntervals.map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="fetch-interval"
                value={value}
                checked={intervalMinutes === value}
                onChange={() => onIntervalChange(value)}
              />
              <span>{value === 0 ? "Off" : `${value} min`}</span>
            </label>
          ))}
        </div>
      </div>
      {persistenceError && (
        <p className="settings-error" role="alert">
          {persistenceError}
        </p>
      )}
    </section>
  );
}
