import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { ContextMenu } from "./ContextMenu";

const MENU_WIDTH = 300;
/** Each choice's row, and the menu's padding. */
const CHOICE_HEIGHT = 48;
const MENU_PADDING = 12;

export type SplitChoice<K extends string> = {
  key: K;
  label: string;
  note: string;
  off: boolean;
};

/** A primary button, and an arrow whose menu picks what the button does. The
 * button takes the name of the choice. */
export function SplitButton<K extends string>({
  label,
  tone,
  choices,
  chosen,
  menuLabel,
  chooseLabel,
  opensDialog = false,
  busy = false,
  unavailable = false,
  icon,
  container,
  onChoose,
  onRun,
}: {
  label: string;
  tone: "primary" | "danger";
  choices: readonly SplitChoice<K>[];
  chosen: K;
  menuLabel: string;
  chooseLabel: string;
  /** The button asks before it acts. */
  opensDialog?: boolean;
  /** Both halves stay in place and do nothing. */
  busy?: boolean;
  unavailable?: boolean;
  icon?: ReactNode;
  /** The modal dialog it sits in, which its menu has to be inside. */
  container?: Element | null;
  onChoose: (key: K) => void;
  onRun: () => void;
}) {
  const id = useId();
  const chevron = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const close = () => {
    setMenu(null);
    chevron.current?.focus();
  };
  const off = busy || unavailable;
  return (
    <div className={`merge-split ${tone}`}>
      <button
        type="button"
        className={`button ${tone}`}
        aria-haspopup={opensDialog ? "dialog" : undefined}
        aria-disabled={off || undefined}
        onClick={() => {
          if (!off) onRun();
        }}
      >
        {icon}
        {label}
      </button>
      <button
        ref={chevron}
        type="button"
        className={`button ${tone}`}
        aria-label={chooseLabel}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (busy) return;
          const rect = chevron.current?.getBoundingClientRect();
          // Above the button, which sits at the bottom of its box.
          if (rect)
            setMenu({
              x: rect.right - MENU_WIDTH,
              y: rect.top - choices.length * CHOICE_HEIGHT - MENU_PADDING,
            });
        }}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {menu && (
        <ContextMenu
          className="merge-menu"
          x={menu.x}
          y={menu.y}
          label={menuLabel}
          container={container}
          onClose={({ returnFocus }) => (returnFocus ? close() : setMenu(null))}
        >
          {choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              role="menuitemradio"
              aria-label={choice.label}
              aria-describedby={`${id}-${choice.key}`}
              aria-checked={choice.key === chosen}
              aria-disabled={choice.off}
              onClick={() => {
                if (choice.off) return;
                close();
                onChoose(choice.key);
              }}
            >
              <Check
                size={14}
                visibility={choice.key === chosen ? "visible" : "hidden"}
                aria-hidden="true"
              />
              <span>
                {choice.label}
                <small id={`${id}-${choice.key}`}>{choice.note}</small>
              </span>
            </button>
          ))}
        </ContextMenu>
      )}
    </div>
  );
}
