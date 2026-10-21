import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { refSchema, rootSchema } from "./domain/repository";
import type { Branch, FullRef, RepositoryRoot } from "./domain/repository";
import { NO_RULE, pruneRule, revealBranch } from "./domain/visibility";
import type { VisibilityRule } from "./domain/visibility";

export const VISIBILITY_KEY = "l1git.visibility.v1";

type Rules = ReadonlyMap<RepositoryRoot, VisibilityRule>;

const visibilitySchema = z.object({
  version: z.literal(1),
  repositories: z.array(
    z.object({
      root: rootSchema,
      kind: z.enum(["hide", "solo"]),
      refs: z.array(refSchema).min(1),
    }),
  ),
});

export function restoreVisibility(storage: Pick<Storage, "getItem">): Rules {
  try {
    const saved = storage.getItem(VISIBILITY_KEY);
    if (saved === null) return new Map();
    return new Map(
      visibilitySchema
        .parse(JSON.parse(saved))
        .repositories.map(({ root, kind, refs }) => [
          root,
          { kind, refs: new Set(refs) },
        ]),
    );
  } catch {
    return new Map();
  }
}

const unsaved =
  "Hidden and soloed branches changed for this session. Could not save them.";

export function persistVisibility(
  storage: Pick<Storage, "setItem">,
  rules: Rules,
): string | null {
  try {
    storage.setItem(
      VISIBILITY_KEY,
      JSON.stringify({
        version: 1,
        repositories: [...rules].flatMap(([root, rule]) =>
          rule.kind === "none"
            ? []
            : [{ root, kind: rule.kind, refs: [...rule.refs] }],
        ),
      }),
    );
    return null;
  } catch {
    return unsaved;
  }
}

export function useBranchVisibility() {
  const [rules, setRules] = useState<Rules>(() => {
    try {
      return restoreVisibility(localStorage);
    } catch {
      return new Map();
    }
  });
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const saved = useRef(rules);
  useEffect(() => {
    if (saved.current === rules) return;
    saved.current = rules;
    try {
      setPersistenceError(persistVisibility(localStorage, rules));
    } catch {
      setPersistenceError(unsaved);
    }
  }, [rules]);

  const update = useCallback(
    (root: RepositoryRoot, change: (rule: VisibilityRule) => VisibilityRule) =>
      setRules((previous) => {
        const current = previous.get(root) ?? NO_RULE;
        const next = change(current);
        if (next === current) return previous;
        const updated = new Map(previous);
        if (next.kind === "none") updated.delete(root);
        else updated.set(root, next);
        return updated;
      }),
    [],
  );
  const prune = useCallback(
    (root: RepositoryRoot, branches: readonly Branch[]) =>
      update(root, (rule) => pruneRule(rule, branches)),
    [update],
  );

  return {
    ruleFor: (root: RepositoryRoot) => rules.get(root) ?? NO_RULE,
    setRule: (root: RepositoryRoot, rule: VisibilityRule) =>
      update(root, () => rule),
    reveal: (root: RepositoryRoot, reference: FullRef) =>
      update(root, (rule) => revealBranch(rule, reference)),
    prune,
    persistenceError,
  };
}
