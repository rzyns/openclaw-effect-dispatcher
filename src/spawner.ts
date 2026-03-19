import { Context, Effect, Layer, Schema } from "effect"
import { SpawnError } from "./errors.js"
import { AppConfig } from "./config.js"

// ---------------------------------------------------------------------------
// Response schema — validates the webhook response at the API boundary
// ---------------------------------------------------------------------------

const SpawnResponseSchema = Schema.Struct({
  sessionKey: Schema.String,
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

        const rawJson = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) =>
            new SpawnError({
              issueId: params.issueId,
              reason: `Failed to read spawn response body: ${String(cause)}`,
            }),
        })

        const body = yield* Schema.decodeUnknown(SpawnResponseSchema)(rawJson).pipe(
          Effect.mapError(
            (e) =>
              new SpawnError({
                issueId: params.issueId,
                reason: `Spawn response validation failed: ${String(e)}`,
              })
          )
        )

        return { sessionKey: body.sessionKey }
      })

    return AgentSpawner.of({ spawn })
  })
)
