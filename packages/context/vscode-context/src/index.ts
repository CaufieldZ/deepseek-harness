/**
 * Opt-in request-preparation IDE context: the workspace, active editor, and
 * selection the VS Code extension host maintains in a state file. Eligible
 * step attempts append durable, source-attributed context naming the active
 * file and selection, so the agent reasons about what the user is looking at.
 *
 * The plugin reads `$DSH_HOME/vscode/context.json` once per turn, for the
 * first request (`step === 1`), and re-injects only when the rendered editor
 * state changed since the last durable injection (the user switched files or
 * moved the selection), with an optional `refreshIntervalMs` floor between
 * injections. An absent file (the extension is not running or no editor is
 * open), an unreadable file, or a malformed feed is a no-op, never an error:
 * a parse failure is contained and logged as a warning so the turn continues.
 *
 * @module @deepseek-ai/dsh-vscode-context
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vscode-context'

/** The agent registry that owns pre-step processing. */
export const inject = ['agents']

/** Per-turn IDE-context scheduling. Invalid values fail plugin load. */
export interface Config {
  /** Absolute path of the feed file the extension host maintains; defaults to `$DSH_HOME/vscode/context.json`. */
  feedPath?: string
  /** Minimum milliseconds between durable injections in one session. Omit or set to 0 to inject on every eligible change. */
  refreshIntervalMs?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  feedPath: z.string(),
  refreshIntervalMs: z.number(),
})

/** Feed file version this plugin reads; the writer bumps it on incompatible changes. */
export const FEED_VERSION = 1

/** The feed file's location under the Harness home. */
export const FEED_FILENAME = 'context.json'

/** One cursor position from the feed (1-based line/character, VS Code convention). */
export interface FeedCursor {
  line: number
  character: number
}

/** One text selection from the feed, with its 1-based line range. */
export interface FeedSelection {
  startLine: number
  endLine: number
  text: string
}

/** The active editor the extension host describes. */
export interface FeedActiveFile {
  path: string
  languageId?: string
  cursor?: FeedCursor
  selection?: FeedSelection
}

/** The feed document the extension host maintains. */
export interface VscodeFeed {
  version: number
  /** Epoch milliseconds of the extension host's snapshot. */
  updatedAt: number
  workspace?: string
  activeFile?: FeedActiveFile
  openFiles?: string[]
}

/**
 * Resolve the default feed path for one Harness home.
 * @param home - the harness home; defaults to {@link resolveDshHome}'s resolution.
 * @returns `<home>/vscode/context.json`.
 */
export function defaultFeedPath(home?: string): string {
  return join(home ?? resolveDshHome(), 'vscode', FEED_FILENAME)
}

/** Prefix marking the volatile turn/step preamble line of a rendered reading. */
const READING_PREFIX = 'vscode context (turn '

/** Failures that mean "no feed yet" versus a malformed one; only the latter warns. */
function readFeed(raw: string): VscodeFeed | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  return parseFeed(parsed)
}

/**
 * Narrow a parsed-JSON value to the feed.
 * @param value - the parsed document from the feed file.
 * @returns the validated feed, or undefined on any malformed field.
 */
export function parseFeed(value: unknown): VscodeFeed | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const feed = value as Record<string, unknown>
  if (feed.version !== FEED_VERSION) return undefined
  if (typeof feed.updatedAt !== 'number' || !Number.isFinite(feed.updatedAt)) return undefined
  const result: VscodeFeed = { version: FEED_VERSION, updatedAt: feed.updatedAt }
  if (feed.workspace !== undefined) {
    if (typeof feed.workspace !== 'string' || feed.workspace === '') return undefined
    result.workspace = feed.workspace
  }
  const activeFile = feed.activeFile
  if (activeFile !== undefined) {
    if (typeof activeFile !== 'object' || activeFile === null || Array.isArray(activeFile)) return undefined
    const file = activeFile as Record<string, unknown>
    if (typeof file.path !== 'string' || file.path === '') return undefined
    const parsedFile: FeedActiveFile = { path: file.path }
    if (file.languageId !== undefined) {
      if (typeof file.languageId !== 'string') return undefined
      parsedFile.languageId = file.languageId
    }
    const cursor = parseCursor(file.cursor)
    if (cursor === null) return undefined
    if (cursor !== undefined) parsedFile.cursor = cursor
    const selection = parseSelection(file.selection)
    if (selection === null) return undefined
    if (selection !== undefined) parsedFile.selection = selection
    result.activeFile = parsedFile
  }
  const openFiles = feed.openFiles
  if (openFiles !== undefined) {
    if (!Array.isArray(openFiles)) return undefined
    const paths = openFiles.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    if (paths.length !== openFiles.length) return undefined
    result.openFiles = paths
  }
  return result
}

/** Narrow one cursor; null distinguishes "present but malformed" from "absent". */
function parseCursor(value: unknown): FeedCursor | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) return null
  const cursor = value as Record<string, unknown>
  if (typeof cursor.line !== 'number' || typeof cursor.character !== 'number') return null
  if (!Number.isSafeInteger(cursor.line) || cursor.line < 1) return null
  if (!Number.isSafeInteger(cursor.character) || cursor.character < 1) return null
  return { line: cursor.line, character: cursor.character }
}

/** Narrow one selection; null distinguishes "present but malformed" from "absent". */
function parseSelection(value: unknown): FeedSelection | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) return null
  const selection = value as Record<string, unknown>
  if (typeof selection.startLine !== 'number' || typeof selection.endLine !== 'number') return null
  if (typeof selection.text !== 'string') return null
  if (!Number.isSafeInteger(selection.startLine) || !Number.isSafeInteger(selection.endLine)) return null
  if (selection.startLine < 1 || selection.endLine < selection.startLine) return null
  return { startLine: selection.startLine, endLine: selection.endLine, text: selection.text }
}

/**
 * Render the stable IDE-state block: the part of a reading compared for
 * change suppression. It excludes the turn preamble so re-injection is driven
 * only by editor state, not by loop position.
 */
function renderState(feed: VscodeFeed): string {
  const lines: string[] = []
  if (feed.workspace !== undefined) lines.push(`workspace ${feed.workspace}`)
  if (feed.activeFile !== undefined) {
    const file = feed.activeFile
    const cursor = file.cursor === undefined ? '' : `, cursor ${file.cursor.line}:${file.cursor.character}`
    const selection = file.selection === undefined
      ? ''
      : `, selection lines ${file.selection.startLine}-${file.selection.endLine}:`
    lines.push(`active file ${file.path}${cursor}${selection}`)
    if (file.selection !== undefined) {
      // A whole-line selection commonly carries its trailing newline; trim it
      // so the reading stays compact and the state comparison is stable.
      const selectionText = file.selection.text.trimEnd()
      if (selectionText !== '') lines.push(selectionText)
    }
  }
  if (feed.openFiles !== undefined && feed.openFiles.length > 0) {
    lines.push(`open files (${feed.openFiles.length}): ${feed.openFiles.join(', ')}`)
  }
  return lines.join('\n')
}

/** Render the full durable reading, including the volatile turn preamble. */
function renderReading(feed: VscodeFeed, turn: number): string {
  return `${READING_PREFIX}${turn}):\n${renderState(feed)}`
}

/**
 * The stable state block of this plugin's latest durable injection, or
 * `undefined` when the session has none. Scans raw durable events so the
 * schedule survives compaction and resumed processes without process-local
 * cache state.
 */
function latestInjectedState(agent: Agent): { state: string; time: number } | undefined {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === name) {
      const [block] = event.data.content
      if (block?.type !== 'text') return undefined
      const newline = block.text.indexOf('\n')
      const state = newline === -1 ? '' : block.text.slice(newline + 1)
      return { state, time: event.time }
    }
  }
  return undefined
}

/** Reject refresh intervals that cannot represent an exact elapsed-millisecond threshold. */
function validateRefreshInterval(refreshIntervalMs: number | undefined): void {
  if (refreshIntervalMs !== undefined && (
    !Number.isSafeInteger(refreshIntervalMs)
    || refreshIntervalMs < 0
  )) {
    throw new TypeError(
      `vscode-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`,
    )
  }
}

/** Read the feed file once, containing every failure mode as "no feed". */
async function loadFeed(feedPath: string, warn: (message: string) => void): Promise<VscodeFeed | undefined> {
  let raw: string
  try {
    raw = await readFile(feedPath, 'utf8')
  } catch {
    // ENOENT (the extension is not running or no editor is open yet) and any
    // other read failure are the same optional-context case: inject nothing.
    return undefined
  }
  const feed = readFeed(raw)
  if (feed === undefined) {
    warn(`vscode-context: ${feedPath} is not a valid feed; injecting no context this turn`)
    return undefined
  }
  return feed
}

/**
 * Register a prepended pre-step listener for the lifetime of `ctx`.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - durable refresh scheduling and feed location configuration.
 * @throws when the refresh interval is invalid.
 */
export function apply(ctx: Context, config: Config): void {
  const refreshIntervalMs = config.refreshIntervalMs
  validateRefreshInterval(refreshIntervalMs)
  const feedPath = config.feedPath ?? defaultFeedPath()

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision
    const previous = latestInjectedState(agent)
    if (refreshIntervalMs !== undefined && refreshIntervalMs > 0 && previous !== undefined) {
      const now = Date.now()
      if (now >= previous.time && now - previous.time < refreshIntervalMs) return decision
    }
    const feed = await loadFeed(feedPath, (message) => { ctx.logger.warn(message) })
    if (feed === undefined) return decision
    const state = renderState(feed)
    if (previous !== undefined && previous.state === state) return decision
    const text = renderReading(feed, turn)
    return {
      kind: 'enter',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }),
        ...decision.messages,
      ],
    }
  }, { prepend: true })
}
