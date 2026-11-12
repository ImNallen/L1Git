import { expect, it } from "vitest";
import { conflictRegions, hasLeftoverMarkers } from "./conflictRegions";

const region = (eol: string) =>
  ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> topic"].join(eol);

it.each(["\n", "\r\n"])("counts closed regions with %j endings", (eol) => {
  expect(conflictRegions(["a", region(eol), "b", region(eol)].join(eol))).toBe(
    2,
  );
  expect(conflictRegions(`${region(eol)}${eol}`)).toBe(1);
});

it("counts a diff3 region once", () => {
  expect(
    conflictRegions(
      "<<<<<<< HEAD\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> topic\n",
    ),
  ).toBe(1);
});

it("ignores text that only looks like markers", () => {
  expect(conflictRegions("")).toBe(0);
  expect(conflictRegions("resolved\n")).toBe(0);
  expect(conflictRegions("<<<<<<<HEAD\nx\n>>>>>>>topic\n")).toBe(0);
  expect(conflictRegions("<<<<<< HEAD\nx\n>>>>>> topic\n")).toBe(0);
  expect(conflictRegions("<<<<<<< HEAD\nunclosed\n")).toBe(0);
  expect(conflictRegions(">>>>>>> topic\n<<<<<<< HEAD\n")).toBe(0);
  expect(conflictRegions("Title\n=======\n")).toBe(0);
});

it.each(["<", "=", ">", "|"])(
  "flags a leftover %s marker as git diff --check does",
  (char) => {
    const run = char.repeat(7);
    expect(hasLeftoverMarkers(`a\n${run}\nb\n`)).toBe(true);
    expect(hasLeftoverMarkers(`a\n${run} label\nb\n`)).toBe(true);
    expect(hasLeftoverMarkers(`a\n${run}\tlabel\r\nb\r\n`)).toBe(true);
    expect(hasLeftoverMarkers(`a\n${run}\r\nb\r\n`)).toBe(true);
  },
);

it("flags an end marker left after only the start line was deleted", () => {
  const text = "ours\n=======\ntheirs\n>>>>>>> topic\n";
  expect(conflictRegions(text)).toBe(0);
  expect(hasLeftoverMarkers(text)).toBe(true);
});

it("ignores runs of 6 or 8 marker characters and a marker glued to text", () => {
  expect(hasLeftoverMarkers("")).toBe(false);
  expect(hasLeftoverMarkers("resolved\n")).toBe(false);
  expect(hasLeftoverMarkers("<<<<<< HEAD\n======\n>>>>>> topic\n")).toBe(false);
  expect(hasLeftoverMarkers("<<<<<<<< HEAD\n========\n>>>>>>>> topic\n")).toBe(
    false,
  );
  expect(hasLeftoverMarkers("<<<<<<<HEAD\n>>>>>>>topic\n")).toBe(false);
  expect(hasLeftoverMarkers(" =======\n")).toBe(false);
});

it("flags a 7-character setext underline, as git diff --check does", () => {
  expect(hasLeftoverMarkers("Heading\n=======\n")).toBe(true);
  expect(hasLeftoverMarkers("Heading\n========\n")).toBe(false);
});

it("flags a marker on a last line with no newline, which git diff --check skips", () => {
  expect(hasLeftoverMarkers("ours\n>>>>>>> topic")).toBe(true);
});
