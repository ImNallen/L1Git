import { expect, it } from "vitest";
import type { ActionContext, Commands } from "../actions";
import { composeActions, defineSlice } from "./actionSlices";

const context = {} as ActionContext;
const commands = {} as Commands;
const withoutTyping: Omit<ActionContext, "typing"> = context;

it("composes slices that cover the contract exactly once", () => {
  const composed = composeActions(
    defineSlice({ context: withoutTyping, commands }),
    defineSlice({ context: { typing: true }, commands: {} }),
  );
  expect(composed.context.typing).toBe(true);
});

it("rejects a missing, doubled, unknown, or mistyped key at compile time", () => {
  // @ts-expect-error `typing` has no owner
  composeActions(defineSlice({ context: withoutTyping, commands }));
  const everything = defineSlice({ context, commands });
  const typing = defineSlice({ context: { typing: false }, commands: {} });
  // @ts-expect-error `typing` has two owners
  composeActions(everything, typing);
  // @ts-expect-error `bogus` is not in the contract
  defineSlice({ context: { bogus: true }, commands: {} });
  // @ts-expect-error `writing` is a boolean
  defineSlice({ context: { writing: "yes" }, commands: {} });
});
