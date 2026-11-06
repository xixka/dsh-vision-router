export const SESSION_VISION_POLICY_REVISION = 1 as const

export type SessionVisionPolicySource = 'user' | 'delegation'

export type SessionVisionPolicy =
  | Readonly<{
      revision: typeof SESSION_VISION_POLICY_REVISION
      enabled: boolean
      source: 'user'
      inheritedFrom?: never
      /**
       * Monotonic per-Session update counter minted by the update seam. Rows
       * written before this field existed keep it absent and count as revision
       * 0 when the next update is computed. Never decreases per Session.
       */
      updateRevision?: number
      /** Non-empty producer label of the latest write, e.g. 'command' or 'model-selection'. */
      updateOrigin?: string
    }>
  | Readonly<{
      revision: typeof SESSION_VISION_POLICY_REVISION
      enabled: boolean
      source: 'delegation'
      inheritedFrom: string
      /** Monotonic per-Session update counter minted by the update seam. */
      updateRevision?: number
      /** Non-empty producer label of the latest write, e.g. 'command:revert'. */
      updateOrigin?: string
    }>

export interface SessionVisionPolicyTable {
  get(key: string): unknown
  put(key: string, value: Readonly<SessionVisionPolicy>): Promise<unknown>
  delete(key: string): Promise<unknown>
}

/**
 * Durable write outcome of one policy update. `persisted` means the write
 * reached the store's own persistence seam; a degraded outcome must never be
 * reported to a user as "saved".
 */
export type SessionVisionPolicyPersistence =
  | Readonly<{ readonly kind: 'persisted' }>
  | Readonly<{ readonly kind: 'degraded'; readonly reason: string }>

/** One monotonic policy update request; `origin` names the calling surface. */
export interface SessionVisionPolicyUpdateRequest {
  readonly enabled: boolean
  readonly source: SessionVisionPolicySource
  /** Parent Session id; required for delegation updates and forbidden for user updates. */
  readonly inheritedFrom?: string
  /** Non-empty producer label, e.g. 'command' | 'service' | 'acp' | 'model-selection'. */
  readonly origin: string
}

/** Result of one monotonic policy update, including its durable write outcome. */
export interface SessionVisionPolicyUpdateOutcome {
  readonly policy: Readonly<SessionVisionPolicy>
  readonly updateRevision: number
  readonly updateOrigin: string
  readonly persistence: SessionVisionPolicyPersistence
}

export interface SessionVisionPolicyStore {
  get(sessionId: string): Readonly<SessionVisionPolicy> | undefined
  /** Optional durable hydration before the Session becomes model-facing. */
  hydrate?(sessionId: string): Promise<Readonly<SessionVisionPolicy> | undefined>
  /** Drop only process-local hot state while retaining durable Session truth. */
  release?(sessionId: string): void
  set(sessionId: string, policy: SessionVisionPolicy): Promise<Readonly<SessionVisionPolicy>>
  delete(sessionId: string): Promise<void>
  /**
   * Monotonic, durability-aware update. Absent on stores that predate this
   * seam; callers fall back to {@link applySessionVisionPolicyUpdate}.
   */
  apply?(
    sessionId: string,
    request: SessionVisionPolicyUpdateRequest,
  ): Promise<SessionVisionPolicyUpdateOutcome>
}

/** A policy whose update counter and origin are guaranteed present. */
export type SessionVisionPolicyRevisioned = Readonly<SessionVisionPolicy> & {
  readonly updateRevision: number
  readonly updateOrigin: string
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function normalizedSessionId(value: unknown): string {
  const id = nonEmptyString(value)
  if (id === undefined) throw new TypeError('session vision policy requires a non-empty session id')
  return id
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && !Object.is(value, -0)
}

export function parseSessionVisionPolicy(value: unknown): Readonly<SessionVisionPolicy> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<PropertyKey, unknown>
  // Own keys only: a policy row is persisted JSON, so a value inherited from a
  // prototype is evidence of a malformed row rather than of a policy.
  if (!Object.hasOwn(record, 'revision') || record.revision !== SESSION_VISION_POLICY_REVISION) return undefined
  if (!Object.hasOwn(record, 'enabled') || typeof record.enabled !== 'boolean') return undefined
  if (!Object.hasOwn(record, 'source') || (record.source !== 'user' && record.source !== 'delegation')) {
    return undefined
  }
  // New rows carry a monotonic update counter and origin; a malformed value on
  // either field fails the whole row closed instead of half-trusting it.
  const hasUpdateRevision = Object.hasOwn(record, 'updateRevision')
  if (hasUpdateRevision && !isPositiveSafeInteger(record.updateRevision)) return undefined
  const hasUpdateOrigin = Object.hasOwn(record, 'updateOrigin')
  if (hasUpdateOrigin && !nonEmptyString(record.updateOrigin)) return undefined

  if (record.source === 'user') {
    if (record.inheritedFrom !== undefined) return undefined
    return Object.freeze({
      revision: SESSION_VISION_POLICY_REVISION,
      enabled: record.enabled,
      source: 'user',
      ...(hasUpdateRevision ? { updateRevision: record.updateRevision as number } : {}),
      ...(hasUpdateOrigin ? { updateOrigin: record.updateOrigin as string } : {}),
    })
  }

  const inheritedFrom = Object.hasOwn(record, 'inheritedFrom')
    ? nonEmptyString(record.inheritedFrom)
    : undefined
  if (inheritedFrom === undefined) return undefined
  return Object.freeze({
    revision: SESSION_VISION_POLICY_REVISION,
    enabled: record.enabled,
    source: 'delegation',
    inheritedFrom,
    ...(hasUpdateRevision ? { updateRevision: record.updateRevision as number } : {}),
    ...(hasUpdateOrigin ? { updateOrigin: record.updateOrigin as string } : {}),
  })
}

export function userSessionVisionPolicy(enabled: boolean): Readonly<SessionVisionPolicy> {
  return Object.freeze({
    revision: SESSION_VISION_POLICY_REVISION,
    enabled,
    source: 'user',
  })
}

export function delegatedSessionVisionPolicy(
  enabled: boolean,
  parentSessionId: string,
): Readonly<SessionVisionPolicy> {
  return Object.freeze({
    revision: SESSION_VISION_POLICY_REVISION,
    enabled,
    source: 'delegation',
    inheritedFrom: normalizedSessionId(parentSessionId),
  })
}

/** Validate one update request at the seam where untrusted callers enter. */
export function normalizeSessionVisionPolicyUpdateRequest(
  request: SessionVisionPolicyUpdateRequest,
): SessionVisionPolicyUpdateRequest {
  if (request === null || typeof request !== 'object') {
    throw new TypeError('session vision policy update requires a request object')
  }
  const candidate = request as unknown as Record<PropertyKey, unknown>
  if (typeof candidate.enabled !== 'boolean') {
    throw new TypeError('session vision policy update requires a boolean enabled')
  }
  const source: unknown = candidate.source
  if (source !== 'user' && source !== 'delegation') {
    throw new TypeError('session vision policy update requires source user or delegation')
  }
  const origin = nonEmptyString(candidate.origin)
  if (origin === undefined) {
    throw new TypeError('session vision policy update requires a non-empty origin')
  }
  if (source === 'user') {
    if (candidate.inheritedFrom !== undefined) {
      throw new TypeError('user session vision policy updates cannot declare inheritedFrom')
    }
    return Object.freeze({ enabled: candidate.enabled, source, origin })
  }
  const inheritedFrom = nonEmptyString(candidate.inheritedFrom)
  if (inheritedFrom === undefined) {
    throw new TypeError('delegation session vision policy updates require inheritedFrom')
  }
  return Object.freeze({ enabled: candidate.enabled, source, inheritedFrom, origin })
}

/**
 * Build the next policy row with a strictly increasing per-Session update
 * counter, so a compare-and-revert can detect any interleaved update.
 *
 * @param current - the current durable policy row, or `undefined` when absent.
 * @param request - validated update request carrying enabled/source/origin.
 * @returns the frozen policy row with `updateRevision` and `updateOrigin` present.
 */
export function nextSessionVisionPolicy(
  current: Readonly<SessionVisionPolicy> | undefined,
  request: SessionVisionPolicyUpdateRequest,
): SessionVisionPolicyRevisioned {
  const normalized = normalizeSessionVisionPolicyUpdateRequest(request)
  const updateRevision = (current?.updateRevision ?? 0) + 1
  if (normalized.source === 'delegation') {
    // Normalize guarantees a non-empty inheritedFrom for delegation updates;
    // the guard also protects direct callers that bypassed normalization.
    const inheritedFrom = nonEmptyString(normalized.inheritedFrom)
    if (inheritedFrom === undefined) {
      throw new TypeError('delegation session vision policy updates require inheritedFrom')
    }
    return Object.freeze({
      revision: SESSION_VISION_POLICY_REVISION,
      enabled: normalized.enabled,
      source: 'delegation',
      inheritedFrom,
      updateRevision,
      updateOrigin: normalized.origin,
    })
  }
  return Object.freeze({
    revision: SESSION_VISION_POLICY_REVISION,
    enabled: normalized.enabled,
    source: 'user',
    updateRevision,
    updateOrigin: normalized.origin,
  })
}

/** Read-modify-write seams behind one per-Session serialized apply pipeline. */
interface SessionVisionPolicyApplySeams {
  readonly readCurrent: (
    key: string,
  ) => Promise<Readonly<SessionVisionPolicy> | undefined> | Readonly<SessionVisionPolicy> | undefined
  readonly writeNext: (key: string, policy: Readonly<SessionVisionPolicy>) => Promise<unknown>
  readonly persistence: SessionVisionPolicyPersistence
}

/**
 * Serialize monotonic updates per Session key. Concurrent apply calls never
 * interleave their read-modify-write, so revisions stay strictly increasing and
 * compare-and-revert can rely on them.
 */
function createSerializedSessionVisionPolicyApply(
  seams: SessionVisionPolicyApplySeams,
): NonNullable<SessionVisionPolicyStore['apply']> {
  const tails = new Map<string, Promise<SessionVisionPolicyUpdateOutcome>>()
  const forget = (key: string, tail: Promise<SessionVisionPolicyUpdateOutcome>) => {
    if (tails.get(key) === tail) tails.delete(key)
  }
  const run = async (
    key: string,
    normalized: SessionVisionPolicyUpdateRequest,
  ): Promise<SessionVisionPolicyUpdateOutcome> => {
    const existing = await seams.readCurrent(key)
    const policy = nextSessionVisionPolicy(existing, normalized)
    await seams.writeNext(key, policy)
    return Object.freeze({
      policy,
      updateRevision: policy.updateRevision,
      updateOrigin: policy.updateOrigin,
      persistence: seams.persistence,
    })
  }
  return (sessionId, request) => {
    const key = normalizedSessionId(sessionId)
    const normalized = normalizeSessionVisionPolicyUpdateRequest(request)
    const previous = tails.get(key) ?? Promise.resolve()
    // Chain on rejection too: one failed apply must not poison every later
    // update on the same Session.
    const current = previous.then(
      () => run(key, normalized),
      () => run(key, normalized),
    )
    tails.set(key, current)
    void current.then(
      () => forget(key, current),
      () => forget(key, current),
    )
    return current
  }
}

/**
 * Own Session-scoped DVR intent independently of provider/model routing.
 *
 * The injected table is deliberately narrower than DSH storage-domain. This
 * module owns DVR policy semantics; the Host boundary that opens a durable
 * domain is a separate composition concern. A malformed persisted row fails
 * closed as absent policy so route-derived compatibility can remain the
 * migration fallback until the durable policy rollout is complete.
 *
 * `apply` reports the persistence of the injected table seam; callers that own
 * a volatile table pass their own degraded outcome instead.
 */
export function createSessionVisionPolicyStore(
  table: SessionVisionPolicyTable,
  options: { readonly persistence?: SessionVisionPolicyPersistence } = {},
): SessionVisionPolicyStore {
  const persistence = options.persistence ?? { kind: 'persisted' }
  return {
    get(sessionId) {
      const key = normalizedSessionId(sessionId)
      return parseSessionVisionPolicy(table.get(key))
    },

    async set(sessionId, policy) {
      const key = normalizedSessionId(sessionId)
      const normalized = parseSessionVisionPolicy(policy)
      if (normalized === undefined) {
        throw new TypeError('invalid session vision policy')
      }
      await table.put(key, normalized)
      return normalized
    },

    async delete(sessionId) {
      await table.delete(normalizedSessionId(sessionId))
    },

    apply: createSerializedSessionVisionPolicyApply({
      readCurrent: (key) => parseSessionVisionPolicy(table.get(key)),
      writeNext: async (key, policy) => {
        if (parseSessionVisionPolicy(policy) === undefined) {
          throw new TypeError('invalid session vision policy')
        }
        await table.put(key, policy)
      },
      persistence,
    }),
  }
}


/**
 * Process-scoped policy backend used while no durable Host sidecar is bound.
 *
 * The Map is closure-owned by the returned store, never process-global. It is
 * intentionally replaceable by a durable table without changing policy,
 * delegation, or authority semantics. Every apply reports the volatile
 * degradation: a process-local Map is never durable Session truth and must not
 * be presented to a user as saved state.
 */
export function createVolatileSessionVisionPolicyStore(): SessionVisionPolicyStore {
  const rows = new Map<string, Readonly<SessionVisionPolicy>>()
  return createSessionVisionPolicyStore(
    {
      get(key) {
        return rows.get(key)
      },
      async put(key, value) {
        rows.set(key, value)
      },
      async delete(key) {
        rows.delete(key)
      },
    },
    {
      persistence: { kind: 'degraded', reason: 'volatile-session-policy-store' },
    },
  )
}

/**
 * Apply one monotonic policy update through the store's durable-aware seam,
 * falling back to a read-modify-write on stores that predate `apply`.
 *
 * The fallback cannot prove durability, so its outcome is reported degraded:
 * no caller may be told "saved" when the store cannot prove the write landed
 * somewhere that survives a process restart.
 */
export async function applySessionVisionPolicyUpdate(
  store: SessionVisionPolicyStore,
  sessionId: string,
  request: SessionVisionPolicyUpdateRequest,
): Promise<SessionVisionPolicyUpdateOutcome> {
  if (typeof store.apply === 'function') {
    return await store.apply(sessionId, request)
  }
  const key = normalizedSessionId(sessionId)
  const normalized = normalizeSessionVisionPolicyUpdateRequest(request)
  const current = store.get(key)
  const policy = nextSessionVisionPolicy(current, normalized)
  await store.set(key, policy)
  return Object.freeze({
    policy,
    updateRevision: policy.updateRevision,
    updateOrigin: policy.updateOrigin,
    persistence: { kind: 'degraded', reason: 'session-policy-store-has-no-durable-update-seam' },
  })
}
