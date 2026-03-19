import { Context, Effect, Layer } from "effect"
import { PlaneApiError } from "./errors.js"

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
  readonly getActiveIssues: (projectId: string) => Effect.Effect<ReadonlyArray<PlaneIssue>, PlaneApiError>
  readonly patchIssue: (projectId: string, issueId: string, patch: IssuePatch) => Effect.Effect<PlaneIssue, PlaneApiError>
  readonly postComment: (projectId: string, issueId: string, html: string) => Effect.Effect<void, PlaneApiError>
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

export const PlaneClient = Context.GenericTag<PlaneClient>("PlaneClient")

// ---------------------------------------------------------------------------
// Stub live layer — real HTTP not wired yet; returns empty arrays
// Real implementation will read PLANE_API_KEY + PLANE_URL from config
// ---------------------------------------------------------------------------

export const PlaneClientStub: Layer.Layer<PlaneClient> = Layer.succeed(
  PlaneClient,
  PlaneClient.of({
    getActiveIssues: (_projectId) =>
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
