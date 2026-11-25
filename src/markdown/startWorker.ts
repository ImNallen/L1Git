import type { Start } from "./reader";

export const startWorker: Start = (heard, failed) => {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = ({ data }) => heard(data);
  worker.onerror = failed;
  return {
    ask: (question) => worker.postMessage(question),
    stop: () => worker.terminate(),
  };
};
