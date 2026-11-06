import assert from 'node:assert/strict'
import test from 'node:test'
import { installPreStepModelRouting } from '../lib/agent-prestep-model-routing.js'
import { blocksHaveRetainedImage } from '../lib/image-offload-compat.js'

const source = (kind = 'user') => ({ kind })
let sequence = 0
const text = (id = String(++sequence)) => ({
  id, role: 'user', source: source(), content: [{ type: 'text', text: 'Question' }],
})
const image = (id = String(++sequence), offloaded = false) => ({
  id, role: 'user', source: source(), content: [{ type: 'image', attachment: { attachmentId: 'mock' }, ...(offloaded ? { offloaded: true } : {}) }],
})
const special = (id = String(++sequence)) => ({
  id, role: 'user', source: source('plugin:dsh-vision-router'), content: [{ type: 'text', text: 'Tool result' }],
})

const VISION_TARGET = { provider: 'hostvision', model: 'vision-pro' }
const ORIGIN_SELECTION = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }

function harness(config = {}) {
  const handlers = new Map()
  const inboxes = new WeakMap()
  const deferredSelections = new WeakMap()
  const registered = new Set(config.adapters ?? ['deepseek-official', 'hostvision', 'hostvision-b', 'third-party'])
  const log = { select: [], warnings: [], deepToolActivations: 0, order: [] }
  const durable = config.durableLeases ?? new Map()
  const leaseStore = {
    load(id) { log.order.push(`load:${id}`); return durable.get(id) },
    save(id, lease) { log.order.push(`save:${id}`); durable.set(id, lease) },
    clear(id) { log.order.push(`clear:${id}`); durable.delete(id) },
  }
  let routing = config.routing ?? true
  let reverse = config.reverse ?? true
  let tool = config.tool ?? true
  let agentCounter = 0
  const ctx = {
    get(name) {
      if (config.noProjection || name !== 'sessionProjections') return undefined
      return { stateOf(session, key) { return key === 'inbox' ? inboxes.get(session) : undefined } }
    },
    on(name, callback) {
      const array = handlers.get(name) ?? []
      array.push(callback)
      handlers.set(name, array)
    },
    logger: { warn(...args) { log.warnings.push(args) }, debug() {} },
  }
  const options = {
    routingEnabled: () => routing,
    reverseRoutingEnabled: () => reverse,
    routingPairs: () => [{ provider: 'hostvision', model: 'vision-pro' }],
    wrapperRoute: () => undefined,
    wrapperRegistered: () => false,
    textProvider: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    hasAdapter: (provider) => registered.has(provider),
    hasImage: blocksHaveRetainedImage,
    toolEnabled: () => tool,
    autoActivateOnImageEnabled: () => true,
    structuredBootstrapEnabled: () => false,
    activateDeepTools: () => { log.deepToolActivations++; if (config.throwActivation) throw new Error(config.activationError || 'synthetic tool mount fault') },
    hostVisionRoute: () => {
      if (config.throwVisionRoute) throw new Error('synthetic host vision route fault')
      return config.noVisionRoute ? undefined : VISION_TARGET
    },
    ...(config.routeSupportsImages ? { routeSupportsImages: config.routeSupportsImages } : {}),
    sessionRevision: () => config.revision ?? 7,
    pluginGeneration: () => config.generation ?? 'gen-1',
    leaseStore,
  }
  const coordinator = installPreStepModelRouting(ctx, options)
  const emit = (event, ...args) => {
    for (const cb of handlers.get(event) ?? []) cb(...args)
  }
  let activeAppend = false
  function agent(initial = ORIGIN_SELECTION) {
    const session = { id: `session-${++agentCounter}` }
    const selected = { ...initial }
    const record = { value: selected, committed: undefined }
    const result = {
      session, status: 'idle',
      model: {
        current() { return { ...record.value } },
        select(next) {
          assert.equal(activeAppend, false, 'model.select must never reenter a Session append')
          // Match real RC1 AgentModel.select: an already recorded identical
          // provider/model is a no-op, not a new accepted user intent.
          if (record.committed?.provider === next.provider && record.committed?.model === next.model) return
          log.order.push('select')
          log.select.push({ ...next })
          record.value = { ...next }
          record.committed = { ...next }
          const event = { type: 'model/selection', data: { ...next } }
          if (config.deferSelectEvents) {
            // Async-Host modeling: the model/selection event fires later than
            // the select() call, so the exact-match correlation record stays
            // live across the window.
            const queue = deferredSelections.get(session) ?? []
            queue.push(event)
            deferredSelections.set(session, queue)
            return
          }
          emit('session/event', session, event)
        },
      },
    }
    inboxes.set(session, { 'next-turn': [], 'next-step': [] })
    return result
  }
  const flushSelections = (agent) => {
    const queue = deferredSelections.get(agent.session) ?? []
    deferredSelections.set(agent.session, [])
    for (const event of queue) emit('session/event', agent.session, event)
  }
  function insert(agent, message, lane = 'next-turn') {
    activeAppend = true
    const pending = inboxes.get(agent.session)
    pending[lane].push(message)
    activeAppend = false
    emit('agent/inbox/inserted', { agent, message })
  }
  function run(agent) {
    agent.status = 'running'
    emit('agent/status', { agent, status: 'running' })
  }
  function done(agent) {
    emit('agent/turn-stopping', { agent })
  }
  function claim(agent, lane = 'next-turn') {
    const messages = inboxes.get(agent.session)[lane]
    const copy = [...messages]
    messages.length = 0
    // Real DSH records the frozen request header when the step's request is
    // built (agent-loop buildRequest): the leased route counts as executed.
    emit('session/event', agent.session, {
      type: 'request/header',
      data: { header: { config: agent.model.current() } },
    })
    return { model: agent.model.current(), messages: copy }
  }
  return {
    agent, insert, run, done, claim, emit, flushSelections, log, coordinator, durable,
    configure(next) { if ('routing' in next) routing = next.routing; if ('reverse' in next) reverse = next.reverse; if ('tool' in next) tool = next.tool },
    removeAdapter: (provider) => registered.delete(provider),
  }
}

test('provider-free image selection commits the real Host vision route BEFORE pre-step', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  const step = t.claim(agent)
  assert.deepEqual(step.model, VISION_TARGET)
  assert.equal(t.log.deepToolActivations >= 1, true)
  assert.deepEqual(t.log.select, [VISION_TARGET])
  assert.deepEqual(t.coordinator.nativeModel(agent), agent.model)
})

test('the route lease is saved with the full original selection before the model selection', () => {
  const t = harness({ revision: 12, generation: 'gen-9' })
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  const lease = t.coordinator.routeLeaseOf(agent)
  assert.ok(lease, 'a live lease must exist while the image turn owns the selection')
  assert.equal(lease.version, 1)
  assert.equal(lease.source, 'dvr-auto')
  assert.deepEqual(lease.origin, ORIGIN_SELECTION)
  assert.deepEqual(lease.target, VISION_TARGET)
  assert.equal(lease.sessionRevision, 12)
  assert.equal(lease.pluginGeneration, 'gen-9')
  assert.equal(lease.executed, true, 'the claimed request header marks the lease executed')
  // The durable save precedes the host model selection (the first store op for
  // this session is the recovery load, not a write): a crash between the two
  // still leaves a recoverable original selection.
  const saveAt = t.log.order.indexOf('save:session-1')
  const selectAt = t.log.order.indexOf('select')
  assert.ok(saveAt >= 0 && selectAt > saveAt, `save must precede select; order=${t.log.order.join(',')}`)
  assert.deepEqual(t.durable.get('session-1'), lease)
})

test('no available Host vision route keeps the chat model unchanged', () => {
  const t = harness({ noVisionRoute: true })
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  const step = t.claim(agent)
  assert.equal(step.model.provider, 'deepseek-official')
  assert.equal(t.log.select.length, 0)
  assert.equal(t.log.deepToolActivations >= 1, true, 'the tools path still mounts without a host vision model')
})

test('a host vision route without attested image support is not selected', () => {
  const t = harness({ routeSupportsImages: () => false })
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  assert.equal(t.claim(agent).model.provider, 'deepseek-official')
  assert.equal(t.log.select.length, 0)
})

test('RC1 restores original text selection, including its reasoning effort, on next turn', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  t.insert(agent, text())
  t.done(agent)
  const next = t.claim(agent)
  assert.deepEqual(next.model, ORIGIN_SELECTION)
  assert.equal(t.log.select.length, 2)
  assert.equal(t.durable.has('session-1'), false, 'the durable lease is retired after the restore')
})

test('mixed queued image plus text is routed as an image regardless of append order', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.insert(agent, text())
  t.run(agent)
  assert.equal(t.claim(agent).model.provider, 'hostvision')
})

test('queued next-turn text never overrides a live step with pending next-step image', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  t.insert(agent, image(), 'next-step')
  t.insert(agent, text())
  assert.equal(agent.model.current().provider, 'hostvision')
  assert.equal(t.claim(agent, 'next-step').model.provider, 'hostvision')
  t.done(agent)
  assert.equal(t.claim(agent).model.provider, 'deepseek-official')
})

test('user steer and internal tool context do not undo an active vision turn', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  t.insert(agent, special(), 'next-step')
  t.insert(agent, text(), 'next-step')
  assert.equal(t.claim(agent, 'next-step').model.provider, 'hostvision')
})

test('text-only user turns retain external manually selected model', () => {
  const t = harness()
  const agent = t.agent({ provider: 'custom-text', model: 'custom-model' })
  t.insert(agent, text())
  t.run(agent)
  assert.equal(t.claim(agent).model.provider, 'custom-text')
  assert.equal(t.log.select.length, 0)
})

test('manual model changes are never overridden by stale DVR restoration state', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  agent.model.select({ provider: 'third-party', model: 'chosen' })
  t.insert(agent, text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, { provider: 'third-party', model: 'chosen' })
  assert.equal(t.durable.has('session-1'), false, 'a real user route change cancels the persisted lease')
})

test('a foreign selection inside the internal select window is not swallowed by the correlation lock', () => {
  // Async-Host modeling: the image-turn commit's model/selection event has
  // not fired yet, so the exact-match correlation record is still live when a
  // foreign user selection commits. Flushing in commit order proves the
  // internal event is ignored ONLY because it matches the record, while the
  // foreign selection cancels the lease instead of being swallowed.
  const foreign = { provider: 'third-party', model: 'foreign' }
  const t = harness({ deferSelectEvents: true })
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  assert.ok(t.coordinator.routeLeaseOf(agent), 'the lease survives while its internal commit is still pending')
  agent.model.select(foreign)
  t.flushSelections(agent)
  assert.deepEqual(agent.model.current(), foreign, 'the foreign selection wins over the internal image-turn commit')
  assert.equal(t.coordinator.routeLeaseOf(agent), undefined, 'the lease is canceled, not silently kept')
  t.insert(agent, text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, foreign)
})

test('effort-only external selection on the leased route never closes DVR ownership', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  // An RC1 AgentModel.select with an identical provider/model is a no-op, so
  // an effort-only commit reaches DVR only as a re-committed durable selection
  // (for example a resumed Session re-consuming its pending modelSelection).
  t.emit('session/event', agent.session, {
    type: 'model/selection',
    data: { provider: 'hostvision', model: 'vision-pro', reasoningEffort: 'low' },
  })
  assert.ok(t.coordinator.routeLeaseOf(agent), 'an effort-only change must not cancel the lease')
  t.insert(agent, text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, ORIGIN_SELECTION)
})

test('/vision off revokes a not-yet-executed lease and restores the original chat selection', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  assert.equal(t.coordinator.revokePendingRouteLease(agent), true)
  assert.deepEqual(agent.model.current(), ORIGIN_SELECTION)
  assert.equal(t.durable.has('session-1'), false)
  // /vision off also closes the session's auto-routing at the composition
  // boundary (plan §3.1: off governs the next prompt assembly), so the still
  // queued image turn must not open a fresh lease for the chat model.
  t.configure({ routing: false })
  t.insert(agent, text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, ORIGIN_SELECTION)
  assert.equal(t.log.select.length, 2)
})

test('/vision off leaves an executed lease intact so the text turn still restores the chat model', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  assert.equal(t.coordinator.revokePendingRouteLease(agent), false, 'an executed lease is not a pending revoke target')
  assert.ok(t.durable.has('session-1'), 'the durable lease survives until its text-turn restore')
  t.insert(agent, text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, ORIGIN_SELECTION)
  assert.equal(t.durable.has('session-1'), false)
})

test('a crash between lease save and restore is recovered from the durable store on restart', () => {
  const durable = new Map()
  const before = harness({ durableLeases: durable })
  const agent = before.agent()
  before.insert(agent, image())
  before.run(agent)
  before.claim(agent)
  // Process restart: a fresh coordinator (new plugin generation) rebuilds
  // from the same durable lease while the session still points at the vision route.
  const after = harness({ durableLeases: durable, generation: 'gen-2' })
  const resumed = after.agent({ provider: 'hostvision', model: 'vision-pro' })
  after.insert(resumed, text())
  after.run(resumed)
  assert.deepEqual(after.claim(resumed).model, ORIGIN_SELECTION)
  assert.deepEqual(after.log.select, [ORIGIN_SELECTION])
  assert.equal(durable.has(resumed.session.id), false)
})

test('recovery drops the lease without touching a user selection that superseded it', () => {
  const durable = new Map()
  const before = harness({ durableLeases: durable })
  const agent = before.agent()
  before.insert(agent, image())
  before.run(agent)
  const after = harness({ durableLeases: durable })
  const resumed = after.agent({ provider: 'third-party', model: 'chosen' })
  after.insert(resumed, text())
  after.run(resumed)
  assert.equal(after.log.select.length, 0, 'recovery never re-interprets a foreign selection as its own lease')
  assert.deepEqual(after.claim(resumed).model, { provider: 'third-party', model: 'chosen' })
  assert.equal(durable.has(resumed.session.id), false)
})

test('disabled routing restores an owned image route, then preserves user model', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  t.configure({ routing: false })
  t.insert(agent, text())
  t.done(agent)
  assert.equal(t.claim(agent).model.provider, 'deepseek-official')
})

test('offloaded image is not used to auto-select a vision provider', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image(undefined, true))
  t.run(agent)
  assert.equal(t.claim(agent).model.provider, 'deepseek-official')
  assert.equal(t.log.select.length, 0)
})

test('unavailable adapter and projection fail closed without inventing a route', () => {
  const t = harness({ adapters: ['deepseek-official'] })
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  assert.equal(t.claim(agent).model.provider, 'deepseek-official')
  const noInbox = harness({ noProjection: true })
  const another = noInbox.agent()
  noInbox.insert(another, image())
  noInbox.run(another)
  assert.equal(another.model.current().provider, 'deepseek-official')
  assert.equal(noInbox.log.warnings.length, 1)
})

test('legacy Agent without model selector remains outside modern routing', () => {
  const t = harness()
  const agent = { session: {}, status: 'idle' }
  t.emit('agent/status', { agent, status: 'running' })
  t.emit('agent/inbox/inserted', { agent, message: image() })
  assert.equal(t.coordinator.nativeModel(agent), undefined)
  assert.equal(t.log.select.length, 0)
})

test('unloading removes Agent-owned routing record without altering user selection', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  t.emit('agent/disposed', { agent })
  agent.model.select({ provider: 'deepseek-official', model: 'chosen' })
  t.insert(agent, text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, { provider: 'deepseek-official', model: 'chosen' })
})

test('default tool-only mode activates deep tools before RC1 tool admission without switching model', () => {
  const t = harness({ routing: false })
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  const request = t.claim(agent)
  assert.equal(request.model.provider, 'deepseek-official')
  assert.equal(t.log.deepToolActivations >= 1, true)
  assert.equal(t.log.select.length, 0)
})

test('explicit manual selection of a different vision route is never treated as auto reverse routing', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  agent.model.select({ provider: 'hostvision-b', model: 'vision-pro' })
  t.insert(agent, text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, { provider: 'hostvision-b', model: 'vision-pro' })
})

test('RC1 same-route no-op emits no manual intent and preserves DVR-owned restoration', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  const chosen = agent.model.current()
  const before = t.log.select.length
  agent.model.select(chosen)
  assert.equal(t.log.select.length, before, 'identical Host model selection does not append')
  t.insert(agent, text())
  t.done(agent)
  assert.deepEqual(t.claim(agent).model, ORIGIN_SELECTION)
})

test('next-turn arriving just after turn-stopping is selected before the next preStep', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  t.done(agent)
  t.insert(agent, text())
  assert.equal(t.claim(agent).model.provider, 'deepseek-official')
})
test('late next-step steer after selecting next-turn restores active turn authority', () => {
  const t = harness()
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  t.insert(agent, text())
  t.done(agent)
  assert.equal(agent.model.current().provider, 'deepseek-official')
  t.insert(agent, text(), 'next-step')
  assert.equal(t.claim(agent, 'next-step').model.provider, 'hostvision')
  t.done(agent)
  assert.equal(t.claim(agent).model.provider, 'deepseek-official')
})

test('reverseRouting=false retains visual model for subsequent text (legacy setting parity)', () => {
  const t = harness({ routing: true, reverse: false })
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  const first = t.claim(agent)
  assert.equal(first.model.provider, 'hostvision')
  t.insert(agent, text())
  t.done(agent)
  const second = t.claim(agent)
  assert.deepEqual(second.model, first.model)
  assert.equal(t.log.select.length, 1)
})
test('turning off whole-turn routing restores user model even when reverseRouting=false', () => {
  const t = harness({ routing: true, reverse: false })
  const agent = t.agent()
  t.insert(agent, image())
  t.run(agent)
  t.claim(agent)
  t.configure({ routing: false })
  t.insert(agent, text())
  t.done(agent)
  assert.equal(t.claim(agent).model.provider, 'deepseek-official')
})

test('early tool mount failure does not strand an accepted inbox message before Host wake', () => {
  const t = harness({ throwActivation: true })
  const agent = t.agent()
  assert.doesNotThrow(() => t.insert(agent, image()))
  assert.doesNotThrow(() => t.run(agent))
  const step = t.claim(agent)
  assert.equal(step.messages.length, 1)
  assert.equal(step.model.provider, 'deepseek-official', 'failed mounting must not pretend visual routing succeeded')
  assert.equal(t.log.warnings.length, 1)
  assert.match(String(t.log.warnings[0][1]), /tool mount fault/)
})
test('malformed host vision route config never vetoes Host wake or drops a queued image', () => {
  const t = harness({ throwVisionRoute: true })
  const agent = t.agent()
  assert.doesNotThrow(() => t.insert(agent, image()))
  assert.doesNotThrow(() => t.run(agent))
  assert.equal(t.claim(agent).messages.length, 1)
  assert.equal(agent.model.current().provider, 'deepseek-official')
  assert.equal(t.log.warnings.length, 1)
})

test('early Hook logs redact provider credentials without changing queued message delivery', () => {
  // Assemble a synthetic provider-shaped token at runtime so source scans do
  // not mistake test-only sentinel bytes for a checked-in real credential.
  const secret = ['sk', 'proj', 'test-only-not-a-live-key', '123456789'].join('-')
  const t = harness({ throwActivation: true, activationError: 'upstream error Authorization: Bearer ' + secret })
  const agent = t.agent()
  assert.doesNotThrow(() => t.insert(agent, image()))
  assert.doesNotThrow(() => t.run(agent))
  assert.equal(t.claim(agent).messages.length, 1)
  assert.equal(t.log.warnings.length, 1)
  const warning = JSON.stringify(t.log.warnings)
  assert.ok(warning.includes('[REDACTED]'), warning)
  assert.ok(!warning.includes(secret), 'credential must not reach logs')
})
