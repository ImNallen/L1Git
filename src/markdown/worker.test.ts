import { afterEach, expect, it, vi } from "vitest";
import { startWorker } from "./startWorker";

afterEach(() => vi.unstubAllGlobals());

it("answers each text, says when it is ready, and survives any text", async () => {
  const answers: unknown[] = [];
  let hear = (_: { data: unknown }) => {};
  vi.stubGlobal("postMessage", (answer: unknown) => answers.push(answer));
  vi.stubGlobal("addEventListener", (_: string, listener: typeof hear) => {
    hear = listener;
  });
  await import("./worker");
  expect(answers).toEqual(["ready"]);
  const base = "https://github.com/octo/app/";
  hear({ data: { text: "[a](b)", base } });
  hear({ data: { text: "a\n\n".repeat(3_000), base } });
  expect(answers.slice(1)).toEqual([
    {
      tree: {
        pieces: [
          {
            kind: "paragraph",
            children: [{ kind: "link", url: `${base}b`, children: ["a"] }],
          },
        ],
        size: base.length + 2,
        weight: 3 + (base.length + 2) / 20,
      },
    },
    { tree: null },
  ]);
});

it("starts a module of the app itself, and stops it", () => {
  const made: unknown[][] = [];
  const said: unknown[] = [];
  class FakeWorker {
    onmessage = (_: { data: unknown }) => {};
    onerror = () => {};
    constructor(...args: unknown[]) {
      made.push(args);
      workers.push(this);
    }
    postMessage = (question: unknown) => said.push(question);
    terminate = () => said.push("terminated");
  }
  const workers: FakeWorker[] = [];
  vi.stubGlobal("Worker", FakeWorker);
  const heard = vi.fn();
  const failed = vi.fn();
  const { ask, stop } = startWorker(heard, failed);
  const [[url, options]] = made as [[URL, unknown]];
  expect(url.protocol).not.toMatch(/blob|data/);
  expect(options).toEqual({ type: "module" });
  const [worker] = workers;
  worker!.onmessage({ data: "ready" });
  expect(heard).toHaveBeenCalledWith("ready");
  worker!.onerror();
  expect(failed).toHaveBeenCalledOnce();
  ask({ text: "a", base: "b" });
  stop();
  expect(said).toEqual([{ text: "a", base: "b" }, "terminated"]);
});
