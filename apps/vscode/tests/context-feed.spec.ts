/**
 * IDE-context feed unit tests: snapshot building (caps, absence), debounced
 * atomic writes, feed removal, and the dispose flush. The vscode-free core
 * runs against an injected writer and timer, so no extension host is needed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildFeed,
  feedFilePath,
  OPEN_FILES_MAX,
  SELECTION_MAX_CHARS,
  VscodeContextFeed,
  writeFeedAtomic,
  type FeedEditor,
} from '../src/context-feed.ts'

let root: string

function editor(path: string, overrides: Partial<FeedEditor> = {}): FeedEditor {
  return {
    path,
    languageId: 'typescript',
    cursor: { line: 3, character: 2 },
    selection: { startLine: 1, endLine: 4, text: 'selected\n' },
    ...overrides,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-vscode-feed-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('buildFeed', () => {
  it('captures workspace, active editor, and open files', () => {
    const feed = buildFeed('/work', editor('/work/src/a.ts'), [editor('/work/src/a.ts'), editor('/work/src/b.ts')])
    expect(feed).toMatchObject({
      version: 1,
      workspace: '/work',
      activeFile: {
        path: '/work/src/a.ts',
        languageId: 'typescript',
        cursor: { line: 3, character: 2 },
        selection: { startLine: 1, endLine: 4, text: 'selected\n' },
      },
      openFiles: ['/work/src/a.ts', '/work/src/b.ts'],
    })
    expect(typeof feed?.updatedAt).toBe('number')
  })

  it('returns undefined without a workspace or an active editor', () => {
    expect(buildFeed(undefined, undefined, [])).toBeUndefined()
    expect(buildFeed('/work', undefined, [])).not.toBeUndefined()
    expect(buildFeed(undefined, editor('/work/a.ts'), [])).not.toBeUndefined()
  })

  it('caps the selection text and the open-file list', () => {
    const feed = buildFeed('/work', editor('/work/a.ts', {
      selection: { startLine: 1, endLine: 2, text: 'x'.repeat(SELECTION_MAX_CHARS + 50) },
    }), Array.from({ length: OPEN_FILES_MAX + 5 }, (_, i) => editor(`/work/f${i}.ts`)))
    expect(feed?.activeFile?.selection?.text).toHaveLength(SELECTION_MAX_CHARS)
    expect(feed?.openFiles).toHaveLength(OPEN_FILES_MAX)
  })
})

describe('VscodeContextFeed', () => {
  it('writes the latest snapshot atomically after the debounce window', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const feed = new VscodeContextFeed({
      home: root,
      debounceMs: 200,
      write: (path, content) => { writes.push(`${path} ${content}`) },
    })
    const first = buildFeed('/work', editor('/work/a.ts'), [])
    const second = buildFeed('/work', editor('/work/b.ts'), [])
    if (first === undefined || second === undefined) throw new Error('feed building failed')
    feed.schedule(first)
    feed.schedule(second)
    expect(writes).toHaveLength(0)
    vi.advanceTimersByTime(200)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(feedFilePath(root))
    expect(writes[0]).toContain('/work/b.ts')
  })

  it('removes the feed when nothing is left to report and flushes on dispose', () => {
    vi.useFakeTimers()
    const removed: string[] = []
    const feed = new VscodeContextFeed({
      home: root,
      debounceMs: 200,
      remove: (path) => { removed.push(path) },
    })
    feed.schedule(undefined)
    vi.advanceTimersByTime(200)
    expect(removed).toEqual([feedFilePath(root)])

    // A pending write flushes immediately on dispose.
    const writes: string[] = []
    const pending = new VscodeContextFeed({
      home: root,
      debounceMs: 200,
      write: (_path, content) => { writes.push(content) },
    })
    const snapshot = buildFeed('/work', editor('/work/a.ts'), [])
    if (snapshot === undefined) throw new Error('feed building failed')
    pending.schedule(snapshot)
    pending.dispose()
    expect(writes).toHaveLength(1)
  })

  it('writes atomically through the default writer', () => {
    const path = feedFilePath(root)
    writeFeedAtomic(path, '{"version":1}')
    expect(readFileSync(path, 'utf8')).toBe('{"version":1}')
  })
})
