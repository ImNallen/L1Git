import { PanelLeft, PanelRight } from "lucide-react";
import { flushSync } from "react-dom";
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
      onClick={() => {
        flushSync(toggle);
        layout.sidebarToggleRef.current?.focus();
      }}
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
      className={`icon-button ${layout.inspectorVisible ? "toggled" : ""}`}
      disabled={disabled}
      aria-label="Toggle commit inspector"
      title="Toggle commit inspector"
      aria-pressed={layout.inspectorVisible}
      onClick={() => {
        flushSync(toggle);
        layout.inspectorToggleRef.current?.focus();
      }}
    >
      <PanelRight size={16} />
    </button>
  );
}
