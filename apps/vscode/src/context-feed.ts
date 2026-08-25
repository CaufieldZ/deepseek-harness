/**
 * The IDE-context feed: debounced atomic snapshots of the visible editor
 * state into `$DSH_HOME/vscode/context.json`, consumed by the harness child's
 * vscode-context plugin. The feed is a state file by design — the child reads
 * it during request preparation, so no wire change carries editor state.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { VscodeFeed } from '@deepseek-ai/dsh-vscode-context'

/** Debounce window for feed writes after editor-state churn. */
const FEED_DEBOUNCE_MS = 200

/** Selection-text cap: the model sees at most this many characters of the selection. */
export const SELECTION_MAX_CHARS = 4_000

/** Open-file list cap: the feed names at most this many visible editors. */
export const OPEN_FILES_MAX = 20

/** The narrow editor surface a snapshot captures from (vscode-free for unit tests). */
export interface FeedEditor {
  /** Absolute file path. */
  path: string
  languageId: string
  cursor: { line: number; character: number }
  selection: { startLine: number; endLine: number; text: string }
}

/**
 * Build one feed document from the live editor surface. Pure and capped: the
 * selection text and the open-file list are bounded here so the writer never
 * depends on capture-side discipline.
 * @param workspaceRoot - the first workspace folder path, when one is open.
 * @param active - the active editor snapshot, when an editor is focused.
 * @param open - the visible editors, in tab order.
 * @returns the feed, or undefined when there is nothing to report (no
 * workspace and no active editor).
 */
export function buildFeed(
  workspaceRoot: string | undefined,
  active: FeedEditor | undefined,
  open: readonly FeedEditor[],
): VscodeFeed | undefined {
  if (workspaceRoot === undefined && active === undefined) return undefined
  const feed: VscodeFeed = { version: 1, updatedAt: Date.now() }
  if (workspaceRoot !== undefined) feed.workspace = workspaceRoot
  if (active !== undefined) {
    feed.activeFile = {
      path: active.path,
      languageId: active.languageId,
      cursor: active.cursor,
      selection: {
        startLine: active.selection.startLine,
        endLine: active.selection.endLine,
        text: active.selection.text.slice(0, SELECTION_MAX_CHARS),
      },
    }
  }
  if (open.length > 0) {
    feed.openFiles = open.slice(0, OPEN_FILES_MAX).map(editor => editor.path)
  }
  return feed
}

/** The feed file inside one harness home. */
export function feedFilePath(home: string): string {
  return join(home, 'vscode', 'context.json')
}

/** Atomic feed writes: temp file plus rename, so the child never reads a torn document. */
export function writeFeedAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, path)
}

export interface VscodeContextFeedOptions {
  /** The resolved harness home the `vscode/` directory lives under. */
  home: string
  /** Debounce window in milliseconds; defaults to {@link FEED_DEBOUNCE_MS}. */
  debounceMs?: number
  /** Write hook for tests; defaults to {@link writeFeedAtomic}. */
  write?: (path: string, content: string) => void
  /** Removal hook for tests; defaults to best-effort `rmSync`. */
  remove?: (path: string) => void
  /** Timer hook for tests; defaults to the global timers. */
  scheduleTimer?: (callback: () => void, delayMs: number) => { clear(): void }
}

/**
 * Owns the feed lifecycle: debounced writes of the latest snapshot, removal
 * when nothing is left to report, and a dispose flush.
 */
export class VscodeContextFeed {
  private timer: { clear(): void } | undefined
  private pending: VscodeFeed | undefined

  private readonly debounceMs: number
  private readonly write: (path: string, content: string) => void
  private readonly remove: (path: string) => void
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => { clear(): void }

  constructor(private readonly options: VscodeContextFeedOptions) {
    this.debounceMs = options.debounceMs ?? FEED_DEBOUNCE_MS
    this.write = options.write ?? writeFeedAtomic
    this.remove = options.remove ?? ((path) => { rmSync(path, { force: true }) })
    this.scheduleTimer = options.scheduleTimer ?? ((callback, delayMs) => {
      const handle = setTimeout(callback, delayMs)
      return { clear: () => { clearTimeout(handle) } }
    })
  }

  /**
   * Stage the latest snapshot for a debounced write; `undefined` removes the
   * feed file so the child stops injecting once nothing is left to report.
   * @param feed - the snapshot to persist, or undefined to clear the feed.
   */
  schedule(feed: VscodeFeed | undefined): void {
    this.pending = feed
    if (this.timer !== undefined) return
    this.timer = this.scheduleTimer(() => { this.flush() }, this.debounceMs)
  }

  /** Write (or clear) the pending snapshot immediately. */
  flush(): void {
    if (this.timer !== undefined) {
      this.timer.clear()
      this.timer = undefined
    }
    const path = feedFilePath(this.options.home)
    if (this.pending === undefined) {
      this.remove(path)
      return
    }
    this.write(path, JSON.stringify(this.pending))
  }

  /** Flush the pending snapshot and stop the timer. */
  dispose(): void {
    this.flush()
  }
}
