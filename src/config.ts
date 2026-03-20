import { Config, Either, Schema } from "effect"

// ---------------------------------------------------------------------------
// All configuration comes from environment variables via the Config module.
// Never use process.env directly — Config integrates with the Layer system
// and makes configuration testable via ConfigProvider.fromMap.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Project config types — defines active states and UUID→name mapping
// per Plane project so the dispatcher can filter + resolve state names.
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  readonly id: string
  readonly activeStateIds: ReadonlyArray<string>
  readonly stateIdToName: Readonly<Record<string, string>>
}

export type ProjectsConfig = ReadonlyArray<ProjectConfig>

// ---------------------------------------------------------------------------
// Runtime schemas for parsing + validating DISPATCHER_PROJECTS_JSON
// ---------------------------------------------------------------------------

const ProjectConfigSchema = Schema.Struct({
  id: Schema.String,
  activeStateIds: Schema.Array(Schema.String),
  stateIdToName: Schema.Record({ key: Schema.String, value: Schema.String }),
})

const ProjectsConfigSchema = Schema.Array(ProjectConfigSchema)

// ---------------------------------------------------------------------------
// Default projects JSON — extracted from memory/plane-dispatcher/config.json.
// Contains STR + ARCH active states. DISPATCHER_PROJECTS_JSON env var can
// override this at runtime without requiring a redeploy.
// ---------------------------------------------------------------------------

const DEFAULT_PROJECTS_JSON: string = JSON.stringify([
  {
    id: "a9ad5d4b-6f28-4334-a46d-dddff4a6d8e4",
    activeStateIds: [
      "d03949ea-05d6-4d98-a8c3-22aed68372c0", // PR Triage
      "c2c4ba94-5acb-46ec-b28f-8d38f8592d9c", // Prepare
      "102028a4-84b1-4a53-a853-55b256d3aa0a", // Test
      "c4c5ed11-df2f-4025-ae63-6e62feac072e", // Review
      "3aedb682-5734-4b2d-af62-7f959f4d4949", // Merge
      "58c77426-05a0-4789-b1ec-5222f370f69e", // Closure
      "9e7d6baa-32da-4ca2-8b33-6189a48a52f6", // Request Changes
      "9cfb5ac6-1816-4e14-880b-2e8501e32d20", // Rebase
    ],
    stateIdToName: {
      "232e6e45-6ed3-4d99-b8f7-919855a1f45d": "Backlog",
      "d03949ea-05d6-4d98-a8c3-22aed68372c0": "PR Triage",
      "c2c4ba94-5acb-46ec-b28f-8d38f8592d9c": "Prepare",
      "102028a4-84b1-4a53-a853-55b256d3aa0a": "Test",
      "c4c5ed11-df2f-4025-ae63-6e62feac072e": "Review",
      "3aedb682-5734-4b2d-af62-7f959f4d4949": "Merge",
      "58c77426-05a0-4789-b1ec-5222f370f69e": "Closure",
      "9e7d6baa-32da-4ca2-8b33-6189a48a52f6": "Request Changes",
      "9cfb5ac6-1816-4e14-880b-2e8501e32d20": "Rebase",
      "d2aa1ea0-a927-4668-81eb-19fc1e3f0eb4": "Waiting",
      "d8b759e9-8bff-4c2d-8979-95f4a44d6cc3": "Done",
      "6a922ec1-1f99-4cf6-9d33-bb61c38f7430": "Cancelled",
      "afa739d4-53cb-4a5d-9873-645d2dfab9c2": "Duplicate",
    },
  },
  {
    id: "b46413da-eb5b-42de-81f4-a801b40ebe02",
    activeStateIds: [
      "4851f395-263e-46de-99f7-b77f6c29a421", // PR Triage
      "5c7df753-2cf3-4bf3-a012-d20dda3b2fb1", // Prepare
      "4f538b4f-94e8-43e2-b1d7-ff5730eca5d2", // Test
      "3261358e-6e5f-4a71-a0ff-bdefa43d2951", // Review
      "593b6056-603c-4f85-94af-7f6620dc41bc", // Merge
      "2e8c9328-d4fb-4a9c-8ca1-dd69e3fee308", // Closure
      "3fae6bfb-93bc-4609-955d-7791bd759574", // Request Changes
      "92488815-879e-4cd7-a313-812ee6d03466", // Rebase
    ],
    stateIdToName: {
      "b4da36e3-0bd3-4d3c-9518-d7de26e462a2": "Backlog",
      "4851f395-263e-46de-99f7-b77f6c29a421": "PR Triage",
      "5c7df753-2cf3-4bf3-a012-d20dda3b2fb1": "Prepare",
      "4f538b4f-94e8-43e2-b1d7-ff5730eca5d2": "Test",
      "3261358e-6e5f-4a71-a0ff-bdefa43d2951": "Review",
      "593b6056-603c-4f85-94af-7f6620dc41bc": "Merge",
      "2e8c9328-d4fb-4a9c-8ca1-dd69e3fee308": "Closure",
      "3fae6bfb-93bc-4609-955d-7791bd759574": "Request Changes",
      "92488815-879e-4cd7-a313-812ee6d03466": "Rebase",
      "b6868076-01f0-4f6f-9b53-fc0f580135f4": "Waiting",
      "cfebc952-9bb9-4ea8-8563-a03c77466b0b": "Done",
      "8b3db507-5c11-41cf-941f-516da915c8b2": "Cancelled",
      "f2186386-0e39-4ced-92d0-b40d44e0e89c": "Duplicate",
    },
  },
] satisfies ProjectsConfig)

export const AppConfig = Config.all({
  openclawGatewayUrl: Config.string("OPENCLAW_GATEWAY_URL").pipe(
    Config.withDefault("http://localhost:18789")
  ),
  openclawGatewayToken: Config.string("OPENCLAW_GATEWAY_TOKEN"),
  dispatcherDbPath: Config.string("DISPATCHER_DB_PATH").pipe(
    Config.withDefault("./dispatcher.db")
  ),
  dispatcherDiscordChannel: Config.string("DISPATCHER_DISCORD_CHANNEL"),
  planeApiKey: Config.string("PLANE_API_KEY"),
  planeUrl: Config.string("PLANE_URL").pipe(
    Config.withDefault("https://plane.svc.dziurzynscy.com/api/v1/workspaces/warsztat")
  ),
  // Projects config with UUID→name mapping. Can be overridden via
  // DISPATCHER_PROJECTS_JSON env var; has a working default baked in.
  projects: Config.string("DISPATCHER_PROJECTS_JSON").pipe(
    Config.withDefault(DEFAULT_PROJECTS_JSON),
    Config.mapOrFail((str) => {
      try {
        const parsed = JSON.parse(str)
        const decoded = Schema.decodeUnknownSync(ProjectsConfigSchema)(parsed)
        return Either.right(decoded)
      } catch (e) {
        return Either.left(new Error(`Invalid DISPATCHER_PROJECTS_JSON: ${String(e)}`))
      }
    })
  ),
})

export type AppConfigShape = Config.Config.Success<typeof AppConfig>
