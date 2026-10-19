import { describe, expect, it } from "vitest";
import { branchTree } from "./branchTree";
import { branchSchema } from "./repository";

const oid = "a".repeat(40);
const local = (name: string) =>
  branchSchema.parse({
    kind: "local",
    reference: `refs/heads/${name}`,
    name,
    oid,
    upstream: null,
  });
const remote = (name: string) =>
  branchSchema.parse({
    kind: "remote",
    reference: `refs/remotes/${name}`,
    name,
    oid,
    remote: name.split("/")[0],
  });

describe("branch folders", () => {
  it("nests every slash segment, sorts folders, keeps branch order, and counts at any depth", () => {
    const main = local("main");
    const greeting = local("t3/greeting");
    const x = local("feat/ui/x");
    const develop = local("develop");
    const sidebar = local("sidebar/foo");
    const api = local("feat/api");
    const a = local("feat/ui/a");
    expect(branchTree([main, greeting, x, develop, sidebar, api, a])).toEqual({
      folders: [
        {
          path: "feat",
          name: "feat",
          count: 3,
          folders: [
            {
              path: "feat/ui",
              name: "ui",
              count: 2,
              folders: [],
              branches: [x, a],
            },
          ],
          branches: [api],
        },
        {
          path: "sidebar",
          name: "sidebar",
          count: 1,
          folders: [],
          branches: [sidebar],
        },
        {
          path: "t3",
          name: "t3",
          count: 1,
          folders: [],
          branches: [greeting],
        },
      ],
      branches: [main, develop],
    });
  });

  it("groups remote branches by remote first, then by folder", () => {
    const head = remote("origin/HEAD");
    const main = remote("origin/main");
    const feat = remote("origin/feat/x");
    const fork = remote("fork/main");
    expect(branchTree([head, main, feat, fork])).toEqual({
      folders: [
        {
          path: "fork",
          name: "fork",
          count: 1,
          folders: [],
          branches: [fork],
        },
        {
          path: "origin",
          name: "origin",
          count: 3,
          folders: [
            {
              path: "origin/feat",
              name: "feat",
              count: 1,
              folders: [],
              branches: [feat],
            },
          ],
          branches: [head, main],
        },
      ],
      branches: [],
    });
  });
});
