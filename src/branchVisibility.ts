import { useState } from "react";
import { z } from "zod";
import { refSchema, rootSchema } from "./domain/repository";
import type { RepositoryRoot } from "./domain/repository";
import { NO_RULE } from "./domain/visibility";
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

  function setRule(root: RepositoryRoot, rule: VisibilityRule) {
    const next = new Map(rules);
    if (rule.kind === "none") next.delete(root);
    else next.set(root, rule);
    setRules(next);
    try {
      setPersistenceError(persistVisibility(localStorage, next));
    } catch {
      setPersistenceError(unsaved);
    }
  }

  return {
    ruleFor: (root: RepositoryRoot) => rules.get(root) ?? NO_RULE,
    setRule,
    persistenceError,
  };
}
