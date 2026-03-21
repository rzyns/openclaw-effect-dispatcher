import { ConfigError, Context, Effect, Layer, Schema } from "effect"
import { SpawnError } from "./errors.js"
import { AppConfig } from "./config.js"

// ---------------------------------------------------------------------------
// Session key helpers
//
// The /hooks/agent endpoint accepts an optional `sessionKey` in the request
// body. When provided, the gateway normalises it to the canonical agent
// store form via:
//
//   toAgentStoreSessionKey({ requestKey, agentId })
//   → `agent:<normalised-agentId>:<requestKey>`   (when key has no agent: prefix)
//
// We build the same key locally so we can store it in the DB *before* the
// agent starts — no subagent_spawned hook needed.
// ---------------------------------------------------------------------------

/**
 * Normalise an agent id the same way the gateway does:
 *   • lower-case
 *   • replace invalid chars with "-"
 *   • strip leading/trailing dashes
 *   • truncate to 64 chars
 */
export function normaliseAgentId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64)
}

/**
 * Build the full canonical session key for a dispatcher-spawned agent.
 *
 * Formula mirrors the gateway's `toAgentStoreSessionKey`:
 *   agent:<normalised-agentId>:<requestKey>
 *
 * The requestKey we use is `plane-<issueId>` — short, stable, and namespaced
 * to the dispatcher so it can't collide with user sessions.
 */
export function buildAgentSessionKey(agentId: string, issueId: string): string {
  const normAgentId = normaliseAgentId(agentId)
  const requestKey = `plane-${issueId}`
  return `agent:${normAgentId}:${requestKey}`
}

// ---------------------------------------------------------------------------
// Response schema — validates the webhook response at the API boundary
// ---------------------------------------------------------------------------

const SpawnResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  runId: Schema.String,
})

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface AgentSpawner {
  readonly spawn: (params: {
    agentId: string
    task: string
    issueId: string
  }) => Effect.Effect<{ readonly sessionKey: string }, SpawnError>
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

export const AgentSpawner = Context.GenericTag<AgentSpawner>("AgentSpawner")

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const AgentSpawnerLive: Layer.Layer<AgentSpawner, ConfigError.ConfigError> = Layer.effect(
  AgentSpawner,
  Effect.gen(function* () {
    const config = yield* AppConfig

    const spawn = (params: {
      agentId: string
      task: string
      issueId: string
    }): Effect.Effect<{ readonly sessionKey: string }, SpawnError> =>
      Effect.gen(function* () {
        const url = `${config.openclawGatewayUrl}/hooks/agent`

        // Compute the deterministic session key. We include it in the POST body
        // so the gateway uses our key instead of generating a random hook:<uuid>.
        // The gateway stores the session under `agent:<agentId>:plane-<issueId>`,
        // which we pre-compute via buildAgentSessionKey.
        //
        // Previously the spawner returned body.runId (a cron-job-tracking UUID
        // unrelated to the session key), which caused liveness checks to always
        // see an empty session and mark every job dead immediately — leading to
        // the infinite re-queue loop observed with ARCH-17.
        const requestKey = `plane-${params.issueId}`
        const sessionKey = buildAgentSessionKey(params.agentId, params.issueId)

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${config.openclawGatewayToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                agentId: params.agentId,
                message: params.task,
                name: `Plane issue ${params.issueId}`,
                sessionKey: requestKey,
              }),
            }),
          catch: (cause) =>
            new SpawnError({
              issueId: params.issueId,
              reason: `Network error: ${String(cause)}`,
            }),
        })

        if (!response.ok) {
          return yield* Effect.fail(
            new SpawnError({
              issueId: params.issueId,
              reason: `Webhook returned ${response.status}`,
            })
          )
        }

        // We still parse (and discard) the response to catch HTTP-level errors
        // early.  The runId in the response is a cron-job tracking UUID — NOT
        // the session key — so we deliberately ignore it and return the key we
        // computed above.
        const rawJson = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) =>
            new SpawnError({
              issueId: params.issueId,
              reason: `Failed to read spawn response body: ${String(cause)}`,
            }),
        })

        yield* Schema.decodeUnknown(SpawnResponseSchema)(rawJson).pipe(
          Effect.mapError(
            (e) =>
              new SpawnError({
                issueId: params.issueId,
                reason: `Spawn response validation failed: ${String(e)}`,
              })
          )
        )

        return { sessionKey }
      })

    return AgentSpawner.of({ spawn })
  })
)

// ---------------------------------------------------------------------------
// Dry-run implementation — logs intent but never hits the real webhook
// ---------------------------------------------------------------------------

export const AgentSpawnerDryRun: Layer.Layer<AgentSpawner> = Layer.succeed(
  AgentSpawner,
  AgentSpawner.of({
    spawn: (params) =>
      Effect.gen(function* () {
        const sessionKey = buildAgentSessionKey(params.agentId, params.issueId)
        yield* Effect.logInfo(
          `DRY RUN: would spawn ${params.agentId} for issue ${params.issueId} (task: ${params.task})`
        )
        return { sessionKey }
      }),
  })
)
