import { Check } from "lucide-react";
import { useCopy } from "./useCopy";
import { WorkspaceIcon } from "./WorkspaceIcon";

/** `what` is copied, such as a branch name. */
export function CopyButton({ text, what }: { text: string; what: string }) {
  const { copy, copyText } = useCopy();
  return (
    <>
      <button
        type="button"
        className={`icon-button copy-button ${copy}`}
        aria-label={`Copy ${what} ${text}`}
        title={
          copy === "copied"
            ? "Copied"
            : copy === "failed"
              ? "Could not copy"
              : `Copy ${text}`
        }
        onClick={() => void copyText(text)}
      >
        {copy === "copied" ? (
          <Check size={14} />
        ) : (
          <WorkspaceIcon name="Copy" />
        )}
      </button>
      <span className="visually-hidden" role="status">
        {copy === "copied"
          ? `Copied ${what}`
          : copy === "failed"
            ? "Could not copy"
            : ""}
      </span>
    </>
  );
}
