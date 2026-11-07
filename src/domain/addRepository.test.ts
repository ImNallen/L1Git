import { describe, expect, it } from "vitest";
import {
  baseFromHome,
  descendInto,
  filterSources,
  joinLocation,
  namesTarget,
  repositoryNameFromUrl,
  shownHints,
  SOURCES,
  SOURCES_HINTS,
  STEP_TEXT,
  targetLocation,
} from "./addRepository";

const entry = (path: string, repository = false) => ({
  name: path.split("/").at(-1) ?? path,
  path,
  repository,
});

describe("filterSources", () => {
  const titles = (query: string) =>
    filterSources(query).map((source) => source.title);

  it("lists every source in order for an empty query", () => {
    expect(titles("")).toEqual(["Local folder", "Git URL", "New repository"]);
    expect(titles("  ")).toEqual(titles(""));
  });

  it("matches a title's substring ignoring case, never its detail", () => {
    expect(titles("g")).toEqual(["Git URL"]);
    expect(titles("G")).toEqual(["Git URL"]);
    expect(titles("fold")).toEqual(["Local folder"]);
    expect(titles("clone")).toEqual([]);
  });
});

describe("repositoryNameFromUrl", () => {
  it.each([
    ["https://github.com/example/docs-site.git", "docs-site"],
    ["https://github.com/example/docs-site", "docs-site"],
    ["https://github.com/example/docs-site.git/", "docs-site"],
    ["https://github.com/example/docs-site///", "docs-site"],
    ["git@github.com:owner/app.git", "app"],
    ["git@host:app.git", "app"],
    ["ssh://git@host:2222/team/app.git", "app"],
    ["  https://host/app.git  ", "app"],
    ["/srv/git/app.git", "app"],
    ["", ""],
    ["https://host/.git", ""],
  ])("%s names %s", (url, name) => {
    expect(repositoryNameFromUrl(url)).toBe(name);
  });
});

describe("joinLocation", () => {
  it.each([
    ["~/Projects", "Sandbox", "~/Projects/Sandbox"],
    ["~", "Sandbox", "~/Sandbox"],
    ["~/Projects/", "Sandbox", "~/Projects/Sandbox"],
    ["/", "Sandbox", "/Sandbox"],
    ["~/Projects", "", "~/Projects"],
  ])("%s and %s make %s", (base, name, location) => {
    expect(joinLocation(base, name)).toBe(location);
  });
});

describe("targetLocation", () => {
  it("derives from the name or URL until a location is typed", () => {
    expect(
      targetLocation({ kind: "new", name: " App ", location: null }, "~"),
    ).toBe("~/App");
    expect(
      targetLocation(
        { kind: "url", url: "https://host/app.git", location: null },
        "~/Projects",
      ),
    ).toBe("~/Projects/app");
    expect(
      targetLocation(
        { kind: "new", name: "App", location: " /elsewhere " },
        "~",
      ),
    ).toBe("/elsewhere");
  });

  it("is the typed path for a local folder", () => {
    expect(targetLocation({ kind: "local", path: " ~/x " }, "~")).toBe("~/x");
  });
});

describe("namesTarget", () => {
  it("needs a name and a location to create", () => {
    const step = { kind: "new", name: "App", location: null } as const;
    expect(namesTarget(step, "~")).toBe(true);
    expect(namesTarget({ ...step, name: "  " }, "~")).toBe(false);
    expect(namesTarget({ ...step, location: " " }, "~")).toBe(false);
  });

  it("needs a URL and somewhere to clone into", () => {
    const step = { kind: "url", url: "https://h/a", location: null } as const;
    expect(namesTarget(step, "~")).toBe(true);
    expect(namesTarget({ ...step, url: "" }, "~")).toBe(false);
    expect(namesTarget({ ...step, url: "https://h/.git" }, "~")).toBe(false);
    expect(
      namesTarget({ ...step, url: "https://h/.git", location: "~/x" }, "~"),
    ).toBe(true);
  });
});

describe("shownHints", () => {
  it("offers Clear only for a query, and greys what cannot be submitted", () => {
    const labels = (query: string) =>
      shownHints(SOURCES_HINTS, { query, canSubmit: true }).map(
        (hint) => hint.label,
      );
    expect(labels("")).toEqual(["Navigate", "Select", "Close"]);
    expect(labels("g")).toEqual(["Navigate", "Select", "Clear", "Close"]);
    const local = shownHints(STEP_TEXT.local.hints, {
      query: "",
      canSubmit: false,
    });
    expect(
      local.filter((hint) => hint.disabled).map(({ label }) => label),
    ).toEqual(["Open"]);
  });
});

describe("baseFromHome", () => {
  it("uses Projects when home has it, else home", () => {
    expect(baseFromHome([entry("/h/Projects"), entry("/h/x")])).toBe(
      "~/Projects",
    );
    expect(baseFromHome([entry("/h/projects")])).toBe("~");
    expect(baseFromHome([])).toBe("~");
  });
});

describe("descendInto", () => {
  it("keeps a typed ~ when the short form names the entry", () => {
    expect(descendInto("~", entry("/h/Projects"))).toBe("~/Projects");
    expect(descendInto("~/Projects", entry("/h/Projects/app"))).toBe(
      "~/Projects/app",
    );
    expect(descendInto("~/Projects/", entry("/h/Projects/app"))).toBe(
      "~/Projects/app",
    );
    expect(descendInto("~/Projects/ap", entry("/h/Projects/app"))).toBe(
      "~/Projects/app",
    );
  });

  it("uses the entry's absolute path otherwise", () => {
    expect(descendInto("/srv/git", entry("/srv/git/app"))).toBe("/srv/git/app");
    expect(descendInto("~/a/../b", entry("/h/b/app"))).toBe("/h/b/app");
  });
});

it("every source starts its own step", () => {
  expect(SOURCES.map((source) => source.start("~/x"))).toEqual([
    { kind: "local", path: "~/x" },
    { kind: "url", url: "", location: null },
    { kind: "new", name: "", location: null },
  ]);
});
