import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  AiPreview,
  Finding,
  RecipeInfo,
  RecipeSuggestion,
  Verdict,
  VerdictBody,
} from "@binlight/shared";
import { z } from "zod";

/** What Binlight sends Claude: finding statements and caveats only, never snippets, strings or binaries. */
export interface AiRequest {
  question: string;
  recipe: string;
  confidence: Verdict["confidence"];
  gaps: string[];
  rulesVerdict: VerdictBody;
  findings: {
    id: string;
    statement: string;
    confidence: Finding["confidence"];
    caveats: string[];
  }[];
}

export interface AiWriter {
  model: string;
  write(request: AiRequest, signal?: AbortSignal): Promise<VerdictBody>;
}

/** A failure with a reason fit to show the user. */
export class AiWriteError extends Error {}

/** Findings beyond this are left out of the request (the validator then rejects citing them). */
const MAX_FINDINGS = 300;

export function aiRequest(
  question: string,
  recipe: string,
  verdict: Pick<Verdict, "confidence" | "gaps" | "rules">,
  findings: Finding[],
): AiRequest {
  return {
    question,
    recipe,
    confidence: verdict.confidence,
    gaps: verdict.gaps,
    rulesVerdict: verdict.rules,
    findings: findings.slice(0, MAX_FINDINGS).map((f) => ({
      id: f.id,
      statement: f.statement,
      confidence: f.confidence,
      caveats: f.caveats,
    })),
  };
}

const SYSTEM = `You write the verdict of a binary-analysis report for working software developers.
You receive the question, findings that Binlight's rules derived from reverse-engineering evidence, the gaps (what could not be checked), a confidence level, and a rule-based draft verdict.
Rewrite the draft in plain, direct English:
- "answer": one or two sentences that answer the question.
- "claims": the supporting sentences, each citing the ids of the findings it rests on (only ids from the input).
Use only facts stated in the findings. Do not add numbers, names or conclusions that the cited findings do not contain, and keep their caveats' meaning: a URL embedded in a binary does not show it is contacted, and an incomplete list must not be presented as complete.
Never say what the program connects or talks to, never call it safe, secure or malicious, and never say it uses "only" some number of servers.
Do not change the confidence; mention a gap when it limits the answer.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          findings: { type: "array", items: { type: "string" } },
        },
        required: ["text", "findings"],
        additionalProperties: false,
      },
    },
  },
  required: ["answer", "claims"],
  additionalProperties: false,
} as const;

const outputShape = z.object({
  answer: z.string(),
  claims: z.array(z.object({ text: z.string(), findings: z.array(z.string()) })),
});

/** The exact request a verdict rewrite sends; the preview shows this same object. */
export function verdictParams(model: string, request: AiRequest) {
  return {
    model,
    max_tokens: 16000,
    // Re-run a declined request on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default" as const,
    output_config: {
      effort: "medium" as const,
      format: { type: "json_schema" as const, schema: OUTPUT_SCHEMA },
    },
    system: SYSTEM,
    messages: [{ role: "user" as const, content: JSON.stringify(request) }],
  };
}

/** What `write` would send, for the user to approve first. */
export function verdictPreview(model: string, request: AiRequest): AiPreview {
  const params = verdictParams(model, request);
  const content = params.messages[0]?.content ?? "";
  return {
    model,
    system: params.system,
    request: content,
    characters: params.system.length + content.length,
  };
}

export interface ClaudeWriterOptions {
  model?: string;
  timeoutMs?: number;
  /** Injected in tests; otherwise created on first use from the environment. */
  client?: Anthropic;
}

export const DEFAULT_AI_MODEL = "claude-opus-5-5";

/**
 * Writes verdicts with Claude (the user's own key, from the environment).
 * Structured output keeps the shape; Binlight's validator still checks the
 * content. Results are remembered per request, so a cached repeat costs nothing.
 */
export function claudeWriter(options: ClaudeWriterOptions = {}): AiWriter {
  const model = options.model ?? DEFAULT_AI_MODEL;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const remembered = new Map<string, VerdictBody>();
  let client = options.client;

  return {
    model,
    async write(request, signal) {
      const key = createHash("sha256").update(model).update(JSON.stringify(request)).digest("hex");
      const known = remembered.get(key);
      if (known) return known;

      let response: Anthropic.Beta.BetaMessage;
      try {
        client ??= new Anthropic();
        response = await client.beta.messages.create(verdictParams(model, request), {
          timeout: timeoutMs,
          ...(signal && { signal }),
        });
      } catch (err) {
        throw new AiWriteError(describeApiError(err, timeoutMs), { cause: err });
      }

      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category;
        throw new AiWriteError(
          `Claude declined to write the verdict${category ? ` (${category})` : ""}.`,
        );
      }
      if (response.stop_reason === "max_tokens") {
        throw new AiWriteError("Claude's answer was cut off before it finished.");
      }
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      let parsed: VerdictBody;
      try {
        parsed = outputShape.parse(JSON.parse(text));
      } catch {
        throw new AiWriteError("Claude's answer was not in the expected format.");
      }
      remembered.set(key, parsed);
      return parsed;
    },
  };
}

export function describeApiError(err: unknown, timeoutMs: number): string {
  // Most specific first: in this SDK the connection errors subclass APIError.
  if (err instanceof Anthropic.AuthenticationError) {
    return "The Claude API rejected the API key (401). Check ANTHROPIC_API_KEY.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return `The Claude API refused access (403): ${err.message}`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "The Claude API rate limit was reached (429); try again later.";
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return `Claude did not answer within ${Math.round(timeoutMs / 1000)} s.`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return `Could not reach the Claude API: ${err.message}`;
  }
  if (err instanceof Anthropic.APIError) {
    return `Claude API error ${err.status ?? ""}: ${err.message}`.trim();
  }
  if (err instanceof Anthropic.AnthropicError) {
    // Raised by the SDK before any request, e.g. no credentials configured.
    return `The Claude API client is not set up (${err.message}). Set ANTHROPIC_API_KEY to your own key on the Binlight server, or switch AI off.`;
  }
  if (err instanceof Error && err.name === "AbortError") return "Cancelled.";
  return err instanceof Error ? err.message : String(err);
}

const SUGGEST_SYSTEM = `You help a developer pick a recipe in Binlight, a tool that analyses compiled programs.
Given their question and the available recipes, choose the one recipe whose question best covers it, or none.
Choose none when no recipe really answers it; do not stretch a recipe to fit. Explain the choice in one short sentence.`;

const SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    recipe: { anyOf: [{ type: "string" }, { type: "null" }] },
    reason: { type: "string" },
  },
  required: ["recipe", "reason"],
  additionalProperties: false,
} as const;

/** Maps a free-text question to a recipe id, or null with the honest reason. */
export async function suggestRecipe(
  client: Anthropic,
  model: string,
  question: string,
  recipes: RecipeInfo[],
): Promise<RecipeSuggestion> {
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create(
      {
        model,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: SUGGEST_SCHEMA } },
        system: SUGGEST_SYSTEM,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              question,
              recipes: recipes.map(({ id, title, question: q, description }) => ({
                id,
                title,
                question: q,
                description,
              })),
            }),
          },
        ],
      },
      { timeout: 60_000 },
    );
  } catch (err) {
    throw new AiWriteError(describeApiError(err, 60_000), { cause: err });
  }
  if (response.stop_reason === "refusal") throw new AiWriteError("Claude declined to answer.");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let parsed: RecipeSuggestion;
  try {
    parsed = z
      .object({ recipe: z.string().nullable(), reason: z.string() })
      .parse(JSON.parse(text));
  } catch {
    throw new AiWriteError("Claude's answer was not in the expected format.");
  }
  // Never trust an id we did not offer.
  if (parsed.recipe !== null && !recipes.some((r) => r.id === parsed.recipe)) {
    return {
      recipe: null,
      reason: `Claude named a recipe that does not exist ("${parsed.recipe}").`,
    };
  }
  return parsed;
}
