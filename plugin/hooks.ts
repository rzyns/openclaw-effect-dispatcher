/**
 * plugin/hooks.ts
 *
 * Subagent lifecycle handlers for the Plane dispatcher plugin.
 *
 * IMPORTANT: These hooks fire for ALL subagents in the gateway, not just
 * dispatcher-spawned ones. Each handler checks whether the event's session key
 * matches a row in the dispatcher's SQLite DB. If not, the event is silently ignored.
 *
 * DESIGN NOTE — webhook vs ACP spawns
 * ------------------------------------
 * The dispatcher spawns agents via the /hooks/agent webhook endpoint.  For
 * that code path OpenClaw runs the agent as a cron job; it does NOT register a
 * subagent run record, so neither subagent_spawned nor subagent_ended ever fire.
 *
 * Job completion for webhook-spawned agents is therefore handled entirely by
 * the liveness-checking loop in dispatcher.ts: once the cron session ends the
 * gateway deletes it, liveness.check() returns "dead", and the dispatcher
 * removes the claim row.
 *
 * The subagent_spawned / subagent_ended hooks exist for forward-compatibility
 * (e.g. if the spawner is later switched to the ACP sessions.spawn path) and
 * as a belt-and-suspenders fast path that completes jobs without waiting for
 * the next liveness poll cycle.
 */
import { Effect, Option } from "effect"
import type { PluginLogger } from "openclaw/plugin-sdk"
import { JobStore } from "../src/db.js"

// ---------------------------------------------------------------------------
// Event types (mirrored from plugin SDK — PluginHookHandlerMap is not exported)
// ---------------------------------------------------------------------------

interface SubagentSpawnBase {
  readonly childSessionKey: string
  readonly agentId: string
  readonly label?: string | undefined
  readonly mode: "run" | "session"
  readonly threadRequested: boolean
}

interface SubagentSpawnedEvent extends SubagentSpawnBase {
  readonly runId: string
}

interface SubagentEndedEvent {
  readonly targetSessionKey: string
  readonly targetKind: "subagent" | "acp"
  readonly reason: string
  readonly outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted" | undefined
  readonly error?: string | undefined
  readonly runId?: string | undefined
  readonly endedAt?: number | undefined
}

interface SubagentContext {
  readonly runId?: string | undefined
  readonly childSessionKey?: string | undefined
  readonly requesterSessionKey?: string | undefined
}

export type SubagentSpawnedHandler = (event: SubagentSpawnedEvent, ctx: SubagentContext) => Promise<void>
export type SubagentEndedHandler = (event: SubagentEndedEvent, ctx: SubagentContext) => Promise<void>

export interface SubagentHooks {
  readonly onSubagentSpawned: SubagentSpawnedHandler
  readonly onSubagentEnded: SubagentEndedHandler
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the subagent_spawned and subagent_ended hooks.
 *
 * The hooks share a JobStore layer so they can query/mutate the same SQLite
 * DB. Both hooks are async fire-and-forget from the gateway's perspective —
 * they must never throw.
 */
export function makeSubagentHooks(
  jobStoreLayer: import("effect").Layer.Layer<JobStore, unknown>,
  logger: PluginLogger
): SubagentHooks {
  const runEffect = (effect: Effect.Effect<void, unknown, JobStore>): Promise<void> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(jobStoreLayer),
        Effect.tapError((e) =>
          Effect.sync(() => logger.error(`Hook effect failed: ${String(e)}`))
        ),
        Effect.orElse(() => Effect.void)
      )
    )

  // -------------------------------------------------------------------------
  // subagent_spawned
  //
  // event.runId           — the runId we stored in DB at spawn time
  // event.childSessionKey — the real session key for liveness lookups
  //
  // Flow:
  //   1. Check if a job exists with session_key = event.runId
  //   2. If yes → update session_key to event.childSessionKey
  //   3. If no → silently ignore (not a dispatcher job)
  // -------------------------------------------------------------------------
  const onSubagentSpawned: SubagentSpawnedHandler = async (event) => {
    const runId = event.runId
    if (!runId) return

    await runEffect(
      Effect.gen(function* () {
        const store = yield* JobStore
        const existing = yield* store.getJobBySessionKey(runId)

        if (Option.isNone(existing)) {
          // Not a dispatcher-managed job — ignore silently
          return
        }

        const childSessionKey = event.childSessionKey
        if (!childSessionKey) {
          logger.warn(`subagent_spawned: runId=${runId} matched a job but childSessionKey is missing`)
          return
        }

        yield* store.updateSessionKey(runId, childSessionKey)
        logger.info(`session key resolved: ${runId} → ${childSessionKey}`)
      })
    )
  }

  // -------------------------------------------------------------------------
  // subagent_ended
  //
  // event.targetSessionKey — the session that ended
  // event.outcome          — "ok" | "error" | "timeout" | "killed" | etc.
  //
  // Flow:
  //   1. Check if a job exists with session_key = event.targetSessionKey
  //   2. If yes → mark it complete (delete from DB)
  //   3. If no → silently ignore
  // -------------------------------------------------------------------------
  const onSubagentEnded: SubagentEndedHandler = async (event) => {
    const { targetSessionKey, outcome } = event

    await runEffect(
      Effect.gen(function* () {
        const store = yield* JobStore
        const existing = yield* store.getJobBySessionKey(targetSessionKey)

        if (Option.isNone(existing)) {
          // Not a dispatcher-managed job — ignore silently
          return
        }

        const job = existing.value
        logger.info(
          `subagent_ended: issueId=${job.issueId} sessionKey=${targetSessionKey} outcome=${outcome ?? "unknown"}`
        )

        yield* store.completeJob(job.issueId)
      })
    )
  }

  return { onSubagentSpawned, onSubagentEnded }
}
