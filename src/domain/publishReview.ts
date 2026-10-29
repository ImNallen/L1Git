import type { PublishOptions, PushIntent } from "./push";

export type PublishReview = {
  generation: number;
  step:
    | { kind: "editing" }
    | { kind: "preparing" }
    | { kind: "review"; intent: PushIntent }
    | { kind: "failed"; message: string };
};
type Event =
  | { kind: "edit" }
  | { kind: "prepare" }
  | { kind: "prepared"; generation: number; intent: PushIntent }
  | { kind: "failed"; generation: number; message: string };

export const initialPublishReview: PublishReview = {
  generation: 0,
  step: { kind: "editing" },
};

export function publishReview(
  state: PublishReview,
  event: Event,
): PublishReview {
  switch (event.kind) {
    case "edit":
      return { generation: state.generation + 1, step: { kind: "editing" } };
    case "prepare":
      return { ...state, step: { kind: "preparing" } };
    case "prepared":
      return event.generation === state.generation &&
        state.step.kind === "preparing"
        ? { ...state, step: { kind: "review", intent: event.intent } }
        : state;
    case "failed":
      return event.generation === state.generation &&
        state.step.kind === "preparing"
        ? { ...state, step: { kind: "failed", message: event.message } }
        : state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export function publishDefaults(
  options: Extract<PublishOptions, { kind: "available" }>,
) {
  const eligible = options.remotes.filter(
    (remote) => remote.availability.kind === "eligible",
  );
  return {
    destination: options.branch.replace(/^refs\/heads\//, ""),
    remote: eligible.length === 1 ? (eligible[0]?.name ?? "") : "",
  };
}
