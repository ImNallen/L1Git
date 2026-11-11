import { PanelLeft, PanelRight } from "lucide-react";
import type { Layout } from "./useLayout";

export function SidebarToggle({
  layout,
  toggle,
}: {
  layout: Layout;
  toggle: () => void;
}) {
  return (
    <button
      ref={layout.sidebarToggleRef}
      className={`icon-button sidebar-toggle ${layout.sidebarOpen ? "toggled" : ""}`}
      aria-label="Toggle sidebar"
      title="Toggle sidebar"
      aria-pressed={layout.sidebarOpen}
      onClick={toggle}
    >
      <PanelLeft size={16} />
    </button>
  );
}

export function InspectorToggle({
  layout,
  disabled,
  toggle,
}: {
  layout: Layout;
  disabled: boolean;
  toggle: () => void;
}) {
  return (
    <button
      ref={layout.inspectorToggleRef}
      className={`icon-button inspector-toggle ${layout.inspectorVisible ? "toggled" : ""}`}
      disabled={disabled}
      aria-label="Toggle commit inspector"
      title="Toggle commit inspector"
      aria-pressed={layout.inspectorVisible}
      onClick={toggle}
    >
      <PanelRight size={16} />
    </button>
  );
}
