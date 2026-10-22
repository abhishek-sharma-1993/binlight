import { describe, expect, it } from "vitest";
import { PINNED_REA_VERSION } from "../rea/version.js";
import { errorSchemaProblems, loadRecordings, schemaProblems } from "./run.js";
import { shapeOf } from "./shape.js";

// Offline: keeps the recordings, the schemas and the REA pin consistent.

const recordings = loadRecordings(PINNED_REA_VERSION);

describe(`recorded REA ${PINNED_REA_VERSION} contracts`, () => {
  it("exist for the pinned REA version", () => {
    expect(recordings.length, "run: npm run contracts:record").toBeGreaterThan(0);
  });

  for (const rec of recordings) {
    describe(rec.provider, () => {
      it.each(rec.steps)("$tool sample parses with Binlight's schema", (step) => {
        expect(schemaProblems(step.tool, step.sample)).toEqual([]);
      });

      it.each(rec.steps)("$tool sample agrees with its recorded shape", (step) => {
        // Samples are truncated, so every sampled path must exist in the full shape.
        const full = step.shape;
        for (const [path, types] of Object.entries(shapeOf(step.sample))) {
          expect(full, path).toHaveProperty([path]);
          for (const t of types.split("|")) expect(full[path]?.split("|"), path).toContain(t);
        }
      });

      it.each(rec.errors)("error '$name' sample parses as a REA error", (err) => {
        expect(errorSchemaProblems(err.name, err.sample)).toEqual([]);
      });
    });
  }
});
