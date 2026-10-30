import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

/** Where the user's Claude API key is kept. Never logged, never sent to the browser. */
export interface KeyStore {
  available(): Promise<boolean>;
  get(): Promise<string | undefined>;
  set(key: string): Promise<void>;
  delete(): Promise<void>;
}

const SERVICE = "binlight";
const ACCOUNT = "claude-api-key";

/**
 * Characters a key may contain. Anthropic keys are [A-Za-z0-9_-] after the
 * "sk-ant-" prefix; anything else is refused before it reaches a shell tool.
 */
export const KEY_PATTERN = /^[A-Za-z0-9_\-.:+=/]{20,300}$/;

/**
 * The macOS Keychain, through the `security` tool. Writes go through
 * `security -i` on stdin, so the key never appears in a process's arguments
 * (where `ps` would show it). `security -i` exits 0 even when a command fails,
 * so failures are read from its output.
 */
export class MacKeychain implements KeyStore {
  async available(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    return promisify(execFile)("security", ["help"]).then(
      () => true,
      // `security help` exits 1 after printing usage; it still means the tool exists.
      (err: { code?: unknown }) => err.code !== "ENOENT",
    );
  }

  async get(): Promise<string | undefined> {
    try {
      const { stdout } = await promisify(execFile)("security", [
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        ACCOUNT,
        "-w",
      ]);
      return stdout.trim() || undefined;
    } catch {
      return undefined; // not found
    }
  }

  async set(key: string): Promise<void> {
    if (!KEY_PATTERN.test(key)) throw new Error("That does not look like an API key.");
    await interactive(`add-generic-password -U -s "${SERVICE}" -a "${ACCOUNT}" -w "${key}"`);
  }

  async delete(): Promise<void> {
    await interactive(`delete-generic-password -s "${SERVICE}" -a "${ACCOUNT}"`, {
      allowNotFound: true,
    });
  }
}

/** Runs one `security -i` command from stdin; throws with `security`'s message on failure. */
function interactive(command: string, options: { allowNotFound?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", ["-i"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr.on("data", (c: Buffer) => (output += c.toString()));
    child.on("error", reject);
    child.on("close", () => {
      const failed = /returned -\d+/.test(output);
      const notFound = /-25300/.test(output);
      if (failed && !(options.allowNotFound && notFound)) {
        // `security` echoes nothing of the key in its error lines.
        reject(
          new Error(`The Keychain refused the change: ${output.trim().split("\n").at(-1) ?? ""}`),
        );
      } else {
        resolve();
      }
    });
    child.stdin.end(`${command}\n`);
  });
}

/** For tests and non-macOS hosts: keeps the key in memory only. */
export class MemoryKeyStore implements KeyStore {
  private key: string | undefined;
  constructor(private readonly isAvailable = true) {}
  available = async () => this.isAvailable;
  get = async () => this.key;
  set = async (key: string) => {
    this.key = key;
  };
  delete = async () => {
    this.key = undefined;
  };
}

/** "sk-ant-…a1b2": enough to recognise a key, useless to anyone else. */
export function keyHint(key: string): string {
  const prefix = key.startsWith("sk-ant-") ? "sk-ant-" : key.slice(0, 3);
  return `${prefix}…${key.slice(-4)}`;
}
