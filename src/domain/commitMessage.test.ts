import { describe, expect, it } from "vitest";
import {
  composeMessage,
  identityCommands,
  loadMessage,
  messageFor,
  splitMessage,
  subjectOf,
} from "./commitMessage";

describe("composeMessage", () => {
  it("writes a summary alone as one line", () => {
    expect(
      composeMessage({ summary: "  Update readme  ", description: "" }),
    ).toBe("Update readme\n");
  });

  it("puts a blank line between the summary and the description", () => {
    expect(
      composeMessage({
        summary: "Update readme",
        description: "Explain the bridge.\nList the ports.",
      }),
    ).toBe("Update readme\n\nExplain the bridge.\nList the ports.\n");
  });

  it("drops blank lines around the description and keeps its indentation", () => {
    expect(
      composeMessage({
        summary: "Update readme",
        description: "\n  \n    indented\n\n\n  \n",
      }),
    ).toBe("Update readme\n\n    indented\n");
  });
});

describe("splitMessage", () => {
  it("splits a previous message into the summary and the description", () => {
    expect(splitMessage("Fix x\n\nFirst line.\nSecond line.\n")).toEqual({
      summary: "Fix x",
      description: "First line.\nSecond line.",
    });
  });

  it("reads a summary alone with an empty description", () => {
    expect(splitMessage("Fix x\n")).toEqual({
      summary: "Fix x",
      description: "",
    });
  });

  it("round-trips a message in Git's usual shape", () => {
    const message = "Fix x\n\nBody line.\n\nMore.\n";
    expect(composeMessage(splitMessage(message))).toBe(message);
  });
});

describe("messageFor", () => {
  it("sends a loaded message byte for byte until a field changes", () => {
    const loaded = loadMessage("Fix x\nand y\n\nBody");
    expect(messageFor(loaded.draft, loaded)).toBe("Fix x\nand y\n\nBody");
    expect(
      messageFor({ ...loaded.draft, summary: "Fix x and y" }, loaded),
    ).toBe("Fix x and y\n\nand y\n\nBody\n");
  });

  it("composes the fields when nothing was loaded", () => {
    expect(messageFor({ summary: "A", description: "" }, null)).toBe("A\n");
  });
});

describe("subjectOf", () => {
  it("names a message by its first line", () => {
    expect(subjectOf("\nUpdate readme\n\nBody")).toBe("Update readme");
  });
});

describe("identityCommands", () => {
  it("picks out the two commands Git prints", () => {
    const output = [
      "Author identity unknown",
      "",
      "*** Please tell me who you are.",
      "",
      "Run",
      "",
      '  git config --global user.email "you@example.com"',
      '  git config --global user.name "Your Name"',
      "",
      "to set your account's default identity.",
    ].join("\n");
    expect(identityCommands(output)).toEqual([
      'git config --global user.email "you@example.com"',
      'git config --global user.name "Your Name"',
    ]);
  });
});
