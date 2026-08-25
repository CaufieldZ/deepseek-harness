/**
 * Host-local diff actions: the extension-host half of the webview's diff
 * surface. Owns the pending registry feeding the editor/title Accept/Reject
 * menu and executes the wire actions through the VS Code workspace API —
 * `diff-apply` writes the change into editors and files, `diff-reveal` opens
 * the old→new preview, and `diff-present` registers the pending entry. The
 * harness child already applied the change on disk at tool time (the edit/
 * write tools write through the sandbox), so apply is an editor sync with
 * an idempotent file write, and reject reverts the file to its pre-edit
 * content. A dirty buffer is never overwritten: the action skips the file
 * and warns instead of destroying unsaved user work.
 */
import { isAbsolute, join } from 'node:path'
import * as vscode from 'vscode'
import type { DiffActionMessage, DiffHunkWire } from './bridge/host-bridge.ts'

/** One pending change, keyed by its resolved absolute path. */
export interface PendingDiff {
  /** The change to apply or revert for that path. */
  hunk: DiffHunkWire
}

/** A multi-file action's per-file settlement. */
export interface DiffOutcome {
  /** Absolute paths now holding the new content. */
  applied: string[]
  /** Paths left untouched, with the reason shown to the user. */
  skipped: { path: string; reason: string }[]
}

/** Resolve one hunk path: absolute paths pass through, relative ones join the session cwd. */
export function resolveHunkPath(path: string, cwd: string | undefined): string {
  return isAbsolute(path) || cwd === undefined || cwd === '' ? path : join(cwd, path)
}

/** The whole-document range, clamped by the document's own extent. */
function fullRange(document: vscode.TextDocument): vscode.Range {
  return document.validateRange(new vscode.Range(
    0, 0,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER,
  ))
}

/** Apply one hunk to the file at its resolved path. */
async function applyOne(resolved: string, hunk: DiffHunkWire): Promise<DiffOutcome> {
  const uri = vscode.Uri.file(resolved)
  const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.fsPath === resolved)
  if (document === undefined) {
    // No open editor: the child's write is already on disk; make it explicit
    // so Apply is total even for a file the editor never loaded.
    await vscode.workspace.fs.writeFile(uri, Buffer.from(hunk.newText, 'utf8'))
    return { applied: [resolved], skipped: [] }
  }
  if (document.isDirty) {
    return { applied: [], skipped: [{ path: resolved, reason: 'the file has unsaved changes; save or revert it first' }] }
  }
  const text = document.getText()
  if (text === hunk.newText) return { applied: [resolved], skipped: [] }
  if (text !== hunk.oldText) {
    return { applied: [], skipped: [{ path: resolved, reason: 'the file changed since the edit was made' }] }
  }
  const edit = new vscode.WorkspaceEdit()
  edit.replace(uri, fullRange(document), hunk.newText)
  const accepted = await vscode.workspace.applyEdit(edit)
  return accepted
    ? { applied: [resolved], skipped: [] }
    : { applied: [], skipped: [{ path: resolved, reason: 'the editor rejected the edit' }] }
}

/** Apply every hunk; per-file failures skip that file and keep the rest. */
export async function applyHunks(hunks: readonly DiffHunkWire[], cwd: string | undefined): Promise<DiffOutcome> {
  const applied: string[] = []
  const skipped: { path: string; reason: string }[] = []
  for (const hunk of hunks) {
    const resolved = resolveHunkPath(hunk.path, cwd)
    try {
      const outcome = await applyOne(resolved, hunk)
      applied.push(...outcome.applied)
      skipped.push(...outcome.skipped)
    } catch (error) {
      skipped.push({ path: resolved, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { applied, skipped }
}

/** Revert one hunk: the disk content must still equal the edit's result. */
async function revertOne(resolved: string, hunk: DiffHunkWire): Promise<DiffOutcome> {
  const uri = vscode.Uri.file(resolved)
  const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.fsPath === resolved)
  if (document?.isDirty === true) {
    return { applied: [], skipped: [{ path: resolved, reason: 'the file has unsaved changes; save or revert it first' }] }
  }
  let current: string
  try {
    current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
  } catch {
    return { applied: [], skipped: [{ path: resolved, reason: 'the file cannot be read' }] }
  }
  if (current !== hunk.newText) {
    return { applied: [], skipped: [{ path: resolved, reason: 'the file changed since the edit was made' }] }
  }
  if (hunk.oldText === null) await vscode.workspace.fs.delete(uri)
  else await vscode.workspace.fs.writeFile(uri, Buffer.from(hunk.oldText, 'utf8'))
  return { applied: [resolved], skipped: [] }
}

/** Revert every hunk to its pre-edit content; per-file failures skip that file. */
export async function revertHunks(hunks: readonly DiffHunkWire[], cwd: string | undefined): Promise<DiffOutcome> {
  const applied: string[] = []
  const skipped: { path: string; reason: string }[] = []
  for (const hunk of hunks) {
    const resolved = resolveHunkPath(hunk.path, cwd)
    try {
      const outcome = await revertOne(resolved, hunk)
      applied.push(...outcome.applied)
      skipped.push(...outcome.skipped)
    } catch (error) {
      skipped.push({ path: resolved, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { applied, skipped }
}

/** Open the old→new preview for the first hunk; the remaining files open as documents. */
export async function revealHunks(hunks: readonly DiffHunkWire[], cwd: string | undefined): Promise<void> {
  for (const [index, hunk] of hunks.entries()) {
    const resolved = resolveHunkPath(hunk.path, cwd)
    const uri = vscode.Uri.file(resolved)
    if (index === 0 && hunk.oldText !== null) {
      const virtual = await vscode.workspace.openTextDocument({ content: hunk.oldText, language: 'plaintext' })
      await vscode.commands.executeCommand('vscode.diff', virtual.uri, uri, `${hunk.path} (dsh change)`)
    } else {
      await vscode.window.showTextDocument(uri)
    }
  }
}

/** Pending-diff registry keyed by resolved path; feeds the editor/title Accept/Reject menu. */
export class PendingDiffs {
  private readonly entries = new Map<string, PendingDiff>()

  /** Register (or replace) the pending entry for every hunk. */
  present(hunks: readonly DiffHunkWire[], cwd: string | undefined): void {
    for (const hunk of hunks) {
      const resolved = resolveHunkPath(hunk.path, cwd)
      this.entries.set(resolved, { hunk: { path: resolved, oldText: hunk.oldText, newText: hunk.newText } })
    }
  }

  /** The pending entry for one resolved path, if any. */
  entry(path: string): PendingDiff | undefined {
    return this.entries.get(path)
  }

  /** Whether a resolved path has a pending change. */
  has(path: string): boolean {
    return this.entries.has(path)
  }

  /** Remove and return the pending entry for one resolved path. */
  clear(path: string): PendingDiff | undefined {
    const entry = this.entries.get(path)
    this.entries.delete(path)
    return entry
  }
}

/** Warn about every skipped file of an apply/revert, one message per file. */
export function warnSkipped(outcome: DiffOutcome): void {
  for (const skipped of outcome.skipped) {
    void vscode.window.showWarningMessage(`dsh: could not change ${skipped.path}: ${skipped.reason}`)
  }
}

export interface DiffActionOptions {
  /** The pending registry diff-present feeds and accept/reject consume. */
  pending: PendingDiffs
  /** Recompute the pending-diff context key (the extension entry installs this). */
  onChanged: () => void
}

/**
 * Execute one narrowed wire diff action.
 * @param message - the validated webview request.
 * @param options - the pending registry and the context-key hook.
 */
export async function handleDiffAction(message: DiffActionMessage, options: DiffActionOptions): Promise<void> {
  if (message.type === 'diff-present') {
    options.pending.present(message.hunks, message.cwd)
    options.onChanged()
    return
  }
  if (message.type === 'diff-apply') {
    const outcome = await applyHunks(message.hunks, message.cwd)
    for (const path of outcome.applied) options.pending.clear(path)
    options.onChanged()
    warnSkipped(outcome)
    return
  }
  try {
    await revealHunks(message.hunks, message.cwd)
  } catch (error) {
    void vscode.window.showWarningMessage(`dsh: could not reveal the change: ${error instanceof Error ? error.message : String(error)}`)
  }
}
