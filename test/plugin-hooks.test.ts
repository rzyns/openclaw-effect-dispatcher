/**
 * test/plugin-hooks.test.ts
 *
 * Live spawn validation for the plugin's subagent lifecycle hooks.
 *
 * Tests makeSubagentHooks (plugin/hooks.ts) against the in-memory JobStore
 * (JobStoreMemory) so no SQLite / Node native addons are required.
 *
 * Coverage:
 *   onSubagentSpawned
 *     - resolves runId → real session key when job exists
 *     - logs the key resolution
 *     - silently ignores events for unknown runIds
 *     - warns but does not throw when childSessionKey is missing
 *     - does not update the store when runId is falsy
 *   onSubagentEnded
 *     - removes job from DB on completion
 *     - logs issueId and sessionKey
 *     - silently ignores events for unknown session keys
 *     - handles all outcome variants without throwing (error, timeout, killed)
 *     - works when ended fires before spawned (race: runId used as sessionKey)
 *
 * NOTE: Layer.sync builds a new Map instance each time it is acquired by
 * Effect.runPromise. To share state between the test's `run` helper and the
 * hooks' internal runEffect, we build the store once with Effect.runSync and
 * wrap it in Layer.succeed — which always returns the same instance.
 */

import { describe, it, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { JobStore, JobStoreMemory } from "../src/db.js"
import { makeSubagentHooks } from "../plugin/hooks.js"

// ---------------------------------------------------------------------------
// Minimal logger stub — captures what was logged for assertion
// ---------------------------------------------------------------------------

interface CapturedLog {
  level: "info" | "warn" | "error"
  message: string
}

function makeLoggerStub() {
  const logs: CapturedLog[] = []
  return {
    info: (msg: string) => logs.push({ level: "info", message: msg }),
    warn: (msg: string) => logs.push({ level: "warn", message: msg }),
    error: (msg: string) => logs.push({ level: "error", message: msg }),
    debug: (_msg: string) => {},
    logs,
    hasLog: (level: "info" | "warn" | "error", substr: string) =>
      logs.some((l) => l.level === level && l.message.includes(substr)),
  }
}

// ---------------------------------------------------------------------------
// Test harness factory
//
// Builds the in-memory JobStore ONCE and wraps it in Layer.succeed so that
// both the test's `run` helper and the hooks' internal Effect.runPromise
// calls share the exact same Map instance.
// ---------------------------------------------------------------------------

function makeHarness() {
  // Layer.sync is synchronous — Effect.runSync can acquire it.
  const storeInstance = Effect.runSync(
    Effect.gen(function* () {
      return yield* JobStore
    }).pipe(Effect.provide(JobStoreMemory))
  )

  // Layer.succeed always returns the same pre-built instance.
  const sharedLayer = Layer.succeed(JobStore, storeInstance)

  const run = <A>(effect: Effect.Effect<A, unknown, JobStore>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(sharedLayer)))

  const logger = makeLoggerStub()
  const hooks = makeSubagentHooks(sharedLayer, logger)

  return { run, logger, hooks }
}

// ---------------------------------------------------------------------------
// Helper: claim a job in the store
// ---------------------------------------------------------------------------

const claimJob = (
  issueId: string,
  sessionKey: string,
  overrides: Partial<{
    project: string
    state: string
    title: string
    agentId: string
  }> = {}
) =>
  Effect.gen(function* () {
    const store = yield* JobStore
    yield* store.claimJob({
      issueId,
      project: overrides.project ?? "project-x",
      state: overrides.state ?? "Prepare",
      title: overrides.title ?? `Issue ${issueId}`,
      agentId: overrides.agentId ?? "coding-implementer",
      sessionKey,
    })
  })

// ---------------------------------------------------------------------------
// Minimal event builders
// ---------------------------------------------------------------------------

type SpawnedEvent = Parameters<ReturnType<typeof makeSubagentHooks>["onSubagentSpawned"]>[0]
type EndedEvent = Parameters<ReturnType<typeof makeSubagentHooks>["onSubagentEnded"]>[0]

function spawnedEvent(overrides: {
  runId: string
  childSessionKey?: string
  agentId?: string
}): SpawnedEvent {
  return {
    runId: overrides.runId,
    childSessionKey: overrides.childSessionKey ?? `child-${overrides.runId}`,
    agentId: overrides.agentId ?? "coding-implementer",
    mode: "run" as const,
    threadRequested: false,
  }
}

function endedEvent(overrides: {
  targetSessionKey: string
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted"
  reason?: string
}): EndedEvent {
  return {
    targetSessionKey: overrides.targetSessionKey,
    targetKind: "subagent" as const,
    reason: overrides.reason ?? "run complete",
    outcome: overrides.outcome ?? "ok",
  }
}

// ---------------------------------------------------------------------------
// onSubagentSpawned
// ---------------------------------------------------------------------------

describe("onSubagentSpawned", () => {
  it("resolves runId → real session key when a matching job exists", async () => {
    const { run, hooks } = makeHarness()
    const runId = "run-abc-001"
    const childSessionKey = "child-session-xyz"

    await run(claimJob("issue-1", runId))
    await hooks.onSubagentSpawned(spawnedEvent({ runId, childSessionKey }), {})

    const updated = await run(
      Effect.gen(function* () {
        const store = yield* JobStore
        return yield* store.getJobBySessionKey(childSessionKey)
      })
    )

    expect(Option.isSome(updated)).toBe(true)
    if (Option.isSome(updated)) {
      expect(updated.value.issueId).toBe("issue-1")
      expect(updated.value.sessionKey).toBe(childSessionKey)
    }
  })

  it("logs the session key resolution on success", async () => {
    const { run, logger, hooks } = makeHarness()
    const runId = "run-log-check"
    const childSessionKey = "child-log-check"

    await run(claimJob("issue-log", runId))
    await hooks.onSubagentSpawned(spawnedEvent({ runId, childSessionKey }), {})

    expect(logger.hasLog("info", "session key resolved")).toBe(true)
    expect(logger.hasLog("info", runId)).toBe(true)
    expect(logger.hasLog("info", childSessionKey)).toBe(true)
  })

  it("silently ignores events for unknown runIds (not a dispatcher job)", async () => {
    const { logger, hooks } = makeHarness()

    await expect(
      hooks.onSubagentSpawned(spawnedEvent({ runId: "unknown-run-id", childSessionKey: "child-xyz" }), {})
    ).resolves.toBeUndefined()

    expect(logger.hasLog("info", "session key resolved")).toBe(false)
    expect(logger.hasLog("warn", "")).toBe(false)
    expect(logger.hasLog("error", "")).toBe(false)
  })

  it("warns but does not throw when childSessionKey is empty", async () => {
    const { run, logger, hooks } = makeHarness()
    const runId = "run-missing-child"

    await run(claimJob("issue-missing-child", runId))

    const event: SpawnedEvent = {
      runId,
      childSessionKey: "",
      agentId: "coding-implementer",
      mode: "run",
      threadRequested: false,
    }

    await expect(hooks.onSubagentSpawned(event, {})).resolves.toBeUndefined()

    // Should have warned about the missing key
    expect(logger.hasLog("warn", runId)).toBe(true)

    // Session key in DB should NOT have been overwritten with an empty string
    const unchanged = await run(
      Effect.gen(function* () {
        const store = yield* JobStore
        return yield* store.getJobBySessionKey(runId)
      })
    )
    expect(Option.isSome(unchanged)).toBe(true)
  })

  it("returns early without touching the store when runId is falsy", async () => {
    const { logger, hooks } = makeHarness()

    const event: SpawnedEvent = {
      runId: "",
      childSessionKey: "child-no-runid",
      agentId: "coding-implementer",
      mode: "run",
      threadRequested: false,
    }

    await expect(hooks.onSubagentSpawned(event, {})).resolves.toBeUndefined()
    expect(logger.logs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// onSubagentEnded
// ---------------------------------------------------------------------------

describe("onSubagentEnded", () => {
  it("removes the job from the store when the session ends", async () => {
    const { run, hooks } = makeHarness()
    const runId = "run-ended-001"
    const sessionKey = "session-ended-001"

    await run(claimJob("issue-ended-1", runId))
    await hooks.onSubagentSpawned(spawnedEvent({ runId, childSessionKey: sessionKey }), {})
    await hooks.onSubagentEnded(endedEvent({ targetSessionKey: sessionKey }), {})

    const after = await run(
      Effect.gen(function* () {
        const store = yield* JobStore
        return yield* store.getJobBySessionKey(sessionKey)
      })
    )
    expect(Option.isNone(after)).toBe(true)
  })

  it("logs issueId and sessionKey when completing a job", async () => {
    const { run, logger, hooks } = makeHarness()
    const runId = "run-log-ended"
    const sessionKey = "session-log-ended"

    await run(claimJob("issue-log-ended", runId))
    await hooks.onSubagentSpawned(spawnedEvent({ runId, childSessionKey: sessionKey }), {})
    await hooks.onSubagentEnded(endedEvent({ targetSessionKey: sessionKey, outcome: "ok" }), {})

    expect(logger.hasLog("info", "subagent_ended")).toBe(true)
    expect(logger.hasLog("info", "issue-log-ended")).toBe(true)
    expect(logger.hasLog("info", sessionKey)).toBe(true)
  })

  it("silently ignores events for unknown session keys", async () => {
    const { logger, hooks } = makeHarness()

    await expect(
      hooks.onSubagentEnded(endedEvent({ targetSessionKey: "unknown-session-key" }), {})
    ).resolves.toBeUndefined()

    expect(logger.hasLog("info", "subagent_ended")).toBe(false)
    expect(logger.hasLog("error", "")).toBe(false)
  })

  it("handles outcome=error without throwing", async () => {
    const { run, hooks } = makeHarness()
    const runId = "run-error-outcome"
    const sessionKey = "session-error-outcome"

    await run(claimJob("issue-error-outcome", runId))
    await hooks.onSubagentSpawned(spawnedEvent({ runId, childSessionKey: sessionKey }), {})

    await expect(
      hooks.onSubagentEnded(endedEvent({ targetSessionKey: sessionKey, outcome: "error" }), {})
    ).resolves.toBeUndefined()

    const after = await run(
      Effect.gen(function* () {
        const store = yield* JobStore
        return yield* store.getJobBySessionKey(sessionKey)
      })
    )
    expect(Option.isNone(after)).toBe(true)
  })

  it("handles outcome=timeout without throwing", async () => {
    const { run, hooks } = makeHarness()
    const runId = "run-timeout-outcome"
    const sessionKey = "session-timeout-outcome"

    await run(claimJob("issue-timeout", runId))
    await hooks.onSubagentSpawned(spawnedEvent({ runId, childSessionKey: sessionKey }), {})

    await expect(
      hooks.onSubagentEnded(endedEvent({ targetSessionKey: sessionKey, outcome: "timeout" }), {})
    ).resolves.toBeUndefined()

    const after = await run(
      Effect.gen(function* () {
        const store = yield* JobStore
        return yield* store.getJobBySessionKey(sessionKey)
      })
    )
    expect(Option.isNone(after)).toBe(true)
  })

  it("handles outcome=killed without throwing", async () => {
    const { run, hooks } = makeHarness()
    const runId = "run-killed-outcome"
    const sessionKey = "session-killed-outcome"

    await run(claimJob("issue-killed", runId))
    await hooks.onSubagentSpawned(spawnedEvent({ runId, childSessionKey: sessionKey }), {})

    await expect(
      hooks.onSubagentEnded(endedEvent({ targetSessionKey: sessionKey, outcome: "killed" }), {})
    ).resolves.toBeUndefined()

    const after = await run(
      Effect.gen(function* () {
        const store = yield* JobStore
        return yield* store.getJobBySessionKey(sessionKey)
      })
    )
    expect(Option.isNone(after)).toBe(true)
  })

  it("works when ended fires before spawned (race: runId still used as session key)", async () => {
    // Edge case: if subagent_ended fires before subagent_spawned resolves the
    // key, the session_key column still holds the original runId. The hook
    // must still find and complete the job.
    const { run, hooks } = makeHarness()
    const runId = "run-race-condition"

    await run(claimJob("issue-race", runId))

    // ended fires with the original runId (not yet resolved to a childSessionKey)
    await hooks.onSubagentEnded(endedEvent({ targetSessionKey: runId }), {})

    const after = await run(
      Effect.gen(function* () {
        const store = yield* JobStore
        return yield* store.getJobBySessionKey(runId)
      })
    )
    expect(Option.isNone(after)).toBe(true)
  })
})
