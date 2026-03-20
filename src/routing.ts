// ---------------------------------------------------------------------------
// State → Agent routing map
//
// Extracted from memory/plane-dispatcher/config.json agent_routing entries.
// States not in this map are silently skipped (no agent spawned).
// ---------------------------------------------------------------------------

export type AgentId = "coding-implementer" | "code-review"

const ROUTING: Record<string, AgentId | undefined> = {
  "Prepare": "coding-implementer",
  "Test": "coding-implementer",
  "Review": "code-review",
  "Merge": "coding-implementer",
  "Closure": "coding-implementer",
  "Request Changes": "code-review",
  "Rebase": "coding-implementer",
  "PR Triage": "coding-implementer",
}

/**
 * Return the agent ID for a given Plane issue state, or null if the state
 * should not trigger an agent spawn.
 */
export const routeIssue = (state: string): AgentId | null => ROUTING[state] ?? null
