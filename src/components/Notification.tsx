import { useEffect, useEffectEvent, useRef, useState } from "react";
import { X } from "lucide-react";
import type { CSSProperties, ReactNode, Ref } from "react";

export type NotificationAction = {
  label: string;
  run: () => void;
  primary?: boolean;
  unavailable?: boolean;
};

type Dismissal =
  | { onDismiss?: undefined; expiresAfter?: undefined }
  | {
      onDismiss: () => void;
      /** Milliseconds shown before it dismisses itself, held while pointed at or focused. */
      expiresAfter?: number;
    };

/** A popup over the panes, so showing or hiding one never moves them. */
export function Notification({
  tone,
  icon,
  children,
  output = [],
  actions = [],
  actionsBelow = false,
  onDismiss,
  expiresAfter,
  ref,
}: {
  tone: "info" | "error";
  icon: ReactNode;
  children: ReactNode;
  /** Lines of command output, shown under the message as Git printed them. */
  output?: readonly string[];
  actions?: readonly NotificationAction[];
  actionsBelow?: boolean;
  ref?: Ref<HTMLDivElement>;
} & Dismissal) {
  const [held, setHeld] = useState({ pointer: false, focus: false });
  const isHeld = held.pointer || held.focus;
  useExpiry(expiresAfter, isHeld, onDismiss);
  const buttons = actions.map((action) => (
    <button
      key={action.label}
      className={`notification-action${action.primary ? " primary" : ""}`}
      aria-disabled={action.unavailable}
      onClick={() => {
        if (!action.unavailable) action.run();
      }}
    >
      {action.label}
    </button>
  ));
  return (
    <div
      ref={ref}
      className={`notification ${tone}${output.length > 0 || actionsBelow ? " stacked" : ""}`}
      role={tone === "error" ? "alert" : "status"}
      data-held={(expiresAfter !== undefined && isHeld) || undefined}
      onPointerEnter={() => setHeld((shown) => ({ ...shown, pointer: true }))}
      onPointerLeave={() => setHeld((shown) => ({ ...shown, pointer: false }))}
      onFocus={() => setHeld((shown) => ({ ...shown, focus: true }))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setHeld((shown) => ({ ...shown, focus: false }));
      }}
    >
      <div className="notification-row">
        {icon}
        <span className="notification-message">{children}</span>
        {!actionsBelow && buttons}
        {onDismiss && (
          <button
            className="notification-dismiss"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {output.length > 0 && (
        <pre className="notification-output">{output.join("\n")}</pre>
      )}
      {actionsBelow && <div className="notification-actions">{buttons}</div>}
      {expiresAfter !== undefined && (
        <div
          className="notification-expiry"
          aria-hidden="true"
          style={{ "--expires-after": `${expiresAfter}ms` } as CSSProperties}
        />
      )}
    </div>
  );
}

function useExpiry(
  expiresAfter: number | undefined,
  held: boolean,
  onExpire: (() => void) | undefined,
) {
  const left = useRef(expiresAfter);
  const expire = useEffectEvent(() => onExpire?.());
  useEffect(() => {
    if (left.current === undefined || held) return;
    const started = Date.now();
    const timer = setTimeout(expire, left.current);
    return () => {
      clearTimeout(timer);
      if (left.current !== undefined) left.current -= Date.now() - started;
    };
  }, [held]);
}
