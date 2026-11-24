import { useCallback, useEffect, useState } from "react";

/** Copies text, and says for a moment that it did. */
export function useCopy() {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copy !== "copied") return;
    const timer = window.setTimeout(() => setCopy("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copy]);
  return {
    copy,
    copyText: async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopy("copied");
      } catch {
        setCopy("failed");
      }
    },
    forgetCopy: useCallback(() => setCopy("idle"), []),
  };
}
