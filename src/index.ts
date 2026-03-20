import { Effect, Layer, Config } from "effect"
import { JobStoreLive } from "./db.js"
import { PlaneClientLive } from "./plane.js"
import { LivenessCheckerLive } from "./liveness.js"
import { AgentSpawnerLive, AgentSpawnerDryRun } from "./spawner.js"
import { dispatchCycle } from "./dispatcher.js"

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
