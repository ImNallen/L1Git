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

import { beginDraftTask, draftImpact, freezeDrafts } from "./commitDrafts";

it("requires consent for inactive-root drafts and amend-aside messages", () => {
  const inactive = rootSchema.parse("/work/inactive");
  const saved = { summary: "Aside", description: "Body" };
  setDraft(root, {
    draft: { summary: "Visible", description: "" },
    amend: null,
  });
  setDraft(inactive, {
    draft: { summary: "Amend", description: "" },
    amend: { draftAside: saved, head: oid("a"), loaded: loadMessage("Amend") },
  });
  expect(draftImpact().drafts).toEqual([
    { root, messages: 1, amending: false },
    { root: inactive, messages: 2, amending: true },
  ]);
  clearSubmitted(root, draftOf(root));
  clearSubmitted(inactive, draftOf(inactive));
});

it("refuses freeze through async result application, then blocks new tasks without dropping setters", async () => {
  const finish = beginDraftTask();
  if (!finish) throw new Error("Task was refused");
  const before = draftImpact().revision;
  expect(freezeDrafts(before)).toEqual({ kind: "busy" });
  await Promise.resolve();
  restoreUndone(root, "Restored asynchronously");
  expect(freezeDrafts(draftImpact().revision)).toEqual({ kind: "busy" });
  finish();
  expect(freezeDrafts(before)).toEqual({ kind: "changed" });
  const current = draftOf(root);
  const frozen = freezeDrafts(draftImpact().revision);
  if (frozen.kind !== "frozen") throw new Error("Freeze was refused");
  expect(beginDraftTask()).toBeNull();
  expect(() =>
    setDraft(root, {
      draft: { summary: "Unexpected", description: "" },
      amend: null,
    }),
  ).toThrow("frozen");
  expect(draftOf(root)).toBe(current);
  frozen.release();
  frozen.release();
  expect(draftOf(root)).toBe(current);
  expect(draftImpact().frozen).toBe(false);
  clearSubmitted(root, current);
});
