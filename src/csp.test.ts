import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const security = (
  JSON.parse(read("src-tauri/tauri.conf.json")) as {
    app: {
      security: {
        csp: string;
        dangerousDisableAssetCspModification?: string[];
      };
    };
  }
).app.security;

// Tauri hashes inline <style> blocks into style-src, and a hash makes the
// webview ignore 'unsafe-inline'. Diffs then lose their inline grid-row spans
// and every line collapses into one row.
it("keeps inline styles allowed in the packaged app", () => {
  const styleSrc = security.csp
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("style-src "));
  expect(styleSrc).toContain("'unsafe-inline'");
  if (/<style[\s>]/.test(read("index.html")))
    expect(security.dangerousDisableAssetCspModification).toContain(
      "style-src",
    );
});
