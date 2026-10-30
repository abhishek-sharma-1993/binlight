import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DEFAULT_AI_MODEL } from "../verdict/ai.js";

/** Settings that are not secret. The API key is never stored here. */
const schema = z.object({
  ai: z
    .object({
      mode: z.enum(["local-only", "claude"]).default("local-only"),
      model: z.string().min(1).default(DEFAULT_AI_MODEL),
      askBeforeSending: z.boolean().default(true),
    })
    .default({ mode: "local-only", model: DEFAULT_AI_MODEL, askBeforeSending: true }),
});
export type StoredSettings = z.infer<typeof schema>;

export const defaultSettingsPath = (): string => join(homedir(), ".binlight", "settings.json");

/** ~/.binlight/settings.json; missing or unreadable means the defaults (local-only). */
export class SettingsFile {
  constructor(readonly path: string = defaultSettingsPath()) {}

  async read(): Promise<StoredSettings> {
    try {
      return schema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return schema.parse({});
    }
  }

  async update(change: (s: StoredSettings) => void): Promise<StoredSettings> {
    const settings = await this.read();
    change(settings);
    const valid = schema.parse(settings);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const partial = `${this.path}.partial`;
    await writeFile(partial, JSON.stringify(valid, null, 2) + "\n", { mode: 0o600 });
    await rename(partial, this.path);
    return valid;
  }
}
