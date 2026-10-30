/** AI settings as the page sees them. The API key itself never leaves the server. */
export interface AiSettings {
  /** "local-only": rule-based verdicts only. "claude": Claude rewrites them (with consent). */
  mode: "local-only" | "claude";
  model: string;
  /** Show what will be sent, and wait for the user's go-ahead, before each job's AI call. */
  askBeforeSending: boolean;
  key: {
    /** Where the key comes from: the Keychain (entered in the page), the server's environment, or nowhere. */
    source: "keychain" | "environment" | "none";
    /** e.g. "sk-ant-…a1b2"; never the key. */
    hint?: string;
  };
  /** Whether this server can store a key in the macOS Keychain. */
  keychainAvailable: boolean;
}

/** Exactly what a job would send to Claude, shown before sending. */
export interface AiPreview {
  model: string;
  system: string;
  /** The user message, verbatim. */
  request: string;
  /** Size of system + request, in characters. */
  characters: number;
}

/** Claude's answer to "which recipe answers this question?". */
export interface RecipeSuggestion {
  /** A recipe id, or null when no recipe covers the question. */
  recipe: string | null;
  reason: string;
}
