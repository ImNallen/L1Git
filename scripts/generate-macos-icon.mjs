import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "l1git-macos-icon-"));
try {
  const source = readFileSync(join(root, "src-tauri/icons/icon.png"));
  const input = join(temporary, "icon.svg");
  writeFileSync(
    input,
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><image x="100" y="100" width="824" height="824" href="data:image/png;base64,${source.toString("base64")}"/></svg>`,
  );
  const result = spawnSync(
    "pnpm",
    ["tauri", "icon", input, "--output", temporary],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("macOS icon generation failed.");
  copyFileSync(
    join(temporary, "icon.icns"),
    join(root, "src-tauri/icons/icon.icns"),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
