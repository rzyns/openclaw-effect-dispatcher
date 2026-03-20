/**
 * plugin/service.ts
 *
 * Wraps the Effect-TS dispatch cycle as an OpenClaw background service.
 * The service runs every intervalMs (default: 2 minutes) via setInterval.
 *
 * Configuration priority:
 *   1. Plugin config (pluginConfig.dbPath, pluginConfig.intervalMs)
 *   2. Environment variables read by AppConfig (DISPATCHER_DB_PATH, etc.)
 */
import { Effect, Layer } from "effect"
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk"
import { dispatchCycle, SpawnerLayer } from "../src/dispatcher.js"
import { JobStore } from "../src/db.js"
import { PlaneClientLive } from "../src/plane.js"
import { makeLivenessCheckerWithRuntime } from "../src/liveness.js"

const DEFAULT_INTERVAL_MS = 120_000 // 2 minutes

export function makeDispatcherService(
  api: OpenClawPluginApi,
  jobStoreLayer: Layer.Layer<JobStore, unknown>
): OpenClawPluginService {
  let timer: ReturnType<typeof setInterval> | null = null

  const runCycle = async (ctx: OpenClawPluginServiceContext): Promise<void> => {
    try {
      // Use in-process runtime for liveness checking (accurate session state)
      const livenessLayer = makeLivenessCheckerWithRuntime(api.runtime)

      const AppLayer = Layer.mergeAll(
        jobStoreLayer,
        PlaneClientLive,
        livenessLayer,
        SpawnerLayer
      )

      await Effect.runPromise(
        dispatchCycle.pipe(Effect.provide(AppLayer))
      )
    } catch (err) {
      ctx.logger.error(`Dispatch cycle failed: ${String(err)}`)
      // Never rethrow — plugin must not crash the gateway process
    }
  }

  return {
    id: "plane-dispatcher",

    async start(ctx) {
      const pluginConfig = api.pluginConfig ?? {}
      const intervalMs =
        typeof pluginConfig["intervalMs"] === "number"
          ? pluginConfig["intervalMs"]
          : DEFAULT_INTERVAL_MS

      ctx.logger.info(`Plane dispatcher service starting (interval: ${intervalMs}ms)`)

      // Run immediately on start, then on interval
      await runCycle(ctx)

      timer = setInterval(() => {
        void runCycle(ctx)
      }, intervalMs)
    },

    async stop(ctx) {
      ctx.logger.info("Plane dispatcher service stopping")
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
