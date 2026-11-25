import { readMarkdown } from "../markdown/readMarkdown";
import type { Start } from "../markdown/reader";

/** Reads Markdown where a test has no workers. */
export const startWorker: Start = (heard) => {
  queueMicrotask(() => heard("ready"));
  return {
    ask: ({ text, base }) =>
      queueMicrotask(() => heard({ tree: readMarkdown(text, base) })),
    stop: () => {},
  };
};
