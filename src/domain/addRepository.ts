import { z } from "zod";

const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  repository: z.boolean(),
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

export const directoryListingSchema = z.object({
  entries: z.array(directoryEntrySchema),
});

export const newRepositorySchema = z.object({ path: z.string() });

export type Step =
  | { kind: "sources"; query: string }
  | { kind: "new"; name: string; location: string | null }
  | { kind: "url"; url: string; location: string | null }
  | { kind: "local"; path: string };
export type SourceStep = Exclude<Step, { kind: "sources" }>;
export type SourceKind = SourceStep["kind"];

export const HOME_BASE = "~";
export const DEFAULT_BASE = "~/Projects";

type Source = {
  kind: SourceKind;
  title: string;
  detail: string;
  start: (base: string) => SourceStep;
};

export const SOURCES: readonly Source[] = [
  {
    kind: "local",
    title: "Local folder",
    detail: "Open an existing Git repository on disk",
    start: (base) => ({ kind: "local", path: base }),
  },
  {
    kind: "url",
    title: "Git URL",
    detail: "Clone a repository from a remote URL",
    start: () => ({ kind: "url", url: "", location: null }),
  },
  {
    kind: "new",
    title: "New repository",
    detail: "Start an empty Git repository",
    start: () => ({ kind: "new", name: "", location: null }),
  },
];

export function filterSources(query: string): readonly Source[] {
  const wanted = query.trim().toLowerCase();
  return SOURCES.filter(({ title }) => title.toLowerCase().includes(wanted));
}

const NAVIGATE: Hint = { keys: "↑ ↓", label: "Navigate" };
const CLOSE: Hint = { keys: "Esc", label: "Close" };
const MOVE_FOCUS: Hint = { keys: "Tab", label: "Move focus" };

type Hint = { keys: string; label: string; role?: "clear" | "submit" };

export const SOURCES_HINTS: readonly Hint[] = [
  NAVIGATE,
  { keys: "↵", label: "Select", role: "submit" },
  { keys: "⌫", label: "Clear", role: "clear" },
  CLOSE,
];

export const STEP_TEXT: Record<
  SourceKind,
  {
    input: string;
    placeholder: string;
    mono: boolean;
    submit: string;
    busy: string;
    section: string;
    hints: readonly Hint[];
  }
> = {
  new: {
    input: "Repository name",
    placeholder: "Repository name",
    mono: false,
    submit: "Create",
    busy: "Creating…",
    section: "Create in",
    hints: [MOVE_FOCUS, { keys: "↵", label: "Create", role: "submit" }, CLOSE],
  },
  url: {
    input: "Git URL",
    placeholder: "https://github.com/owner/repository.git",
    mono: true,
    submit: "Clone",
    busy: "Cloning…",
    section: "Clone into",
    hints: [MOVE_FOCUS, { keys: "↵", label: "Clone", role: "submit" }, CLOSE],
  },
  local: {
    input: "Path",
    placeholder: DEFAULT_BASE,
    mono: true,
    submit: "Open",
    busy: "Opening…",
    section: "Directories",
    hints: [
      NAVIGATE,
      { keys: "↵", label: "Open", role: "submit" },
      { keys: "⌫", label: "Back" },
      CLOSE,
    ],
  },
};

export function shownHints(
  hints: readonly Hint[],
  { query, canSubmit }: { query: string; canSubmit: boolean },
) {
  return hints
    .filter(({ role }) => role !== "clear" || query !== "")
    .map((hint) => ({
      ...hint,
      disabled: hint.role === "submit" && !canSubmit,
    }));
}

export function repositoryNameFromUrl(url: string): string {
  const stripped = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  return stripped.split(/[/:]/).at(-1) ?? "";
}

export function joinLocation(base: string, name: string): string {
  return name === "" ? base : `${base.replace(/\/+$/, "")}/${name}`;
}

/** Where a step's work happens. An unedited location follows the name. */
export function targetLocation(step: SourceStep, base: string): string {
  switch (step.kind) {
    case "new":
      return (step.location ?? joinLocation(base, step.name.trim())).trim();
    case "url":
      return (
        step.location ?? joinLocation(base, repositoryNameFromUrl(step.url))
      ).trim();
    case "local":
      return step.path.trim();
  }
}

/** Whether a new or URL step names both what to make and where it goes. */
export function namesTarget(
  step: Extract<SourceStep, { kind: "new" | "url" }>,
  base: string,
): boolean {
  const named =
    step.kind === "new"
      ? step.name.trim() !== ""
      : step.url.trim() !== "" &&
        (step.location !== null || repositoryNameFromUrl(step.url) !== "");
  return named && targetLocation(step, base) !== "";
}

export function headerValue(step: SourceStep): string {
  switch (step.kind) {
    case "new":
      return step.name;
    case "url":
      return step.url;
    case "local":
      return step.path;
  }
}

export function withHeaderValue(step: SourceStep, value: string): SourceStep {
  switch (step.kind) {
    case "new":
      return { ...step, name: value };
    case "url":
      return { ...step, url: value };
    case "local":
      return { ...step, path: value };
  }
}

/** Where new locations go, from what the home directory lists. */
export function baseFromHome(entries: readonly DirectoryEntry[]): string {
  return entries.some(({ name }) => name === "Projects")
    ? DEFAULT_BASE
    : HOME_BASE;
}

/**
 * The path that opens `entry`, written the way the user wrote theirs when the
 * short form names the same directory. A typed path is a directory or a name
 * prefix in one, so it is checked as both.
 */
export function descendInto(typed: string, entry: DirectoryEntry): string {
  const directory = typed.trim().replace(/\/+$/, "");
  const parent = directory.slice(0, Math.max(directory.lastIndexOf("/"), 0));
  const short = [directory, parent]
    .map((base) => joinLocation(base, entry.name))
    .find((path) => path.startsWith("~") && entry.path.endsWith(path.slice(1)));
  return short ?? entry.path;
}
