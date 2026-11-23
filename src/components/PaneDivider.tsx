import { useRef } from "react";

type Props = {
  label: string;
  width: number;
  min: number;
  max: number;
  direction: 1 | -1;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
};

export function PaneDivider({
  label,
  width,
  min,
  max,
  direction,
  onResize,
  onResizeEnd,
}: Props) {
  const origin = useRef({ x: 0, width });
  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  const dragged = (clientX: number) =>
    clamp(origin.current.width + direction * (clientX - origin.current.x));
  return (
    <div
      className="pane-divider"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        origin.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          onResize(dragged(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onResizeEnd(dragged(event.clientX));
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onResizeEnd(
            clamp(width + (event.key === "ArrowRight" ? 16 : -16) * direction),
          );
        }
      }}
    />
  );
}
