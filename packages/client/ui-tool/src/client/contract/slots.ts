/** Tool UI slot declarations and their composed component props. */
import type { HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Keyed atomic Tool call view, dispatched by the wire Tool name. Register
     * with `key: '<tool name>'` to own how one tool's calls render inside a
     * turn — the key domain is open (any wire tool name, including a tool your
     * own package registered), so there is no compile-time key set to pick
     * from and a typo simply never renders.
     *
     * A key the shipped composition already covers is replaced, not shared;
     * an unclaimed key falls back to the generic tool row, so registering is
     * additive for your own tool and a takeover for a shipped one. The owner
     * passes the call's identity, its frozen running-or-settled node, and the
     * expansion state (see ToolCallOwnerProps), so the view stays a pure
     * function of what the turn already knows.
     */
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolCallOwnerProps }
    /**
     * Action surface of one tool call whose change derived diff hunks. The
     * tool-call chat node declares it and the call tree renders it beside the
     * call, so a surface acting on file changes (Apply/Reveal) mounts next to
     * the shipped rows without replacing them. No registration renders
     * nothing; the shipped web surface stays unchanged. The owner passes the
     * call identity and the already-narrowed hunks (see DiffActionOwnerProps),
     * never a raw wire view.
     */
    'tool.call.diff-actions': { kind: 'single'; scope: 'session'; owner: DiffActionOwnerProps }
  }
}

/** Standard owner currency supplied to every atomic Tool view. */
export interface ToolCallOwnerProps {
  /** Tool call identity, stable across running and settled forms. */
  callId: string
  /** Wire Tool name and keyed dispatch value. */
  toolName: string
  /** Frozen running call or settled result node. */
  block: ToolCallBlock
  /** Session workspace root for relative summaries. */
  cwd?: string | undefined
  /** Host account home; POSIX home-rooted summaries display as `~`. */
  home?: string | undefined
  /** Open a Tool argument path through the Host. */
  openFile: (path: string) => void
  /** Inspect this call in the trajectory view when available. */
  inspect?: (() => void) | undefined
}

/** Full props of a registered atomic Tool view. */
export type ToolCallViewProps = PropsRuntime<'tool.call.toolview'>

/** Owner share of the diff-action surface: the call identity plus the narrowed hunks to act on. */
export interface DiffActionOwnerProps {
  /** Tool call identity, stable across running and settled forms. */
  callId: string
  /** Wire Tool name of the call carrying the diff. */
  toolName: string
  /** Session workspace root for resolving relative hunk paths. */
  cwd?: string | undefined
  /** Host account home. */
  home?: string | undefined
  /** The narrowed change hunks; the call tree renders the slot only when these derived, so they are never empty. */
  diffs: DiffHunk[]
}

/** Injected Host description for POSIX home-path display. */
export type ToolHostDescriptionInjected = {
  hooks: {
    /** Current generation's Host description, bound by the slot renderer. */
    hostDescription: HostDescriptionSource
  }
}

/** Full props of the Tool call-tree renderer registered as a `tool-call` Chat Node. */
export type ToolTreeProps = PropsRuntime<'conversation.chat.node', 'tool-call'>
  & PropsRenderSlots<'tool.call.toolview' | 'tool.call.diff-actions'>
  & PropsLocale<'conversation'>
  & InjectFace<ToolHostDescriptionInjected>

/** Full props of the selected Tool output renderer in the details panel. */
export type ToolDetailsProps = PropsRuntime<'conversation.details.tool'>
  & PropsLocale<'conversation'>
  & InjectFace<ToolHostDescriptionInjected>
