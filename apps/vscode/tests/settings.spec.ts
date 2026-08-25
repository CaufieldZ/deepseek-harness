import { afterEach, describe, expect, it } from 'vitest'
import {
  buildChildArgs,
  buildChildCommand,
  buildChildEnv,
  extractAcpApiKey,
  parseSettings,
  type ConfigurationReader,
  type DshSettings,
} from '../src/settings.ts'

function reader(overrides: Record<string, unknown>): ConfigurationReader {
  return {
    get: (section, defaultValue) => (section in overrides ? overrides[section] as typeof defaultValue : defaultValue),
  }
}

describe('parseSettings', () => {
  it('applies shipped defaults', () => {
    const settings = parseSettings(reader({}))
    expect(settings).toEqual({
      command: 'dsh',
      profile: 'vscode',
      node: undefined,
      home: undefined,
      spawnTimeoutMs: 30_000,
      extraEnv: {},
      initialPreset: 'read-only',
    })
  })

  it('honors explicit values and treats empty launcher strings as unset', () => {
    const settings = parseSettings(reader({ command: '/x/bin.js', node: '', home: '', extraEnv: { A: '1' } }))
    expect(settings.command).toBe('/x/bin.js')
    expect(settings.node).toBeUndefined()
    expect(settings.home).toBeUndefined()
    expect(settings.extraEnv).toEqual({ A: '1' })
  })

  it('maps the initial permission mode onto its preset and falls back on unknown values', () => {
    expect(parseSettings(reader({ initialPermissionMode: 'auto' })).initialPreset).toBe('workspace-write')
    expect(parseSettings(reader({ initialPermissionMode: 'fullAccess' })).initialPreset).toBe('danger-full-access')
    expect(parseSettings(reader({ initialPermissionMode: 'full-access' })).initialPreset).toBe('read-only')
    expect(parseSettings(reader({ initialPermissionMode: 3 })).initialPreset).toBe('read-only')
  })
})

describe('buildChildEnv', () => {
  afterEach(() => {
    delete process.env.DSH_FAKE_TEST
    delete process.env.FAKE_SECRET_TOKEN
  })

  it('scrubs DSH_* and credential-looking parent entries and adds the key', () => {
    process.env.DSH_FAKE_TEST = 'parent'
    process.env.FAKE_SECRET_TOKEN = 'parent'
    const env = buildChildEnv({ command: 'dsh', profile: 'web', node: undefined, home: undefined, spawnTimeoutMs: 1, extraEnv: {}, initialPreset: 'read-only' }, 'sk-child')
    expect(env.DEEPSEEK_API_KEY).toBe('sk-child')
    expect(env.DSH_FAKE_TEST).toBeUndefined()
    expect(env.FAKE_SECRET_TOKEN).toBeUndefined()
  })

  it('sets DSH_HOME from settings and merges extra env last', () => {
    const env = buildChildEnv({
      command: 'dsh',
      profile: 'web',
      node: undefined,
      home: '/tmp/dsh-home',
      spawnTimeoutMs: 1,
      extraEnv: { DEEPSEEK_BASE_URL: 'https://example.invalid' },
      initialPreset: 'read-only',
    }, 'sk-child')
    expect(env.DSH_HOME).toBe('/tmp/dsh-home')
    expect(env.DEEPSEEK_BASE_URL).toBe('https://example.invalid')
  })
})

describe('buildChildCommand', () => {
  const base = { command: 'dsh', profile: 'web', node: undefined, home: undefined, spawnTimeoutMs: 1, extraEnv: {}, initialPreset: 'read-only' } satisfies DshSettings

  it('spawns the command directly without a node launcher', () => {
    expect(buildChildCommand(base)).toEqual({ command: 'dsh', args: ['--profile', 'web', '--no-open', '--port', '0'] })
  })

  it('routes through the configured Node executable when set', () => {
    expect(buildChildCommand({ ...base, node: 'node' })).toEqual({
      command: 'node',
      args: ['dsh', '--profile', 'web', '--no-open', '--port', '0'],
    })
  })
})

describe('buildChildArgs', () => {
  it('forwards the profile and the headless web switches', () => {
    expect(buildChildArgs({ command: 'dsh', profile: 'web', node: undefined, home: undefined, spawnTimeoutMs: 1, extraEnv: {}, initialPreset: 'read-only' }))
      .toEqual(['--profile', 'web', '--no-open', '--port', '0'])
  })
})

describe('extractAcpApiKey', () => {
  it('finds the key inside an acp.agents entry', () => {
    const agents = { dsh: { command: 'node', args: [], env: { DEEPSEEK_API_KEY: 'sk-acp' } } }
    expect(extractAcpApiKey(agents)).toBe('sk-acp')
  })

  it('returns undefined for empty, malformed, or missing configurations', () => {
    expect(extractAcpApiKey(undefined)).toBeUndefined()
    expect(extractAcpApiKey('dsh')).toBeUndefined()
    expect(extractAcpApiKey({ dsh: { env: {} } })).toBeUndefined()
    expect(extractAcpApiKey({ dsh: { env: { DEEPSEEK_API_KEY: '' } } })).toBeUndefined()
  })
})
