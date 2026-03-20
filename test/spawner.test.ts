import { describe, it, expect } from "bun:test"
import { Effect, Layer, Exit, Cause, Option, ConfigProvider } from "effect"
import { AgentSpawner, AgentSpawnerLive, AgentSpawnerDryRun } from "../src/spawner.js"
import { SpawnError } from "../src/errors.js"

// ---------------------------------------------------------------------------
// Test config provider
// ---------------------------------------------------------------------------

const testConfig = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["OPENCLAW_GATEWAY_URL", "http://fake-gateway.test"],
      ["OPENCLAW_GATEWAY_TOKEN", "test-token"],
      ["DISPATCHER_DB_PATH", ":memory:"],
      ["DISPATCHER_DISCORD_CHANNEL", "test-channel"],
      ["PLANE_API_KEY", "test-plane-key"],
    ])
  )
)

// ---------------------------------------------------------------------------
// Fetch mock helper
// ---------------------------------------------------------------------------

type FetchMock = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

function withFetchMock<A, E>(
  mockFn: FetchMock,
  effect: Effect.Effect<A, E, AgentSpawner>
): Effect.Effect<A, E, AgentSpawner> {
  const original = globalThis.fetch
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      globalThis.fetch = mockFn as typeof fetch
      return original
    }),
    () => effect,
    (orig) => Effect.sync(() => { globalThis.fetch = orig })
  )
}

// ---------------------------------------------------------------------------
// Helpers: run with AgentSpawnerLive
// ---------------------------------------------------------------------------

const run = <A, E>(
  effect: Effect.Effect<A, E, AgentSpawner>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(AgentSpawnerLive),
      Effect.provide(testConfig)
    )
  )

const runExit = <A, E>(
  effect: Effect.Effect<A, E, AgentSpawner>
) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(AgentSpawnerLive),
      Effect.provide(testConfig)
    )
  )

// ---------------------------------------------------------------------------
// Helpers: run with AgentSpawnerDryRun (no config needed)
// ---------------------------------------------------------------------------

const runDryRun = <A, E>(
  effect: Effect.Effect<A, E, AgentSpawner>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(AgentSpawnerDryRun))
  )

// ---------------------------------------------------------------------------
// Shared spawn params
// ---------------------------------------------------------------------------

const defaultParams = {
  agentId: "coding-implementer",
  task: "Work on Plane issue abc-123: Add tests",
  issueId: "abc-123",
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentSpawnerLive", () => {
  describe("successful spawn", () => {
    it("returns sessionKey from response runId on success", async () => {
      const mockFn: FetchMock = async () =>
        new Response(
          JSON.stringify({ ok: true, runId: "run-xyz-789" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )

      const result = await run(
        withFetchMock(
          mockFn,
          Effect.gen(function* () {
            const spawner = yield* AgentSpawner
            return yield* spawner.spawn(defaultParams)
          })
        )
      )

      expect(result.sessionKey).toBe("run-xyz-789")
    })

    it("POSTs to /hooks/agent with correct URL and headers", async () => {
      let capturedUrl: string | undefined
      let capturedInit: RequestInit | undefined

      const mockFn: FetchMock = async (input, init) => {
        capturedUrl = typeof input === "string" ? input : input.toString()
        capturedInit = init
        return new Response(
          JSON.stringify({ ok: true, runId: "run-captured" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }

      await run(
        withFetchMock(
          mockFn,
          Effect.gen(function* () {
            const spawner = yield* AgentSpawner
            return yield* spawner.spawn(defaultParams)
          })
        )
      )

      expect(capturedUrl).toBe("http://fake-gateway.test/hooks/agent")
      expect(capturedInit?.method).toBe("POST")
      // Auth header present
      const headers = capturedInit?.headers as Record<string, string> | undefined
      expect(headers?.["Authorization"]).toBe("Bearer test-token")
      expect(headers?.["Content-Type"]).toBe("application/json")
    })

    it("includes agentId, message, and name in request body", async () => {
      let capturedBody: unknown

      const mockFn: FetchMock = async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string)
        return new Response(
          JSON.stringify({ ok: true, runId: "run-body-check" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }

      await run(
        withFetchMock(
          mockFn,
          Effect.gen(function* () {
            const spawner = yield* AgentSpawner
            return yield* spawner.spawn(defaultParams)
          })
        )
      )

      expect(capturedBody).toMatchObject({
        agentId: "coding-implementer",
        message: "Work on Plane issue abc-123: Add tests",
        name: "Plane issue abc-123",
      })
    })
  })

  describe("network error", () => {
    it("fails with SpawnError on fetch rejection", async () => {
      const mockFn: FetchMock = async () => {
        throw new Error("connection refused")
      }

      const exit = await runExit(
        withFetchMock(
          mockFn,
          Effect.gen(function* () {
            const spawner = yield* AgentSpawner
            return yield* spawner.spawn(defaultParams)
          })
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(Option.isSome(failure)).toBe(true)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(SpawnError)
          expect((failure.value as InstanceType<typeof SpawnError>).issueId).toBe("abc-123")
          expect((failure.value as InstanceType<typeof SpawnError>).reason).toMatch(/Network error/)
        }
      }
    })
  })

  describe("non-200 response", () => {
    it("fails with SpawnError on 500 response", async () => {
      const mockFn: FetchMock = async () =>
        new Response("Internal Server Error", { status: 500 })

      const exit = await runExit(
        withFetchMock(
          mockFn,
          Effect.gen(function* () {
            const spawner = yield* AgentSpawner
            return yield* spawner.spawn(defaultParams)
          })
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        expect(Option.isSome(failure)).toBe(true)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(SpawnError)
          expect((failure.value as InstanceType<typeof SpawnError>).reason).toMatch(/500/)
        }
      }
    })

    it("fails with SpawnError on 401 unauthorized", async () => {
      const mockFn: FetchMock = async () =>
        new Response("Unauthorized", { status: 401 })

      const exit = await runExit(
        withFetchMock(
          mockFn,
          Effect.gen(function* () {
            const spawner = yield* AgentSpawner
            return yield* spawner.spawn(defaultParams)
          })
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(SpawnError)
          expect((failure.value as InstanceType<typeof SpawnError>).reason).toMatch(/401/)
        }
      }
    })
  })

  describe("malformed response body", () => {
    it("fails with SpawnError when body is not valid JSON", async () => {
      const mockFn: FetchMock = async () =>
        new Response("not json at all", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        })

      const exit = await runExit(
        withFetchMock(
          mockFn,
          Effect.gen(function* () {
            const spawner = yield* AgentSpawner
            return yield* spawner.spawn(defaultParams)
          })
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(SpawnError)
        }
      }
    })

    it("fails with SpawnError when runId is missing from response", async () => {
      // Schema requires both `ok: boolean` and `runId: string`
      const mockFn: FetchMock = async () =>
        new Response(
          JSON.stringify({ ok: true }),  // missing runId
          { status: 200, headers: { "Content-Type": "application/json" } }
        )

      const exit = await runExit(
        withFetchMock(
          mockFn,
          Effect.gen(function* () {
            const spawner = yield* AgentSpawner
            return yield* spawner.spawn(defaultParams)
          })
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(SpawnError)
          expect((failure.value as InstanceType<typeof SpawnError>).reason).toMatch(/validation failed/)
        }
      }
    })

    it("fails with SpawnError when response schema is entirely wrong type", async () => {
      const mockFn: FetchMock = async () =>
        new Response(
          JSON.stringify([1, 2, 3]),  // array instead of object
          { status: 200, headers: { "Content-Type": "application/json" } }
        )

      const exit = await runExit(
        withFetchMock(
          mockFn,
          Effect.gen(function* () {
            const spawner = yield* AgentSpawner
            return yield* spawner.spawn(defaultParams)
          })
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause)
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(SpawnError)
          expect((failure.value as InstanceType<typeof SpawnError>).reason).toMatch(/validation failed/)
        }
      }
    })
  })
})

// ---------------------------------------------------------------------------
// AgentSpawnerDryRun tests
// ---------------------------------------------------------------------------

describe("AgentSpawnerDryRun", () => {
  it("returns a session key without hitting the network", async () => {
    // If this touches fetch it would throw (we never mock it here)
    const result = await runDryRun(
      Effect.gen(function* () {
        const spawner = yield* AgentSpawner
        return yield* spawner.spawn(defaultParams)
      })
    )

    expect(result.sessionKey).toBeString()
    expect(result.sessionKey).toMatch(/dry-run/)
    expect(result.sessionKey).toMatch(/coding-implementer/)
    expect(result.sessionKey).toMatch(/abc-123/)
  })

  it("includes issueId in the dry-run session key", async () => {
    const result = await runDryRun(
      Effect.gen(function* () {
        const spawner = yield* AgentSpawner
        return yield* spawner.spawn({
          agentId: "code-review",
          task: "Review PR #42",
          issueId: "pr-review-42",
        })
      })
    )

    expect(result.sessionKey).toMatch(/pr-review-42/)
  })

  it("returns distinct session keys per spawn call", async () => {
    // Session keys include Date.now() so they should be unique
    const results = await runDryRun(
      Effect.gen(function* () {
        const spawner = yield* AgentSpawner
        const a = yield* spawner.spawn({ ...defaultParams, issueId: "issue-A" })
        const b = yield* spawner.spawn({ ...defaultParams, issueId: "issue-B" })
        return { a: a.sessionKey, b: b.sessionKey }
      })
    )

    // Different issueIds → different session keys
    expect(results.a).not.toBe(results.b)
    expect(results.a).toMatch(/issue-A/)
    expect(results.b).toMatch(/issue-B/)
  })
})
