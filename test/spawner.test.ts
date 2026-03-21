import { describe, it, expect } from "bun:test"
import { Effect, Layer, Exit, Cause, Option, ConfigProvider } from "effect"
import {
  AgentSpawner,
  AgentSpawnerLive,
  AgentSpawnerDryRun,
  buildAgentSessionKey,
  normaliseAgentId,
} from "../src/spawner.js"
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
// Unit tests for session key helpers
// ---------------------------------------------------------------------------

describe("normaliseAgentId", () => {
  it("lowercases and keeps valid chars", () => {
    expect(normaliseAgentId("coding-implementer")).toBe("coding-implementer")
  })

  it("replaces invalid chars with dashes", () => {
    // Space → dash; trailing dash from "!" is stripped by trailing-dash rule
    expect(normaliseAgentId("My Agent!")).toBe("my-agent")
  })

  it("strips leading and trailing dashes", () => {
    expect(normaliseAgentId("-agent-")).toBe("agent")
  })

  it("truncates to 64 chars", () => {
    const long = "a".repeat(80)
    expect(normaliseAgentId(long)).toHaveLength(64)
  })
})

describe("buildAgentSessionKey", () => {
  it("builds canonical session key from agentId and issueId", () => {
    expect(buildAgentSessionKey("coding-implementer", "abc-123")).toBe(
      "agent:coding-implementer:plane-abc-123"
    )
  })

  it("normalises the agentId", () => {
    expect(buildAgentSessionKey("Coding Implementer", "abc-123")).toBe(
      "agent:coding-implementer:plane-abc-123"
    )
  })

  it("includes plane- prefix in the request key", () => {
    expect(buildAgentSessionKey("code-review", "FEAT-42")).toBe(
      "agent:code-review:plane-FEAT-42"
    )
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentSpawnerLive", () => {
  describe("successful spawn", () => {
    it("returns deterministic sessionKey derived from agentId and issueId (not runId)", async () => {
      // The webhook returns a random runId but we must NOT use it as the
      // session key — that was the OC-21 bug.  The spawner must return the
      // pre-computed canonical key so liveness checks hit the right session.
      const mockFn: FetchMock = async () =>
        new Response(
          JSON.stringify({ ok: true, runId: "some-random-run-id-xyz" }),
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

      // Must NOT be the runId
      expect(result.sessionKey).not.toBe("some-random-run-id-xyz")
      // Must be the deterministic canonical key
      expect(result.sessionKey).toBe("agent:coding-implementer:plane-abc-123")
    })

    it("sessionKey matches buildAgentSessionKey(agentId, issueId)", async () => {
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

      expect(result.sessionKey).toBe(
        buildAgentSessionKey(defaultParams.agentId, defaultParams.issueId)
      )
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

    it("includes agentId, message, name, and sessionKey in request body", async () => {
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
        // The sessionKey sent to the gateway is the request key (without agent: prefix)
        sessionKey: "plane-abc-123",
      })
    })

    it("sends the request key (not the full canonical key) as sessionKey in request body", async () => {
      // The gateway computes the full canonical key internally.
      // We only need to send the short `plane-<issueId>` prefix.
      let capturedBody: Record<string, unknown> | undefined

      const mockFn: FetchMock = async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>
        return new Response(
          JSON.stringify({ ok: true, runId: "run-ok" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }

      await run(
        withFetchMock(
          mockFn,
          Effect.gen(function* () {
            const spawner = yield* AgentSpawner
            return yield* spawner.spawn({
              agentId: "code-review",
              task: "Review PR #7",
              issueId: "FEAT-99",
            })
          })
        )
      )

      expect(capturedBody?.["sessionKey"]).toBe("plane-FEAT-99")
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
        expect(Option.isSome(failure)).toBe(true)
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
        expect(Option.isSome(failure)).toBe(true)
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
        expect(Option.isSome(failure)).toBe(true)
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
        expect(Option.isSome(failure)).toBe(true)
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
  it("returns deterministic sessionKey matching buildAgentSessionKey", async () => {
    const result = await runDryRun(
      Effect.gen(function* () {
        const spawner = yield* AgentSpawner
        return yield* spawner.spawn(defaultParams)
      })
    )

    expect(result.sessionKey).toBe(
      buildAgentSessionKey(defaultParams.agentId, defaultParams.issueId)
    )
    expect(result.sessionKey).toBe("agent:coding-implementer:plane-abc-123")
  })

  it("does NOT contain 'dry-run' — key is canonical not synthetic", async () => {
    const result = await runDryRun(
      Effect.gen(function* () {
        const spawner = yield* AgentSpawner
        return yield* spawner.spawn(defaultParams)
      })
    )

    // Canonical key — stable across calls, not time-based
    expect(result.sessionKey).not.toMatch(/dry-run/)
  })

  it("returns a session key without hitting the network", async () => {
    // If this touches fetch it would throw (we never mock it here)
    const result = await runDryRun(
      Effect.gen(function* () {
        const spawner = yield* AgentSpawner
        return yield* spawner.spawn(defaultParams)
      })
    )

    expect(result.sessionKey).toBeString()
    expect(result.sessionKey).toMatch(/coding-implementer/)
    expect(result.sessionKey).toMatch(/abc-123/)
  })

  it("includes issueId in the session key", async () => {
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
    expect(result.sessionKey).toBe("agent:code-review:plane-pr-review-42")
  })

  it("returns the SAME key on repeated calls (deterministic)", async () => {
    // Previously used Date.now() so keys were non-deterministic.
    // After the fix, same inputs → same key, always.
    const results = await runDryRun(
      Effect.gen(function* () {
        const spawner = yield* AgentSpawner
        const a = yield* spawner.spawn({ ...defaultParams, issueId: "issue-A" })
        const b = yield* spawner.spawn({ ...defaultParams, issueId: "issue-A" })
        return { a: a.sessionKey, b: b.sessionKey }
      })
    )

    expect(results.a).toBe(results.b)
  })

  it("returns different keys for different issueIds", async () => {
    const results = await runDryRun(
      Effect.gen(function* () {
        const spawner = yield* AgentSpawner
        const a = yield* spawner.spawn({ ...defaultParams, issueId: "issue-A" })
        const b = yield* spawner.spawn({ ...defaultParams, issueId: "issue-B" })
        return { a: a.sessionKey, b: b.sessionKey }
      })
    )

    expect(results.a).not.toBe(results.b)
    expect(results.a).toMatch(/issue-A/)
    expect(results.b).toMatch(/issue-B/)
  })
})
