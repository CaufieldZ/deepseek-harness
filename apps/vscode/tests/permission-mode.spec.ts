// Permission-mode read side: the fold narrows wire events field by field,
// malformed mode data never reaches a preset, the toggle loops Auto↔Manual
// with every other state leaving through Manual, and the apply path writes
// the new-session default before switching every open session.

import { describe, expect, it, vi } from 'vitest'
import {
  applyPreset, INITIAL_PRESETS, isInitialPermissionMode, isPreset, latestPreset,
  PERMISSION_PRESETS, PRESET_LABELS, presetOfEvent, toggledPreset,
  type PermissionClient, type WireSessionEvent,
} from '../src/permission-mode.ts'

const event = (type: string, data: unknown): WireSessionEvent => ({ type, data })

describe('presetOfEvent', () => {
  it('narrows permission/preset and sandbox/mode events to their preset', () => {
    expect(presetOfEvent(event('permission/preset', { preset: 'workspace-write' }))).toBe('workspace-write')
    expect(presetOfEvent(event('sandbox/mode', { mode: 'danger-full-access' }))).toBe('danger-full-access')
  })

  it('rejects malformed wire data', () => {
    expect(presetOfEvent(event('permission/preset', { preset: 'forged' }))).toBeUndefined()
    expect(presetOfEvent(event('permission/preset', { preset: 7 }))).toBeUndefined()
    expect(presetOfEvent(event('permission/preset', null))).toBeUndefined()
    expect(presetOfEvent(event('sandbox/mode', { mode: 'read-only-ish' }))).toBeUndefined()
    expect(presetOfEvent(event('sandbox/mode', {}))).toBeUndefined()
    expect(presetOfEvent(event('user/message', { preset: 'read-only' }))).toBeUndefined()
  })
})

describe('latestPreset', () => {
  it('folds to the last mode event, skipping unrelated and malformed ones', () => {
    expect(latestPreset([
      event('sandbox/mode', { mode: 'workspace-write' }),
      event('user/message', { text: 'hi' }),
      event('permission/preset', { preset: 'bogus' }),
      event('sandbox/mode', { mode: 'read-only' }),
    ])).toBe('read-only')
  })

  it('returns undefined without a mode event', () => {
    expect(latestPreset([])).toBeUndefined()
    expect(latestPreset([event('user/message', {})])).toBeUndefined()
  })
})

describe('toggledPreset', () => {
  it('loops Auto↔Manual and leaves every other state through Manual', () => {
    expect(toggledPreset('workspace-write')).toBe('read-only')
    expect(toggledPreset('read-only')).toBe('workspace-write')
    expect(toggledPreset('danger-full-access')).toBe('read-only')
    expect(toggledPreset(undefined)).toBe('read-only')
  })
})

describe('initial mode mapping', () => {
  it('maps the setting values onto the shipped presets', () => {
    expect(INITIAL_PRESETS.manual).toBe('read-only')
    expect(INITIAL_PRESETS.auto).toBe('workspace-write')
    expect(INITIAL_PRESETS.fullAccess).toBe('danger-full-access')
  })

  it('narrows unknown setting values', () => {
    expect(isInitialPermissionMode('manual')).toBe(true)
    expect(isInitialPermissionMode('auto')).toBe(true)
    expect(isInitialPermissionMode('fullAccess')).toBe(true)
    expect(isInitialPermissionMode('full-access')).toBe(false)
    expect(isInitialPermissionMode(3)).toBe(false)
    expect(isInitialPermissionMode(undefined)).toBe(false)
  })

  it('keeps the preset table and the labels in step', () => {
    expect(Object.keys(PRESET_LABELS)).toEqual([...PERMISSION_PRESETS])
    expect(isPreset('read-only')).toBe(true)
    expect(isPreset('nope')).toBe(false)
    expect(isPreset(1)).toBe(false)
  })
})

describe('applyPreset', () => {
  it('sets the new-session default before switching every open session', async () => {
    const calls: string[] = []
    const client: PermissionClient = {
      setDefaultPreset: async (preset) => { calls.push(`default:${preset}`) },
      executeCommand: async (sessionId, line) => { calls.push(`${sessionId}:${line}`) },
    }
    await applyPreset(client, ['s1', 's2'], 'read-only')
    expect(calls).toEqual(['default:read-only', 's1:/permission read-only', 's2:/permission read-only'])
  })

  it('propagates a failing default write instead of touching sessions', async () => {
    const executeCommand = vi.fn(async () => {})
    const client: PermissionClient = {
      setDefaultPreset: async () => { throw new Error('child is not ready') },
      executeCommand,
    }
    await expect(applyPreset(client, ['s1'], 'read-only')).rejects.toThrow('child is not ready')
    expect(executeCommand).not.toHaveBeenCalled()
  })
})
