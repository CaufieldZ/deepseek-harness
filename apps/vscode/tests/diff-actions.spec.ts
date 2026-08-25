// Host-local diff actions over a minimal mocked vscode surface: apply syncs
// open editors and writes unopened files, dirty or diverged buffers skip
// with a reason instead of destroying user work, revert restores the pre-edit
// content, reveal opens the old→new preview, and the pending registry feeds
// present/apply/reject while keeping skipped entries for a retry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A document fake the actions read: text, dirty flag, and its file path. */
interface FakeDocument {
  uri: { fsPath: string }
  isDirty: boolean
  getText(): string
  validateRange(range: unknown): unknown
}

/** Mutable vscode surface state, reset per case. */
interface VscodeState {
  documents: FakeDocument[]
  edits: { uri: { fsPath: string }; text: string }[]
  files: Map<string, string>
  deleted: string[]
  warnings: string[]
  shown: string[]
  diffs: { left: unknown; right: unknown; title: unknown }[]
  applyResult: boolean
  readErrors: Set<string>
  virtual: { uri: { fsPath: string } } | undefined
}

let state: VscodeState = null as unknown as VscodeState

vi.mock('vscode', () => ({
  Uri: { file: (path: string) => ({ fsPath: path }) },
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  WorkspaceEdit: class {
    replace(uri: { fsPath: string }, _range: unknown, text: string): void {
      state.edits.push({ uri, text })
    }
  },
  workspace: {
    textDocuments: {
      find(predicate: (document: FakeDocument) => boolean): FakeDocument | undefined {
        return state.documents.find(predicate)
      },
    },
    applyEdit: async (): Promise<boolean> => state.applyResult,
    fs: {
      writeFile: async (uri: { fsPath: string }, data: Uint8Array): Promise<void> => {
        state.files.set(uri.fsPath, Buffer.from(data).toString('utf8'))
      },
      readFile: async (uri: { fsPath: string }): Promise<Uint8Array> => {
        if (state.readErrors.has(uri.fsPath)) throw new Error(`ENOENT ${uri.fsPath}`)
        return Buffer.from(state.files.get(uri.fsPath) ?? '', 'utf8')
      },
      delete: async (uri: { fsPath: string }): Promise<void> => {
        state.files.delete(uri.fsPath)
        state.deleted.push(uri.fsPath)
      },
    },
    openTextDocument: async (): Promise<{ uri: { fsPath: string } }> => {
      if (state.virtual === undefined) throw new Error('no virtual document')
      return state.virtual
    },
  },
  window: {
    showTextDocument: async (uri: { fsPath: string }): Promise<void> => { state.shown.push(uri.fsPath) },
    showWarningMessage: async (message: string): Promise<void> => { state.warnings.push(message) },
  },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]): Promise<void> => {
      if (command === 'vscode.diff') state.diffs.push({ left: args[0], right: args[1], title: args[2] })
    },
  },
}))

const { applyHunks, handleDiffAction, PendingDiffs, resolveHunkPath, revealHunks, revertHunks, warnSkipped } = await import('../src/diff-actions.ts')
import type { DiffHunkWire } from '../src/bridge/host-bridge.ts'

/** A document the actions treat as clean and matching. */
const doc = (path: string, text: string, isDirty = false): FakeDocument => ({
  uri: { fsPath: path }, isDirty,
  getText: () => text,
  validateRange: (range: unknown) => range,
})

const HUNK: DiffHunkWire = { path: 'src/a.ts', oldText: 'old\n', newText: 'new\n' }

beforeEach(() => {
  state = {
    documents: [],
    edits: [],
    files: new Map(),
    deleted: [],
    warnings: [],
    shown: [],
    diffs: [],
    applyResult: true,
    readErrors: new Set(),
    virtual: undefined,
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('resolveHunkPath', () => {
  it('joins relative paths onto the cwd and passes absolute paths through', () => {
    expect(resolveHunkPath('src/a.ts', '/work')).toBe('/work/src/a.ts')
    expect(resolveHunkPath('/etc/hosts', '/work')).toBe('/etc/hosts')
    expect(resolveHunkPath('src/a.ts', undefined)).toBe('src/a.ts')
    expect(resolveHunkPath('src/a.ts', '')).toBe('src/a.ts')
  })
})

describe('applyHunks', () => {
  it('writes the new content when no editor has the file open', async () => {
    const outcome = await applyHunks([HUNK], '/work')
    expect(outcome).toEqual({ applied: ['/work/src/a.ts'], skipped: [] })
    expect(state.files.get('/work/src/a.ts')).toBe('new\n')
  })

  it('replaces a clean open document through applyEdit', async () => {
    state.documents.push(doc('/work/src/a.ts', 'old\n'))
    const outcome = await applyHunks([HUNK], '/work')
    expect(outcome).toEqual({ applied: ['/work/src/a.ts'], skipped: [] })
    expect(state.edits).toEqual([{ uri: { fsPath: '/work/src/a.ts' }, text: 'new\n' }])
  })

  it('is a no-op when the document already holds the new content', async () => {
    state.documents.push(doc('/work/src/a.ts', 'new\n'))
    const outcome = await applyHunks([HUNK], '/work')
    expect(outcome).toEqual({ applied: ['/work/src/a.ts'], skipped: [] })
    expect(state.edits).toHaveLength(0)
  })

  it('skips a dirty document instead of overwriting unsaved work', async () => {
    state.documents.push(doc('/work/src/a.ts', 'old\n', true))
    const outcome = await applyHunks([HUNK], '/work')
    expect(outcome.applied).toEqual([])
    expect(outcome.skipped[0]?.reason).toContain('unsaved changes')
    expect(state.edits).toHaveLength(0)
  })

  it('skips a document whose content diverged from both sides', async () => {
    state.documents.push(doc('/work/src/a.ts', 'user edited\n'))
    const outcome = await applyHunks([HUNK], '/work')
    expect(outcome.applied).toEqual([])
    expect(outcome.skipped[0]?.reason).toContain('changed since')
    expect(state.edits).toHaveLength(0)
  })

  it('skips a file whose editor rejected the edit', async () => {
    state.documents.push(doc('/work/src/a.ts', 'old\n'))
    state.applyResult = false
    const outcome = await applyHunks([HUNK], '/work')
    expect(outcome.applied).toEqual([])
    expect(outcome.skipped[0]?.reason).toContain('rejected')
  })

  it('keeps applying the remaining hunks after one failure', async () => {
    state.documents.push(doc('/work/src/a.ts', 'diverged\n'))
    const outcome = await applyHunks([HUNK, { path: 'src/b.ts', oldText: null, newText: 'b\n' }], '/work')
    expect(outcome.applied).toEqual(['/work/src/b.ts'])
    expect(outcome.skipped.map(s => s.path)).toEqual(['/work/src/a.ts'])
    expect(state.files.get('/work/src/b.ts')).toBe('b\n')
  })
})

describe('revertHunks', () => {
  it('restores the pre-edit content when the file still holds the new content', async () => {
    state.files.set('/work/src/a.ts', 'new\n')
    const outcome = await revertHunks([HUNK], '/work')
    expect(outcome).toEqual({ applied: ['/work/src/a.ts'], skipped: [] })
    expect(state.files.get('/work/src/a.ts')).toBe('old\n')
  })

  it('deletes the file when the hunk had no prior content', async () => {
    state.files.set('/work/src/b.ts', 'b\n')
    const outcome = await revertHunks([{ path: 'src/b.ts', oldText: null, newText: 'b\n' }], '/work')
    expect(outcome).toEqual({ applied: ['/work/src/b.ts'], skipped: [] })
    expect(state.deleted).toEqual(['/work/src/b.ts'])
  })

  it('skips when the file changed since the edit', async () => {
    state.files.set('/work/src/a.ts', 'later\n')
    const outcome = await revertHunks([HUNK], '/work')
    expect(outcome.applied).toEqual([])
    expect(outcome.skipped[0]?.reason).toContain('changed since')
    expect(state.files.get('/work/src/a.ts')).toBe('later\n')
  })

  it('skips a dirty open document and an unreadable file', async () => {
    state.documents.push(doc('/work/src/a.ts', 'new\n', true))
    state.files.set('/work/src/a.ts', 'new\n')
    state.readErrors.add('/work/src/c.ts')
    const outcome = await revertHunks([HUNK, { path: 'src/c.ts', oldText: 'c\n', newText: 'c2\n' }], '/work')
    expect(outcome.applied).toEqual([])
    expect(outcome.skipped.map(s => s.path)).toEqual(['/work/src/a.ts', '/work/src/c.ts'])
  })
})

describe('revealHunks', () => {
  it('opens the old→new diff preview for the first hunk and documents for the rest', async () => {
    state.virtual = { uri: { fsPath: 'untitled:1' } }
    await revealHunks([HUNK, { path: 'src/b.ts', oldText: null, newText: 'b\n' }], '/work')
    expect(state.diffs).toEqual([{ left: { fsPath: 'untitled:1' }, right: { fsPath: '/work/src/a.ts' }, title: 'src/a.ts (dsh change)' }])
    expect(state.shown).toEqual(['/work/src/b.ts'])
  })

  it('opens a created file as a document when there is no prior content', async () => {
    await revealHunks([{ path: 'src/b.ts', oldText: null, newText: 'b\n' }], '/work')
    expect(state.shown).toEqual(['/work/src/b.ts'])
  })
})

describe('PendingDiffs', () => {
  it('presents hunks by resolved path and clears on demand', () => {
    const pending = new PendingDiffs()
    pending.present([HUNK], '/work')
    expect(pending.has('/work/src/a.ts')).toBe(true)
    expect(pending.has('src/a.ts')).toBe(false)
    const entry = pending.entry('/work/src/a.ts')
    expect(entry?.hunk).toEqual({ path: '/work/src/a.ts', oldText: 'old\n', newText: 'new\n' })
    expect(pending.clear('/work/src/a.ts')).toEqual(entry)
    expect(pending.has('/work/src/a.ts')).toBe(false)
    expect(pending.clear('/work/src/a.ts')).toBeUndefined()
  })

  it('replaces the pending entry when a later present names the same path', () => {
    const pending = new PendingDiffs()
    pending.present([HUNK], '/work')
    pending.present([{ path: 'src/a.ts', oldText: null, newText: 'rewritten\n' }], '/work')
    expect(pending.entry('/work/src/a.ts')?.hunk.newText).toBe('rewritten\n')
  })
})

describe('handleDiffAction', () => {
  it('diff-present registers pending entries and notifies the context-key hook', async () => {
    const pending = new PendingDiffs()
    const onChanged = vi.fn()
    await handleDiffAction({ type: 'diff-present', sessionId: 's1', cwd: '/work', hunks: [HUNK] }, { pending, onChanged })
    expect(pending.has('/work/src/a.ts')).toBe(true)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('diff-apply clears applied entries, warns about skipped ones, and keeps them pending', async () => {
    const pending = new PendingDiffs()
    pending.present([HUNK], '/work')
    state.documents.push(doc('/work/src/a.ts', 'diverged\n'))
    const onChanged = vi.fn()
    await handleDiffAction({ type: 'diff-apply', sessionId: 's1', cwd: '/work', hunks: [HUNK] }, { pending, onChanged })
    // The skipped file keeps its entry so the editor/title menu can retry it.
    expect(pending.has('/work/src/a.ts')).toBe(true)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(state.warnings.some(w => w.includes('changed since'))).toBe(true)
  })

  it('diff-apply clears the pending entry of every applied file', async () => {
    const pending = new PendingDiffs()
    pending.present([HUNK], '/work')
    state.documents.push(doc('/work/src/a.ts', 'old\n'))
    await handleDiffAction({ type: 'diff-apply', sessionId: 's1', cwd: '/work', hunks: [HUNK] }, { pending, onChanged: () => {} })
    expect(pending.has('/work/src/a.ts')).toBe(false)
  })

  it('diff-reveal failures surface as a warning instead of throwing', async () => {
    state.virtual = undefined
    await handleDiffAction({ type: 'diff-reveal', sessionId: 's1', cwd: '/work', hunks: [HUNK] }, { pending: new PendingDiffs(), onChanged: () => {} })
    expect(state.warnings.some(w => w.includes('could not reveal'))).toBe(true)
  })
})

describe('warnSkipped', () => {
  it('warns once per skipped file', () => {
    warnSkipped({ applied: [], skipped: [{ path: '/work/a.ts', reason: 'r1' }, { path: '/work/b.ts', reason: 'r2' }] })
    expect(state.warnings).toEqual([
      'dsh: could not change /work/a.ts: r1',
      'dsh: could not change /work/b.ts: r2',
    ])
  })
})
