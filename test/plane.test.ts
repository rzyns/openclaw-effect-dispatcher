import { describe, it, expect } from "bun:test"
import { Effect, Layer, Exit, Cause, Option, ConfigProvider } from "effect"
import { PlaneClient, PlaneClientLive } from "../src/plane.js"
import { PlaneApiError } from "../src/errors.js"

// ---------------------------------------------------------------------------
// Test config provider — supplies required env vars without real values
// ---------------------------------------------------------------------------

const testConfig = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["PLANE_API_KEY", "test-api-key"],
      ["PLANE_URL", "http://fake-plane.test/api/v1/workspaces/warsztat"],
      ["OPENCLAW_GATEWAY_URL", "http://localhost:18789"],
      ["OPENCLAW_GATEWAY_TOKEN", "test-token"],
      ["DISPATCHER_DB_PATH", ":memory:"],
      ["DISPATCHER_DISCORD_CHANNEL", "test-channel"],
    ])
  )
)

// ---------------------------------------------------------------------------
// Global fetch mock helper
//
// Bun supports globalThis.fetch replacement. We restore it after each test.
// ---------------------------------------------------------------------------

type FetchMock = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>

function withFetchMock(mockFn: FetchMock, effect: Effect.Effect<unknown, unknown, PlaneClient>) {
  const original = globalThis.fetch
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      globalThis.fetch = mockFn as typeof fetch
      return original
    }),
    () => effect,
    (original) => Effect.sync(() => { globalThis.fetch = original })
  )
}

// ---------------------------------------------------------------------------
// Helper: run an effect with PlaneClientLive + test config
// ---------------------------------------------------------------------------

const run = <A, E>(
  effect: Effect.Effect<A, E, PlaneClient>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PlaneClientLive),
      Effect.provide(testConfig)
    )
  )

const runExit = <A, E>(
  effect: Effect.Effect<A, E, PlaneClient>
) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(PlaneClientLive),
      Effect.provide(testConfig)
    )
  )

// ---------------------------------------------------------------------------
// Fake issue response builder
// ---------------------------------------------------------------------------

const fakeIssueBody = (overrides: Partial<{
  id: string; name: string; state: string; assignees: string[]
}> = {}) => ({
  id: overrides.id ?? "issue-abc",
  name: overrides.name ?? "Test Issue",
  state: overrides.state ?? "state-id-prepare",
  assignees: overrides.assignees ?? ["assignee-1"],
})

const fakeListResponse = (issues: ReturnType<typeof fakeIssueBody>[]) => ({
  count: issues.length,
  next: null,
  previous: null,
  results: issues,
})

// ---------------------------------------------------------------------------
// Test fixtures — state UUIDs and name mapping
// ---------------------------------------------------------------------------

// Real STR UUIDs from config.json
const PREPARE_UUID = "c2c4ba94-5acb-46ec-b28f-8d38f8592d9c"
const TEST_UUID    = "102028a4-84b1-4a53-a853-55b256d3aa0a"
const REVIEW_UUID  = "c4c5ed11-df2f-4025-ae63-6e62feac072e"
const DONE_UUID    = "d8b759e9-8bff-4c2d-8979-95f4a44d6cc3"

const testStateIdToName: Record<string, string> = {
  [PREPARE_UUID]: "Prepare",
  [TEST_UUID]:    "Test",
  [REVIEW_UUID]:  "Review",
  [DONE_UUID]:    "Done",
}

const activeStateIds = [PREPARE_UUID, TEST_UUID, REVIEW_UUID]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PlaneClientLive", () => {
  describe("getActiveIssues", () => {
    it("maps Plane API response to PlaneIssue domain type", async () => {
      const apiIssue = fakeIssueBody({ id: "issue-1", name: "My Feature", state: PREPARE_UUID, assignees: ["user-1"] })
      const listResponse = fakeListResponse([apiIssue])

      const result = await Effect.runPromise(
        withFetchMock(
          async () =>
            new Response(JSON.stringify(listResponse), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.getActiveIssues("project-abc", activeStateIds, testStateIdToName)
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(result).toHaveLength(1)
      const issue = result[0]!
      expect(issue.id).toBe("issue-1")
      expect(issue.title).toBe("My Feature")   // name → title mapping
      expect(issue.projectId).toBe("project-abc")
      expect(issue.state).toBe("Prepare")      // UUID → name resolved
      expect(issue.assigneeId).toBe("user-1")
    })

    it("resolves state UUID to human-readable name in returned PlaneIssue", async () => {
      // The API returns UUIDs; the client must resolve them to names
      const apiIssue = fakeIssueBody({ id: "issue-uuid-resolve", state: REVIEW_UUID })
      const result = await Effect.runPromise(
        withFetchMock(
          async () => new Response(JSON.stringify(fakeListResponse([apiIssue])), { status: 200 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.getActiveIssues("project-abc", activeStateIds, testStateIdToName)
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(result).toHaveLength(1)
      expect(result[0]!.state).toBe("Review")  // UUID resolved to name
    })

    it("falls back to raw UUID when stateIdToName has no entry", async () => {
      const unknownUUID = "00000000-0000-0000-0000-000000000000"
      const apiIssue = fakeIssueBody({ id: "issue-fallback", state: unknownUUID })
      const result = await Effect.runPromise(
        withFetchMock(
          async () => new Response(JSON.stringify(fakeListResponse([apiIssue])), { status: 200 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            // Include the unknown UUID in activeStateIds so it passes the filter
            return yield* client.getActiveIssues(
              "project-abc",
              [unknownUUID],
              testStateIdToName  // does not contain unknownUUID
            )
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(result).toHaveLength(1)
      expect(result[0]!.state).toBe(unknownUUID)  // fallback: raw UUID returned
    })

    it("filters out issues whose state UUID is not in activeStateIds", async () => {
      // DONE_UUID is not in activeStateIds — should be excluded
      const activeIssue = fakeIssueBody({ id: "issue-active", state: PREPARE_UUID })
      const doneIssue   = fakeIssueBody({ id: "issue-done",   state: DONE_UUID })
      const listResponse = fakeListResponse([activeIssue, doneIssue])

      const result = await Effect.runPromise(
        withFetchMock(
          async () => new Response(JSON.stringify(listResponse), { status: 200 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.getActiveIssues("project-abc", activeStateIds, testStateIdToName)
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(result).toHaveLength(1)
      expect(result[0]!.id).toBe("issue-active")
    })

    it("returns empty array when results is empty", async () => {
      const result = await Effect.runPromise(
        withFetchMock(
          async () =>
            new Response(JSON.stringify(fakeListResponse([])), { status: 200 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.getActiveIssues("project-abc", activeStateIds, testStateIdToName)
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(result).toHaveLength(0)
    })

    it("returns empty array when all issues are in non-active states", async () => {
      // DONE_UUID is not in activeStateIds
      const doneIssue1 = fakeIssueBody({ id: "issue-done-1", state: DONE_UUID })
      const doneIssue2 = fakeIssueBody({ id: "issue-done-2", state: DONE_UUID })

      const result = await Effect.runPromise(
        withFetchMock(
          async () => new Response(JSON.stringify(fakeListResponse([doneIssue1, doneIssue2])), { status: 200 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.getActiveIssues("project-abc", activeStateIds, testStateIdToName)
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(result).toHaveLength(0)
    })

    it("sets assigneeId to null when assignees array is empty", async () => {
      const apiIssue = fakeIssueBody({ state: PREPARE_UUID, assignees: [] })
      const result = await Effect.runPromise(
        withFetchMock(
          async () =>
            new Response(JSON.stringify(fakeListResponse([apiIssue])), { status: 200 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.getActiveIssues("project-abc", activeStateIds, testStateIdToName)
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(result[0]!.assigneeId).toBeNull()
    })

    it("fails with PlaneApiError on non-200 response", async () => {
      const exit = await Effect.runPromiseExit(
        withFetchMock(
          async () => new Response("Not Found", { status: 404 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.getActiveIssues("project-abc", activeStateIds, testStateIdToName)
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(Option.isSome(failure)).toBe(true)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(PlaneApiError)
          expect((failure.value as InstanceType<typeof PlaneApiError>).statusCode).toBe(404)
        }
      }
    })

    it("fails with PlaneApiError on network error", async () => {
      const exit = await Effect.runPromiseExit(
        withFetchMock(
          async () => { throw new Error("ECONNREFUSED") },
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.getActiveIssues("project-abc", activeStateIds, testStateIdToName)
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(Option.isSome(failure)).toBe(true)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(PlaneApiError)
          expect((failure.value as InstanceType<typeof PlaneApiError>).statusCode).toBe(0)
        }
      }
    })

    it("fails with PlaneApiError on malformed JSON response", async () => {
      const exit = await Effect.runPromiseExit(
        withFetchMock(
          async () =>
            new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.getActiveIssues("project-abc", activeStateIds, testStateIdToName)
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(Option.isSome(failure)).toBe(true)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(PlaneApiError)
        }
      }
    })
  })

  describe("patchIssue", () => {
    it("returns updated PlaneIssue on success", async () => {
      const updatedIssue = fakeIssueBody({ id: "issue-1", name: "Updated Title", state: "new-state-id" })

      const result = await Effect.runPromise(
        withFetchMock(
          async () =>
            new Response(JSON.stringify(updatedIssue), { status: 200 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.patchIssue("project-abc", "issue-1", { state: "new-state-id" })
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(result.id).toBe("issue-1")
      expect(result.title).toBe("Updated Title")
      expect(result.state).toBe("new-state-id")
    })

    it("fails with PlaneApiError on non-200 response", async () => {
      const exit = await Effect.runPromiseExit(
        withFetchMock(
          async () => new Response("Forbidden", { status: 403 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.patchIssue("project-abc", "issue-1", { state: "x" })
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(PlaneApiError)
          expect((failure.value as InstanceType<typeof PlaneApiError>).statusCode).toBe(403)
        }
      }
    })
  })

  describe("postComment", () => {
    it("resolves void on success", async () => {
      const result = await Effect.runPromise(
        withFetchMock(
          async () =>
            new Response(JSON.stringify({ id: "comment-1", comment_html: "<p>hi</p>" }), { status: 201 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.postComment("project-abc", "issue-1", "<p>hello</p>")
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(result).toBeUndefined()
    })

    it("fails with PlaneApiError on non-ok response", async () => {
      const exit = await Effect.runPromiseExit(
        withFetchMock(
          async () => new Response("Server Error", { status: 500 }),
          Effect.gen(function* () {
            const client = yield* PlaneClient
            return yield* client.postComment("project-abc", "issue-1", "<p>hi</p>")
          })
        ).pipe(
          Effect.provide(PlaneClientLive),
          Effect.provide(testConfig)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(PlaneApiError)
          expect((failure.value as InstanceType<typeof PlaneApiError>).statusCode).toBe(500)
        }
      }
    })
  })
})
