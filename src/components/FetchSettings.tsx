import { useEffect, useRef } from "react";
import { fetchIntervals } from "../fetchSettings";
import type { FetchInterval } from "../fetchSettings";

type Props = {
  intervalMinutes: FetchInterval;
  onIntervalChange: (value: FetchInterval) => void;
  persistenceError: string | null;
};

export function FetchSettings({
  intervalMinutes,
  onIntervalChange,
  persistenceError,
}: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  return (
    <section className="settings-page" aria-labelledby="fetching-heading">
      <div className="settings-content">
        <h1 id="fetching-heading" tabIndex={-1} ref={heading}>
          Fetching
        </h1>
        <p className="settings-description">
          When L1 Git downloads new commits from your remotes.
        </p>
        <h2 className="settings-section-title">Schedule</h2>
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
      </div>
    </section>
  );
}
