/** These choices populate the existing per-instance environment editor. */
export const MEERKAT_CREDENTIAL_PRESETS = [
  {
    label: "Anthropic",
    variables: [{ name: "ANTHROPIC_API_KEY", label: "Anthropic API key", sensitive: true }],
  },
  {
    label: "OpenAI",
    variables: [{ name: "OPENAI_API_KEY", label: "OpenAI API key", sensitive: true }],
  },
  {
    label: "Gemini",
    variables: [{ name: "GEMINI_API_KEY", label: "Gemini API key", sensitive: true }],
  },
  {
    label: "Prefer Azure OpenAI",
    variables: [
      { name: "RKAT_AZURE_OPENAI_ENDPOINT", label: "Preferred Azure endpoint", sensitive: false },
      { name: "RKAT_AZURE_OPENAI_API_KEY", label: "Preferred Azure API key", sensitive: true },
    ],
  },
] as const;

export const MEERKAT_CREDENTIAL_FIELDS = [
  ...MEERKAT_CREDENTIAL_PRESETS.flatMap((preset) => [...preset.variables]),
  { name: "AZURE_OPENAI_ENDPOINT", label: "Azure endpoint (fallback)", sensitive: false },
  { name: "AZURE_OPENAI_API_KEY", label: "Azure API key (fallback)", sensitive: true },
] as const;

export const MEERKAT_AZURE_CREDENTIAL_GUIDANCE =
  "Public OpenAI keys take priority over plain AZURE_* settings. Either nonempty preferred Azure field selects Azure when an endpoint and key are available. Fields save separately; a missing preferred value can come from saved or host-level Azure settings. Check that the endpoint and key belong together. Other keys are retained. New and resumed sessions using environment credentials can adopt these changes; explicitly configured connections use their own accounts.";

export const MEERKAT_BROWSER_SIGN_IN_GUIDANCE =
  "For a configured OAuth account, open Provider connections from your project's Connections menu to sign in with a browser.";

export const MEERKAT_API_KEY_GUIDANCE =
  "Add an API key in this provider's Credentials settings. Browser sign-in for configured OAuth accounts is in project Connections.";

/** Replace the old setup directions while preserving actual runtime diagnostics. */
export function meerkatCredentialStatusDetail(message: string | null | undefined) {
  return !message ||
    message ===
      "Open project Connections to set up API-key credentials or sign in with a configured OAuth profile."
    ? MEERKAT_API_KEY_GUIDANCE
    : message;
}
