import type { CSSProperties } from "react";

type Name =
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
  | "Panel"
  | "Copy";

export function WorkspaceIcon({
  name,
  size = 16,
  className = "",
}: {
  name: Name;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`workspace-icon ${className}`}
      style={
        {
          width: size,
          height: size,
          "--icon": `url("/assets/workspace/${name}.svg")`,
        } as CSSProperties
      }
    />
  );
}
