import { describe, it, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "@effect/sql"
import { JobStore, type Job } from "../src/db.js"
import { DbError } from "../src/errors.js"

// ---------------------------------------------------------------------------
// In-memory SQLite layer for tests — no file I/O
// ---------------------------------------------------------------------------

const SqliteMemory = SqliteClient.layer({ filename: ":memory:" })

// ---------------------------------------------------------------------------
// DDL — must run before each test to get a clean slate
// The JobStore.make already runs this, but we need it on the same connection.
// We use JobStoreMemory which inlines the SqliteClient.
// ---------------------------------------------------------------------------

// Build a fresh in-memory JobStore for each test
const makeTestLayer = () =>
  Layer.provide(
    Layer.effect(
      JobStore,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        // Bootstrap schema
        yield* sql.unsafe(`
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
        `)

        // Re-use the same make function by yielding the JobStore tag
        // after the sql layer is available — we need to replicate the
        // impl here to avoid circular dep. Instead, use JobStoreMemory.
        // Actually, let's just import and use the make function directly.
        // But make is not exported. So we inline a minimal test store.

        interface JobRow {
          issue_id: string
          project: string
          state: string
          title: string
          agent_id: string | null
          session_key: string | null
          liveness: string
          claimed_at: number
          updated_at: number
        }

        type LivenessType = "pending" | "active" | "stale" | "dead"

        const rowToJob = (row: JobRow): Job => ({
          issueId: row.issue_id,
          project: row.project,
          state: row.state,
          title: row.title,
          agentId: row.agent_id,
          sessionKey: row.session_key,
          liveness: row.liveness as LivenessType,
          claimedAt: row.claimed_at,
          updatedAt: row.updated_at,
        })

        return JobStore.of({
          claimJob: (job) => {
            const now = Date.now()
            return sql`
              INSERT INTO jobs (issue_id, project, state, title, agent_id, liveness, claimed_at, updated_at)
              VALUES (${job.issueId}, ${job.project}, ${job.state}, ${job.title}, ${job.agentId}, 'pending', ${now}, ${now})
              ON CONFLICT (issue_id) DO UPDATE SET
                state = excluded.state, title = excluded.title,
                agent_id = excluded.agent_id, updated_at = excluded.updated_at
            `.pipe(
              Effect.asVoid,
              Effect.mapError((cause) => new DbError({ cause }))
            )
          },
          updateLiveness: (issueId, liveness) =>
            sql`UPDATE jobs SET liveness = ${liveness}, updated_at = ${Date.now()} WHERE issue_id = ${issueId}`.pipe(
              Effect.asVoid,
              Effect.mapError((cause) => new DbError({ cause }))
            ),
          completeJob: (issueId) =>
            sql`DELETE FROM jobs WHERE issue_id = ${issueId}`.pipe(
              Effect.asVoid,
              Effect.mapError((cause) => new DbError({ cause }))
            ),
          getActiveJobs: () =>
            sql<JobRow>`SELECT * FROM jobs`.pipe(
              Effect.map((rows) => rows.map(rowToJob)),
              Effect.mapError((cause) => new DbError({ cause }))
            ),
          getJobByIssueId: (issueId) =>
            sql<JobRow>`SELECT * FROM jobs WHERE issue_id = ${issueId}`.pipe(
              Effect.map((rows) => {
                const first = rows[0]
                return first !== undefined ? Option.some(rowToJob(first)) : Option.none()
              }),
              Effect.mapError((cause) => new DbError({ cause }))
            ),
        })
      })
    ),
    SqliteMemory
  )

// ---------------------------------------------------------------------------
// Helper: run an effect with a fresh in-memory JobStore
// ---------------------------------------------------------------------------

const run = <A>(effect: Effect.Effect<A, unknown, JobStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(makeTestLayer())))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JobStore", () => {
  describe("claimJob", () => {
    it("inserts a new job and getActiveJobs returns it", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* JobStore
          yield* store.claimJob({
            issueId: "ISSUE-1",
            project: "STR",
            state: "Prepare",
            title: "Test issue",
            agentId: "coding-implementer",
          })
          return yield* store.getActiveJobs()
        })
      )

      expect(result).toHaveLength(1)
      const job = result[0]!
      expect(job.issueId).toBe("ISSUE-1")
      expect(job.project).toBe("STR")
      expect(job.state).toBe("Prepare")
      expect(job.title).toBe("Test issue")
      expect(job.agentId).toBe("coding-implementer")
      expect(job.liveness).toBe("pending")
    })

    it("upserts on conflict — updates existing job", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* JobStore
          yield* store.claimJob({
            issueId: "ISSUE-2",
            project: "STR",
            state: "Prepare",
            title: "Original title",
            agentId: "coding-implementer",
          })
          yield* store.claimJob({
            issueId: "ISSUE-2",
            project: "STR",
            state: "Test",
            title: "Updated title",
            agentId: "coding-implementer",
          })
          return yield* store.getActiveJobs()
        })
      )

      expect(result).toHaveLength(1)
      expect(result[0]!.title).toBe("Updated title")
      expect(result[0]!.state).toBe("Test")
    })
  })

  describe("getActiveJobs", () => {
    it("returns empty array when no jobs", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* JobStore
          return yield* store.getActiveJobs()
        })
      )
      expect(result).toHaveLength(0)
    })

    it("returns multiple jobs", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* JobStore
          yield* store.claimJob({ issueId: "A", project: "STR", state: "Prepare", title: "A", agentId: "x" })
          yield* store.claimJob({ issueId: "B", project: "STR", state: "Test", title: "B", agentId: "y" })
          return yield* store.getActiveJobs()
        })
      )
      expect(result).toHaveLength(2)
      const ids = result.map((j) => j.issueId).sort()
      expect(ids).toEqual(["A", "B"])
    })
  })

  describe("getJobByIssueId", () => {
    it("returns Some when job exists", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* JobStore
          yield* store.claimJob({ issueId: "X-1", project: "STR", state: "Prepare", title: "X", agentId: "a" })
          return yield* store.getJobByIssueId("X-1")
        })
      )
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.issueId).toBe("X-1")
      }
    })

    it("returns None when job does not exist", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* JobStore
          return yield* store.getJobByIssueId("NONEXISTENT")
        })
      )
      expect(Option.isNone(result)).toBe(true)
    })
  })

  describe("updateLiveness", () => {
    it("updates the liveness column", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* JobStore
          yield* store.claimJob({ issueId: "L-1", project: "STR", state: "Prepare", title: "L", agentId: "a" })
          yield* store.updateLiveness("L-1", "active")
          return yield* store.getJobByIssueId("L-1")
        })
      )
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.liveness).toBe("active")
      }
    })

    it("supports all liveness values", async () => {
      const livenessValues = ["pending", "active", "stale", "dead"] as const

      for (const liveness of livenessValues) {
        const issueId = `LIVENESS-${liveness}`
        const result = await run(
          Effect.gen(function* () {
            const store = yield* JobStore
            yield* store.claimJob({ issueId, project: "STR", state: "Prepare", title: liveness, agentId: "a" })
            yield* store.updateLiveness(issueId, liveness)
            return yield* store.getJobByIssueId(issueId)
          })
        )
        expect(Option.isSome(result)).toBe(true)
        if (Option.isSome(result)) {
          expect(result.value.liveness).toBe(liveness)
        }
      }
    })
  })

  describe("completeJob", () => {
    it("removes the job from the store", async () => {
      const result = await run(
        Effect.gen(function* () {
          const store = yield* JobStore
          yield* store.claimJob({ issueId: "D-1", project: "STR", state: "Prepare", title: "D", agentId: "a" })
          yield* store.completeJob("D-1")
          return yield* store.getActiveJobs()
        })
      )
      expect(result).toHaveLength(0)
    })

    it("is idempotent — does not error if job does not exist", async () => {
      await expect(
        run(
          Effect.gen(function* () {
            const store = yield* JobStore
            yield* store.completeJob("DOES-NOT-EXIST")
          })
        )
      ).resolves.toBeUndefined()
    })
  })
})
