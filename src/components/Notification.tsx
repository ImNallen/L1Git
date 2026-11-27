import { X } from "lucide-react";
import type { ReactNode, Ref } from "react";

export type NotificationAction = {
  label: string;
  run: () => void;
  primary?: boolean;
  unavailable?: boolean;
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
  ref,
}: {
  tone: "info" | "error";
  icon: ReactNode;
  children: ReactNode;
  /** Lines of command output, shown under the message as Git printed them. */
  output?: readonly string[];
  actions?: readonly NotificationAction[];
  actionsBelow?: boolean;
  onDismiss?: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
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
    </div>
  );
}
