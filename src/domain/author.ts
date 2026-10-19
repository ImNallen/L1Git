export const initials = (author: string) =>
  author
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

const githubNoreply = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;

/** The GitHub username behind a private noreply address, else null. */
export function githubHandle(email: string): string | null {
  return githubNoreply.exec(email)?.[1] ?? null;
}
