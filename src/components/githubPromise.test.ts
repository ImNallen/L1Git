import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const self = "src/components/githubPromise.test.ts";

const filesUnder = (folder: string) =>
  readdirSync(join(repo, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(repo.length));

it("never again promises that L1 Git only reads from GitHub", () => {
  const files = [...filesUnder("src"), ...filesUnder("docs"), "README.md"];
  const promising = files.filter(
    (file) =>
      file !== self &&
      /only (reads|to read) from GitHub/i.test(
        readFileSync(join(repo, file), "utf8"),
      ),
  );
  expect(promising).toEqual([]);
});
