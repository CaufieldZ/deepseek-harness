/**
 * Permission-mode read side: folds the session-log events that switch the
 * sandbox mode (`sandbox/mode`, `permission/preset`) into the preset shown on
 * the status-bar badge. The harness owns every mode — `read-only` (Manual),
 * `workspace-write` (Auto), `danger-full-access` (Full Access) — and the
 * `/permission` write path; the extension only projects the latest state,
 * maps the Claude-Code-style labels, and toggles. Mux frames carry wide event
 * data on the wire, so the fold narrows every field before trusting it.
 */

/** The shipped permission presets; the base bundle's patch table owns these names. */
export const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** One switchable permission preset name. */
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

/** Badge chrome per preset: the codicon and the Claude-Code-style label. */
export const PRESET_LABELS: Record<PermissionPreset, { icon: string; label: string }> = {
  'read-only': { icon: '$(shield)', label: 'Manual' },
  'workspace-write': { icon: '$(zap)', label: 'Auto' },
  'danger-full-access': { icon: '$(warning)', label: 'Full Access' },
}

/** The VSCode setting values, mapped onto the preset names the harness advertises. */
export type InitialPermissionMode = 'manual' | 'auto' | 'fullAccess'

/** Setting → preset mapping (`dsh.initialPermissionMode`). */
export const INITIAL_PRESETS: Record<InitialPermissionMode, PermissionPreset> = {
  manual: 'read-only',
  auto: 'workspace-write',
  fullAccess: 'danger-full-access',
}

/** Whether one unknown setting value is a valid initial permission mode. */
export function isInitialPermissionMode(value: unknown): value is InitialPermissionMode {
  return value === 'manual' || value === 'auto' || value === 'fullAccess'
}

/** Whether one unknown wire value is a shipped preset name. */
export function isPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && (PERMISSION_PRESETS as readonly string[]).includes(value)
}

/** The wire envelope of one session event (the wide-data passthrough the mux carries). */
export interface WireSessionEvent {
  type: string
  data: unknown
}

/**
 * Narrow one event to the preset it switches to, or undefined when the event
 * is not a mode event or its data is malformed (a wire value the fold must
 * never trust).
 * @param event - one session event off the mux stream.
 * @returns the switched-to preset, or undefined.
 */
export function presetOfEvent(event: WireSessionEvent): PermissionPreset | undefined {
  if (event.type === 'permission/preset') {
    const data = event.data as { preset?: unknown } | null | undefined
    return isPreset(data?.preset) ? data.preset : undefined
  }
  if (event.type === 'sandbox/mode') {
    const data = event.data as { mode?: unknown } | null | undefined
    return isPreset(data?.mode) ? data.mode : undefined
  }
  return undefined
}

/**
 * Fold a session's events in log order to its latest known preset.
 * @param events - session events in log order (other event types are skipped).
 * @returns the preset of the last mode event, or undefined without one.
 */
export function latestPreset(events: readonly WireSessionEvent[]): PermissionPreset | undefined {
  let result: PermissionPreset | undefined
  for (const event of events) {
    const preset = presetOfEvent(event)
    if (preset !== undefined) result = preset
  }
  return result
}

/**
 * The toggle target of the badge click: Auto ↔ Manual. Every other state
 * (an unknown preset or Full Access) leaves the loop through Manual.
 * @param preset - the current preset, or undefined when no mode event arrived yet.
 * @returns the preset the badge click switches to.
 */
export function toggledPreset(preset: PermissionPreset | undefined): PermissionPreset {
  return preset === 'read-only' ? 'workspace-write' : 'read-only'
}

/** Client-side face of the permission apply path (settings default + per-session command). */
export interface PermissionClient {
  /** Set the new-session default preset through the settings namespace. */
  setDefaultPreset(preset: PermissionPreset): Promise<void>
  /** Execute one slash-command line in one session. */
  executeCommand(sessionId: string, line: string): Promise<void>
}

/**
 * Switch one preset: the new-session default first, then every open session.
 * A session's switch rides the `/permission` command — the harness's one
 * write path, which records `permission/preset` and `sandbox/mode` events.
 * @param client - the API client face.
 * @param sessionIds - the open panel sessions to switch.
 * @param preset - the preset every call targets.
 */
export async function applyPreset(client: PermissionClient, sessionIds: readonly string[], preset: PermissionPreset): Promise<void> {
  await client.setDefaultPreset(preset)
  for (const sessionId of sessionIds) {
    await client.executeCommand(sessionId, `/permission ${preset}`)
  }
}
