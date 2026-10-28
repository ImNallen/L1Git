import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { worktreeStatusSchema } from "../domain/repository";
import { CommitBox } from "./CommitBox";
import { EditMessageDialog } from "./EditMessageDialog";

const status = worktreeStatusSchema.parse({
  root: "/repo",
  head: {
    kind: "attached",
    reference: "refs/heads/main",
    oid: "a".repeat(40),
  },
  entries: [],
  stagedStamp: "b".repeat(40),
});
const never = () => new Promise<never>(() => {});

/**
 * A browser submits a control's form when Enter is pressed in it, so a
 * control with no form owner cannot commit on a plain Enter.
 */
const formOwners = (markup: string) => markup.match(/<form[\s>]|\sform="/g);

describe("a plain Enter submits nothing by itself", () => {
  it("in the commit box", () => {
    const markup = renderToStaticMarkup(
      <CommitBox status={status} staged={1} busy={false} onCommit={never} />,
    );
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('aria-label="Summary"');
    expect(formOwners(markup)).toBeNull();
  });

  it("in the Edit message dialog", () => {
    const markup = renderToStaticMarkup(
      <EditMessageDialog status={status} onSave={never} onClose={() => {}} />,
    );
    expect(markup).toContain("Save message");
    expect(formOwners(markup)).toBeNull();
  });
});
