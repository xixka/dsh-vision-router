import assert from 'node:assert/strict'
import test from 'node:test'
import { installPreStepModelRouting } from '../lib/agent-prestep-model-routing.js'
import { blocksHaveRetainedImage } from '../lib/image-offload-compat.js'

// Route-lease lifecycle coverage for the provider-free execution chain
// (plan §4.3): real Host model selection, durable lease persistence and
// ordering, exact-match internal/external selection classification, user
// override, effort-only changes, /vision off revocation, and crash/hot-reset
// recovery. The harness mirrors the DSH 0.2.1-rc.5 shapes the routing module
// consumes: Agent.model.select appends a `model/selection` session event
// synchronously (an identical provider/model commit is a no-op), the step's
// request records a frozen `request/header` event, and the inbox projection
// feeds the pre-step boundary.

const VISION_TARGET = { provider: 'hostvision', model: 'vision-pro' }
const ORIGIN_SELECTION = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }

function harness(config = {}) {
  const handlers = new Map()
  const inboxes = new WeakMap()
  const durable = config.durable ?? new Map()
  const log = { select: [], warnings: [], order: [] }
  const registered = new Set(config.adapters ?? ['deepseek-official', 'hostvision', 'third-party'])
  let agentCounter = 0
  const leaseStore = {
    load(id) { log.order.push(`load:${id}`); return durable.get(id) },
    save(id, lease) { log.order.push(`save:${id}`); durable.set(id, lease) },
    clear(id) { log.order.push(`clear:${id}`); durable.delete(id) },
  }
  const ctx = {
    get(name) {
      if (name !== 'sessionProjections') return undefined
      return { stateOf(session, key) { return key === 'inbox' ? inboxes.get(session) : undefined } }
    },
    on(name, callback) {
      const array = handlers.get(name) ?? []
      array.push(callback)
      handlers.set(name, array)
    },
    logger: { warn(...args) { log.warnings.push(args) }, debug() {} },
  }
  const coordinator = installPreStepModelRouting(ctx, {
    routingEnabled: () => config.routing ?? true,
    reverseRoutingEnabled: () => config.reverse ?? true,
    routingPairs: () => [{ provider: 'hostvision', model: 'vision-pro' }],
    wrapperRoute: () => undefined,
    wrapperRegistered: () => false,
    textProvider: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    hasAdapter: (provider) => registered.has(provider),
    hasImage: blocksHaveRetainedImage,
    toolEnabled: () => false,
    autoActivateOnImageEnabled: () => false,
    structuredBootstrapEnabled: () => false,
    activateDeepTools: () => {},
    hostVisionRoute: () => (config.noVisionRoute ? undefined : VISION_TARGET),
    ...(config.routeSupportsImages ? { routeSupportsImages: config.routeSupportsImages } : {}),
    sessionRevision: () => config.revision ?? 42,
    pluginGeneration: () => config.generation ?? 'gen-1',
    leaseStore,
  })
  const emit = (event, ...args) => {
    for (const cb of handlers.get(event) ?? []) cb(...args)
  }
  function agent(initial = ORIGIN_SELECTION) {
    const session = { id: config.sessionId ?? `session-${++agentCounter}` }
    const record = { value: { ...initial }, committed: undefined }
    const handle = {
      session, status: 'idle',
      model: {
        current() { return { ...record.value } },
        select(next) {
          if (record.committed?.provider === next.provider && record.committed?.model === next.model) return
          log.order.push('select')
          log.select.push({ ...next })
          record.value = { ...next }
          record.committed = { ...next }
          emit('session/event', session, { type: 'model/selection', data: { ...next } })
          if (config.afterSelectEmit) config.afterSelectEmit(handle)
        },
      },
    }
    inboxes.set(session, { 'next-turn': [], 'next-step': [] })
    return handle
  }
  const userText = (id = `msg-${++agentCounter}`) => ({
    id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Question' }],
  })
  const userImage = (id = `msg-${++agentCounter}`) => ({
    id, role: 'user', source: { kind: 'user' },
    content: [{ type: 'image', attachment: { attachmentId: 'sha256:lease-image' } }],
  })
  const insert = (agentHandle, message, lane = 'next-turn') => {
    inboxes.get(agentHandle.session)[lane].push(message)
    emit('agent/inbox/inserted', { agent: agentHandle, message })
  }
  const run = (agentHandle) => {
    agentHandle.status = 'running'
    emit('agent/status', { agent: agentHandle, status: 'running' })
  }
  const done = (agentHandle) => emit('agent/turn-stopping', { agent: agentHandle })
  const claim = (agentHandle, lane = 'next-turn') => {
    const laneMessages = inboxes.get(agentHandle.session)[lane]
    const messages = [...laneMessages]
    laneMessages.length = 0
    emit('session/event', agentHandle.session, {
      type: 'request/header',
      data: { header: { config: agentHandle.model.current() } },
    })
    return { model: agentHandle.model.current(), messages }
  }
  return { agent, userText, userImage, insert, run, done, claim, emit, log, coordinator, durable }
}

test('the durable lease is written before the host selection and carries the complete lease record', () => {
  const t = harness({ revision: 99, generation: 'gen-42' })
  const agent = t.agent()
  t.insert(agent, t.userImage())
  t.run(agent)
  t.claim(agent)
  const saved = t.durable.get(agent.session.id)
  assert.ok(saved, 'a lease must be durable before the selection can be lost to a crash')
  assert.equal(saved.version, 1)
  assert.equal(saved.source, 'dvr-auto')
  assert.deepEqual(saved.origin, ORIGIN_SELECTION, 'the full original selection including effort is saved')
  assert.deepEqual(saved.target, VISION_TARGET)
  assert.equal(saved.sessionRevision, 99)
  assert.equal(saved.pluginGeneration, 'gen-42')
  assert.equal(saved.executed, true, 'the executed lease is persisted with the marker for /vision off decisions')
  assert.ok(t.log.order.indexOf('select') > t.log.order.indexOf(`save:${agent.session.id}`),
    `save must strictly precede select; order=${t.log.order.join(',')}`)
})

test('image turns select the attested real Host vision route and text turns restore the chat model', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, t.userImage())
  t.run(agent)
  assert.deepEqual(t.claim(agent).model, VISION_TARGET)
  t.insert(agent, t.userText())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, ORIGIN_SELECTION)
  assert.equal(t.durable.has(agent.session.id), false)
})

test('a real user route change cancels the lease, keeps the user model and clears the durable lease', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, t.userImage())
  t.run(agent)
  t.claim(agent)
  agent.model.select({ provider: 'third-party', model: 'user-chosen' })
  assert.equal(t.coordinator.routeLeaseOf(agent), undefined)
  t.insert(agent, t.userText())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, { provider: 'third-party', model: 'user-chosen' })
  assert.equal(t.durable.has(agent.session.id), false)
})

test('an effort-only change never closes DVR ownership of the lease', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, t.userImage())
  t.run(agent)
  // An RC1 AgentModel.select with an identical provider/model is a no-op, so
  // an effort-only commit reaches DVR only as a re-committed durable selection
  // (for example a resumed Session re-consuming its pending modelSelection).
  t.emit('session/event', agent.session, {
    type: 'model/selection',
    data: { provider: 'hostvision', model: 'vision-pro', reasoningEffort: 'low' },
  })
  assert.ok(t.coordinator.routeLeaseOf(agent), 'an effort-only selection keeps the lease owned')
  t.insert(agent, t.userText())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, ORIGIN_SELECTION)
})

test('internal selection commits are ignored only on exact match, never swallowing foreign selections', () => {
  const foreign = { provider: 'third-party', model: 'foreign' }
  const t = harness({
    afterSelectEmit: (agent) => {
      t.emit('session/event', agent.session, { type: 'model/selection', data: { ...foreign } })
    },
  })
  const agent = t.agent()
  t.insert(agent, t.userImage())
  t.run(agent)
  assert.deepEqual(agent.model.current(), foreign, 'the foreign selection wins over the internal commit')
  assert.equal(t.coordinator.routeLeaseOf(agent), undefined, 'the correlation lock cancels the lease for the foreign route')
  assert.equal(t.durable.has(agent.session.id), false)
})

test('/vision off revokes a pending lease and restores the original chat selection before execution', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, t.userImage())
  t.run(agent)
  assert.equal(t.coordinator.revokePendingRouteLease(agent), true)
  assert.deepEqual(agent.model.current(), ORIGIN_SELECTION)
  assert.equal(t.durable.has(agent.session.id), false)
  t.insert(agent, t.userText())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, ORIGIN_SELECTION)
  assert.deepEqual(t.log.select, [VISION_TARGET, ORIGIN_SELECTION])
})

test('/vision off cannot revoke an executed lease: the text turn still returns the chat model', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, t.userImage())
  t.run(agent)
  t.claim(agent)
  assert.equal(t.coordinator.revokePendingRouteLease(agent), false)
  assert.ok(t.durable.has(agent.session.id), 'the executed lease is left intact for its restore')
  t.insert(agent, t.userText())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, ORIGIN_SELECTION)
  assert.equal(t.durable.has(agent.session.id), false)
})

test('restarting the process after the leased request executed restores the saved chat selection', () => {
  const durable = new Map()
  const before = harness({ durable })
  const agent = before.agent({ sessionId: 'durable-session' })
  before.insert(agent, before.userImage())
  before.run(agent)
  before.claim(agent)

  const after = harness({ durable, generation: 'gen-2' })
  const resumed = after.agent({ provider: 'hostvision', model: 'vision-pro', sessionId: 'durable-session' })
  after.insert(resumed, after.userText())
  after.run(resumed)
  assert.deepEqual(after.claim(resumed).model, ORIGIN_SELECTION)
  assert.deepEqual(after.log.select, [ORIGIN_SELECTION])
  assert.equal(durable.has('durable-session'), false)
})

test('restarting before the leased request executed also restores the saved chat selection', () => {
  const durable = new Map()
  const before = harness({ durable })
  const agent = before.agent({ sessionId: 'pending-session' })
  before.insert(agent, before.userImage())
  before.run(agent)

  const after = harness({ durable })
  const resumed = after.agent({ provider: 'hostvision', model: 'vision-pro', sessionId: 'pending-session' })
  after.insert(resumed, after.userText())
  after.run(resumed)
  assert.deepEqual(after.claim(resumed).model, ORIGIN_SELECTION)
  assert.equal(durable.has('pending-session'), false)
})

test('recovery never overrides a foreign selection that replaced the leased route', () => {
  const durable = new Map()
  const before = harness({ durable })
  const agent = before.agent({ sessionId: 'foreign-session' })
  before.insert(agent, before.userImage())
  before.run(agent)

  const after = harness({ durable })
  const resumed = after.agent({ provider: 'third-party', model: 'user-chosen', sessionId: 'foreign-session' })
  after.insert(resumed, after.userText())
  after.run(resumed)
  assert.deepEqual(after.claim(resumed).model, { provider: 'third-party', model: 'user-chosen' })
  assert.equal(after.log.select.length, 0, 'recovery must not select anything over a foreign route')
  assert.equal(durable.has('foreign-session'), false)
})

test('a cold pending lease is revoked from the durable store, an executed one is left for warm-up recovery', () => {
  const pendingDurable = new Map()
  const executedDurable = new Map()
  const pendingHost = harness({ durable: pendingDurable })
  const executedHost = harness({ durable: executedDurable })

  const pendingAgent = pendingHost.agent({ sessionId: 'cold-pending' })
  pendingHost.insert(pendingAgent, pendingHost.userImage())
  pendingHost.run(pendingAgent)

  const executedAgent = executedHost.agent({ sessionId: 'cold-executed' })
  executedHost.insert(executedAgent, executedHost.userImage())
  executedHost.run(executedAgent)
  executedHost.claim(executedAgent)

  assert.equal(pendingHost.coordinator.revokePersistedRouteLease({ id: 'cold-pending' }), true)
  assert.equal(pendingDurable.has('cold-pending'), false)
  assert.equal(executedHost.coordinator.revokePersistedRouteLease({ id: 'cold-executed' }), false)
  assert.ok(executedDurable.has('cold-executed'), 'the executed lease survives for warm-up recovery')
})

test('reverseRouting=false keeps the real vision route for text turns without losing the lease record', () => {
  const t = harness({ reverse: false })
  const agent = t.agent()
  t.insert(agent, t.userImage())
  t.run(agent)
  const first = t.claim(agent)
  assert.deepEqual(first.model, VISION_TARGET)
  t.insert(agent, t.userText())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, VISION_TARGET)
  assert.ok(t.durable.has(agent.session.id), 'the lease is kept for a later restore once reverse routing is re-enabled')
})

test('without any host vision model the chat model never changes and no lease is written', () => {
  const t = harness({ noVisionRoute: true })
  const agent = t.agent()
  t.insert(agent, t.userImage())
  t.run(agent)
  assert.deepEqual(t.claim(agent).model, ORIGIN_SELECTION)
  assert.equal(t.log.select.length, 0)
  assert.equal(t.durable.size, 0)
  assert.equal(t.coordinator.routeLeaseOf(agent), undefined)
})

test('a host vision route that fails the image-capability attestation is never selected', () => {
  const t = harness({ routeSupportsImages: () => false })
  const agent = t.agent()
  t.insert(agent, t.userImage())
  t.run(agent)
  assert.deepEqual(t.claim(agent).model, ORIGIN_SELECTION)
  assert.equal(t.log.select.length, 0)
  assert.equal(t.durable.size, 0)
})
