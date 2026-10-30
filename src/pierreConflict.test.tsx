// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { File, EditProvider } from "@pierre/diffs/react";
import { ConflictChoices } from "./components/ConflictChoices";
import { Editor, type EditorFactory, TextDocument } from "@pierre/diffs/edit";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({
    font: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
  }),
});
afterEach(() => document.body.replaceChildren());

it.each(["one\ntwo\n", "one\r\ntwo\r\n", "one\ntwo", "one\r\ntwo", ""])(
  "retains exact text through Pierre edits and document Undo for %j",
  (text) => {
    const document = new TextDocument("f.txt", text);
    expect(document.getText()).toBe(text);
    document.applyEdits([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        newText: "x",
      },
    ]);
    expect(document.getText()).toBe(`x${text}`);
    document.undo();
    expect(document.getText()).toBe(text);
  },
);

it.each(
  ["\n", "\r\n"].flatMap((eol) =>
    ["current", "incoming", "both"].map((choice) => ({ eol, choice })),
  ),
)(
  "renders Pierre $choice choices with exact separators $eol and final bytes",
  async ({ eol, choice }) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const resolved = vi.fn();
    const file = {
      name: "f.txt",
      contents: [
        "before",
        "<<<<<<< current",
        "ours",
        "=======",
        "theirs",
        ">>>>>>> incoming",
        "after",
      ].join(eol),
    };
    await act(async () =>
      root.render(
        <ConflictChoices
          file={file}
          options={{ theme: "pierre-dark", onMergeConflictResolve: resolved }}
        />,
      ),
    );
    await vi.waitFor(() =>
      expect(
        host.querySelector("diffs-container")?.shadowRoot?.textContent,
      ).toContain("ours"),
    );
    const shadow = host.querySelector("diffs-container")?.shadowRoot;
    const button = [
      ...host.querySelectorAll("button"),
      ...(shadow?.querySelectorAll("button") ?? []),
    ].find((button) =>
      button.textContent?.toLowerCase().includes(`accept ${choice}`),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(resolved.mock.calls[0]?.[0].contents).toBe(
      [
        "before",
        ...(choice === "current"
          ? ["ours"]
          : choice === "incoming"
            ? ["theirs"]
            : ["ours", "theirs"]),
        "after",
      ].join(eol),
    );
    await act(async () => root.unmount());
  },
);

it.each(["one\r\ntwo", "one\ntwo\n"])(
  "mounts an actual File editor and completes exact text %j",
  async (contents) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let editor: Editor<"file"> | undefined;
    const complete = vi.fn();
    const change = vi.fn();
    const factory: EditorFactory<undefined, undefined> = (type, options, key) =>
      new Editor(type, options, key);
    await act(async () =>
      root.render(
        <EditProvider createEditor={factory}>
          <File
            file={{ name: "f.txt", contents }}
            edit
            editorOptions={{
              onAttach: (attached) => {
                editor = attached;
              },
            }}
            onEditChange={change}
            onEditComplete={(event) => {
              complete(event.file.contents);
              return "accept";
            }}
          />
        </EditProvider>,
      ),
    );
    await vi.waitFor(() => expect(editor).toBeDefined());
    await act(async () => {
      editor?.applyEdits([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "x",
        },
      ]);
    });
    expect(change.mock.calls.at(-1)?.[0].file.contents).toBe(`x${contents}`);
    await act(async () => {
      editor?.undo();
    });
    expect(editor?.getText()).toBe(contents);
    await act(async () => root.unmount());
    expect(complete).toHaveBeenCalledWith(contents);
  },
);
