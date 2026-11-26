import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { githubPromise } from "./githubPromise";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const self = "src/components/githubPromise.test.ts";
const read = (file: string) => readFileSync(join(repo, file), "utf8");

const filesUnder = (folder: string) =>
  readdirSync(join(repo, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(repo.length));

it("never again promises that L1 Git only reads from GitHub", () => {
  const files = [
    ...filesUnder("src"),
    ...filesUnder("src-tauri/src"),
    ...readdirSync(join(repo, "crates")).flatMap((crate) =>
      filesUnder(`crates/${crate}/src`),
    ),
    ...filesUnder("docs"),
    "README.md",
  ];
  const promising = files.filter(
    (file) =>
      file !== self &&
      /only (reads|to read) from GitHub|only reads pull requests/i.test(
        read(file),
      ),
  );
  expect(promising).toEqual([]);
});

it("no longer says that L1 Git doesn't write to GitHub yet", () => {
  const notYet = /doesn't write to GitHub yet|has no box that writes/;
  const docs = ["README.md", "docs/reference.md"];
  expect(docs.filter((file) => notYet.test(read(file)))).toEqual([]);
  expect(githubPromise).not.toMatch(notYet);
  expect(githubPromise).toContain("only when you click");
});
