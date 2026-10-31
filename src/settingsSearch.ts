import type { SettingsSection } from "./actions";

type SettingsDestination = {
  section: SettingsSection;
  label: string;
  description: string;
  keywords: string;
  targetId: string;
};

export const settingsDestinations = {
  fetch: {
    section: "general",
    label: "Fetch automatically",
    description: "Choose the automatic fetch interval.",
    keywords: "remotes schedule minutes off launch",
    targetId: "settings-fetch",
  },
  channel: {
    section: "general",
    label: "Update channel",
    description: "Choose Stable or Nightly releases.",
    keywords: "track beta release",
    targetId: "settings-update-channel",
  },
  updates: {
    section: "general",
    label: "App updates",
    description: "Installed version, check, download, and restart.",
    keywords: "upgrade install status",
    targetId: "settings-app-updates",
  },
  scheme: {
    section: "appearance",
    label: "Color scheme",
    description: "Use System, Light, or Dark mode.",
    keywords: "operating system appearance",
    targetId: "settings-color-scheme",
  },
  themes: {
    section: "appearance",
    label: "Themes",
    description: "Choose themes for light and dark mode.",
    keywords: "colors palette appearance",
    targetId: "themes-heading",
  },
  create: {
    section: "appearance",
    label: "Create theme",
    description: "Design a custom theme.",
    keywords: "colors palette editor",
    targetId: "settings-create-theme",
  },
  add: {
    section: "appearance",
    label: "Add theme",
    description: "Import a theme.",
    keywords: "extension file vscode marketplace",
    targetId: "settings-add-theme",
  },
} satisfies Record<string, SettingsDestination>;

export function searchSettings(query: string) {
  const words = query.trim().toLowerCase().split(/\s+/);
  if (!query.trim()) return [];
  return Object.values(settingsDestinations).filter((entry) => {
    const text = [entry.section, entry.label, entry.description, entry.keywords]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
