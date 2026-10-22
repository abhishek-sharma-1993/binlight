import { describe, expect, it } from "vitest";
import { diffShapes, shapeOf } from "./shape.js";

describe("shapeOf", () => {
  it("maps every path to its types, marking keys some array elements lack", () => {
    expect(
      shapeOf({ id: "x", items: [{ a: 1, b: null }, { a: 2 }], tags: [], extra: null }),
    ).toEqual({
      $: "object",
      extra: "null",
      id: "string",
      items: "array",
      "items[]": "object",
      "items[].a": "number",
      "items[].b": "absent|null",
      tags: "array",
    });
  });
});

describe("diffShapes", () => {
  it("reports removed, changed and added paths", () => {
    const diff = diffShapes({ a: "string", b: "number" }, { a: "number", c: "string" });
    expect(diff).toEqual({ removed: ["b"], changed: ["a: string -> number"], added: ["c"] });
  });
});
