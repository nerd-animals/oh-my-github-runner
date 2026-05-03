export const PERSONAS = [
  { id: "architect", label: "Architect", omgrDoc: ".omgr/architecture.md" },
  { id: "test", label: "Test", omgrDoc: ".omgr/testing.md" },
  { id: "ops", label: "Ops", omgrDoc: ".omgr/deployment.md" },
  { id: "maintenance", label: "Maintenance", omgrDoc: ".omgr/architecture.md" },
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
  ops: "codex",
  maintenance: "codex",
};

export const PUBLISHER_TOOL = "codex";
