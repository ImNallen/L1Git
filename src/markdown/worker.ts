import { readMarkdown } from "./readMarkdown";
import type { Answer, Question } from "./reader";

const answer = (message: Answer) => postMessage(message);

addEventListener("message", ({ data }: MessageEvent<Question>) => {
  try {
    answer({ tree: readMarkdown(data.text, data.base) });
  } catch {
    answer({ tree: null });
  }
});
answer("ready");
