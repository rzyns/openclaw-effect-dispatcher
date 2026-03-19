import { Data } from "effect"

// ---------------------------------------------------------------------------
// Typed errors for the dispatcher
// ---------------------------------------------------------------------------

export class PlaneApiError extends Data.TaggedError("PlaneApiError")<{
  readonly statusCode: number
  readonly url: string
  readonly cause: unknown
}> {}

export class DbError extends Data.TaggedError("DbError")<{
  readonly cause: unknown
}> {}

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly issueId: string
  readonly reason: string
}> {}

export class LivenessCheckError extends Data.TaggedError("LivenessCheckError")<{
  readonly sessionKey: string
  readonly cause: unknown
}> {}

// ConfigError: use Effect's built-in ConfigError — no custom class needed.
// It surfaces automatically when Config.string(...) etc. are yielded and the
// environment variable is missing or malformed.
export type { ConfigError } from "effect/ConfigError"
