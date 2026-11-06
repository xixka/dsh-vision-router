/**
 * UI-less Vision session service: one shared owner for Session Vision mode
 * changes and image-task submissions, so Commands and ACP/headless/SDK
 * adapters run the exact same contract (plan.md §3.2).
 *
 * Submission order is fixed: validate Agent/attachments -> persist
 * `enabled=true` with a fresh monotonic revision -> `agent.steer()`. A failure
 * before acceptance reverts the persisted policy only when the observed
 * revision was not advanced by anyone else in between; once a task is
 * accepted nothing is rolled back and nothing is replayed.
 */

import { randomUUID } from 'node:crypto'

import type {
  ContentBlock,
  FileBlock,
  ImageBlock,
  UserMessage,
} from '@deepseek-ai/dsh-llm/types'
import {
  applySessionVisionPolicyUpdate,
  parseSessionVisionPolicy,
  type SessionVisionPolicy,
  type SessionVisionPolicyPersistence,
  type SessionVisionPolicySource,
  type SessionVisionPolicyStore,
  type SessionVisionPolicyUpdateOutcome,
} from './session-vision-policy.js'

/** Default question used when `/vision` is submitted with attachments only. */
export const VISION_DEFAULT_TASK_PROMPT = '请分析这些图片'

export type VisionSessionServiceErrorCode =
  | 'VISION_AGENT_INVALID'
  | 'VISION_TASK_EMPTY'
  | 'VISION_ATTACHMENTS_REQUIRE_IMAGE'
  | 'VISION_CANCELLED'
  | 'VISION_DUPLICATE_SUBMISSION'

/** Typed, structured service failure; callers render it, never rethrow-wrap it. */
export class VisionSessionServiceError extends Error {
  readonly code: VisionSessionServiceErrorCode

  constructor(code: VisionSessionServiceErrorCode, message: string) {
    super(message)
    this.name = 'VisionSessionServiceError'
    this.code = code
  }
}

/**
 * Throw the cancellation error for an already aborted signal so callers stop
 * before writing state, reading attachments, or submitting a task.
 *
 * @param signal - cancellation signal owned by the dispatching surface.
 */
export function throwIfVisionCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  const reason: unknown = (signal as { readonly reason?: unknown }).reason
  throw new VisionSessionServiceError(
    'VISION_CANCELLED',
    reason instanceof Error
      ? `Vision task cancelled before completion: ${reason.message}`
      : 'Vision task cancelled before completion',
  )
}

/** Minimal structural Agent seam the service needs: identity and steer(). */
export interface VisionSessionAgent {
  readonly id: string
  steer(message: Readonly<UserMessage>): void
}

/** Structural validation and projection of the Agent seam the service needs. */
export function visionSessionAgentOf(agent: unknown): VisionSessionAgent {
  if (agent === null || (typeof agent !== 'object' && typeof agent !== 'function')) {
    throw new VisionSessionServiceError(
      'VISION_AGENT_INVALID',
      'Vision submission requires the receiving Agent',
    )
  }
  const record = agent as Record<PropertyKey, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (id === '') {
    throw new VisionSessionServiceError(
      'VISION_AGENT_INVALID',
      'Vision submission requires an Agent with a non-empty id',
    )
  }
  if (typeof record.steer !== 'function') {
    throw new VisionSessionServiceError(
      'VISION_AGENT_INVALID',
      'Vision submission requires the Agent steer() seam',
    )
  }
  return Object.freeze({
    id,
    steer: (record.steer as (message: Readonly<UserMessage>) => void).bind(agent),
  })
}

function createVisionUserMessage(content: readonly ContentBlock[]): Readonly<UserMessage> {
  const message: UserMessage = {
    id: randomUUID() as UserMessage['id'],
    role: 'user',
    content: [...content],
    source: { kind: 'user' },
  }
  return Object.freeze(message)
}

/** Sanitized Session status for command and adapter surfaces. */
export interface VisionSessionStatus {
  readonly enabled: boolean
  readonly updateRevision: number
  readonly source: SessionVisionPolicySource | 'unset'
  readonly inheritedFrom?: string
  readonly persistence: 'persisted' | 'degraded' | 'unknown'
  readonly degradedReason?: string
  readonly backends: readonly string[]
}

/** Outcome of one accepted submission; it never claims image analysis succeeded. */
export interface VisionTaskSubmissionOutcome {
  readonly status: 'accepted'
  readonly updateRevision: number
  readonly persistence: SessionVisionPolicyPersistence
  readonly message: Readonly<UserMessage>
}

export interface VisionSessionServiceDeps {
  readonly store: SessionVisionPolicyStore
  readonly logger?: {
    info?(message: string, ...args: unknown[]): void
    warn?(message: string, ...args: unknown[]): void
  }
  /** Sanitized backend names only: no credentials, endpoints, or local paths. */
  readonly listBackends?: () => readonly string[]
}

/** The routing coordinator's lease-revocation surface consumed by /vision off. */
export interface VisionRouteLeaseRevoker {
  /** Revoke a not-yet-executed live lease and restore its saved origin selection. */
  revokePendingRouteLease(agent: unknown): boolean
  /** Clear a not-yet-executed persisted lease for a cold Session. */
  revokePersistedRouteLease(session: unknown): boolean
}

export interface VisionSessionService {
  getStatus(sessionId: string): Promise<VisionSessionStatus>
  /**
   * Register the routing coordinator's lease revoker once composition wiring
   * can reach it; /vision off then also revokes DVR's not-yet-executed route
   * ownership (plan §3.1) in addition to persisting the disabled policy.
   */
  registerRouteLeaseRevoker(revoker: VisionRouteLeaseRevoker): void
  setMode(input: {
    readonly sessionId: string
    readonly enabled: boolean
    readonly origin: string
    readonly signal?: AbortSignal
    /** Live Agent; /vision off uses it to revoke a pending route lease. */
    readonly agent?: unknown
  }): Promise<SessionVisionPolicyUpdateOutcome>
  submitVisionTask(input: {
    readonly agent: unknown
    readonly question: string
    readonly attachments: readonly (ImageBlock | FileBlock)[]
    readonly origin: string
    readonly signal?: AbortSignal
  }): Promise<VisionTaskSubmissionOutcome>
}

function storeDurabilityOf(store: SessionVisionPolicyStore): 'persisted' | 'degraded' | 'unknown' {
  // The runtime store (session-vision-policy-domain) exposes `durable`; base
  // stores do not declare durability, and 'unknown' keeps status honest
  // instead of guessing on the caller's behalf.
  const candidate = store as { readonly durable?: unknown }
  if (candidate.durable === true) return 'persisted'
  if (candidate.durable === false) return 'degraded'
  return 'unknown'
}

/**
 * Create the shared service over one policy store.
 *
 * @param deps - the policy store plus optional logger and sanitized backend
 *   summary used by status rendering.
 */
export function createVisionSessionService(deps: VisionSessionServiceDeps): VisionSessionService {
  if (deps === null || typeof deps !== 'object' || typeof deps.store !== 'object') {
    throw new TypeError('VisionSessionService requires a SessionVisionPolicyStore')
  }
  const store = deps.store
  const pendingSubmissions = new Set<string>()
  let routeLeaseRevoker: VisionRouteLeaseRevoker | undefined

  const readCurrentPolicy = async (
    sessionId: string,
  ): Promise<Readonly<SessionVisionPolicy> | undefined> => {
    const direct = store.get(sessionId)
    if (direct !== undefined) {
      const parsed = parseSessionVisionPolicy(direct)
      if (parsed !== undefined) return parsed
    }
    if (typeof store.hydrate === 'function') {
      try {
        const hydrated = await store.hydrate(sessionId)
        return hydrated === undefined ? undefined : parseSessionVisionPolicy(hydrated)
      } catch {
        // A failed durable read keeps the in-process view; callers treat the
        // policy as absent rather than guessing durable truth.
        return undefined
      }
    }
    return undefined
  }

  const revertPolicyIfUnchanged = async (
    sessionId: string,
    previous: Readonly<SessionVisionPolicy> | undefined,
    observedRevision: number,
    origin: string,
  ): Promise<void> => {
    try {
      const current = await readCurrentPolicy(sessionId)
      if (current?.updateRevision !== observedRevision) {
        // Another update already advanced the policy; never clobber it.
        return
      }
      if (previous === undefined) {
        // The observed row exists only because this submission wrote it.
        await store.delete(sessionId)
        return
      }
      const revertOrigin = `${origin}:revert`
      await applySessionVisionPolicyUpdate(
        store,
        sessionId,
        previous.source === 'delegation'
          ? {
              enabled: previous.enabled,
              source: previous.source,
              inheritedFrom: previous.inheritedFrom,
              origin: revertOrigin,
            }
          : {
              enabled: previous.enabled,
              source: previous.source,
              origin: revertOrigin,
            },
      )
    } catch (error) {
      // Revert is best-effort: the failed submission already reports its own
      // error, and the durable row keeps the observed revision so a later
      // generation can still repair the state.
      try {
        deps.logger?.warn?.(
          'vision-router: /vision pre-submit revert failed for session %s: %s',
          sessionId,
          error instanceof Error ? error.message : String(error),
        )
      } catch {}
    }
  }

  return {
    registerRouteLeaseRevoker(revoker) {
      routeLeaseRevoker = revoker
    },

    async getStatus(sessionId) {
      const policy = await readCurrentPolicy(sessionId)
      const durability = storeDurabilityOf(store)
      let backends: readonly string[] = []
      try {
        backends = deps.listBackends?.() ?? []
      } catch {
        backends = []
      }
      const status: VisionSessionStatus = {
        enabled: policy?.enabled === true,
        updateRevision: policy?.updateRevision ?? 0,
        source: policy === undefined ? 'unset' : policy.source,
        ...(policy?.source === 'delegation' ? { inheritedFrom: policy.inheritedFrom } : {}),
        persistence: durability,
        ...(durability === 'degraded'
          ? { degradedReason: 'session-policy-store-not-durable' }
          : {}),
        backends: Object.freeze([...backends]),
      }
      return Object.freeze(status)
    },

    async setMode(input) {
      const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : ''
      if (sessionId.trim() === '') {
        throw new TypeError('Vision session setMode requires a non-empty sessionId')
      }
      throwIfVisionCancelled(input?.signal)
      const outcome = await applySessionVisionPolicyUpdate(store, sessionId, {
        enabled: input.enabled === true,
        source: 'user',
        origin: input.origin,
      })
      if (input.enabled === false && input.agent !== undefined && routeLeaseRevoker !== undefined) {
        // /vision off (plan §3.1) also revokes DVR's not-yet-executed route
        // ownership: restore the saved origin selection and clear the durable
        // lease. Best-effort by design — a revoke failure never fails off,
        // and the coordinator's next text-turn restore still self-heals.
        const revoker = routeLeaseRevoker
        try {
          revoker.revokePendingRouteLease(input.agent)
          const session = (input.agent as { session?: unknown })?.session
          if (session !== undefined && session !== null) revoker.revokePersistedRouteLease(session)
        } catch (error) {
          try {
            deps.logger?.warn?.(
              'vision-router: /vision off route lease revoke failed for session %s: %s',
              sessionId,
              error instanceof Error ? error.message : String(error),
            )
          } catch {}
        }
      }
      return outcome
    },

    async submitVisionTask(input) {
      const agent = visionSessionAgentOf(input?.agent)
      const attachments = Array.isArray(input?.attachments) ? [...input.attachments] : []
      const question = typeof input?.question === 'string' ? input.question.trim() : ''
      const origin = typeof input?.origin === 'string' ? input.origin : ''
      // One in-flight submission per session: a second submit while the first
      // is still between validation and steer() would duplicate the task and
      // double-bill the user; the gate opens again once the task is accepted.
      if (pendingSubmissions.has(agent.id)) {
        throw new VisionSessionServiceError(
          'VISION_DUPLICATE_SUBMISSION',
          'A vision task submission is already in progress for this session; wait for it to be accepted before submitting again',
        )
      }
      pendingSubmissions.add(agent.id)
      try {
        throwIfVisionCancelled(input?.signal)
        if (question === '' && attachments.length === 0) {
          throw new VisionSessionServiceError(
            'VISION_TASK_EMPTY',
            'A vision task requires a question or at least one image attachment',
          )
        }
        const imageCount = attachments.reduce(
          (count, block) => count + (block.type === 'image' ? 1 : 0),
          0,
        )
        if (attachments.length > 0 && imageCount === 0) {
          throw new VisionSessionServiceError(
            'VISION_ATTACHMENTS_REQUIRE_IMAGE',
            'A vision task requires at least one image attachment; plain files only accompany images',
          )
        }
        throwIfVisionCancelled(input?.signal)
        const previous = await readCurrentPolicy(agent.id)
        const outcome = await applySessionVisionPolicyUpdate(store, agent.id, {
          enabled: true,
          source: 'user',
          origin,
        })
        try {
          throwIfVisionCancelled(input?.signal)
          const prompt = question === '' ? VISION_DEFAULT_TASK_PROMPT : question
          const message = createVisionUserMessage([
            { type: 'text', text: prompt },
            ...attachments,
          ])
          agent.steer(message)
          return Object.freeze({
            status: 'accepted',
            updateRevision: outcome.updateRevision,
            persistence: outcome.persistence,
            message,
          })
        } catch (error) {
          // The task never entered the Agent inbox, so the persisted
          // enablement is ours to revert - but only if nobody else updated
          // the policy in between.
          await revertPolicyIfUnchanged(agent.id, previous, outcome.updateRevision, origin)
          throw error
        }
      } finally {
        pendingSubmissions.delete(agent.id)
      }
    },
  }
}
