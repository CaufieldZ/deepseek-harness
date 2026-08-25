/**
 * Extension settings and credential assembly, separated from vscode so the
 * parsing and environment construction stay unit-testable without the
 * extension host. extension.ts binds the vscode configuration and
 * SecretStorage to these shapes.
 */
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { INITIAL_PRESETS, isInitialPermissionMode, type PermissionPreset } from './permission-mode.ts'

/** Raw configuration reader shape (vscode.WorkspaceConfiguration satisfies it). */
export interface ConfigurationReader {
  get<T>(section: string, defaultValue: T): T | undefined
}

/** The resolved extension settings. */
export interface DshSettings {
  /** Command spawned as the harness child: a PATH bin or an absolute script path. */
  command: string
  /** Profile the child boots; `vscode` ships with the IDE-context bundle, `web` is the plain browser surface. */
  profile: string
  /** Optional Node executable used to launch `command`; undefined spawns it directly. */
  node: string | undefined
  /** Optional DSH_HOME override for the child; undefined inherits the child default. */
  home: string | undefined
  /** Milliseconds to wait for the child's ready line before killing it. */
  spawnTimeoutMs: number
  /** Extra environment entries for the child, merged after the credential entry. */
  extraEnv: Record<string, string>
  /** The permission preset the child starts from (new-session default). */
  initialPreset: PermissionPreset
}

/** Secret-storage key holding the DeepSeek API key. */
export const API_KEY_STORAGE_KEY = 'deepseek.apiKey'

/** Resolve settings from a configuration reader, applying the shipped defaults. */
export function parseSettings(reader: ConfigurationReader): DshSettings {
  const node = reader.get<string>('node', '')
  const home = reader.get<string>('home', '')
  const initial = reader.get<unknown>('initialPermissionMode', 'manual')
  return {
    command: reader.get<string>('command', 'dsh') ?? 'dsh',
    profile: reader.get<string>('profile', 'vscode') ?? 'vscode',
    node: node === '' ? undefined : node,
    home: home === '' ? undefined : home,
    spawnTimeoutMs: reader.get<number>('spawnTimeoutMs', 30_000) ?? 30_000,
    extraEnv: reader.get<Record<string, string>>('extraEnv', {}) ?? {},
    initialPreset: isInitialPermissionMode(initial) ? INITIAL_PRESETS[initial] : 'read-only',
  }
}

/**
 * Child environment: scrubbed parent env plus the explicit credential and
 * deployment entries. DEEPSEEK_API_KEY is re-added because scrubbedParentEnv
 * strips every DSH_* name and every credential-looking name.
 */
export function buildChildEnv(settings: DshSettings, apiKey: string): Record<string, string> {
  const env = scrubbedParentEnv()
  env.DEEPSEEK_API_KEY = apiKey
  if (settings.home !== undefined) env.DSH_HOME = settings.home
  Object.assign(env, settings.extraEnv)
  return env
}

/** The child argv after the launcher's own flags: profile plus the headless web switches. */
export function buildChildArgs(settings: DshSettings): string[] {
  return ['--profile', settings.profile, '--no-open', '--port', '0']
}

/** Spawn command split, honoring the optional Node launcher. */
export function buildChildCommand(settings: DshSettings): { command: string; args: string[] } {
  const args = buildChildArgs(settings)
  if (settings.node === undefined) return { command: settings.command, args }
  return { command: settings.node, args: [settings.command, ...args] }
}

/**
 * The DeepSeek key a P0 `acp.agents` configuration may carry in plaintext
 * (`acp.agents.<name>.env.DEEPSEEK_API_KEY`); undefined when absent. Read as
 * one-shot import for users migrating from the generic ACP client.
 */
export function extractAcpApiKey(acpAgents: unknown): string | undefined {
  if (typeof acpAgents !== 'object' || acpAgents === null) return undefined
  for (const agent of Object.values(acpAgents)) {
    if (typeof agent !== 'object' || agent === null) continue
    const env = (agent as { env?: unknown }).env
    if (typeof env !== 'object' || env === null) continue
    const key = (env as Record<string, unknown>).DEEPSEEK_API_KEY
    if (typeof key === 'string' && key !== '') return key
  }
  return undefined
}
