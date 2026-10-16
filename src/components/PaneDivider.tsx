import { useRef } from "react";

type Props = {
  label: string;
  width: number;
  min: number;
  max: number;
  direction: 1 | -1;
  onResize: (width: number) => void;
};

export function PaneDivider({
  label,
  width,
  min,
  max,
  direction,
  onResize,
}: Props) {
  const origin = useRef({ x: 0, width });
  const resize = (value: number) =>
    onResize(Math.min(max, Math.max(min, value)));
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
          resize(
            origin.current.width +
              direction * (event.clientX - origin.current.x),
          );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          resize(width + (event.key === "ArrowRight" ? 16 : -16) * direction);
        }
      }}
    />
  );
}
