import { Context, Effect, Layer } from "effect"
import { SpawnError } from "./errors.js"
import { AppConfig } from "./config.js"

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
// Response type from OpenClaw webhook
// ---------------------------------------------------------------------------

interface SpawnResponse {
  readonly sessionKey: string
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const AgentSpawnerLive: Layer.Layer<AgentSpawner> = Layer.effect(
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
                task: params.task,
                metadata: { issueId: params.issueId },
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

        const body = yield* Effect.tryPromise({
          try: () => response.json() as Promise<SpawnResponse>,
          catch: (cause) =>
            new SpawnError({
              issueId: params.issueId,
              reason: `Failed to parse spawn response: ${String(cause)}`,
            }),
        })

        return { sessionKey: body.sessionKey }
      })

    return AgentSpawner.of({ spawn })
  })
)
