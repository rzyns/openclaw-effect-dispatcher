import { ConfigError, Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Schema } from "effect"
import { DbError } from "./errors.js"
import { AppConfig } from "./config.js"

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type Liveness = "pending" | "active" | "stale" | "dead"

export const LivenessSchema = Schema.Literal("pending", "active", "stale", "dead")

export interface Job {
  readonly issueId: string
  readonly project: string
  readonly state: string
  readonly title: string
  readonly agentId: string | null
  readonly sessionKey: string | null
  readonly liveness: Liveness
  readonly claimedAt: number
  readonly updatedAt: number
}

// ---------------------------------------------------------------------------
// Raw DB row shape (snake_case — @effect/sql returns verbatim column names)
// ---------------------------------------------------------------------------

interface JobRow {
  readonly issue_id: string
  readonly project: string
  readonly state: string
  readonly title: string
  readonly agent_id: string | null
  readonly session_key: string | null
  readonly liveness: string
  readonly claimed_at: number
  readonly updated_at: number
}

const decodeRow = (row: JobRow): Effect.Effect<Job, DbError> =>
  Schema.decodeUnknown(LivenessSchema)(row.liveness).pipe(
    Effect.mapError((cause) => new DbError({ cause })),
    Effect.map((liveness) => ({
      issueId: row.issue_id,
      project: row.project,
      state: row.state,
      title: row.title,
      agentId: row.agent_id,
      sessionKey: row.session_key,
      liveness,
      claimedAt: row.claimed_at,
      updatedAt: row.updated_at,
    }))
  )

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface JobStore {
  readonly claimJob: (job: {
    issueId: string
    project: string
    state: string
    title: string
    agentId: string
    sessionKey: string
  }) => Effect.Effect<void, DbError>
  readonly updateLiveness: (issueId: string, liveness: Liveness) => Effect.Effect<void, DbError>
  readonly completeJob: (issueId: string) => Effect.Effect<void, DbError>
  readonly getActiveJobs: () => Effect.Effect<ReadonlyArray<Job>, DbError>
  readonly getJobByIssueId: (issueId: string) => Effect.Effect<Option.Option<Job>, DbError>
  /** Look up a job by its current session_key value (used by plugin hooks). */
  readonly getJobBySessionKey: (sessionKey: string) => Effect.Effect<Option.Option<Job>, DbError>
  /** Atomically replace one session_key value with another (used to resolve runId → real key). */
  readonly updateSessionKey: (oldKey: string, newKey: string) => Effect.Effect<void, DbError>
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

export const JobStore = Context.GenericTag<JobStore>("JobStore")

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS jobs (
    issue_id    TEXT PRIMARY KEY,
    project     TEXT NOT NULL,
    state       TEXT NOT NULL,
    title       TEXT NOT NULL,
    agent_id    TEXT,
    session_key TEXT,
    liveness    TEXT NOT NULL DEFAULT 'pending',
    claimed_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )
`

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // Ensure schema exists
  yield* sql.unsafe(SCHEMA_SQL).pipe(
    Effect.mapError((cause) => new DbError({ cause }))
  )

  const claimJob = (job: {
    issueId: string
    project: string
    state: string
    title: string
    agentId: string
    sessionKey: string
  }): Effect.Effect<void, DbError> => {
    const now = Date.now()
    return sql`
      INSERT INTO jobs (issue_id, project, state, title, agent_id, session_key, liveness, claimed_at, updated_at)
      VALUES (
        ${job.issueId},
        ${job.project},
        ${job.state},
        ${job.title},
        ${job.agentId},
        ${job.sessionKey},
        'pending',
        ${now},
        ${now}
      )
      ON CONFLICT (issue_id) DO UPDATE SET
        state       = excluded.state,
        title       = excluded.title,
        agent_id    = excluded.agent_id,
        session_key = excluded.session_key,
        updated_at  = excluded.updated_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new DbError({ cause }))
    )
  }

  const updateLiveness = (issueId: string, liveness: Liveness): Effect.Effect<void, DbError> =>
    sql`
      UPDATE jobs
      SET liveness = ${liveness}, updated_at = ${Date.now()}
      WHERE issue_id = ${issueId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new DbError({ cause }))
    )

  const completeJob = (issueId: string): Effect.Effect<void, DbError> =>
    sql`DELETE FROM jobs WHERE issue_id = ${issueId}`.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new DbError({ cause }))
    )

  const getActiveJobs = (): Effect.Effect<ReadonlyArray<Job>, DbError> =>
    sql<JobRow>`SELECT * FROM jobs`.pipe(
      Effect.mapError((cause) => new DbError({ cause })),
      Effect.flatMap((rows) => Effect.all(rows.map(decodeRow)))
    )

  const getJobByIssueId = (issueId: string): Effect.Effect<Option.Option<Job>, DbError> =>
    sql<JobRow>`SELECT * FROM jobs WHERE issue_id = ${issueId}`.pipe(
      Effect.mapError((cause) => new DbError({ cause })),
      Effect.flatMap((rows) => {
        const first = rows[0]
        if (first === undefined) return Effect.succeed(Option.none<Job>())
        return decodeRow(first).pipe(Effect.map(Option.some))
      })
    )

  const getJobBySessionKey = (sessionKey: string): Effect.Effect<Option.Option<Job>, DbError> =>
    sql<JobRow>`SELECT * FROM jobs WHERE session_key = ${sessionKey}`.pipe(
      Effect.mapError((cause) => new DbError({ cause })),
      Effect.flatMap((rows) => {
        const first = rows[0]
        if (first === undefined) return Effect.succeed(Option.none<Job>())
        return decodeRow(first).pipe(Effect.map(Option.some))
      })
    )

  const updateSessionKey = (oldKey: string, newKey: string): Effect.Effect<void, DbError> =>
    sql`
      UPDATE jobs
      SET session_key = ${newKey}, updated_at = ${Date.now()}
      WHERE session_key = ${oldKey}
    `.pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new DbError({ cause }))
    )

  return JobStore.of({ claimJob, updateLiveness, completeJob, getActiveJobs, getJobByIssueId, getJobBySessionKey, updateSessionKey })
})

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/** Live layer — reads DB path from config, connects to SQLite file */
export const JobStoreLive: Layer.Layer<JobStore, ConfigError.ConfigError | DbError> = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const sqliteLayer = SqliteClient.layer({ filename: config.dispatcherDbPath })
    return Layer.effect(JobStore, make).pipe(Layer.provide(sqliteLayer))
  }).pipe(Effect.mapError((cause) => new DbError({ cause })))
)

/** Test layer — pure in-memory Map, no SQLite, works with both Bun and Node */
export const JobStoreMemory: Layer.Layer<JobStore, never> = Layer.sync(JobStore, () => {
  const store = new Map<string, Job>()

  const claimJob = (job: {
    issueId: string
    project: string
    state: string
    title: string
    agentId: string
    sessionKey: string
  }): Effect.Effect<void, DbError> => {
    const now = Date.now()
    const existing = store.get(job.issueId)
    store.set(job.issueId, {
      issueId: job.issueId,
      project: job.project,
      state: job.state,
      title: job.title,
      agentId: job.agentId,
      sessionKey: job.sessionKey,
      liveness: existing?.liveness ?? "pending",
      claimedAt: existing?.claimedAt ?? now,
      updatedAt: now,
    })
    return Effect.void
  }

  const updateLiveness = (issueId: string, liveness: Liveness): Effect.Effect<void, DbError> => {
    const existing = store.get(issueId)
    if (existing) {
      store.set(issueId, { ...existing, liveness, updatedAt: Date.now() })
    }
    return Effect.void
  }

  const completeJob = (issueId: string): Effect.Effect<void, DbError> => {
    store.delete(issueId)
    return Effect.void
  }

  const getActiveJobs = (): Effect.Effect<ReadonlyArray<Job>, DbError> =>
    Effect.succeed(Array.from(store.values()))

  const getJobByIssueId = (issueId: string): Effect.Effect<Option.Option<Job>, DbError> => {
    const job = store.get(issueId)
    return Effect.succeed(job !== undefined ? Option.some(job) : Option.none())
  }

  const getJobBySessionKey = (sessionKey: string): Effect.Effect<Option.Option<Job>, DbError> => {
    for (const job of store.values()) {
      if (job.sessionKey === sessionKey) return Effect.succeed(Option.some(job))
    }
    return Effect.succeed(Option.none())
  }

  const updateSessionKey = (oldKey: string, newKey: string): Effect.Effect<void, DbError> => {
    for (const [issueId, job] of store.entries()) {
      if (job.sessionKey === oldKey) {
        store.set(issueId, { ...job, sessionKey: newKey, updatedAt: Date.now() })
        break
      }
    }
    return Effect.void
  }

  return JobStore.of({ claimJob, updateLiveness, completeJob, getActiveJobs, getJobByIssueId, getJobBySessionKey, updateSessionKey })
})

/** Build a JobStore layer for a specific DB file path (used by plugin). */
export const makeJobStoreLive = (dbPath: string): Layer.Layer<JobStore, ConfigError.ConfigError | DbError> =>
  Layer.provide(
    Layer.effect(JobStore, make),
    SqliteClient.layer({ filename: dbPath })
  )
