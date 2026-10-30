import type { AiSettings } from "@binlight/shared";
import { useEffect, useState, type FormEvent } from "react";
import { getAiSettings, removeAiKey, saveAiKey, updateAiSettings } from "./api.js";

/** AI on or off, the user's own key (shown only as a hint), and whether to ask before sending. */
export function AiPanel({ onChange }: { onChange: (s: AiSettings) => void }) {
  const [settings, setSettings] = useState<AiSettings | undefined>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    getAiSettings().then(
      (s) => {
        setSettings(s);
        onChange(s);
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [onChange]);

  async function act(label: string, action: () => Promise<AiSettings>) {
    setError(undefined);
    setBusy(label);
    try {
      const next = await action();
      setSettings(next);
      onChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  }

  function submitKey(e: FormEvent) {
    e.preventDefault();
    const value = key;
    // Clear the field at once: the key is not kept in the page.
    setKey("");
    void act("Checking the key with Claude…", () => saveAiKey(value));
  }

  if (!settings) {
    return (
      <section className="card">
        <h2>AI</h2>
        {error ? (
          <p className="error">Could not load AI settings: {error}</p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>
    );
  }

  const on = settings.mode === "claude";
  const hasKey = settings.key.source !== "none";
  return (
    <section className="card ai-panel">
      <h2>AI</h2>
      <label className="inline">
        <input
          type="checkbox"
          checked={on}
          disabled={!hasKey || busy !== undefined}
          onChange={(e) =>
            void act("Saving…", () =>
              updateAiSettings({ mode: e.target.checked ? "claude" : "local-only" }),
            )
          }
        />
        Use Claude to write verdicts in plain English
      </label>
      <p className="hint">
        {on
          ? `On (${settings.model}). Claude gets the findings' statements and caveats, never your binary or its strings.`
          : "Off: local-only. Verdicts come from Binlight's rules; nothing leaves this machine."}
      </p>
      {on && (
        <label className="inline">
          <input
            type="checkbox"
            checked={settings.askBeforeSending}
            disabled={busy !== undefined}
            onChange={(e) =>
              void act("Saving…", () => updateAiSettings({ askBeforeSending: e.target.checked }))
            }
          />
          Show me what will be sent, and ask, for each job
        </label>
      )}
      <p className="small">
        Key: {settings.key.source === "none" && <span className="muted">none</span>}
        {settings.key.source === "keychain" && (
          <>
            <code>{settings.key.hint}</code> <span className="muted">in the macOS Keychain</span>
          </>
        )}
        {settings.key.source === "environment" && (
          <>
            <code>{settings.key.hint}</code>{" "}
            <span className="muted">from ANTHROPIC_API_KEY on the server</span>
          </>
        )}
      </p>
      {settings.keychainAvailable ? (
        <form onSubmit={submitKey} className="key-form">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={hasKey ? "Replace with another key" : "Your Claude API key (sk-ant-…)"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label="Claude API key"
          />
          <button type="submit" disabled={!key.trim() || busy !== undefined}>
            Save
          </button>
        </form>
      ) : (
        <p className="hint">
          This server can't use the macOS Keychain; set ANTHROPIC_API_KEY where the server runs.
        </p>
      )}
      {settings.key.source === "keychain" && (
        <button
          type="button"
          className="link small"
          disabled={busy !== undefined}
          onClick={() => void act("Removing…", removeAiKey)}
        >
          Remove the key from the Keychain
        </button>
      )}
      <p className="hint">
        Your own key, checked with Claude before it is saved. It stays on this machine and is never
        shown again.
      </p>
      {busy && <p className="muted small">{busy}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
