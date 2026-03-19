import { Config } from "effect"

// ---------------------------------------------------------------------------
// All configuration comes from environment variables via the Config module.
// Never use process.env directly — Config integrates with the Layer system
// and makes configuration testable via ConfigProvider.fromMap.
// ---------------------------------------------------------------------------

export const AppConfig = Config.all({
  openclawGatewayUrl: Config.string("OPENCLAW_GATEWAY_URL").pipe(
    Config.withDefault("http://localhost:18789")
  ),
  openclawGatewayToken: Config.string("OPENCLAW_GATEWAY_TOKEN"),
  dispatcherDbPath: Config.string("DISPATCHER_DB_PATH").pipe(
    Config.withDefault("./dispatcher.db")
  ),
  dispatcherDiscordChannel: Config.string("DISPATCHER_DISCORD_CHANNEL"),
})

export type AppConfigShape = Config.Config.Success<typeof AppConfig>
