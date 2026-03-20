import { Effect } from "effect"
import { dispatchCycle, AppLayer } from "./dispatcher.js"

// ---------------------------------------------------------------------------
// Standalone binary entry point
// ---------------------------------------------------------------------------
// This file exists for local dev/testing. When running as an OpenClaw plugin,
// use plugin/index.ts instead (registered via openclaw.plugin.json).
// ---------------------------------------------------------------------------

const main = dispatchCycle.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).catch((e: unknown) => {
  console.error("Dispatcher failed:", e)
  process.exit(1)
})
