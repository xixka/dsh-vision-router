import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import {
  applySessionVisionPolicyUpdate,
  createSessionVisionPolicyStore,
  createVolatileSessionVisionPolicyStore,
  normalizeSessionVisionPolicyUpdateRequest,
  nextSessionVisionPolicy,
  parseSessionVisionPolicy,
} from '../lib/session-vision-policy.js'
import { createSessionVisionPolicyRuntimeStore } from '../lib/session-vision-policy-domain.js'
import {
  createVisionSessionService,
} from '../lib/vision-session-service.js'
import { materializeDelegatedSessionVisionPolicy } from '../lib/session-vision-delegation.js'

function memoryTable(seed = []) {
  const rows = new Map(seed)
  return {
    rows,
    get(key) {
      return rows.get(key)
    },
    async put(key, value) {
      rows.set(key, value)
    },
    async delete(key) {
      rows.delete(key)
    },
  }
}

function runtimeContext(facility) {
  const disposers = []
  const ctx = {
    get(name) {
      return name === 'storageDomain' ? facility : undefined
    },
    effect(factory, label) {
      const dispose = factory()
      disposers.push({ dispose, label })
      return dispose
    },
    logger: { warn() {} },
  }
  return { ctx, disposers }
}

function fakeFacility(rows, { putThrows = false } = {}) {
  return {
    async open(spec) {
      assert.equal(spec.name, 'vision_router_session_policy')
      return {
        async table(name) {
          assert.equal(name, 'policies')
          return {
            get: (key) => rows.get(key),
            put: async (key, value) => {
              if (putThrows) throw new Error('disk full')
              rows.set(key, value)
            },
            delete: async (key) => {
              rows.delete(key)
            },
          }
        },
        close: async () => {},
      }
    },
  }
}

test('policy updates mint strictly monotonic revisions with the update origin', async () => {
  const table = memoryTable()
  const service = createVisionSessionService({ store: createSessionVisionPolicyStore(table) })
  const first = await service.setMode({ sessionId: 's1', enabled: true, origin: 'command' })
  const second = await service.setMode({ sessionId: 's1', enabled: false, origin: 'acp' })
  const third = await service.setMode({ sessionId: 's1', enabled: true, origin: 'service' })
  assert.deepEqual(
    [first.updateRevision, second.updateRevision, third.updateRevision],
    [1, 2, 3],
  )
  assert.deepEqual(table.rows.get('s1'), {
    revision: 1,
    enabled: true,
    source: 'user',
    updateRevision: 3,
    updateOrigin: 'service',
  })
})

test('concurrent on/off updates serialize with distinct revisions', async () => {
  const table = memoryTable()
  const service = createVisionSessionService({ store: createSessionVisionPolicyStore(table) })
  const [on, off] = await Promise.all([
    service.setMode({ sessionId: 's1', enabled: true, origin: 'surface-a' }),
    service.setMode({ sessionId: 's1', enabled: false, origin: 'surface-b' }),
  ])
  assert.equal(new Set([on.updateRevision, off.updateRevision]).size, 2)
  assert.deepEqual([on.updateRevision, off.updateRevision].sort(), [1, 2])
  const current = table.rows.get('s1')
  assert.equal(current.updateRevision, 2)
  assert.equal(current.updateOrigin, 'surface-b')
  assert.equal(current.enabled, false)
})

test('the update-seam fallback stays monotonic and reports an explicit degraded outcome', async () => {
  const rows = new Map()
  const legacyStore = {
    get: (id) => rows.get(id),
    set: async (id, policy) => {
      rows.set(id, policy)
      return policy
    },
    delete: async (id) => {
      rows.delete(id)
    },
  }
  const first = await applySessionVisionPolicyUpdate(legacyStore, 's1', {
    enabled: true,
    source: 'user',
    origin: 'command',
  })
  assert.equal(first.updateRevision, 1)
  assert.equal(first.persistence.kind, 'degraded')
  assert.match(first.persistence.reason, /no-durable-update-seam/)
  const second = await applySessionVisionPolicyUpdate(legacyStore, 's1', {
    enabled: false,
    source: 'user',
    origin: 'command',
  })
  assert.equal(second.updateRevision, 2)
})

test('the volatile store never claims durable persistence for an update', async () => {
  const store = createVolatileSessionVisionPolicyStore()
  const outcome = await applySessionVisionPolicyUpdate(store, 's1', {
    enabled: true,
    source: 'user',
    origin: 'command',
  })
  assert.deepEqual(outcome.persistence, { kind: 'degraded', reason: 'volatile-session-policy-store' })
  assert.equal(outcome.policy.enabled, true)
})

test('the runtime store persists updates through the storage-domain sidecar', async () => {
  const rows = new Map()
  const { ctx } = runtimeContext(fakeFacility(rows))
  const store = createSessionVisionPolicyRuntimeStore(ctx)
  assert.equal(store.durable, true)
  const outcome = await applySessionVisionPolicyUpdate(store, 'session-cold', {
    enabled: true,
    source: 'user',
    origin: 'command',
  })
  assert.deepEqual(outcome.persistence, { kind: 'persisted' })
  assert.equal(outcome.updateRevision, 1)
  assert.equal(rows.get('session-cold').enabled, true)
  assert.equal(rows.get('session-cold').updateOrigin, 'command')

  // Hot reset: a later plugin generation rebuilds from the same durable truth
  // and continues the revision counter instead of restarting it.
  const nextGeneration = createSessionVisionPolicyRuntimeStore(ctx)
  const service = createVisionSessionService({ store: nextGeneration })
  const status = await service.getStatus('session-cold')
  assert.equal(status.enabled, true)
  assert.equal(status.updateRevision, 1)
  assert.equal(status.persistence, 'persisted')
  const continued = await service.setMode({ sessionId: 'session-cold', enabled: false, origin: 'command' })
  assert.equal(continued.updateRevision, 2)
  assert.equal(rows.get('session-cold').updateRevision, 2)
})

test('a missing storage-domain capability degrades explicitly while staying usable in-process', async () => {
  const { ctx } = runtimeContext(undefined)
  const store = createSessionVisionPolicyRuntimeStore(ctx)
  assert.equal(store.durable, false)
  const outcome = await applySessionVisionPolicyUpdate(store, 's1', {
    enabled: true,
    source: 'user',
    origin: 'command',
  })
  assert.equal(outcome.persistence.kind, 'degraded')
  assert.match(outcome.persistence.reason, /storage-domain-unavailable/)
  assert.equal(outcome.policy.enabled, true)
  assert.equal(store.get('s1').enabled, true)
})

test('a failed durable write pins the degradation reason for every later update', async () => {
  const rows = new Map()
  const { ctx } = runtimeContext(fakeFacility(rows, { putThrows: true }))
  const store = createSessionVisionPolicyRuntimeStore(ctx)
  const outcome = await applySessionVisionPolicyUpdate(store, 's1', {
    enabled: true,
    source: 'user',
    origin: 'command',
  })
  assert.equal(outcome.persistence.kind, 'degraded')
  assert.match(outcome.persistence.reason, /session-policy-storage-failed/)
  assert.equal(store.durable, false)
  const status = await createVisionSessionService({ store }).getStatus('s1')
  assert.equal(status.enabled, true)
  assert.equal(status.persistence, 'degraded')
})

test('sub-agents inherit the delegated snapshot and can override it locally', async () => {
  const table = memoryTable()
  const store = createSessionVisionPolicyStore(table)
  const service = createVisionSessionService({ store })
  await service.setMode({ sessionId: 'parent', enabled: true, origin: 'command' })
  const delegated = await materializeDelegatedSessionVisionPolicy(
    store,
    { id: 'parent' },
    { id: 'child' },
    () => ({ enabled: true }),
  )
  assert.equal(delegated.status, 'materialized')
  const inherited = await service.getStatus('child')
  assert.equal(inherited.enabled, true)
  assert.equal(inherited.source, 'delegation')
  assert.equal(inherited.inheritedFrom, 'parent')
  const override = await service.setMode({ sessionId: 'child', enabled: false, origin: 'command' })
  assert.equal(override.policy.enabled, false)
  const after = await service.getStatus('child')
  assert.equal(after.enabled, false)
  assert.equal(after.source, 'user')
})

test('policy rows round-trip the new fields and fail closed on malformed values', () => {
  assert.deepEqual(
    parseSessionVisionPolicy({
      revision: 1,
      enabled: true,
      source: 'user',
      updateRevision: 3,
      updateOrigin: 'command',
    }),
    {
      revision: 1,
      enabled: true,
      source: 'user',
      updateRevision: 3,
      updateOrigin: 'command',
    },
  )
  assert.deepEqual(
    parseSessionVisionPolicy({
      revision: 1,
      enabled: false,
      source: 'delegation',
      inheritedFrom: 'parent',
      updateRevision: 2,
      updateOrigin: 'delegation',
    }),
    {
      revision: 1,
      enabled: false,
      source: 'delegation',
      inheritedFrom: 'parent',
      updateRevision: 2,
      updateOrigin: 'delegation',
    },
  )
  // Rows written before the field existed keep parsing unchanged.
  assert.deepEqual(
    parseSessionVisionPolicy({ revision: 1, enabled: true, source: 'user' }),
    { revision: 1, enabled: true, source: 'user' },
  )
  for (const malformed of [
    { revision: 1, enabled: true, source: 'user', updateRevision: 0 },
    { revision: 1, enabled: true, source: 'user', updateRevision: -1 },
    { revision: 1, enabled: true, source: 'user', updateRevision: 1.5 },
    { revision: 1, enabled: true, source: 'user', updateRevision: 'x' },
    { revision: 1, enabled: true, source: 'user', updateOrigin: '' },
    { revision: 1, enabled: true, source: 'user', updateOrigin: 42 },
  ]) {
    assert.equal(parseSessionVisionPolicy(malformed), undefined, JSON.stringify(malformed))
  }
  const request = { enabled: true, source: 'user', origin: 'command' }
  assert.equal(nextSessionVisionPolicy(undefined, request).updateRevision, 1)
  assert.equal(
    nextSessionVisionPolicy(parseSessionVisionPolicy({
      revision: 1,
      enabled: true,
      source: 'user',
      updateRevision: 3,
      updateOrigin: 'command',
    }), request).updateRevision,
    4,
  )
  assert.throws(
    () => normalizeSessionVisionPolicyUpdateRequest({ enabled: true, source: 'user', origin: '  ' }),
    /non-empty origin/,
  )
  assert.throws(
    () => normalizeSessionVisionPolicyUpdateRequest({ enabled: true, source: 'user', inheritedFrom: 'p', origin: 'command' }),
    /cannot declare inheritedFrom/,
  )
  assert.throws(
    () => normalizeSessionVisionPolicyUpdateRequest({ enabled: true, source: 'delegation', origin: 'command' }),
    /require inheritedFrom/,
  )
})

test('the mode boundary teaches /vision on and no longer points at the retired composer control', async () => {
  const boundary = await readFile(
    new URL('../lib/session-vision-mode-boundary.js', import.meta.url),
    'utf8',
  )
  assert.match(boundary, /run \/vision on before using Vision Router tools/)
  assert.doesNotMatch(boundary, /enable the composer Vision control/)
})

test('runtime composition wires the session service and the /vision command registration', async () => {
  const composition = await readFile(
    new URL('../lib/runtime-composition.js', import.meta.url),
    'utf8',
  )
  assert.match(composition, /createVisionSessionService\(\{/)
  assert.match(composition, /installVisionCommand\(/)
  assert.match(composition, /store: sessionVisionPolicyStore/)
})
