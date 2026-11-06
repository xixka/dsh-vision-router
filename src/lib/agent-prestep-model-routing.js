import { reverseRouteTarget } from './core-primitives.js'
import { redactDiagnosticText } from './diagnostic-redaction.js'
import { createVisionImageProjection } from './vision-image-projection.js'

const LEASE_VERSION = 1
const LEASE_SOURCE = 'dvr-auto'

function routeOf(value) {
  if (!value || typeof value !== 'object') return undefined
  if (typeof value.provider !== 'string' || !value.provider || typeof value.model !== 'string' || !value.model) return undefined
  return { provider: value.provider, model: value.model }
}

function sameRoute(a, b) {
  return a?.provider === b?.provider && a?.model === b?.model
}

// Complete selection snapshot mirroring the DSH 0.2.1-rc.5 ModelSelection
// contract (packages/core/agent/src/model-selection.ts): provider, model, and
// an optional adapter-owned reasoning effort. The lease saves the full
// original selection so a later text turn can restore the user's chat model
// including its effort, never a provider-defaulted guess.
function selectionOf(value) {
  const route = routeOf(value)
  if (!route) return undefined
  const record = { ...route }
  const effort = value?.reasoningEffort
  if (typeof effort === 'string' && effort !== '') record.reasoningEffort = effort
  return record
}

// Exact-match correlation for one plugin-initiated model/selection commit
// (packages/api/session-controller/src/agent.ts: session.append('model/selection',
// selection) with data {provider, model, reasoningEffort?}). The Host emits
// the event synchronously from inside agent.model.select and treats an
// identical provider/model commit as a no-op that appends nothing, so a
// retained record can never swallow a foreign selection: an external event
// either names a different route/effort (not an exact match) or cannot exist.
function sameSelection(a, b) {
  return a?.provider === b?.provider && a?.model === b?.model
    && a?.reasoningEffort === b?.reasoningEffort
}

function validMessages(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && item.role === 'user') : []
}

/**
 * Modern DSH freezes the model BEFORE agent/pre-step, while the old
 * agent/request model switch is now forbidden. The Agent's own inbox is the
 * last durable, synchronously observable input before that freeze.
 *
 * Never select during session/event: Session.append forbids reentrant appends,
 * and agent.model.select appends a model/selection event. Inbox notifications
 * and status events fire only AFTER the triggering append has returned.
 *
 * P2 provider-free routing (plan §4.3): image turns only select a REAL Host
 * provider/model attested by the caller (registered via hasAdapter and
 * explicitly image-capable); chain/wrapper or invented routes are never
 * composed. Each selection is owned by a persisted, recoverable route lease
 * ({origin, target, sessionRevision, pluginGeneration, source: 'dvr-auto'})
 * that is saved BEFORE the model selection is issued, correlated by exact
 * match so internal model/selection commits are ignored while foreign
 * selections cancel the lease, restored on later text turns while DVR still
 * owns the selection, revoked by /vision off before execution, and safely
 * recovered from the durable store after a process restart or hot reset.
 */
export function installPreStepModelRouting(ctx, options) {
  const owned = new WeakMap()
  const executedLeases = new WeakSet()
  const warning = new WeakSet()
  const agentsBySession = new WeakMap()
  const pendingInternal = new WeakMap()
  const manualOverride = new WeakSet()
  const stopping = new WeakMap()
  const recoveredSessions = new WeakSet()
  let leaseCounter = 0

  const warnOnce = (agent, message) => {
    if (warning.has(agent)) return
    warning.add(agent)
    ctx.logger?.warn?.('vision-router: modern pre-step routing unavailable: %s', redactDiagnosticText(message, 180))
  }
  const nativeModel = (agent) => {
    try {
      const model = agent?.model
      return model && typeof model.select === 'function' && typeof model.current === 'function'
        ? model : undefined
    } catch {
      return undefined
    }
  }
  const currentOf = (agent) => {
    try { return nativeModel(agent)?.current() }
    catch (error) {
      warnOnce(agent, String(error?.message ?? error).slice(0, 180))
      return undefined
    }
  }
  const readInbox = (agent) => {
    if (!agent?.session || typeof ctx.get !== 'function') return undefined
    try {
      const registry = ctx.get('sessionProjections')
      if (typeof registry?.stateOf !== 'function') return undefined
      const state = registry.stateOf(agent.session, 'inbox')
      if (!state || typeof state !== 'object') return undefined
      return {
        nextTurn: validMessages(state['next-turn']),
        nextStep: validMessages(state['next-step']),
      }
    } catch {
      return undefined
    }
  }
  const available = (provider) => {
    try { return options.hasAdapter(provider) === true } catch { return false }
  }
  const sessionIdOf = (session) => {
    try {
      if (typeof options.sessionIdOf === 'function') return options.sessionIdOf(session)
    } catch { /* fall back to the durable session identity */ }
    const id = session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  // Durable lease store (plan §4.3): composition wires the real storage. The
  // store is optional and every failure degrades to the in-memory lease
  // without blocking vision routing; a saved lease is what makes restart and
  // hot-reset recovery possible.
  const persistLease = (session, lease) => {
    const store = options.leaseStore
    const id = sessionIdOf(session)
    if (id === undefined || !store || typeof store !== 'object') return
    try { store.save(id, lease) }
    catch (error) { warnOnce(agentsBySession.get(session), String(error?.message ?? error).slice(0, 180)) }
  }
  const clearPersistedLease = (session) => {
    const store = options.leaseStore
    const id = sessionIdOf(session)
    if (id === undefined || !store || typeof store !== 'object') return
    try { store.clear(id) }
    catch { /* a stale durable lease is cleaned up by the next save or load */ }
  }
  function validPersistedLease(value) {
    if (!value || typeof value !== 'object') return undefined
    if (value.version !== LEASE_VERSION || value.source !== LEASE_SOURCE) return undefined
    const origin = selectionOf(value.origin)
    const target = routeOf(value.target)
    if (!origin || !target) return undefined
    return { ...value, origin, target }
  }
  const loadPersistedLease = (session) => {
    const store = options.leaseStore
    const id = sessionIdOf(session)
    if (id === undefined || !store || typeof store !== 'object') return undefined
    try {
      return validPersistedLease(store.load(id))
    } catch {
      return undefined
    }
  }

  const select = (agent, target, previous, reason) => {
    const targetSelection = selectionOf(target)
    if (!targetSelection || !available(targetSelection.provider) || sameRoute(targetSelection, previous)) return false
    // Keep an explicit same-route effort selection; drop provider-specific effort
    // only on a cross-route transition.
    try {
      // Correlate this internal commit BEFORE the Host call: the model/selection
      // event fires synchronously inside select and is ignored only when it
      // matches this exact selection. The record is not cleared afterwards:
      // the Host no-ops an identical provider/model commit, so an identical
      // foreign event cannot exist, and the next internal select overwrites it.
      if (agent.session) pendingInternal.set(agent.session, targetSelection)
      agent.model.select(targetSelection)
      ctx.logger?.debug?.('vision-router: pre-step model selected for %s', reason)
      return true
    } catch (error) {
      warnOnce(agent, String(error?.message ?? error).slice(0, 180))
      return false
    }
  }

  // The only selectable image route is a REAL Host provider/model attested by
  // the caller: it must be registered (hasAdapter) and explicitly image-capable
  // when a routeSupportsImages attestation is provided. No chain, wrapper, or
  // composed route id is ever fabricated here.
  const hostVisionTarget = (agent) => {
    let candidate
    try { candidate = options.hostVisionRoute?.() }
    catch (error) {
      warnOnce(agent, String(error?.message ?? error).slice(0, 180))
      return undefined
    }
    const route = routeOf(candidate)
    if (!route || !available(route.provider)) return undefined
    try {
      if (typeof options.routeSupportsImages === 'function'
        && options.routeSupportsImages(route.provider, route.model) === false) return undefined
    } catch (error) {
      warnOnce(agent, String(error?.message ?? error).slice(0, 180))
      return undefined
    }
    return route
  }

  const hasImage = (messages) => messages.some((message) => {
    try { return options.hasImage(message.content) === true } catch { return false }
  })
  const startDeepTools = () => {
    if (options.toolEnabled() && (options.autoActivateOnImageEnabled() || options.structuredBootstrapEnabled())) {
      options.activateDeepTools()
    }
  }

  const retireLease = (agent) => {
    owned.delete(agent)
    if (agent?.session) clearPersistedLease(agent.session)
  }

  const markLeaseExecuted = (agent, lease) => {
    if (executedLeases.has(lease)) return
    executedLeases.add(lease)
    const session = agent?.session
    if (session !== undefined) persistLease(session, { ...lease, executed: true })
  }

  const imageTurn = (agent, messages) => {
    const model = nativeModel(agent)
    if (!model || !hasImage(messages)) return
    // RC1 resolves step tools before agent/pre-step. Mount progressive deep
    // tools even when whole-turn routing is OFF (the default).
    startDeepTools()
    if (!options.routingEnabled()) return
    const selection = currentOf(agent)
    const source = routeOf(selection)
    if (!source) return
    const target = hostVisionTarget(agent)
    // No real Host vision model: keep the chat model unchanged and let the
    // tools/projection path serve the image (plan §4.3/§4.4).
    if (!target || sameRoute(target, source)) return
    const record = owned.get(agent)
    if (record && !sameRoute(source, routeOf(record.target))) owned.delete(agent)
    const origin = selectionOf(record?.origin) ?? selectionOf(selection)
    if (!origin) return
    const lease = {
      version: LEASE_VERSION,
      source: LEASE_SOURCE,
      origin,
      target: { provider: target.provider, model: target.model },
      sessionRevision: options.sessionRevision?.(agent?.session),
      pluginGeneration: options.pluginGeneration?.(),
      token: `lease-${++leaseCounter}`,
    }
    // Save the lease (in-memory + durable store) BEFORE the model selection so
    // a crash between the two never strands the session on a vision model
    // without a recoverable original selection.
    owned.set(agent, lease)
    persistLease(agent.session, lease)
    if (select(agent, lease.target, source, 'image turn')) {
      manualOverride.delete(agent)
    } else {
      retireLease(agent)
    }
  }
  const textTurn = (agent) => {
    const model = nativeModel(agent)
    if (!model) return
    const current = routeOf(currentOf(agent))
    if (!current || manualOverride.has(agent)) return
    const record = owned.get(agent)
    if (record) {
      // In-memory ownership of this temporary selection ends here either way;
      // the durable lease is kept until the restore succeeds so a crash
      // mid-restore can still recover the original chat model.
      owned.delete(agent)
      // Only a selection DVR still owns is restored: when the current route is
      // no longer the lease target, a user/external choice already replaced it.
      if (!sameRoute(current, routeOf(record.target))) {
        clearPersistedLease(agent.session)
        return
      }
      // reverseRouting=false explicitly keeps the visual route for later text
      // turns. Only a disabled whole-turn routing switch must restore DVR's
      // temporary image selection to the user's original model.
      if (options.routingEnabled() && !options.reverseRoutingEnabled()) return
      // Restore the actual Session model chosen before DVR routed its image,
      // including its reasoning effort. Never overwrite a different model
      // explicitly selected by the user.
      const origin = selectionOf(record.origin)
      const candidate = options.routingEnabled() && options.reverseRoutingEnabled()
        ? reverseRouteTarget(routeOf(origin), {
            pairs: options.routingPairs(),
            wrapperRoute: options.wrapperRoute(),
            wrapperRegistered: options.wrapperRegistered(),
            textProvider: options.textProvider(),
            hasAdapter: available,
          })
        : undefined
      const restoreTo = candidate ?? origin
      if (!restoreTo) {
        clearPersistedLease(agent.session)
        return
      }
      if (select(agent, restoreTo, current, 'text restore')) {
        clearPersistedLease(agent.session)
        return
      }
      if (!available(restoreTo.provider)) {
        warnOnce(agent, 'original text model is no longer registered')
      }
      return
    }
    if (!options.routingEnabled() || !options.reverseRoutingEnabled()) return
    const target = reverseRouteTarget(current, {
      pairs: options.routingPairs(),
      wrapperRoute: options.wrapperRoute(),
      wrapperRegistered: options.wrapperRegistered(),
      textProvider: options.textProvider(),
      hasAdapter: available,
    })
    select(agent, target, current, 'reverse text routing')
  }
  const nextTurn = (agent, inbox) => {
    if (!nativeModel(agent)) return
    if (!inbox) { warnOnce(agent, 'Session inbox projection unavailable'); return }
    if (!inbox.nextTurn.length) return
    if (hasImage(inbox.nextTurn)) imageTurn(agent, inbox.nextTurn)
    else textTurn(agent)
  }
  const nextStep = (agent, inbox) => {
    if (!nativeModel(agent) || !inbox?.nextStep.length) return
    // Tool-produced context is not a new user text turn. In particular, it
    // must NOT undo an image selection from an ongoing multi-step tool run.
    if (hasImage(inbox.nextStep)) imageTurn(agent, inbox.nextStep)
  }

  // Restart/hot-reset recovery (plan §4.3): an unfinished persisted lease is
  // resolved against the live selection — restore the saved original
  // selection when the vision model is still active, or drop the lease without
  // touching a user/external choice. Recovery never depends on the recording
  // plugin generation, so a hot reset recovers the previous generation's lease.
  const recoverRouteLease = (agent) => {
    const persisted = loadPersistedLease(agent?.session)
    if (!persisted) return false
    const origin = selectionOf(persisted.origin)
    const target = routeOf(persisted.target)
    if (!origin || !target) {
      clearPersistedLease(agent.session)
      return false
    }
    const current = routeOf(currentOf(agent))
    if (!current) return false
    if (sameRoute(current, target)) {
      if (select(agent, origin, current, 'lease recovery')) {
        clearPersistedLease(agent.session)
        return true
      }
      warnOnce(agent, 'persisted vision route lease could not be restored to the saved selection')
      return false
    }
    // Either the lease already ended on the original chat model, or an
    // external selection superseded it: never re-interpret a foreign choice.
    clearPersistedLease(agent.session)
    return false
  }

  const rememberAgent = (agent) => {
    if (nativeModel(agent) && agent?.session) {
      agentsBySession.set(agent.session, agent)
      if (!recoveredSessions.has(agent.session)) {
        recoveredSessions.add(agent.session)
        try { recoverRouteLease(agent) }
        catch (error) { warnOnce(agent, String(error?.message ?? error).slice(0, 180)) }
      }
    }
  }
  // Observing model/selection commits is read-only: selecting inside
  // session/event would reenter Session.append and crash. Internal commits
  // are correlated by the exact selection recorded before agent.model.select;
  // a foreign selection never matches it, so it is never swallowed by a
  // global reentrancy lock. A real provider/model change cancels the lease
  // and keeps the user's choice (existing manual-override semantics); an
  // effort-only change on the same route never closes DVR ownership.
  ctx.on('session/event', (session, event) => {
    const agent = agentsBySession.get(session)
    if (event?.type === 'turn/start') {
      // Clear the previous turn's closing-window marker without appending a
      // Session event from inside the non-reentrant Session publication.
      if (agent) stopping.delete(agent)
      return
    }
    if (event?.type === 'request/header') {
      // A recorded request header proves the leased route actually assembled a
      // model request: the lease is executed, and /vision off must leave its
      // text-turn restore intact.
      if (!agent) return
      const lease = owned.get(agent)
      if (lease && sameRoute(routeOf(event?.data?.header?.config), routeOf(lease.target))) {
        markLeaseExecuted(agent, lease)
      }
      return
    }
    if (event?.type !== 'model/selection' || !agent) return
    const pending = pendingInternal.get(session)
    const committed = selectionOf(event?.data)
    if (pending && sameSelection(pending, committed)) {
      pendingInternal.delete(session)
      return
    }
    const lease = owned.get(agent)
    if (!lease) return
    if (committed && sameRoute(committed, routeOf(lease.target))) {
      // Same-route re-commit or effort-only change: not a foreign route
      // choice, the lease stays owned by DVR.
      return
    }
    owned.delete(agent)
    manualOverride.add(agent)
    clearPersistedLease(session)
  })
  const containEarlyHook = (agent, action) => {
    try { action() }
    catch (error) {
      // agent.send() calls inbox listeners synchronously BEFORE wakeDriver().
      // A plugin failure here must not strand a durably queued user message.
      if (agent && typeof agent === 'object') warnOnce(agent, String(error?.message ?? error).slice(0, 180))
    }
  }
  ctx.on('agent/inbox/inserted', ({ agent, message } = {}) => containEarlyHook(agent, () => {
    if (!nativeModel(agent)) return
    rememberAgent(agent)
    const inbox = readInbox(agent)
    if (!inbox) { warnOnce(agent, 'Session inbox projection unavailable'); return }
    // An inserted next-turn message may be waiting behind an active step.
    // Prefer the pending next-step image; the turn-stopping and running
    // boundaries re-evaluate next-turn once the active turn finishes.
    if (message?.id && inbox.nextStep.some((item) => item.id === message.id)) {
      const previous = stopping.get(agent)
      if (previous && !manualOverride.has(agent)) {
        // A next-step steering message may arrive while turn-stopping awaits
        // other hooks, after DVR temporarily selected a queued next-turn route.
        // Reassert this turn's actual route, never the later queued turn's route.
        const current = routeOf(currentOf(agent))
        if (current && previous.route && !sameRoute(current, previous.route)) {
          if (select(agent, previous.route, current, 'closing step continuation')) {
            if (previous.owned) owned.set(agent, previous.owned)
            else owned.delete(agent)
          }
        }
      }
      nextStep(agent, inbox)
    } else if (message?.id && inbox.nextTurn.some((item) => item.id === message.id)
        && (agent.status === 'idle' || stopping.has(agent))) {
      // Once turn-stopping starts there can be a tiny gap before the next
      // turn/start where status is still running. New queued turns must not
      // miss the pre-step model selection in that window.
      nextTurn(agent, inbox)
    }
  }))
  ctx.on('agent/status', ({ agent, status } = {}) => containEarlyHook(agent, () => {
    rememberAgent(agent)
    if (status === 'running') nextTurn(agent, readInbox(agent))
  }))
  ctx.on('agent/turn-stopping', ({ agent } = {}) => {
    try {
      rememberAgent(agent)
      const selection = currentOf(agent)
      const current = routeOf(selection)
      if (current) stopping.set(agent, { route: selectionOf(selection), owned: owned.get(agent) })
      const inbox = readInbox(agent)
      if (inbox?.nextStep.length) nextStep(agent, inbox)
      else nextTurn(agent, inbox)
    } catch (error) {
      // A routing plugin must never veto the Host's turn completion.
      if (agent && typeof agent === 'object') warnOnce(agent, String(error?.message ?? error).slice(0, 180))
    }
  })
  ctx.on('agent/disposed', ({ agent } = {}) => {
    if (agent && typeof agent === 'object') {
      owned.delete(agent)
      warning.delete(agent)
      manualOverride.delete(agent)
      stopping.delete(agent)
      if (agent.session) agentsBySession.delete(agent.session)
    }
  })

  // P2 image projection (plan §4.4 preferred scheme): installed only when the
  // composition provides the projection attestations. The integration lives on
  // this routing-owned path, so runtime-composition stays untouched, and the
  // listener applies after the Host decision without ever vetoing the step.
  const projection = options.visionImageProjection
    ? createVisionImageProjection(options.visionImageProjection)
    : undefined
  if (projection) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (!decision || decision.kind !== 'enter' || !nativeModel(payload?.agent)) return decision
        // The step's model is frozen from this selection for prompt assembly
        // (packages/core/agent/src/model-selection.ts), so the route resolved
        // here is the route this request uses; projection therefore happens
        // before the Host's image admission and the adapter-boundary image
        // capability rejection.
        const route = routeOf(currentOf(payload.agent))
        return projection.applyToPreStep(route, decision)
      } catch (error) {
        // A projection failure must never veto an admitted step.
        const agent = payload?.agent
        if (agent && typeof agent === 'object') warnOnce(agent, String(error?.message ?? error).slice(0, 180))
        return decision
      }
    })
  }

  // /vision off (plan §3.1): revoke a lease that has not executed yet by
  // restoring the saved original selection while DVR still owns it. An
  // executed lease keeps its normal text-turn restore, so /vision off never
  // strands the session on the vision model.
  const revokePendingRouteLease = (agent) => {
    if (!agent || typeof agent !== 'object') return false
    const lease = owned.get(agent)
    if (!lease) return false
    if (executedLeases.has(lease)) return false
    const current = routeOf(currentOf(agent))
    const origin = selectionOf(lease.origin)
    if (current && sameRoute(current, routeOf(lease.target)) && origin
        && !sameRoute(routeOf(origin), current)) {
      select(agent, origin, current, 'vision off lease revoke')
    }
    retireLease(agent)
    return true
  }
  // Cold-session variant: a persisted lease without a live Agent is cleared
  // when it has not executed; an executed one is left for warm-up recovery,
  // which restores the saved chat model once the Session attaches again.
  const revokePersistedRouteLease = (session) => {
    const persisted = loadPersistedLease(session)
    if (!persisted) return false
    if (persisted.executed === true) return false
    clearPersistedLease(session)
    return true
  }

  return {
    nativeModel,
    projection,
    revokePendingRouteLease,
    revokePersistedRouteLease,
    recoverRouteLease,
    routeLeaseOf: (agent) => {
      const lease = owned.get(agent)
      return lease ? { ...lease, executed: executedLeases.has(lease) } : undefined
    },
  }
}
