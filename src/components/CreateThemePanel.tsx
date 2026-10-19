import { useEffect, useId, useState } from "react";
import { Paintbrush, X } from "lucide-react";
import {
  APPEARANCE_LABEL,
  APPEARANCES,
  L1_VARIANTS,
  type ThemeDraft,
  type ThemeFamilyDraft,
  type ThemeVariant,
} from "../themes/catalog";
import { formatHex, isDark, parseHex } from "../themes/color";
import {
  completePalette,
  TOKEN_NAMES,
  type Appearance,
  type Token,
} from "../themes/palette";

type Props = {
  initial: ThemeDraft;
  onCreate: (family: ThemeFamilyDraft) => void;
  onPreview: (variant: ThemeVariant | null) => void;
  onClose: () => void;
};

const SEEDS = ["background", "accent"] as const satisfies readonly Token[];
const ADVANCED = TOKEN_NAMES.filter(
  (t) => t !== "background" && t !== "accent",
);

const FULL_HEX = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;

const represents = (text: string, hex: string) => {
  const parsed = parseHex(text);
  return parsed !== null && formatHex(parsed) === hex;
};

const tokenLabel = (token: Token) =>
  token
    .replace(/[A-Z]|\d+/g, (c) => ` ${c.toLowerCase()}`)
    .replace(/^./, (c) => c.toUpperCase());

function ColorField({
  token,
  value,
  onChange,
}: {
  token: Token;
  value: string;
  onChange: (hex: string) => void;
}) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    if (!represents(text, value)) setText(value);
  }
  const valid = parseHex(text) !== null;
  const change = (next: string) => {
    setText(next);
    const parsed = FULL_HEX.test(next.trim()) && parseHex(next);
    if (parsed) onChange(formatHex(parsed));
  };
  const settle = () => {
    const parsed = parseHex(text);
    const hex = parsed ? formatHex(parsed) : value;
    setText(hex);
    if (hex !== value) onChange(hex);
  };
  const id = `theme-color-${token}`;
  return (
    <div className="theme-color-field">
      <label htmlFor={id}>{tokenLabel(token)}</label>
      <span className="theme-color-chip" style={{ background: value }}>
        <input
          type="color"
          aria-label={`${tokenLabel(token)} picker`}
          value={value.slice(0, 7)}
          onChange={(event) => change(event.target.value + value.slice(7))}
        />
      </span>
      <input
        id={id}
        className="theme-input mono"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={!valid}
        value={text}
        onChange={(event) => change(event.target.value)}
        onBlur={settle}
        onKeyDown={(event) => {
          if (event.key === "Enter") settle();
        }}
      />
    </div>
  );
}

export function CreateThemePanel({
  initial,
  onCreate,
  onPreview,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(initial);
  const [advanced, setAdvanced] = useState(false);
  const titleId = useId();
  const palette = completePalette(draft.appearance, draft.colors);
  const name = draft.name.trim();

  useEffect(() => {
    onPreview({
      id: "draft",
      name: draft.name,
      appearance: draft.appearance,
      swatch: {
        background: draft.colors.background,
        accent: draft.colors.accent,
      },
      palette: completePalette(draft.appearance, draft.colors),
    });
  }, [draft, onPreview]);
  useEffect(() => () => onPreview(null), [onPreview]);

  const setColor = (token: Token, value: string) =>
    setDraft((d) => ({ ...d, colors: { ...d.colors, [token]: value } }));
  const setAppearance = (appearance: Appearance) =>
    setDraft((d) => {
      const fits = isDark(d.colors.background) === (appearance === "dark");
      const background = fits
        ? d.colors.background
        : L1_VARIANTS[appearance].swatch.background;
      return { ...d, appearance, colors: { ...d.colors, background } };
    });
  const create = () => {
    if (!name) return;
    onCreate({ name, variants: [{ ...draft, name }] });
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      className="create-theme-panel"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="create-theme-header">
        <h2 id={titleId}>Create theme</h2>
        <span>Two colors, the rest derived</span>
        <button
          className="icon-button"
          aria-label="Close create theme"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <div className="create-theme-body">
        <div className="create-theme-row">
          <label htmlFor="theme-name">Theme name</label>
          <input
            id="theme-name"
            className="theme-input"
            autoFocus
            autoComplete="off"
            placeholder="e.g. Aurora"
            value={draft.name}
            onChange={(event) =>
              setDraft((d) => ({ ...d, name: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // Closing focuses the opener mid-keystroke, and Enter would then click it.
              event.preventDefault();
              create();
            }}
          />
        </div>
        <div className="create-theme-row">
          <span id="theme-appearance">Appearance</span>
          <div
            className="settings-options"
            role="radiogroup"
            aria-labelledby="theme-appearance"
          >
            {APPEARANCES.map((a) => (
              <label key={a}>
                <input
                  type="radio"
                  name="theme-appearance"
                  value={a}
                  checked={draft.appearance === a}
                  onChange={() => setAppearance(a)}
                />
                <span>{APPEARANCE_LABEL[a]}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="create-theme-row">
          <div>
            <span>Colors</span>
            <small>
              {advanced ? "Every token, editable" : "Background and accent"}
            </small>
          </div>
          <label className="create-theme-advanced">
            Advanced
            <input
              type="checkbox"
              checked={advanced}
              onChange={(event) => setAdvanced(event.target.checked)}
            />
          </label>
        </div>
        <div className="create-theme-colors">
          {(advanced ? [...SEEDS, ...ADVANCED] : SEEDS).map((token) => (
            <ColorField
              key={token}
              token={token}
              value={palette[token]}
              onChange={(value) => setColor(token, value)}
            />
          ))}
        </div>
      </div>
      <footer className="create-theme-footer">
        <button className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={!name}
          title={name ? undefined : "Name the theme first"}
          onClick={create}
        >
          <Paintbrush size={14} />
          Create theme
        </button>
      </footer>
    </div>
  );
}
