/**
 * Packaged-extension smoke test, executed inside the VS Code test host by
 * @vscode/test-electron: the extension must activate from the installed vsix
 * and register the core command surface. A thrown error or a non-zero exit
 * fails the run.
 */
import * as vscode from 'vscode'

const EXTENSION_ID = 'caufieldz.dsh-vscode'

/** Commands every shipped milestone registers. */
const EXPECTED_COMMANDS = [
  'dsh.setApiKey',
  'dsh.newSession',
  'dsh.toggleAutomode',
  'dsh.setPermissionMode',
  'dsh.stopSession',
  'dsh.acceptDiff',
  'dsh.rejectDiff',
]

async function main(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)
  if (extension === undefined) throw new Error(`${EXTENSION_ID} is not installed`)
  await extension.activate()
  if (!extension.isActive) throw new Error(`${EXTENSION_ID} did not activate`)
  const commands = await vscode.commands.getCommands(true)
  const missing = EXPECTED_COMMANDS.filter(command => !commands.includes(command))
  if (missing.length > 0) throw new Error(`missing commands: ${missing.join(', ')}`)
  console.log(`smoke OK: ${EXTENSION_ID} activated with ${EXPECTED_COMMANDS.length} expected commands`)
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
