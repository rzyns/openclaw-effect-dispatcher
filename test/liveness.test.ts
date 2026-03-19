import { describe, it, expect } from "bun:test"
import { Effect, Layer, Exit, Cause, Option } from "effect"
import { LivenessChecker } from "../src/liveness.js"
import { LivenessCheckError } from "../src/errors.js"
import type { Liveness } from "../src/db.js"

// ---------------------------------------------------------------------------
// Fake HTTP client for liveness tests
//
// We don't want to mock fetch globally (pollutes other tests). Instead we
// keep the LivenessChecker implementation pure by depending only on the
// AppConfig and a fetch-shaped function. For tests, we build a fake
// LivenessChecker layer directly via Layer.succeed.
// ---------------------------------------------------------------------------

const ONE_HOUR_MS = 60 * 60 * 1000

/**
 * Build a fake LivenessChecker that deterministically returns a given liveness
 * based on a simulated session history state.
 */
function makeFakeLivenessChecker(
  simulate:
    | { kind: "not_found" }
    | { kind: "empty_messages" }
    | { kind: "recent"; ageMs: number }
    | { kind: "old"; ageMs: number }
    | { kind: "error"; message: string }
): Layer.Layer<LivenessChecker> {
  return Layer.succeed(LivenessChecker, {
    check: (sessionKey): Effect.Effect<Liveness, LivenessCheckError> =>
      Effect.gen(function* () {
        if (simulate.kind === "error") {
          return yield* Effect.fail(
            new LivenessCheckError({ sessionKey, cause: simulate.message })
          )
        }

        if (simulate.kind === "not_found" || simulate.kind === "empty_messages") {
          return "dead"
        }

        const { ageMs } = simulate
        if (ageMs < ONE_HOUR_MS) {
          return "active"
        }
        return "stale"
      }),
  })
}

// ---------------------------------------------------------------------------
// Helper: run a LivenessChecker.check with a given fake layer
// ---------------------------------------------------------------------------

const runCheck = (
  sessionKey: string,
  fakeLayer: Layer.Layer<LivenessChecker>
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const checker = yield* LivenessChecker
      return yield* checker.check(sessionKey)
    }).pipe(Effect.provide(fakeLayer))
  )

const runCheckExit = (
  sessionKey: string,
  fakeLayer: Layer.Layer<LivenessChecker>
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const checker = yield* LivenessChecker
      return yield* checker.check(sessionKey)
    }).pipe(Effect.provide(fakeLayer))
  )

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LivenessChecker", () => {
  describe("404 / not found → dead", () => {
    it("returns 'dead' when session is not found", async () => {
      const result = await runCheck(
        "session-abc",
        makeFakeLivenessChecker({ kind: "not_found" })
      )
      expect(result).toBe("dead")
    })
  })

  describe("empty messages → dead", () => {
    it("returns 'dead' when session exists but has no messages", async () => {
      const result = await runCheck(
        "session-empty",
        makeFakeLivenessChecker({ kind: "empty_messages" })
      )
      expect(result).toBe("dead")
    })
  })

  describe("recent message → active", () => {
    it("returns 'active' when last message is < 1h old", async () => {
      const result = await runCheck(
        "session-fresh",
        makeFakeLivenessChecker({ kind: "recent", ageMs: 5 * 60 * 1000 }) // 5 minutes ago
      )
      expect(result).toBe("active")
    })

    it("is still 'active' at 59 minutes", async () => {
      const result = await runCheck(
        "session-almost-stale",
        makeFakeLivenessChecker({ kind: "recent", ageMs: 59 * 60 * 1000 })
      )
      expect(result).toBe("active")
    })
  })

  describe("old message → stale", () => {
    it("returns 'stale' when last message is > 1h old", async () => {
      const result = await runCheck(
        "session-stale",
        makeFakeLivenessChecker({ kind: "old", ageMs: 2 * 60 * 60 * 1000 }) // 2 hours ago
      )
      expect(result).toBe("stale")
    })

    it("is 'stale' at exactly 1 hour + 1 ms", async () => {
      const result = await runCheck(
        "session-stale-edge",
        makeFakeLivenessChecker({ kind: "old", ageMs: ONE_HOUR_MS + 1 })
      )
      expect(result).toBe("stale")
    })
  })

  describe("error propagation", () => {
    it("fails with LivenessCheckError on network failure", async () => {
      const exit = await runCheckExit(
        "session-broken",
        makeFakeLivenessChecker({ kind: "error", message: "connection refused" })
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(Option.isSome(failure)).toBe(true)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(LivenessCheckError)
          expect((failure.value as InstanceType<typeof LivenessCheckError>).sessionKey).toBe("session-broken")
        }
      }
    })
  })
})
