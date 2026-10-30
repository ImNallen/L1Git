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
      <p className="settings-description">
        When L1 Git downloads new commits from your remotes.
      </p>
      <p className="settings-section-title">Schedule</p>
      <div className="settings-row">
        <div>
          <h3 id="interval-label">Fetch automatically</h3>
          <p id="interval-description">
            L1 Git always fetches at launch and when you click Fetch. It waits
            while the window is hidden.
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
