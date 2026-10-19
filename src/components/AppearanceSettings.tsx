import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { Moon, Sun } from "lucide-react";
import type { AppearanceState } from "../appearance";
import {
  familyPicks,
  FIXED_APPEARANCE,
  pickedVariant,
  THEME_SLOT,
  themeFamilies,
  type ColorScheme,
  type ThemeFamily,
  type ThemeVariant,
} from "../themes/catalog";
import {
  completePalette,
  TOKEN_NAMES,
  TOKENS,
  type Appearance,
} from "../themes/palette";

type Props = { appearance: AppearanceState };

const SCHEMES: { scheme: ColorScheme; label: string }[] = [
  { scheme: "system", label: "System" },
  { scheme: "light", label: "Light" },
  { scheme: "dark", label: "Dark" },
];

/** The variant's every token as the stylesheet's own custom properties, so a swatch paints with the real rules. */
function paletteStyle(variant: ThemeVariant): CSSProperties {
  const palette = completePalette(variant.appearance, {
    ...variant.palette,
    ...variant.swatch,
  });
  return Object.fromEntries(
    TOKEN_NAMES.map((token) => [TOKENS[token], palette[token]]),
  );
}

function ThemeSwatch({ variant }: { variant: ThemeVariant }) {
  return (
    <span className="theme-swatch" style={paletteStyle(variant)}>
      <span className="theme-swatch-sidebar">
        <span className="theme-swatch-search" />
        <span className="theme-swatch-row" />
        <span className="theme-swatch-row selected" />
        <span className="theme-swatch-row" />
      </span>
      <span className="theme-swatch-main">
        <span className="theme-swatch-button" />
        {[1, 2, 1, 3, 1].map((lane, row) => (
          <span key={row} className="theme-swatch-commit">
            <span style={{ background: `var(--graph-lane-${lane})` }} />
            <span />
          </span>
        ))}
      </span>
      <span className="theme-swatch-inspector">
        <span />
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}

function SchemePreview({
  scheme,
  picks,
}: {
  scheme: ColorScheme;
  picks: Record<Appearance, ThemeVariant>;
}) {
  const fixed = FIXED_APPEARANCE[scheme];
  if (fixed) return <ThemeSwatch variant={picks[fixed]} />;
  return (
    <>
      <ThemeSwatch variant={picks.light} />
      <span className="theme-swatch-split">
        <ThemeSwatch variant={picks.dark} />
      </span>
    </>
  );
}

const ORB_ICON: Record<Appearance, typeof Sun> = { light: Sun, dark: Moon };

const orbSize = (count: number) =>
  count <= 2 ? "large" : count === 3 ? "medium" : "small";

function Orb({
  variant,
  checked,
  onPick,
}: {
  variant: ThemeVariant;
  checked: boolean;
  onPick: () => void;
}) {
  const { background, accent } = variant.swatch;
  const Icon = ORB_ICON[variant.appearance];
  return (
    <label className="theme-orb" title={variant.name}>
      <input
        type="radio"
        name={THEME_SLOT[variant.appearance]}
        value={variant.id}
        aria-label={variant.name}
        checked={checked}
        readOnly
        onClick={onPick}
      />
      <span
        className="theme-orb-fill"
        style={{
          background: `radial-gradient(circle at 32% 28%, ${background} 18%, ${accent} 100%)`,
        }}
      />
      {checked && (
        <span className="theme-orb-badge">
          <Icon size={10} />
        </span>
      )}
    </label>
  );
}

function ThemeCard({
  family,
  picks,
  onPick,
}: {
  family: ThemeFamily;
  picks: Record<Appearance, string>;
  onPick: (variants: readonly ThemeVariant[]) => void;
}) {
  const both = new Set(family.variants.map((v) => v.appearance)).size > 1;
  return (
    <div className="theme-card">
      <div className="theme-orbs" data-size={orbSize(family.variants.length)}>
        {family.variants.map((v) => (
          <Orb
            key={v.id}
            variant={v}
            checked={picks[v.appearance] === v.id}
            onPick={() => onPick([v])}
          />
        ))}
      </div>
      <div className="theme-card-footer">
        <button
          className="theme-card-name"
          title={
            both
              ? `Use ${family.name} for light and dark`
              : `Use ${family.name}`
          }
          onClick={() => onPick(familyPicks(family))}
        >
          {family.name}
        </button>
      </div>
    </div>
  );
}

export function AppearanceSettings({ appearance }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const { settings, persistenceError, nativeError } = appearance;
  const variants = {
    light: pickedVariant(settings, "light"),
    dark: pickedVariant(settings, "dark"),
  };
  const picks = { light: settings.lightTheme, dark: settings.darkTheme };

  return (
    <section className="settings-page" aria-labelledby="appearance-heading">
      <div className="settings-content">
        <h1 id="appearance-heading" tabIndex={-1} ref={heading}>
          Appearance
        </h1>
        <p className="settings-description">How L1 Git looks on this device.</p>
        <fieldset className="settings-group">
          <legend className="settings-section-title">Color scheme</legend>
          <p className="settings-group-description">
            System follows your operating system setting.
          </p>
          <div className="theme-schemes">
            {SCHEMES.map(({ scheme, label }) => (
              <label key={scheme} className="theme-scheme">
                <input
                  type="radio"
                  name="color-scheme"
                  value={scheme}
                  checked={settings.colorScheme === scheme}
                  onChange={() => appearance.setColorScheme(scheme)}
                />
                <span className="theme-scheme-preview">
                  <SchemePreview scheme={scheme} picks={variants} />
                </span>
                <span className="theme-scheme-label">{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <section className="settings-group" aria-labelledby="themes-heading">
          <div className="settings-group-header">
            <div>
              <h2 id="themes-heading" className="settings-section-title">
                Themes
              </h2>
              <p className="settings-group-description">
                Pick one theme for light mode and one for dark.
              </p>
            </div>
          </div>
          <div className="theme-grid">
            {themeFamilies(settings.customThemes).map((family) => (
              <ThemeCard
                key={family.id}
                family={family}
                picks={picks}
                onPick={appearance.chooseThemes}
              />
            ))}
          </div>
        </section>
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
