export const PERSONAS = [
  { id: "architect", label: "Architect" },
  { id: "test", label: "Test" },
  { id: "ops", label: "Ops" },
  { id: "maintenance", label: "Maintenance" },
] as const;

export type PersonaId = (typeof PERSONAS)[number]["id"];

// Static persona ↔ tool mapping. The strategy uses all three tools by design;
// if any tool is rate-limited, the whole task returns rate_limited and the
// queue retries — no fallback (kept simple intentionally).
//
// The mapping is empirical. Adjust here as we learn which tool produces the
// best output for each persona; nothing else needs to change.
export const TOOL_MAP: Record<PersonaId, string> = {
  architect: "claude",
  test: "codex",
  ops: "gemini",
  maintenance: "codex",
};
