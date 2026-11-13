import type { CSSProperties } from "react";

type WorkspaceName =
  | "SelectedRepository"
  | "Repository"
  | "Settings"
  | "Update"
  | "Branch"
  | "Cloud"
  | "Folder"
  | "Stash"
  | "Tag"
  | "Check"
  | "Search"
  | "Plus"
  | "File"
  | "Copy";

const sources = {
  SelectedRepository: ["workspace/SelectedRepository", 16, 16],
  Repository: ["workspace/Repository", 16, 16],
  Settings: ["workspace/Settings", 16, 16],
  Update: ["workspace/Update", 16, 16],
  Branch: ["workspace/Branch", 16, 16],
  Cloud: ["workspace/Cloud", 16, 16],
  Folder: ["workspace/Folder", 16, 16],
  Stash: ["workspace/Stash", 16, 16],
  Tag: ["workspace/Tag", 16, 16],
  Check: ["workspace/Check", 16, 16],
  Search: ["workspace/Search", 16, 16],
  Plus: ["workspace/Plus", 16, 16],
  File: ["workspace/File", 16, 16],
  Copy: ["workspace/Copy", 16, 16],
  SettingsSearch: ["settings/Search", 14, 14],
  SettingsGeneral: ["settings/Settings", 16, 16],
  SettingsPalette: ["settings/Palette", 16, 16],
  SettingsReset: ["settings/Reset", 15, 15],
  SettingsResetSmall: ["settings/ResetSmall", 10, 10],
  SettingsClose: ["settings/Close", 16, 16],
  SettingsRefresh: ["settings/Refresh", 14, 14],
  AddSearch: ["add-repository/Search", 16, 16],
  AddChevron: ["add-repository/Chevron", 16, 16],
  AddLink: ["add-repository/Link", 16, 16],
  AddBack: ["add-repository/Back", 16, 16],
  AddNew: ["add-repository/New", 16, 16],
  AddDirectory: ["add-repository/Directory", 16, 16],
  AddFolder: ["add-repository/Folder", 16, 16],
  UpdateCheck: ["updates/Check", 18, 18],
  UpdateDownload: ["updates/Download", 18, 18],
  UpdateInstall: ["updates/Install", 18, 18],
  UpdateBullet: ["updates/Bullet", 3, 3],
} satisfies Record<string, readonly [string, number, number]>;

type WorkspaceIconName = keyof typeof sources;
type Props = { className?: string } & (
  | { name: WorkspaceName; size?: number }
  | { name: Exclude<WorkspaceIconName, WorkspaceName>; size?: never }
);

export function WorkspaceIcon({ name, size, className = "" }: Props) {
  const [source, width, height] = sources[name];
  const style: CSSProperties & { "--icon": string } = {
    width: size ?? width,
    height: size ?? height,
    "--icon": `url("/assets/${source}.svg")`,
  };
  return (
    <span
      aria-hidden="true"
      className={`workspace-icon ${className}`}
      style={style}
    />
  );
}
