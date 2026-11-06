/**
 * The `/vision` command: one module owning parsing, registration, result copy,
 * and submission for DSH 0.2.1-rc.5's public `ctx.commands.register()` surface
 * (plan.md §3).
 *
 * Registration follows the host's own pattern: the disposer returned by
 * `commands.register()` is held by `ctx.effect()`, so one plugin generation
 * owns exactly one `/vision`. A duplicate command name throws from the Host
 * registry (NamedEntries never overwrites); that error is deliberately
 * propagated so the plugin install fails with the exact conflict named.
 */

import type { FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm/types'
import {
  VisionSessionServiceError,
  throwIfVisionCancelled,
  visionSessionAgentOf,
  VISION_DEFAULT_TASK_PROMPT,
  type VisionSessionService,
  type VisionSessionStatus,
} from './vision-session-service.js'
import type { SessionVisionPolicyPersistence } from './session-vision-policy.js'

export { VISION_DEFAULT_TASK_PROMPT }

export const VISION_COMMAND_NAME = 'vision'

/** Stable plugin namespace for client identity (package name + command name). */
export const VISION_COMMAND_DEFINITION_ID = 'dsh-vision-router/vision'

export const VISION_COMMAND_DESCRIPTION =
  'Control this Session\'s Vision mode and submit image tasks'

export const VISION_COMMAND_INPUT_HINT =
  'Question for the attached images; leave empty to submit them for analysis'

/** Structural mirror of the registry-normalized CommandResult (rc.5). */
export type VisionCommandResult =
  | Readonly<{ readonly kind: 'success'; readonly text?: string }>
  | Readonly<{ readonly kind: 'error'; readonly text: string }>

/** Structural mirror of the rc.5 CommandInvocation the handler receives. */
export interface VisionCommandInvocation {
  readonly commandId: string
  readonly agent: unknown
  readonly rawInput: string
  readonly attachments: readonly (ImageBlock | FileBlock)[]
  readonly signal: AbortSignal
}

/**
 * The definition DVR hands to the Host registry. `recordInput: false` follows
 * the rc.5 dedup contract: the `agent.steer()` user message owns the
 * model-visible payload, so `command/run` must not record a duplicate of it.
 */
export interface VisionCommandDefinition {
  readonly definitionId: string
  readonly name: string
  readonly description: string
  readonly input: Readonly<{ readonly hint: string; readonly attachments: true }>
  readonly recordInput: false
  readonly handler: (
    invocation: VisionCommandInvocation,
  ) => Promise<VisionCommandResult> | VisionCommandResult
}

/** Structural mirror of the Host command registry surface DVR consumes. */
export interface VisionCommandRegistry {
  register(definition: VisionCommandDefinition): () => void
}

export type VisionCommandIntent =
  | Readonly<{ readonly kind: 'status' }>
  | Readonly<{ readonly kind: 'on' }>
  | Readonly<{ readonly kind: 'off' }>
  | Readonly<{ readonly kind: 'task'; readonly question: string }>

/**
 * Parse the exact text after `/vision`.
 *
 * Only `status`, `on`, and `off` are reserved sub-commands and only on exact
 * match; every other suffix is one natural-language question, not parsed
 * further. Outer whitespace is not content, so it never creates a sub-command
 * and never alters a question.
 *
 * @param rawInput - verbatim text following the registered command name.
 * @returns the parsed intent for the dispatching handler.
 */
export function parseVisionCommandInput(rawInput: string): VisionCommandIntent {
  const trimmed = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (trimmed === '' || trimmed === 'status') return Object.freeze({ kind: 'status' })
  if (trimmed === 'on') return Object.freeze({ kind: 'on' })
  if (trimmed === 'off') return Object.freeze({ kind: 'off' })
  return Object.freeze({ kind: 'task', question: trimmed })
}

export interface VisionCommandRegistrationDeps {
  readonly service: VisionSessionService
  readonly logger?: {
    info?(message: string, ...args: unknown[]): void
    warn?(message: string, ...args: unknown[]): void
  }
}

/** Map a service failure to the command contract; cancellation rethrows. */
function commandFailure(error: unknown): VisionCommandResult {
  if (error instanceof VisionSessionServiceError) {
    // Cancellation follows the registry's own abort path: rethrow so the
    // dispatching UI request settles with its abort instead of a fake error.
    if (error.code === 'VISION_CANCELLED') throw error
    return { kind: 'error', text: error.message }
  }
  throw error
}

/**
 * Render the status copy. Sanitized by construction: backend names only, plus
 * mode, policy revision, and persistence state; never credentials, endpoints,
 * or local paths.
 */
export function visionStatusText(status: VisionSessionStatus): string {
  const lines = [
    `Vision mode: ${status.enabled ? 'enabled' : 'disabled'}`,
    `Policy source: ${
      status.source === 'user'
        ? 'this Session\'s own policy'
        : status.source === 'delegation'
          ? `inherited from parent session ${status.inheritedFrom ?? 'unknown'}`
          : 'unset for this Session'
    }`,
    `Policy revision: ${status.updateRevision}`,
    `Policy persistence: ${
      status.persistence === 'persisted'
        ? 'durable (Session store)'
        : status.persistence === 'degraded'
          ? `degraded (${status.degradedReason ?? 'unavailable'}); process-local only`
          : 'unknown (store does not report durability)'
    }`,
  ]
  if (status.backends.length > 0) {
    lines.push(`Configured vision backends (names only): ${status.backends.join(', ')}`)
  }
  lines.push('Usage: /vision on · /vision off · /vision <question> (+ image attachments)')
  return lines.join('\n')
}

function visionModeText(
  mode: 'on' | 'off',
  persistence: SessionVisionPolicyPersistence,
): string {
  if (persistence.kind === 'persisted') {
    return mode === 'on'
      ? 'Vision mode enabled for this Session (state saved). Submit image tasks with /vision <question> and image attachments.'
      : 'Vision mode disabled for this Session (state saved). DSH native vision capabilities are unaffected.'
  }
  // Degraded persistence must never be presented as "saved".
  return mode === 'on'
    ? `Vision mode enabled for this Session, but persistence is unavailable: ${persistence.reason}. The change is process-local and must be re-applied after a restart.`
    : `Vision mode disabled for this Session, but persistence is unavailable: ${persistence.reason}. The change is process-local. DSH native vision capabilities are unaffected.`
}

function visionTaskText(persistence: SessionVisionPolicyPersistence): string {
  const base = 'Vision task accepted: it entered the Agent queue and its answer will arrive as a normal reply. This confirms receipt of the task, not that image analysis succeeded.'
  if (persistence.kind === 'persisted') return base
  return `${base} (Session mode persistence is degraded: ${persistence.reason}.)`
}

/**
 * Build the `/vision` definition handed to the Host registry.
 *
 * @param deps - the shared UI-less session service plus optional logger.
 * @returns the frozen command definition.
 */
export function buildVisionCommandDefinition(
  deps: VisionCommandRegistrationDeps,
): VisionCommandDefinition {
  const definition: VisionCommandDefinition = {
    definitionId: VISION_COMMAND_DEFINITION_ID,
    name: VISION_COMMAND_NAME,
    description: VISION_COMMAND_DESCRIPTION,
    input: { hint: VISION_COMMAND_INPUT_HINT, attachments: true },
    recordInput: false,
    async handler(invocation) {
      try {
        return await runVisionCommand(deps, invocation)
      } catch (error) {
        return commandFailure(error)
      }
    },
  }
  return Object.freeze(definition)
}

async function runVisionCommand(
  deps: VisionCommandRegistrationDeps,
  invocation: VisionCommandInvocation,
): Promise<VisionCommandResult> {
  const intent = parseVisionCommandInput(invocation.rawInput)
  const attachments = Array.isArray(invocation.attachments) ? invocation.attachments : []
  const agent = visionSessionAgentOf(invocation.agent)
  const hasAttachments = attachments.length > 0
  const trimmedInput = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''

  // Explicit control words never consume attachments: a clear error keeps the
  // mode unchanged, and the dispatching composer retains the user's draft.
  // Bare `/vision` is not a control form: with attachments it submits them
  // under the default prompt (plan.md §3.1).
  const isExplicitControl =
    trimmedInput === 'status' || trimmedInput === 'on' || trimmedInput === 'off'
  if (isExplicitControl && hasAttachments) {
    return {
      kind: 'error',
      text: `/vision ${trimmedInput} does not accept attachments; the Session mode is unchanged and the composer draft is retained`,
    }
  }

  if (intent.kind === 'status' && !hasAttachments) {
    const status = await deps.service.getStatus(agent.id)
    return { kind: 'success', text: visionStatusText(status) }
  }

  if (intent.kind === 'on' || intent.kind === 'off') {
    throwIfVisionCancelled(invocation.signal)
    const outcome = await deps.service.setMode({
      sessionId: agent.id,
      enabled: intent.kind === 'on',
      origin: 'command',
      signal: invocation.signal,
      // Off also revokes a not-yet-executed route lease through the same
      // live Agent (plan §3.1); on ignores it.
      agent: invocation.agent,
    })
    return { kind: 'success', text: visionModeText(intent.kind, outcome.persistence) }
  }

  // `/vision` with attachments and no question submits them under the default
  // prompt; `/vision <question>` may carry attachments or not.
  const question = intent.kind === 'task' ? intent.question : VISION_DEFAULT_TASK_PROMPT
  const submission = await deps.service.submitVisionTask({
    agent: invocation.agent,
    question,
    attachments,
    origin: 'command',
    signal: invocation.signal,
  })
  return { kind: 'success', text: visionTaskText(submission.persistence) }
}

/** Structural Context needs of the installer: optional probe plus effect. */
export interface VisionCommandContext {
  get?(name: string): unknown
  effect?(setup: () => (() => Promise<void> | void) | void, label?: string): unknown
  readonly logger?: {
    info?(message: string, ...args: unknown[]): void
    warn?(message: string, ...args: unknown[]): void
  }
}

function visionCommandRegistryOf(ctx: VisionCommandContext): VisionCommandRegistry | undefined {
  // Commands is an optional Host capability: headless/ACP compositions may
  // never mount it. Context#get is the non-owning probe, mirroring the
  // storageDomain/sessionQuery capability reads elsewhere in DVR.
  try {
    const candidate = ctx.get?.('commands') as Partial<VisionCommandRegistry> | undefined
    return candidate && typeof candidate.register === 'function'
      ? candidate as VisionCommandRegistry
      : undefined
  } catch {
    return undefined
  }
}

/** Result of one installer call: whether the slash command is registered. */
export interface VisionCommandInstallResult {
  readonly installed: boolean
}

/**
 * Register `/vision` when the Host composes the Commands registry.
 *
 * A composition without Commands keeps the service layer fully usable while
 * reporting `installed: false`; it must never claim the slash command exists.
 * A duplicate `/vision` name throws from the Host registry through this
 * installer (never caught here), so the plugin install fails with the exact
 * conflict named instead of overwriting the other owner.
 *
 * @param ctx - plugin Context used for the optional probe and the effect.
 * @param deps - the shared session service plus optional logger.
 * @returns whether the command was registered in this Host.
 */
export function installVisionCommand(
  ctx: VisionCommandContext,
  deps: VisionCommandRegistrationDeps,
): VisionCommandInstallResult {
  const registry = visionCommandRegistryOf(ctx)
  if (registry === undefined) {
    try {
      ctx?.logger?.info?.(
        'vision-router: Commands capability not mounted; /vision stays unregistered while the service layer remains available',
      )
    } catch {}
    return { installed: false }
  }
  if (typeof ctx?.effect !== 'function') {
    throw new TypeError('vision-router: /vision registration requires a Context with effect()')
  }
  // The disposer from register() is owned by this plugin generation through
  // ctx.effect(); a synchronous name-conflict throw rolls the effect back and
  // propagates out of this installer.
  ctx.effect(
    () => registry.register(buildVisionCommandDefinition(deps)),
    'vision-router: /vision command registration',
  )
  return { installed: true }
}
