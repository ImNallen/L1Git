import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const shellFiles = readdirSync(new URL("./", import.meta.url))
  .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
  .map((name) => `shell/${name}`);
const files = ["App.tsx", ...shellFiles];

const source = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

function identifiers(node: ts.Node, found: ts.Identifier[] = []) {
  if (ts.isIdentifier(node)) found.push(node);
  node.forEachChild((child) => {
    identifiers(child, found);
  });
  return found;
}

const isApp = (node: ts.Node | undefined) =>
  node !== undefined && ts.isIdentifier(node) && node.text === "app";

/** `app.name`, or `name` destructured from `app`. */
function readFromApp(identifier: ts.Identifier) {
  const { parent } = identifier;
  if (ts.isPropertyAccessExpression(parent))
    return parent.name === identifier && isApp(parent.expression);
  if (!ts.isBindingElement(parent)) return false;
  const key = parent.propertyName ?? parent.name;
  const declaration = parent.parent.parent;
  return (
    key === identifier &&
    ts.isVariableDeclaration(declaration) &&
    isApp(declaration.initializer)
  );
}

function callsHook(identifier: ts.Identifier) {
  const { parent } = identifier;
  return (
    /^use[A-Z]/.test(identifier.text) &&
    ts.isCallExpression(parent) &&
    parent.expression === identifier
  );
}

/** Hook calls in source order, not counting calls inside nested functions. */
function hookCalls(body: ts.Node, found: string[] = []) {
  body.forEachChild((child) => {
    if (ts.isFunctionLike(child)) return;
    if (ts.isIdentifier(child) && callsHook(child)) found.push(child.text);
    hookCalls(child, found);
  });
  return found;
}

describe("shell boundaries", () => {
  it("App calls its owners in the order their effects must run", () => {
    const app = source("App.tsx").statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "App",
    );
    if (!app?.body) throw new Error("App is not a function declaration");
    expect(hookCalls(app.body)).toEqual([
      "useAppearance",
      "useWorkspace",
      "useFetchSettings",
      "useUpdates",
      "useUpdateRestart",
      "useOverview",
      "useLayout",
      "useSettingsScreen",
      "useFocus",
      "usePalette",
      "useExpandedRepositories",
      "useHistoryColumns",
      "useBranchVisibility",
      "useRepositoryRefs",
      "useHistoryPane",
      "useActiveWorktree",
      "useWriteLoop",
      "useSyncControls",
      "useNavigation",
      "useFocusRecovery",
      "useDiffPane",
      "useStaging",
      "useRefWrites",
      "useMergePanel",
      "useResolutionDrafts",
      "useUndoSteps",
      "useShortcuts",
      "usePrefetchLazyViews",
    ]);
  });

  it("only the write loop refreshes the overview or listens for moved refs", () => {
    const loop = ["refreshLocal", "invalidatePush", "onRefsChanged"];
    const users = files.filter((file) =>
      identifiers(source(file)).some(({ text }) => loop.includes(text)),
    );
    expect(users).toEqual(["shell/useWriteLoop.ts"]);
  });

  it("only navigation selects through the workspace directly", () => {
    const raw = ["select", "compareWith", "endCompare"];
    const users = files.filter((file) =>
      identifiers(source(file)).some(
        (identifier) =>
          raw.includes(identifier.text) && readFromApp(identifier),
      ),
    );
    expect(users).toEqual(["shell/useNavigation.ts"]);
  });

  it("regions call no hooks, so no effect runs before App's", () => {
    const regions = shellFiles.filter((file) => file.endsWith(".tsx"));
    const withHooks = regions.filter((file) =>
      identifiers(source(file)).some(callsHook),
    );
    expect(regions).not.toEqual([]);
    expect(withHooks).toEqual([]);
  });

  it("App and every shell file stay under 500 lines", () => {
    const lines = (file: string) => {
      const parsed = source(file);
      return parsed.getLineAndCharacterOfPosition(parsed.end).line;
    };
    expect(files.filter((file) => lines(file) >= 500)).toEqual([]);
  });
});
