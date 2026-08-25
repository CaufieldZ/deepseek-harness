import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

// Keep the Loader config under examples so both modes exercise the same deployable
// topology: local fixture source plus bare plugins owned by the examples workspace.
const driver = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/vscode-context-driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  '../../../../examples/headless-agent/tests/fixtures/vscode-context.cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

describe('vscode-context through a real headless cordis.yml', () => {
  it('injects the seeded feed once and persists the ordered context event', async () => {
    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'vscode-context headless smoke',
      tempDirPrefix: 'vscode-context-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      prepare: async (cwd) => {
        await writeFile(join(cwd, 'context.json'), JSON.stringify({
          version: 1,
          updatedAt: 1,
          workspace: cwd,
          activeFile: {
            path: 'src/index.ts',
            languageId: 'typescript',
            cursor: { line: 4, character: 2 },
            selection: { startLine: 1, endLine: 4, text: 'const answer = 42\n' },
          },
          openFiles: ['src/index.ts'],
        }))
      },
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(2)

    // The static feed injects once: the second turn's unchanged state is
    // suppressed by the durable-event backscan, the same scheduling the
    // package tests pin per rule.
    const contexts = events.filter(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'plugin')
    const starts = events.filter(event => event.type === 'step/start')
    expect(contexts).toHaveLength(1)
    expect(starts).toHaveLength(2)
    expect(contexts[0]!.seq).toBeGreaterThan(starts[0]!.seq)
    expect(contexts[0]!.surfaceOp).toBe('append')
    // `snapshot` form: one named contribution whose text is exactly what the
    // model read, so a consumer attributes it without re-splitting prose.
    expect(contexts[0]!.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'vscode-context',
      form: 'snapshot',
      sections: [{ name: 'vscode-context' }],
    })
    const contextText = contexts[0]!.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(contextText).toMatch(/vscode context \(turn 1\):\nworkspace /)
    expect(contextText).toContain('active file src/index.ts, cursor 4:2, selection lines 1-4:')
    expect(contextText).toContain('const answer = 42')
    expect(contextText).toContain('open files (1): src/index.ts')

    // The preamble belongs to the injected message, never the system prompt.
    const headers = events.filter(event => event.type === 'request/header')
    expect(JSON.stringify(headers)).not.toContain('vscode context (turn')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
