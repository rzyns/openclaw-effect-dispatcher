/**
 * plugin/index.ts
 *
 * OpenClaw plugin entry point for the Plane dispatcher.
 *
 * This module is loaded by the gateway when the plugin is enabled via
 * openclaw.plugin.json. It wires the Effect-TS core (JobStore, dispatch cycle)
 * into the OpenClaw plugin lifecycle:
 *
 *   - Registers subagent_spawned/subagent_ended hooks for session key resolution
 *     and job completion tracking.
 *   - Registers the dispatch cycle as a background service.
 *
 * The JobStore instance is created once and shared between hooks and service,
 * ensuring consistent DB access from a single SQLite connection layer.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { makeJobStoreLive } from "../src/db.js"
import { makeSubagentHooks } from "./hooks.js"
import { makeDispatcherService } from "./service.js"

const DEFAULT_DB_PATH = "./dispatcher.db"

export default function register(api: OpenClawPluginApi): void {
  const pluginConfig = api.pluginConfig ?? {}

  // Resolve DB path: plugin config wins over default
  const dbPath =
    typeof pluginConfig["dbPath"] === "string" && pluginConfig["dbPath"].length > 0
      ? api.resolvePath(pluginConfig["dbPath"])
      : DEFAULT_DB_PATH

  api.logger.info(`Plane dispatcher plugin initializing (db: ${dbPath})`)

  // ---------------------------------------------------------------------------
  // 1. Build the shared JobStore layer (single SQLite connection for the plugin)
  // ---------------------------------------------------------------------------
  const jobStoreLayer = makeJobStoreLive(dbPath)

  // ---------------------------------------------------------------------------
  // 2. Register subagent lifecycle hooks
  // ---------------------------------------------------------------------------
  const hooks = makeSubagentHooks(jobStoreLayer, api.logger)

  api.on("subagent_spawned", hooks.onSubagentSpawned)
  api.on("subagent_ended", hooks.onSubagentEnded)

  // ---------------------------------------------------------------------------
  // 3. Register the dispatch loop as a background service
  // ---------------------------------------------------------------------------
  const service = makeDispatcherService(api, jobStoreLayer)

  api.registerService(service)

  api.logger.info("Plane dispatcher plugin registered (hooks + service)")
}
