import { describe, expect, it } from "vitest";
import {
  amendsHead,
  clearSubmitted,
  draftOf,
  restoreUndone,
  setDraft,
} from "./commitDrafts";
import type { CommitDraft } from "./commitDrafts";
import { loadMessage } from "./domain/commitMessage";
import { oidSchema, refSchema, rootSchema } from "./domain/repository";

const root = rootSchema.parse("/work/drafts");
const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
const attached = (digit: string) => ({
  kind: "attached" as const,
  reference: refSchema.parse("refs/heads/main"),
  oid: oid(digit),
});

describe("clearSubmitted", () => {
  it("clears the draft a commit sent", () => {
    const sent: CommitDraft = {
      draft: { summary: "Fix", description: "" },
      amend: null,
    };
    setDraft(root, sent);
    clearSubmitted(root, sent);
    expect(draftOf(root).draft).toEqual({ summary: "", description: "" });
  });

  it("keeps edits made while the commit ran", () => {
    const sent: CommitDraft = {
      draft: { summary: "Fix", description: "" },
      amend: null,
    };
    setDraft(root, sent);
    const edited: CommitDraft = {
      draft: { summary: "Fix", description: "More" },
      amend: null,
    };
    setDraft(root, edited);
    clearSubmitted(root, sent);
    expect(draftOf(root)).toEqual(edited);
    clearSubmitted(root, edited);
  });
});

describe("amendsHead", () => {
  it("holds only while HEAD is the commit whose message was loaded", () => {
    const amending: CommitDraft = {
      draft: { summary: "Old", description: "" },
      amend: {
        draftAside: { summary: "", description: "" },
        loaded: loadMessage("Old\n"),
        head: oid("a"),
      },
    };
    expect(amendsHead(amending, attached("a"))).toBe(true);
    expect(amendsHead(amending, attached("b"))).toBe(false);
    expect(
      amendsHead(amending, {
        kind: "unborn",
        reference: refSchema.parse("refs/heads/main"),
      }),
    ).toBe(false);
  });
});

describe("restoreUndone", () => {
  it("brings an undone commit's message back only into an empty draft", () => {
    restoreUndone(root, "Undone\n\nBody\n");
    expect(draftOf(root).draft).toEqual({
      summary: "Undone",
      description: "Body",
    });
    restoreUndone(root, "Other\n");
    expect(draftOf(root).draft.summary).toBe("Undone");
    clearSubmitted(root, draftOf(root));
  });
});
