/**
 * Config entrypoint — re-exports the split config system
 * for backward compatibility.
 */

export {
  type JarvisConfig,
  type AgentDefaultsConfig,
  type ProvidersConfig,
  type ProviderConfig,
  type ToolsConfig,
  type WebToolsConfig,
  type ExecToolConfig,
  type MyToolConfig,
  type MCPServerConfig,
  type ChannelCommonConfig,
  type DreamConfig,
  type ApiConfig,
  type GatewayConfig,
  type HeartbeatConfig,
  type WebSearchConfig,
  DEFAULTS,
} from './config/schema'

export { loadConfig, saveConfig, setConfigPath, getConfigPath } from './config/loader'
export {
  getDataDir,
  getRuntimeSubdir,
  getMediaDir,
  getCronDir,
  getLogsDir,
  getWorkspacePath,
} from './config/paths'
