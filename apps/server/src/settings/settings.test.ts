import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiService, AiSettingsError } from "./ai-service.js";
import { KEY_PATTERN, keyHint, MacKeychain, MemoryKeyStore } from "./keystore.js";
import { SettingsFile } from "./settings.js";

const KEY = `sk-ant-api03-${"k".repeat(40)}wxyz`;

/** A fake SDK client whose key check succeeds or throws. */
function clientFactory(check: () => Promise<unknown> = async () => ({ id: "claude-opus-5-5" })) {
  const made: string[] = [];
  const make = (apiKey: string) => {
    made.push(apiKey);
    return {
      models: { retrieve: check },
      beta: { messages: { create: async () => ({}) } },
    } as unknown as Anthropic;
  };
  return { make, made };
}

describe("key store helpers", () => {
  it("hints at a key without revealing it", () => {
    expect(keyHint(KEY)).toBe("sk-ant-…wxyz");
  });

  it("refuses anything that could break out of the security command", () => {
    expect(KEY_PATTERN.test(KEY)).toBe(true);
    for (const bad of [`${KEY}"; delete-keychain x`, `${KEY} x`, `${KEY}\\`, "short"]) {
      expect(KEY_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it("rejects a malformed key before running security", async () => {
    await expect(new MacKeychain().set('bad" key')).rejects.toThrow(
      /does not look like an API key/,
    );
  });
});

describe("AiService", () => {
  let dir: string;
  let settings: SettingsFile;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "binlight-settings-"));
    settings = new SettingsFile(join(dir, "settings.json"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is local-only by default, with no key", async () => {
    const ai = new AiService(settings, new MemoryKeyStore(), {}, clientFactory().make);
    expect(await ai.status()).toEqual({
      mode: "local-only",
      model: "claude-opus-5-5",
      askBeforeSending: true,
      key: { source: "none" },
      keychainAvailable: true,
    });
    expect(await ai.current()).toEqual({ off: expect.stringContaining("local-only") });
  });

  it("checks a key with Claude before storing it, and never returns it", async () => {
    const keys = new MemoryKeyStore();
    const clients = clientFactory();
    const ai = new AiService(settings, keys, {}, clients.make);
    const status = await ai.setKey(` ${KEY} `);
    expect(clients.made).toEqual([KEY]);
    expect(await keys.get()).toBe(KEY);
    expect(status.key).toEqual({ source: "keychain", hint: "sk-ant-…wxyz" });
    expect(JSON.stringify(status)).not.toContain(KEY);
    // Nothing secret is written to the settings file.
    await ai.update({ mode: "claude" });
    expect(readFileSync(settings.path, "utf8")).not.toContain(KEY);
  });

  it("stores nothing when Claude rejects the key, and says why", async () => {
    const keys = new MemoryKeyStore();
    const reject = clientFactory(async () => {
      throw new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers());
    });
    const ai = new AiService(settings, keys, {}, reject.make);
    await expect(ai.setKey(KEY)).rejects.toThrow(
      new AiSettingsError(
        "The key was not saved: Claude rejected this key (401). Check that it was copied in full and has not been revoked.",
      ),
    );
    expect(await keys.get()).toBeUndefined();
  });

  it("refuses to switch AI on without a key, and uses ANTHROPIC_API_KEY when set", async () => {
    const without = new AiService(settings, new MemoryKeyStore(), {}, clientFactory().make);
    await expect(without.update({ mode: "claude" })).rejects.toThrow(/Add a Claude API key/);
    const withEnv = new AiService(
      settings,
      new MemoryKeyStore(),
      { ANTHROPIC_API_KEY: KEY },
      clientFactory().make,
    );
    await withEnv.update({ mode: "claude", askBeforeSending: false });
    expect((await withEnv.status()).key).toEqual({ source: "environment", hint: "sk-ant-…wxyz" });
    const state = await withEnv.current();
    expect("writer" in state && state.ask).toBe(false);
  });

  it("goes back to local-only when the only key is removed", async () => {
    const keys = new MemoryKeyStore();
    const ai = new AiService(settings, keys, {}, clientFactory().make);
    await ai.setKey(KEY);
    await ai.update({ mode: "claude" });
    const status = await ai.deleteKey();
    expect(status).toMatchObject({ mode: "local-only", key: { source: "none" } });
  });

  it("explains when the Keychain is not available", async () => {
    const ai = new AiService(settings, new MemoryKeyStore(false), {}, clientFactory().make);
    await expect(ai.setKey(KEY)).rejects.toThrow(/cannot use the macOS Keychain/);
  });

  it("only offers recipe suggestions with AI on", async () => {
    const ai = new AiService(settings, new MemoryKeyStore(), {}, clientFactory().make);
    await expect(ai.suggest("does it phone home?", [])).rejects.toThrow(/needs AI on/);
  });
});
