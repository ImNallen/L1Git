import { useEffect, useRef } from "react";
import type { ThemePreference } from "../appearance";

type Props = {
  preference: ThemePreference;
  onPreferenceChange: (value: ThemePreference) => void;
  persistenceError: string | null;
  nativeError: string | null;
};

export function AppearanceSettings({
  preference,
  onPreferenceChange,
  persistenceError,
  nativeError,
}: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  return (
    <section className="settings-page" aria-labelledby="appearance-heading">
      <div className="settings-content">
        <h1 id="appearance-heading" tabIndex={-1} ref={heading}>
          Appearance
        </h1>
        <p className="settings-description">How L1 Git looks on this device.</p>
        <h2 className="settings-section-title">Theme</h2>
        <div className="settings-row">
          <div>
            <h3 id="theme-label">Theme</h3>
            <p id="theme-description">
              System follows your operating system setting.
            </p>
          </div>
          <div
            className="settings-options"
            role="radiogroup"
            aria-labelledby="theme-label"
            aria-describedby="theme-description"
          >
            {(["system", "light", "dark"] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={preference === value}
                  onChange={() => onPreferenceChange(value)}
                />
                <span>
                  {value === "system"
                    ? "System"
                    : value === "light"
                      ? "Light"
                      : "Dark"}
                </span>
              </label>
            ))}
          </div>
        </div>
        {persistenceError && (
          <p className="settings-error" role="alert">
            {persistenceError}
          </p>
        )}
        {nativeError && (
          <p className="settings-error" role="alert">
            {nativeError}
          </p>
        )}
      </div>
    </section>
  );
}
