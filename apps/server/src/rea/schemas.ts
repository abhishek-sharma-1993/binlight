import { z } from "zod";

/**
 * The parts of REA's responses that Binlight relies on, recorded from REA 6.7.0.
 * Objects are not strict: REA may add fields. Removing or retyping one of these
 * fails the contract tests (src/contracts) and the parse at runtime.
 */

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const Subject = z.object({
  name: z.string(),
  digest: z.object({ sha256 }),
  local_path: z.string(),
  format: z.string(),
  architecture: z.string().nullable(),
});

const Provider = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().nullable(),
});

/** REA's Evidence envelope. Every verdict claim cites an `evidence_id`. */
function evidence<T extends z.ZodType>(normalized: T) {
  return z.object({
    evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/),
    subject: Subject,
    provider: Provider,
    operation: z.string(),
    confidence: z.string(),
    limitations: z.array(z.string()),
    normalized_result: normalized,
  });
}

const count = z.number().int().nonnegative();

/** An address/value row, as `list_strings` and `list_procedures` return them. */
const AddressValue = z.object({ address: z.string(), value: z.string() });

const GoModule = z.object({
  path: z.string(),
  version: z.string(),
  sum: z.string(),
  replacement: z.unknown().nullable(),
});

export const toolSchemas = {
  open_binary: z.object({
    result: z.object({
      path: z.string(),
      format: z.string(),
      kind: z.string(),
      sha256,
      architecture: z.string().nullable(),
    }),
  }),
  close_binary: z.object({ result: z.null() }),
  binary_overview: evidence(
    z.object({
      document: z.string(),
      segments: z.array(
        z.object({ name: z.string(), start: z.string(), end: z.string(), length: count }),
      ),
      segment_count: count,
      procedure_count: count,
      string_count: count,
    }),
  ),
  list_strings: evidence(z.array(AddressValue)),
  list_procedures: evidence(z.array(AddressValue)),
  inspect_go_binary: evidence(
    z.object({
      format: z.string(),
      architecture: z.string().nullable(),
      build_info: z.object({
        go_version: z.string(),
        module: z.object({
          path: z.string(),
          main: GoModule,
          dependencies: z.array(GoModule),
          settings: z.array(z.object({ key: z.string(), value: z.string() })),
          complete: z.boolean(),
        }),
      }),
    }),
  ),
} as const;

export type ContractTool = keyof typeof toolSchemas;
export type ToolOutput<T extends ContractTool> = z.infer<(typeof toolSchemas)[T]>;

export function isContractTool(name: string): name is ContractTool {
  return Object.hasOwn(toolSchemas, name);
}

/** REA's structured tool error (see @binlight/shared ReaError). */
export const reaErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    category: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    remediation: z.object({ action: z.string() }),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
