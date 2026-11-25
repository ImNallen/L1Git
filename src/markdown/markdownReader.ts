import { MarkdownReader } from "./reader";
import { startWorker } from "./startWorker";

export const markdownReader = new MarkdownReader(startWorker);
