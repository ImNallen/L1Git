export type Draft = { summary: string; description: string };

export const emptyDraft: Draft = { summary: "", description: "" };

export type Loaded = { message: string; draft: Draft };

export function composeMessage({ summary, description }: Draft): string {
  const body = description.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  return `${summary.trim()}${body === "" ? "" : `\n\n${body}`}\n`;
}

export function splitMessage(message: string): Draft {
  const [summary = "", ...rest] = message.replace(/\s+$/, "").split("\n");
  return {
    summary,
    description: rest.join("\n").replace(/^(?:[ \t]*\n)+/, ""),
  };
}

export function loadMessage(message: string): Loaded {
  return { message, draft: splitMessage(message) };
}

export function messageFor(draft: Draft, loaded: Loaded | null): string {
  return loaded !== null &&
    loaded.draft.summary === draft.summary &&
    loaded.draft.description === draft.description
    ? loaded.message
    : composeMessage(draft);
}

export function subjectOf(message: string): string {
  return message.trimStart().split("\n", 1)[0]?.trim() ?? "";
}

export function identityCommands(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("git config "));
}

export type MessageField = "summary" | "description";

/**
 * Only Cmd or Ctrl+Enter submits. A plain Enter in the one-line summary
 * would submit its form, so it is suppressed there.
 */
export function enterAction(
  key: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
  },
  field: MessageField,
): "submit" | "suppress" | "type" {
  if (key.key !== "Enter" || key.isComposing) return "type";
  if (key.metaKey || key.ctrlKey) return "submit";
  return field === "summary" ? "suppress" : "type";
}
