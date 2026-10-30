import Anthropic from "@anthropic-ai/sdk";
import type { AiSettings, RecipeInfo, RecipeSuggestion } from "@binlight/shared";
import {
  AiWriteError,
  claudeWriter,
  describeApiError,
  suggestRecipe,
  type AiWriter,
} from "../verdict/index.js";
import { KEY_PATTERN, keyHint, type KeyStore } from "./keystore.js";
import type { SettingsFile } from "./settings.js";

/** What the job manager gets: either why AI is off, or a writer and whether to ask first. */
export type AiState = { off: string } | { writer: AiWriter; ask: boolean };

export interface AiProvider {
  current(): Promise<AiState>;
}

/** A settings change the user must fix, with the reason. */
export class AiSettingsError extends Error {}

/**
 * AI settings: the mode and model (settings file), the user's own key
 * (Keychain first, else ANTHROPIC_API_KEY in the server's environment), and
 * Claude clients built from them. The key is never returned, only a hint.
 */
export class AiService implements AiProvider {
  private readonly writers = new Map<string, AiWriter>();

  constructor(
    private readonly settings: SettingsFile,
    private readonly keys: KeyStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly makeClient: (apiKey: string) => Anthropic = (apiKey) =>
      new Anthropic({ apiKey }),
  ) {}

  async status(): Promise<AiSettings> {
    const { ai } = await this.settings.read();
    const key = await this.resolveKey();
    return {
      mode: ai.mode,
      model: ai.model,
      askBeforeSending: ai.askBeforeSending,
      key: key ? { source: key.source, hint: keyHint(key.key) } : { source: "none" },
      keychainAvailable: await this.keys.available(),
    };
  }

  async current(): Promise<AiState> {
    const { ai } = await this.settings.read();
    if (ai.mode !== "claude") {
      return {
        off: "AI is off (local-only mode): this verdict comes from Binlight's rules alone.",
      };
    }
    const key = await this.resolveKey();
    if (!key) {
      return {
        off: "AI is on, but no Claude API key is set: this verdict comes from Binlight's rules alone.",
      };
    }
    const id = `${ai.model}\u0000${key.key}`;
    let writer = this.writers.get(id);
    if (!writer) {
      writer = claudeWriter({ model: ai.model, client: this.makeClient(key.key) });
      this.writers.set(id, writer);
    }
    return { writer, ask: ai.askBeforeSending };
  }

  /** Checks the key with the Claude API (free), then stores it. Nothing is stored if the check fails. */
  async setKey(raw: string): Promise<AiSettings> {
    const key = raw.trim();
    if (!KEY_PATTERN.test(key)) {
      throw new AiSettingsError(
        "That does not look like a Claude API key (it should start with sk-ant-).",
      );
    }
    if (!(await this.keys.available())) {
      throw new AiSettingsError(
        "This server cannot use the macOS Keychain. Set ANTHROPIC_API_KEY in the server's environment instead.",
      );
    }
    const { ai } = await this.settings.read();
    try {
      await this.makeClient(key).models.retrieve(ai.model);
    } catch (err) {
      // About the key just pasted, not ANTHROPIC_API_KEY.
      const reason =
        err instanceof Anthropic.AuthenticationError
          ? "Claude rejected this key (401). Check that it was copied in full and has not been revoked."
          : describeApiError(err, 60_000);
      throw new AiSettingsError(`The key was not saved: ${reason}`);
    }
    await this.keys.set(key);
    this.writers.clear();
    return this.status();
  }

  async deleteKey(): Promise<AiSettings> {
    await this.keys.delete();
    this.writers.clear();
    // Without a key, Claude can't be used; say so by switching to local-only.
    if (!(await this.resolveKey())) await this.settings.update((s) => (s.ai.mode = "local-only"));
    return this.status();
  }

  async update(change: {
    mode?: AiSettings["mode"];
    askBeforeSending?: boolean;
    model?: string;
  }): Promise<AiSettings> {
    if (change.mode === "claude" && !(await this.resolveKey())) {
      throw new AiSettingsError("Add a Claude API key before switching AI on.");
    }
    await this.settings.update((s) => {
      if (change.mode) s.ai.mode = change.mode;
      if (change.askBeforeSending !== undefined) s.ai.askBeforeSending = change.askBeforeSending;
      if (change.model) s.ai.model = change.model;
    });
    this.writers.clear();
    return this.status();
  }

  /** Which recipe answers a question. Sends the question and the recipe list to Claude. */
  async suggest(question: string, recipes: RecipeInfo[]): Promise<RecipeSuggestion> {
    const { ai } = await this.settings.read();
    const key = await this.resolveKey();
    if (ai.mode !== "claude" || !key) {
      throw new AiSettingsError("Asking in your own words needs AI on, with a Claude API key.");
    }
    try {
      return await suggestRecipe(this.makeClient(key.key), ai.model, question, recipes);
    } catch (err) {
      throw new AiSettingsError(err instanceof AiWriteError ? err.message : String(err));
    }
  }

  private async resolveKey(): Promise<
    { key: string; source: "keychain" | "environment" } | undefined
  > {
    const stored = (await this.keys.available()) ? await this.keys.get() : undefined;
    if (stored) return { key: stored, source: "keychain" };
    const fromEnv = this.env["ANTHROPIC_API_KEY"]?.trim();
    return fromEnv ? { key: fromEnv, source: "environment" } : undefined;
  }
}
