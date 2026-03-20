import { ConfigError, Context, Effect, Layer, Schema } from "effect"
import { LivenessCheckError } from "./errors.js"
import { AppConfig } from "./config.js"
import type { Liveness } from "./db.js"
import type { PluginRuntime } from "openclaw/plugin-sdk/core"

// ---------------------------------------------------------------------------
// Response schema — validates the sessions history API response
// ---------------------------------------------------------------------------

const SessionMessageSchema = Schema.Struct({
  role: Schema.String,
  timestamp: Schema.String,
})

const SessionHistoryResponseSchema = Schema.Struct({
  messages: Schema.Array(SessionMessageSchema),
})

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface LivenessChecker {
  readonly check: (sessionKey: string) => Effect.Effect<Liveness, LivenessCheckError>
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

export const LivenessChecker = Context.GenericTag<LivenessChecker>("LivenessChecker")

// ---------------------------------------------------------------------------
// Liveness thresholds
// ---------------------------------------------------------------------------

const ONE_HOUR_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Runtime-based implementation — uses api.runtime.subagent.getSessionMessages()
// This is the preferred implementation when running as a plugin.
// ---------------------------------------------------------------------------

/**
 * Build a LivenessChecker Layer backed by the OpenClaw plugin runtime.
 * Uses getSessionMessages() instead of a REST endpoint, which gives accurate
 * in-process access to session state.
 */
export function makeLivenessCheckerWithRuntime(runtime: PluginRuntime): Layer.Layer<LivenessChecker> {
  return Layer.succeed(
    LivenessChecker,
    LivenessChecker.of({
      check: (sessionKey: string): Effect.Effect<Liveness, LivenessCheckError> =>
        Effect.tryPromise({
          try: () => runtime.subagent.getSessionMessages({ sessionKey, limit: 1 }),
          catch: (cause) => new LivenessCheckError({ sessionKey, cause }),
        }).pipe(
          Effect.flatMap((result) => {
            if (result.messages.length === 0) {
              return Effect.succeed("dead" as const)
            }

            const lastMsg = result.messages[result.messages.length - 1]
            if (lastMsg === undefined || lastMsg === null) {
              return Effect.succeed("dead" as const)
            }

            // Try to extract a timestamp from the message object
            const timestamp =
              typeof lastMsg === "object" &&
              lastMsg !== null &&
              "timestamp" in lastMsg &&
              (typeof (lastMsg as Record<string, unknown>)["timestamp"] === "string" ||
                typeof (lastMsg as Record<string, unknown>)["timestamp"] === "number")
                ? (lastMsg as Record<string, unknown>)["timestamp"]
                : null

            if (timestamp === null) {
              // No timestamp — assume active (has messages, can't tell age)
              return Effect.succeed("active" as const)
            }

            const ts =
              typeof timestamp === "number"
                ? timestamp
                : new Date(timestamp as string).getTime()

            const age = Date.now() - ts

            if (age < ONE_HOUR_MS) {
              return Effect.succeed("active" as const)
            }

            return Effect.succeed("stale" as const)
          })
        ),
    })
  )
}

// ---------------------------------------------------------------------------
// REST-endpoint-based Live implementation (standalone binary fallback)
// ---------------------------------------------------------------------------

export const LivenessCheckerLive: Layer.Layer<LivenessChecker, ConfigError.ConfigError> = Layer.effect(
  LivenessChecker,
  Effect.gen(function* () {
    const config = yield* AppConfig

    const check = (sessionKey: string): Effect.Effect<Liveness, LivenessCheckError> =>
      Effect.gen(function* () {
        const url = `${config.openclawGatewayUrl}/api/sessions/${sessionKey}/history`

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              headers: { Authorization: `Bearer ${config.openclawGatewayToken}` },
            }),
          catch: (cause) => new LivenessCheckError({ sessionKey, cause }),
        })

        // 404 → session not found → dead
        if (response.status === 404) {
          return "dead" as const
        }

        if (!response.ok) {
          return yield* Effect.fail(
            new LivenessCheckError({
              sessionKey,
              cause: `Unexpected status ${response.status} from sessions history`,
            })
          )
        }

        const rawJson = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) => new LivenessCheckError({ sessionKey, cause }),
        })

        const body = yield* Schema.decodeUnknown(SessionHistoryResponseSchema)(rawJson).pipe(
          Effect.mapError(
            (e) => new LivenessCheckError({ sessionKey, cause: String(e) })
          )
        )

        // No messages → dead
        if (body.messages.length === 0) {
          return "dead" as const
        }

        const lastMessage = body.messages[body.messages.length - 1]
        if (lastMessage === undefined) {
          return "dead" as const
        }

        const lastTs = new Date(lastMessage.timestamp).getTime()
        const age = Date.now() - lastTs

        if (age < ONE_HOUR_MS) {
          return "active" as const
        }

        return "stale" as const
      })

    return LivenessChecker.of({ check })
  })
)
