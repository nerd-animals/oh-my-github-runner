export const PERSONAS = [
  { id: "architect", label: "Architect" },
  { id: "test", label: "Test" },
  { id: "ops", label: "Ops" },
  { id: "maintenance", label: "Maintenance" },
] as const;

export type PersonaId = (typeof PERSONAS)[number]["id"];

// Static persona ↔ tool mapping. The strategy declares all three tools in
// `policies.uses`, so the daemon defers the task until every tool is clear
// of rate-limit before starting — no fallback at strategy level needed.
//
// Mapping is empirical; adjust here as we learn which tool produces the best
// output for each persona. Nothing else needs to change.
export const TOOL_MAP: Record<PersonaId, string> = {
  architect: "claude",
  test: "codex",
  ops: "gemini",
  maintenance: "codex",
};

export const PUBLISHER_TOOL = "gemini";
