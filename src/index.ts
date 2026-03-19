import { Effect, Layer, ConfigProvider } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { JobStore, JobStoreLive, type Liveness } from "./db.js"
import { PlaneClient, PlaneClientStub } from "./plane.js"
import { LivenessChecker, LivenessCheckerLive } from "./liveness.js"
import { AgentSpawner, AgentSpawnerLive } from "./spawner.js"
import { AppConfig } from "./config.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Hardcoded STR project ID for the initial scaffold.
// TODO: move to config once multi-project support is needed.
const STR_PROJECT_ID = "str"

/** Max agents to spawn per project per dispatch cycle */
const MAX_SPAWNS_PER_CYCLE = 2

// ---------------------------------------------------------------------------
// Dispatch cycle
// ---------------------------------------------------------------------------

const dispatchCycle = Effect.gen(function* () {
  yield* Effect.logInfo("Dispatch cycle starting")

  const jobs = yield* JobStore
  const plane = yield* PlaneClient
  const liveness = yield* LivenessChecker
  const spawner = yield* AgentSpawner

  // 1. Load active jobs from SQLite
  const activeJobs = yield* jobs.getActiveJobs()
  yield* Effect.logInfo(`Active jobs: ${activeJobs.length}`)

  // 2. For each active job: check liveness and update the column
  const livenessResults = yield* Effect.forEach(
    activeJobs,
    (job) =>
      Effect.gen(function* () {
        if (job.sessionKey === null) {
          // No session key — can't check liveness; leave as pending
          return { job, liveness: "pending" as Liveness }
        }

        const newLiveness = yield* liveness.check(job.sessionKey).pipe(
          Effect.tapError((e) =>
            Effect.logWarning(`Liveness check failed for ${job.issueId}: ${String(e)}`)
          ),
          Effect.orElse(() => Effect.succeed("stale" as Liveness))
        )

        yield* jobs.updateLiveness(job.issueId, newLiveness)
        return { job, liveness: newLiveness }
      }),
    { concurrency: 4 }
  )

  // 3. Remove dead claims from SQLite
  const deadJobs = livenessResults.filter((r) => r.liveness === "dead")
  yield* Effect.forEach(
    deadJobs,
    (r) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Removing dead job claim: ${r.job.issueId}`)
        yield* jobs.completeJob(r.job.issueId)
      }),
    { concurrency: 1 }
  )

  // 4. Fetch active Plane issues (stub returns [] for now)
  const planeIssues = yield* plane.getActiveIssues(STR_PROJECT_ID).pipe(
    Effect.tapError((e) =>
      Effect.logError(`Failed to fetch Plane issues: ${String(e)}`)
    ),
    Effect.orElse(() => Effect.succeed([] as typeof planeIssues))
  )
  yield* Effect.logInfo(`Plane issues: ${planeIssues.length}`)

  // Build set of currently-claimed issue IDs (non-dead)
  const claimedIssueIds = new Set(
    livenessResults
      .filter((r) => r.liveness !== "dead")
      .map((r) => r.job.issueId)
  )

  // 5. Reconcile: issues not already claimed → candidates
  const candidates = planeIssues.filter((issue) => !claimedIssueIds.has(issue.id))
  yield* Effect.logInfo(`Spawn candidates: ${candidates.length}`)

  // 6. Spawn agents for candidates (max MAX_SPAWNS_PER_CYCLE)
  const toSpawn = candidates.slice(0, MAX_SPAWNS_PER_CYCLE)

  const spawnResults = yield* Effect.forEach(
    toSpawn,
    (issue) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Spawning agent for issue: ${issue.id} — ${issue.title}`)

        const result = yield* spawner
          .spawn({
            agentId: "coding-implementer",
            task: `Work on Plane issue ${issue.id}: ${issue.title}`,
            issueId: issue.id,
          })
          .pipe(
            Effect.tapError((e) =>
              Effect.logError(`Spawn failed for ${issue.id}: ${e.reason}`)
            )
          )

        yield* jobs.claimJob({
          issueId: issue.id,
          project: issue.projectId,
          state: issue.state,
          title: issue.title,
          agentId: "coding-implementer",
          sessionKey: result.sessionKey,
        })

        return { issueId: issue.id, sessionKey: result.sessionKey }
      }).pipe(Effect.option),
    { concurrency: 1 }
  )

  const spawned = spawnResults.filter((r) => r._tag === "Some").length

  // 7. Log cycle summary
  yield* Effect.logInfo(
    `Dispatch cycle complete — active: ${activeJobs.length}, dead removed: ${deadJobs.length}, spawned: ${spawned}`
  )
})

// ---------------------------------------------------------------------------
// Application layer composition
// ---------------------------------------------------------------------------

const AppLayer = Layer.mergeAll(
  JobStoreLive,
  PlaneClientStub,
  LivenessCheckerLive,
  AgentSpawnerLive
)

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const main = dispatchCycle.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).catch((e: unknown) => {
  console.error("Dispatcher failed:", e)
  process.exit(1)
})
