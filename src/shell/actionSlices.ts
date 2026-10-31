import type { ActionContext, Commands } from "../actions";

/** One owner's share of the palette and keyboard contract, keyed by the literal passed to `defineSlice`. */
export type ActionSlice<
  C extends keyof ActionContext = never,
  M extends keyof Commands = never,
> = {
  readonly context: Pick<ActionContext, C>;
  readonly commands: Pick<Commands, M>;
};

export type ComposedActions = {
  readonly context: ActionContext;
  readonly commands: Commands;
};

type AnySlice = {
  readonly context: Partial<ActionContext>;
  readonly commands: Partial<Commands>;
};

export function defineSlice<
  C extends keyof ActionContext = never,
  M extends keyof Commands = never,
>(slice: {
  context: Pick<ActionContext, C>;
  commands: Pick<Commands, M>;
}): ActionSlice<C, M> {
  return slice;
}

type KeysOf<S> = S extends { context: infer C; commands: infer M }
  ? `context.${keyof C & string}` | `commands.${keyof M & string}`
  : never;
type Duplicates<
  T extends readonly unknown[],
  Seen extends string = never,
> = T extends readonly [infer Head, ...infer Rest]
  ? (KeysOf<Head> & Seen) | Duplicates<Rest, Seen | KeysOf<Head>>
  : never;
type Contract =
  | `context.${keyof ActionContext & string}`
  | `commands.${keyof Commands & string}`;
type Missing<T extends readonly unknown[]> = Exclude<
  Contract,
  KeysOf<T[number]>
>;
/** `unknown` when the slices cover the contract exactly once; otherwise an object whose keys name each gap. */
type ExactCover<T extends readonly unknown[]> = [Duplicates<T>] extends [never]
  ? [Missing<T>] extends [never]
    ? unknown
    : { readonly [K in Missing<T> as `no owner for ${K}`]: true }
  : { readonly [K in Duplicates<T> as `two owners for ${K}`]: true };

/** The build fails when a key of `ActionContext` or `Commands` has no owner or has two. */
export function composeActions<const T extends readonly AnySlice[]>(
  ...slices: T & ExactCover<T>
): ComposedActions {
  const context = {} as ActionContext;
  const commands = {} as Commands;
  for (const slice of slices as readonly AnySlice[]) {
    Object.assign(context, slice.context);
    Object.assign(commands, slice.commands);
  }
  return { context, commands };
}
