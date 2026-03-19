import { describe, it, expect } from "bun:test"
import { Effect, Option } from "effect"
import { JobStore, JobStoreMemory, type Job } from "../src/db.js"

// ---------------------------------------------------------------------------
// Helper: run an effect with the exported in-memory JobStore layer
// ---------------------------------------------------------------------------

const run = <A>(effect: Effect.Effect<A, unknown, JobStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(JobStoreMemory)))

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
            sessionKey: "sess-abc123",
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
      expect(job.sessionKey).toBe("sess-abc123")
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
            sessionKey: "sess-v1",
          })
          yield* store.claimJob({
            issueId: "ISSUE-2",
            project: "STR",
            state: "Test",
            title: "Updated title",
            agentId: "coding-implementer",
            sessionKey: "sess-v2",
          })
          return yield* store.getActiveJobs()
        })
      )

      expect(result).toHaveLength(1)
      expect(result[0]!.title).toBe("Updated title")
      expect(result[0]!.state).toBe("Test")
      expect(result[0]!.sessionKey).toBe("sess-v2")
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
          yield* store.claimJob({ issueId: "A", project: "STR", state: "Prepare", title: "A", agentId: "x", sessionKey: "s1" })
          yield* store.claimJob({ issueId: "B", project: "STR", state: "Test", title: "B", agentId: "y", sessionKey: "s2" })
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
          yield* store.claimJob({ issueId: "X-1", project: "STR", state: "Prepare", title: "X", agentId: "a", sessionKey: "sk1" })
          return yield* store.getJobByIssueId("X-1")
        })
      )
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.issueId).toBe("X-1")
        expect(result.value.sessionKey).toBe("sk1")
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
          yield* store.claimJob({ issueId: "L-1", project: "STR", state: "Prepare", title: "L", agentId: "a", sessionKey: "sk-l" })
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
            yield* store.claimJob({ issueId, project: "STR", state: "Prepare", title: liveness, agentId: "a", sessionKey: `sk-${liveness}` })
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
          yield* store.claimJob({ issueId: "D-1", project: "STR", state: "Prepare", title: "D", agentId: "a", sessionKey: "sk-d" })
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
