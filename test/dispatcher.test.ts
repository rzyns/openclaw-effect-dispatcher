/**
 * test/dispatcher.test.ts
 *
 * Integration tests for the dispatchCycle duplicate-claim guard.
 *
 * All four service dependencies (JobStore, PlaneClient, LivenessChecker,
 * AgentSpawner) are replaced with fully controlled in-memory fakes so the
 * tests exercise only the dispatch logic, not I/O.
 */

import { describe, it, expect } from "bun:test"
import { Effect, Layer, Option, ConfigProvider } from "effect"
import { JobStore, JobStoreMemory, type Job } from "../src/db.js"
import { PlaneClient, type PlaneIssue } from "../src/plane.js"
import { LivenessChecker } from "../src/liveness.js"
import { AgentSpawner } from "../src/spawner.js"
import { dispatchCycle } from "../src/dispatcher.js"

// ---------------------------------------------------------------------------
// Minimal test config (dispatcher.ts reads AppConfig for projects list)
// ---------------------------------------------------------------------------

const testConfig = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["OPENCLAW_GATEWAY_URL", "http://fake-gateway.test"],
      ["OPENCLAW_GATEWAY_TOKEN", "test-token"],
      ["DISPATCHER_DB_PATH", ":memory:"],
      ["DISPATCHER_DISCORD_CHANNEL", "test-channel"],
      ["PLANE_API_KEY", "test-plane-key"],
      // Single project that maps to real state names the routing module understands
      [
        "DISPATCHER_PROJECTS_JSON",
        JSON.stringify([
          {
            id: "project-test",
            activeStateIds: ["state-prepare-uuid"],
            stateIdToName: { "state-prepare-uuid": "Prepare" },
          },
        ]),
      ],
    ])
  )
)

// ---------------------------------------------------------------------------
// Fake PlaneClient layer — returns a configurable list of issues
// ---------------------------------------------------------------------------

function makeFakePlaneClient(issues: ReadonlyArray<PlaneIssue>): Layer.Layer<PlaneClient> {
  return Layer.succeed(
    PlaneClient,
    PlaneClient.of({
      getActiveIssues: () => Effect.succeed(issues),
      patchIssue: () =>
        Effect.succeed({
          id: "irrelevant",
          projectId: "irrelevant",
          state: "irrelevant",
          title: "irrelevant",
          assigneeId: null,
        }),
      postComment: () => Effect.succeed(undefined),
    })
  )
}

// ---------------------------------------------------------------------------
// Fake LivenessChecker layer — always returns a fixed liveness value
// ---------------------------------------------------------------------------

function makeFakeLivenessChecker(
  liveness: "active" | "stale" | "dead" | "pending"
): Layer.Layer<LivenessChecker> {
  return Layer.succeed(
    LivenessChecker,
    LivenessChecker.of({
      check: () => Effect.succeed(liveness as "active" | "stale" | "dead"),
    })
  )
}

// ---------------------------------------------------------------------------
// Spy AgentSpawner — records which issueIds were spawned, returns a fake key
// ---------------------------------------------------------------------------

interface SpawnRecord {
  agentId: string
  issueId: string
  task: string
}

function makeSpySpawner(): { layer: Layer.Layer<AgentSpawner>; calls: SpawnRecord[] } {
  const calls: SpawnRecord[] = []

  const layer = Layer.succeed(
    AgentSpawner,
    AgentSpawner.of({
      spawn: (params) =>
        Effect.sync(() => {
          calls.push({ agentId: params.agentId, issueId: params.issueId, task: params.task })
          return { sessionKey: `fake-session-${params.issueId}` }
        }),
    })
  )

  return { layer, calls }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const runCycle = (
  planeIssues: ReadonlyArray<PlaneIssue>,
  livenessValue: "active" | "stale" | "dead" | "pending",
  spawner: { layer: Layer.Layer<AgentSpawner>; calls: SpawnRecord[] },
  /**
   * Optional setup effect run against the JobStore before the dispatch cycle.
   * Use this to pre-populate claimed jobs.
   */
  setup?: Effect.Effect<void, unknown, JobStore>
): Promise<void> => {
  const AppLayer = Layer.mergeAll(
    JobStoreMemory,
    makeFakePlaneClient(planeIssues),
    makeFakeLivenessChecker(livenessValue),
    spawner.layer
  )

  const program = Effect.gen(function* () {
    if (setup) {
      yield* setup
    }
    yield* dispatchCycle
  })

  return Effect.runPromise(
    program.pipe(Effect.provide(AppLayer), Effect.provide(testConfig))
  )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const prepareIssue: PlaneIssue = {
  id: "issue-abc",
  projectId: "project-test",
  state: "Prepare",     // routable → coding-implementer
  title: "Do a thing",
  assigneeId: null,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchCycle — duplicate claim guard", () => {
  it("spawns agent for an unclaimed routable issue", async () => {
    const spawner = makeSpySpawner()

    await runCycle([prepareIssue], "active", spawner)

    expect(spawner.calls).toHaveLength(1)
    expect(spawner.calls[0]!.issueId).toBe("issue-abc")
    expect(spawner.calls[0]!.agentId).toBe("coding-implementer")
  })

  it("does NOT spawn a second agent when issue is already claimed (active)", async () => {
    const spawner = makeSpySpawner()

    // Pre-claim the issue before the dispatch cycle runs
    const setup = Effect.gen(function* () {
      const store = yield* JobStore
      yield* store.claimJob({
        issueId: "issue-abc",
        project: "project-test",
        state: "Prepare",
        title: "Do a thing",
        agentId: "coding-implementer",
        sessionKey: "existing-session",
      })
    })

    await runCycle([prepareIssue], "active", spawner, setup)

    // The liveness check will mark the existing claim "active" — issue stays claimed
    expect(spawner.calls).toHaveLength(0)
  })

  it("does NOT spawn when existing claim is stale (still alive)", async () => {
    const spawner = makeSpySpawner()

    const setup = Effect.gen(function* () {
      const store = yield* JobStore
      yield* store.claimJob({
        issueId: "issue-abc",
        project: "project-test",
        state: "Prepare",
        title: "Do a thing",
        agentId: "coding-implementer",
        sessionKey: "stale-session",
      })
    })

    // Liveness returns "stale" → claim is kept, issue stays in claimedIssueIds
    await runCycle([prepareIssue], "stale", spawner, setup)

    expect(spawner.calls).toHaveLength(0)
  })

  it("re-spawns when existing claim is dead (session gone)", async () => {
    const spawner = makeSpySpawner()

    const setup = Effect.gen(function* () {
      const store = yield* JobStore
      yield* store.claimJob({
        issueId: "issue-abc",
        project: "project-test",
        state: "Prepare",
        title: "Do a thing",
        agentId: "coding-implementer",
        sessionKey: "dead-session",
      })
    })

    // Liveness returns "dead" → claim is removed from SQLite → issue becomes a candidate again
    await runCycle([prepareIssue], "dead", spawner, setup)

    expect(spawner.calls).toHaveLength(1)
    expect(spawner.calls[0]!.issueId).toBe("issue-abc")
  })

  it("only skips the claimed issue — still spawns for unclaimed ones", async () => {
    const spawner = makeSpySpawner()

    const alreadyClaimedIssue: PlaneIssue = {
      id: "issue-claimed",
      projectId: "project-test",
      state: "Prepare",
      title: "Already running",
      assigneeId: null,
    }
    const newIssue: PlaneIssue = {
      id: "issue-new",
      projectId: "project-test",
      state: "Prepare",
      title: "Brand new",
      assigneeId: null,
    }

    const setup = Effect.gen(function* () {
      const store = yield* JobStore
      yield* store.claimJob({
        issueId: "issue-claimed",
        project: "project-test",
        state: "Prepare",
        title: "Already running",
        agentId: "coding-implementer",
        sessionKey: "active-session",
      })
    })

    await runCycle([alreadyClaimedIssue, newIssue], "active", spawner, setup)

    // Only the new, unclaimed issue should be spawned
    expect(spawner.calls).toHaveLength(1)
    expect(spawner.calls[0]!.issueId).toBe("issue-new")
  })

  it("records a new claim in JobStore after spawning", async () => {
    const spawner = makeSpySpawner()
    let capturedJobs: ReadonlyArray<Job> = []

    const AppLayer = Layer.mergeAll(
      JobStoreMemory,
      makeFakePlaneClient([prepareIssue]),
      makeFakeLivenessChecker("active"),
      spawner.layer
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* dispatchCycle
        // Inspect the store after the cycle
        const store = yield* JobStore
        capturedJobs = yield* store.getActiveJobs()
      }).pipe(Effect.provide(AppLayer), Effect.provide(testConfig))
    )

    expect(capturedJobs).toHaveLength(1)
    expect(capturedJobs[0]!.issueId).toBe("issue-abc")
    expect(capturedJobs[0]!.sessionKey).toBe("fake-session-issue-abc")
    expect(capturedJobs[0]!.agentId).toBe("coding-implementer")
  })

  it("dead claim is removed from JobStore before new spawn", async () => {
    const spawner = makeSpySpawner()
    let capturedJobs: ReadonlyArray<Job> = []

    const AppLayer = Layer.mergeAll(
      JobStoreMemory,
      makeFakePlaneClient([prepareIssue]),
      makeFakeLivenessChecker("dead"),
      spawner.layer
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        // Pre-claim with a dead session
        const store = yield* JobStore
        yield* store.claimJob({
          issueId: "issue-abc",
          project: "project-test",
          state: "Prepare",
          title: "Do a thing",
          agentId: "coding-implementer",
          sessionKey: "dead-session",
        })

        yield* dispatchCycle

        // Should have one job: the fresh claim (old dead one deleted, new one inserted)
        capturedJobs = yield* store.getActiveJobs()
      }).pipe(Effect.provide(AppLayer), Effect.provide(testConfig))
    )

    expect(capturedJobs).toHaveLength(1)
    expect(capturedJobs[0]!.sessionKey).toBe("fake-session-issue-abc")
    expect(capturedJobs[0]!.sessionKey).not.toBe("dead-session")
  })

  it("does not spawn for unroutable issue states", async () => {
    const spawner = makeSpySpawner()

    const doneIssue: PlaneIssue = {
      id: "issue-done",
      projectId: "project-test",
      state: "Done",    // not routable
      title: "All done",
      assigneeId: null,
    }

    await runCycle([doneIssue], "active", spawner)

    expect(spawner.calls).toHaveLength(0)
  })

  it("caps spawns at MAX_SPAWNS_PER_CYCLE", async () => {
    const spawner = makeSpySpawner()

    // Create more than MAX_SPAWNS_PER_CYCLE (2) routable issues
    const manyIssues: PlaneIssue[] = Array.from({ length: 5 }, (_, i) => ({
      id: `issue-${i}`,
      projectId: "project-test",
      state: "Prepare",
      title: `Issue ${i}`,
      assigneeId: null,
    }))

    await runCycle(manyIssues, "active", spawner)

    // Should spawn at most MAX_SPAWNS_PER_CYCLE (2)
    expect(spawner.calls.length).toBeLessThanOrEqual(2)
    expect(spawner.calls.length).toBe(2)
  })
})
