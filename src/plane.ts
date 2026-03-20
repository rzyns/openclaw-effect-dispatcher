import { ConfigError, Context, Effect, Layer, Schema } from "effect"
import { PlaneApiError } from "./errors.js"
import { AppConfig } from "./config.js"

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface PlaneIssue {
  readonly id: string
  readonly projectId: string
  readonly state: string
  readonly title: string
  readonly assigneeId: string | null
}

export interface IssuePatch {
  readonly state?: string
  readonly assigneeId?: string
  readonly description?: string
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface PlaneClient {
  readonly getActiveIssues: (
    projectId: string,
    activeStateIds: ReadonlyArray<string>,
    stateIdToName: Readonly<Record<string, string>>
  ) => Effect.Effect<ReadonlyArray<PlaneIssue>, PlaneApiError>
  readonly patchIssue: (projectId: string, issueId: string, patch: IssuePatch) => Effect.Effect<PlaneIssue, PlaneApiError>
  readonly postComment: (projectId: string, issueId: string, html: string) => Effect.Effect<void, PlaneApiError>
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

export const PlaneClient = Context.GenericTag<PlaneClient>("PlaneClient")

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

// Plane issue shape from REST API — note "name" not "title"
const PlaneIssueApiSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: Schema.String,
  assignees: Schema.Array(Schema.String),
})
type PlaneIssueApi = Schema.Schema.Type<typeof PlaneIssueApiSchema>

// Paginated list response
// next is null (not undefined) when there's no next page — use NullOr
const PlaneIssueListSchema = Schema.Struct({
  results: Schema.Array(PlaneIssueApiSchema),
  next: Schema.NullOr(Schema.String),
})

// Map API shape → domain shape.
// Resolves state UUID to human-readable name via stateIdToName.
// Falls back to the raw UUID if the mapping is unknown (defensive).
const mapIssue = (
  raw: PlaneIssueApi,
  projectId: string,
  stateIdToName: Readonly<Record<string, string>>
): PlaneIssue => ({
  id: raw.id,
  projectId,
  state: stateIdToName[raw.state] ?? raw.state, // UUID → name; fallback to UUID
  title: raw.name,              // Plane uses "name", domain uses "title"
  assigneeId: raw.assignees[0] ?? null,
})

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const PlaneClientLive: Layer.Layer<PlaneClient, ConfigError.ConfigError> = Layer.effect(
  PlaneClient,
  Effect.gen(function* () {
    const config = yield* AppConfig
    const base = config.planeUrl
    const headers = {
      "X-API-Key": config.planeApiKey,
      "Content-Type": "application/json",
    }

    // -----------------------------------------------------------------------
    // getActiveIssues — fetches all issues for a project, filters to those
    // whose state UUID is in activeStateIds, then resolves UUIDs to names.
    //
    // Design: fetch all + client-side filter rather than N API calls per state.
    // Plane projects have < 100 issues, so a single fetch is fine.
    // -----------------------------------------------------------------------
    const getActiveIssues = (
      projectId: string,
      activeStateIds: ReadonlyArray<string>,
      stateIdToName: Readonly<Record<string, string>>
    ): Effect.Effect<ReadonlyArray<PlaneIssue>, PlaneApiError> =>
      Effect.gen(function* () {
        const url = `${base}/projects/${projectId}/issues/`

        const r = yield* Effect.tryPromise({
          try: () => fetch(url, { headers }),
          catch: (cause) =>
            new PlaneApiError({ statusCode: 0, url, cause }),
        })

        if (!r.ok) {
          return yield* Effect.fail(
            new PlaneApiError({ statusCode: r.status, url, cause: `HTTP ${r.status}` })
          )
        }

        const rawJson = yield* Effect.tryPromise({
          try: () => r.json(),
          catch: (cause) =>
            new PlaneApiError({ statusCode: r.status, url, cause }),
        })

        const body = yield* Schema.decodeUnknown(PlaneIssueListSchema)(rawJson).pipe(
          Effect.mapError(
            (e) => new PlaneApiError({ statusCode: r.status, url, cause: e })
          )
        )

        // Filter to active states only, then resolve UUIDs → names
        const activeSet = new Set(activeStateIds)
        return body.results
          .filter((raw) => activeSet.has(raw.state))
          .map((raw) => mapIssue(raw, projectId, stateIdToName))
      })

    // -----------------------------------------------------------------------
    // patchIssue — PATCH /projects/{projectId}/issues/{issueId}/
    // -----------------------------------------------------------------------
    const patchIssue = (
      projectId: string,
      issueId: string,
      patch: IssuePatch
    ): Effect.Effect<PlaneIssue, PlaneApiError> =>
      Effect.gen(function* () {
        const url = `${base}/projects/${projectId}/issues/${issueId}/`

        // Map domain patch shape → API shape
        const body: Record<string, unknown> = {}
        if (patch.state !== undefined) body["state"] = patch.state
        if (patch.assigneeId !== undefined) body["assignee_ids"] = [patch.assigneeId]
        if (patch.description !== undefined) body["description_html"] = patch.description

        const r = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              method: "PATCH",
              headers,
              body: JSON.stringify(body),
            }),
          catch: (cause) =>
            new PlaneApiError({ statusCode: 0, url, cause }),
        })

        if (!r.ok) {
          return yield* Effect.fail(
            new PlaneApiError({ statusCode: r.status, url, cause: `HTTP ${r.status}` })
          )
        }

        const rawJson = yield* Effect.tryPromise({
          try: () => r.json(),
          catch: (cause) =>
            new PlaneApiError({ statusCode: r.status, url, cause }),
        })

        const issue = yield* Schema.decodeUnknown(PlaneIssueApiSchema)(rawJson).pipe(
          Effect.mapError(
            (e) => new PlaneApiError({ statusCode: r.status, url, cause: e })
          )
        )

        // patchIssue doesn't have stateIdToName context — return the raw UUID
        // from the API (caller knows what they patched). If needed, callers can
        // resolve via their project config.
        return mapIssue(issue, projectId, {})
      })

    // -----------------------------------------------------------------------
    // postComment — POST /projects/{projectId}/issues/{issueId}/comments/
    // -----------------------------------------------------------------------
    const postComment = (
      projectId: string,
      issueId: string,
      html: string
    ): Effect.Effect<void, PlaneApiError> =>
      Effect.gen(function* () {
        const url = `${base}/projects/${projectId}/issues/${issueId}/comments/`

        const r = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify({ comment_html: html }),
            }),
          catch: (cause) =>
            new PlaneApiError({ statusCode: 0, url, cause }),
        })

        if (!r.ok) {
          return yield* Effect.fail(
            new PlaneApiError({ statusCode: r.status, url, cause: `HTTP ${r.status}` })
          )
        }

        return
      })

    return PlaneClient.of({ getActiveIssues, patchIssue, postComment })
  })
)

// ---------------------------------------------------------------------------
// Stub layer — kept for backward compat / easy swap-in
// ---------------------------------------------------------------------------

export const PlaneClientStub: Layer.Layer<PlaneClient> = Layer.succeed(
  PlaneClient,
  PlaneClient.of({
    getActiveIssues: (_projectId, _activeStateIds, _stateIdToName) =>
      Effect.logDebug("PlaneClient.getActiveIssues — stub, returning []").pipe(
        Effect.as([])
      ),
    patchIssue: (_projectId, issueId, _patch) =>
      Effect.fail(
        new PlaneApiError({
          statusCode: 501,
          url: `/issues/${issueId}`,
          cause: "PlaneClient not implemented yet",
        })
      ),
    postComment: (_projectId, issueId, _html) =>
      Effect.fail(
        new PlaneApiError({
          statusCode: 501,
          url: `/issues/${issueId}/comments`,
          cause: "PlaneClient not implemented yet",
        })
      ),
  })
)
