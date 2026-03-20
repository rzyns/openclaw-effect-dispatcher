import { Effect, Layer, Config } from "effect"
import { JobStore, JobStoreLive, type Liveness } from "./db.js"
import { PlaneClient, PlaneClientLive } from "./plane.js"
import { LivenessChecker, LivenessCheckerLive } from "./liveness.js"
import { AgentSpawner, AgentSpawnerLive, AgentSpawnerDryRun } from "./spawner.js"
import { AppConfig } from "./config.js"
import { routeIssue } from "./routing.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
  const config = yield* AppConfig

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

  // Build set of currently-claimed issue IDs (non-dead)
  const claimedIssueIds = new Set(
    livenessResults
      .filter((r) => r.liveness !== "dead")
      .map((r) => r.job.issueId)
  )

  // 4. Fetch active Plane issues for all configured projects
  // Each project has its own activeStateIds + UUID→name mapping.
  const allPlaneIssues = yield* Effect.forEach(
    config.projects,
    (project) =>
      plane.getActiveIssues(project.id, project.activeStateIds, project.stateIdToName).pipe(
        Effect.tapError((e) =>
          Effect.logError(`Failed to fetch Plane issues for project ${project.id}: ${String(e)}`)
        ),
        Effect.orElse(() => Effect.succeed([] as ReturnType<typeof plane.getActiveIssues> extends Effect.Effect<infer A, any, any> ? A : never))
      ),
    { concurrency: 2 }
  ).pipe(Effect.map((arrays) => arrays.flat()))

  yield* Effect.logInfo(`Plane issues: ${allPlaneIssues.length}`)

  // 5. Reconcile: issues not already claimed → candidates
  // Only include issues whose state maps to an agent (state is now a name, not UUID)
  const candidates = allPlaneIssues.filter(
    (issue) => !claimedIssueIds.has(issue.id) && routeIssue(issue.state) !== null
  )
  yield* Effect.logInfo(`Spawn candidates: ${candidates.length}`)

  // 6. Spawn agents for candidates (max MAX_SPAWNS_PER_CYCLE across all projects)
  const toSpawn = candidates.slice(0, MAX_SPAWNS_PER_CYCLE)

  const spawnResults = yield* Effect.forEach(
    toSpawn,
    (issue) =>
      Effect.gen(function* () {
        const agentId = routeIssue(issue.state)
        if (agentId === null) {
          // Should not happen (filtered above), but be explicit
          yield* Effect.logDebug(`Skipping issue ${issue.id} — state '${issue.state}' not routable`)
          return null
        }

        yield* Effect.logInfo(`Spawning ${agentId} for issue: ${issue.id} — ${issue.title} [state: ${issue.state}]`)

        const result = yield* spawner
          .spawn({
            agentId,
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
          agentId,
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

// DRY_RUN=true → use AgentSpawnerDryRun; otherwise AgentSpawnerLive
const SpawnerLayer = Effect.gen(function* () {
  const dryRun = yield* Config.boolean("DRY_RUN").pipe(Config.withDefault(false))
  return dryRun ? AgentSpawnerDryRun : AgentSpawnerLive
}).pipe(Layer.unwrapEffect)

const AppLayer = Layer.mergeAll(
  JobStoreLive,
  PlaneClientLive,
  LivenessCheckerLive,
  SpawnerLayer
)

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const main = dispatchCycle.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).catch((e: unknown) => {
  console.error("Dispatcher failed:", e)
  process.exit(1)
})
