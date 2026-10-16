import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const build = spawn("cargo", ["build", "-p", "l1-git-dev-bridge"], {
  cwd: root,
  stdio: "inherit",
});
let children = [build];
let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop());
build.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
build.on("exit", (code) => {
  if (stopping || code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
  const bridge = spawn("./target/debug/l1-git-dev-bridge", [], {
    cwd: root,
    stdio: "inherit",
  });
  const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    cwd: root,
    stdio: "inherit",
  });
  children = [bridge, vite];
  for (const child of children) {
    child.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      stop();
      process.exitCode = 1;
    });
    child.on("exit", (exitCode) => {
      stop();
      process.exitCode = exitCode ?? 0;
    });
  }
});
