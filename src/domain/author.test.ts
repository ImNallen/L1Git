import { describe, expect, it } from "vitest";
import { githubHandle, initials } from "./author";

describe("initials", () => {
  it("takes the first letter of the first two names", () => {
    expect(initials("adam nilsson")).toBe("AN");
    expect(initials("  Ada Byron Lovelace ")).toBe("AB");
    expect(initials("Nallen")).toBe("N");
  });
});

describe("githubHandle", () => {
  it("reads the username from GitHub noreply addresses", () => {
    expect(githubHandle("47414671+ImNallen@users.noreply.github.com")).toBe(
      "ImNallen",
    );
    expect(githubHandle("octocat@users.noreply.github.com")).toBe("octocat");
  });

  it("returns null for other addresses", () => {
    expect(githubHandle("nooxie94@gmail.com")).toBeNull();
    expect(githubHandle("someone@noreply.github.com")).toBeNull();
  });
});
