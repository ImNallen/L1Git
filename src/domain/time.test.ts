import { describe, expect, it } from "vitest";
import { relativeTime } from "./time";

const now = 1_800_000_000;
const ago = (seconds: number) => relativeTime(now - seconds, now, "en");

describe("relativeTime", () => {
  it("names recent moments in the largest whole unit", () => {
    expect(ago(20)).toBe("just now");
    expect(ago(5 * 60)).toBe("5 minutes ago");
    expect(ago(3 * 3600)).toBe("3 hours ago");
    expect(ago(24 * 3600)).toBe("yesterday");
    expect(ago(3 * 24 * 3600)).toBe("3 days ago");
    expect(ago(14 * 24 * 3600)).toBe("2 weeks ago");
    expect(ago(60 * 24 * 3600)).toBe("2 months ago");
    expect(ago(2 * 365 * 24 * 3600)).toBe("2 years ago");
  });

  it("handles commit dates slightly in the future", () => {
    expect(ago(-2 * 3600)).toBe("in 2 hours");
  });
});
