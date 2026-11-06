import assert from 'node:assert/strict'
import test from 'node:test'

import { buildVisionCommandDefinition } from '../lib/vision-command.js'
import {
  createVisionSessionService,
  VisionSessionServiceError,
} from '../lib/vision-session-service.js'
import {
  createSessionVisionPolicyStore,
  nextSessionVisionPolicy,
} from '../lib/session-vision-policy.js'

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

function imageBlock(id = 'img-1') {
  return Object.freeze({
    type: 'image',
    attachment: Object.freeze({
      attachmentId: `sha256:${id}`,
      mediaType: 'image/png',
      bytes: 8,
      width: 4,
      height: 4,
    }),
  })
}

function fileBlock(id = 'file-1') {
  return Object.freeze({
    type: 'file',
    attachment: Object.freeze({
      attachmentId: `sha256:${id}`,
      name: `${id}.txt`,
      bytes: 8,
    }),
  })
}

function makeAgent(id = 'session-a', overrides = {}) {
  const steered = []
  return {
    id,
    steered,
    steer(message) {
      steered.push(message)
    },
    ...overrides,
  }
}

// A store whose apply() is synchronous inside the promise body; tests rearm
// gate when they need to hold a submission mid-flight.
function controlledStore({ gate } = {}) {
  const rows = new Map()
  const store = {
    get: (id) => rows.get(id),
    set: async (id, policy) => {
      rows.set(id, policy)
      return policy
    },
    delete: async (id) => {
      rows.delete(id)
    },
    apply: async (id, request) => {
      if (gate) await gate.promise
      const policy = nextSessionVisionPolicy(rows.get(id), request)
      rows.set(id, policy)
      return {
        policy,
        updateRevision: policy.updateRevision,
        updateOrigin: policy.updateOrigin,
        persistence: { kind: 'persisted' },
      }
    },
  }
  return { store, rows }
}

function tableService() {
  const table = memoryTable()
  const service = createVisionSessionService({ store: createSessionVisionPolicyStore(table) })
  return { service, rows: table.rows, definition: buildVisionCommandDefinition({ service }) }
}

test('attachments without any image are rejected with the mode unchanged', async () => {
  const { rows, definition } = tableService()
  const agent = makeAgent()
  const result = await definition.handler({
    commandId: 'cmd-test',
    agent,
    rawInput: '总结这些文件',
    attachments: [fileBlock('a'), fileBlock('b')],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /at least one image attachment/)
  assert.equal(rows.size, 0)
  assert.equal(agent.steered.length, 0)
})

test('mixed submissions preserve attachment order and pass the durable blocks through', async () => {
  const { definition } = tableService()
  const agent = makeAgent()
  const file = fileBlock('notes')
  const imageA = imageBlock('shot-a')
  const imageB = imageBlock('shot-b')
  const result = await definition.handler({
    commandId: 'cmd-test',
    agent,
    rawInput: '对照文件和两张截图',
    attachments: [file, imageA, imageB],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.equal(agent.steered.length, 1)
  const content = agent.steered[0].content
  assert.deepEqual(content, [
    { type: 'text', text: '对照文件和两张截图' },
    file,
    imageA,
    imageB,
  ])
  // The exact admitted durable blocks are reused, never rebuilt or reordered.
  assert.equal(content[1], file)
  assert.equal(content[2], imageA)
  assert.equal(content[3], imageB)
})

test('a question without attachments is a plain vision task with text-only content', async () => {
  const { rows, definition } = tableService()
  const agent = makeAgent()
  const result = await definition.handler({
    commandId: 'cmd-test',
    agent,
    rawInput: '看看这张之前的图',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.kind, 'success')
  assert.equal(agent.steered.length, 1)
  assert.deepEqual(agent.steered[0].content, [{ type: 'text', text: '看看这张之前的图' }])
  assert.equal(rows.get('session-a').enabled, true)
})

test('an empty task from a non-Commands adapter is rejected by the service contract', async () => {
  const { service, rows } = tableService()
  await assert.rejects(
    () => service.submitVisionTask({
      agent: makeAgent(),
      question: '   ',
      attachments: [],
      origin: 'acp',
    }),
    (error) => error instanceof VisionSessionServiceError && error.code === 'VISION_TASK_EMPTY',
  )
  assert.equal(rows.size, 0)
})

test('a cancelled signal stops the task before any attachment read or policy write', async () => {
  const { rows, definition } = tableService()
  const agent = makeAgent()
  const controller = new AbortController()
  controller.abort(new Error('user cancelled'))
  await assert.rejects(
    () => definition.handler({
      commandId: 'cmd-test',
      agent,
      rawInput: '分析这张图',
      attachments: [imageBlock()],
      signal: controller.signal,
    }),
    /cancelled/,
  )
  assert.equal(rows.size, 0)
  assert.equal(agent.steered.length, 0)
})

test('cancellation during the persisted enable reverts the fresh policy row', async () => {
  let releaseGate
  const gate = new Promise((resolve) => { releaseGate = resolve })
  const { store, rows } = controlledStore({ gate })
  const service = createVisionSessionService({ store })
  const agent = makeAgent()
  const controller = new AbortController()
  const submission = service.submitVisionTask({
    agent,
    question: '分析这张图',
    attachments: [imageBlock()],
    origin: 'command',
    signal: controller.signal,
  })
  controller.abort(new Error('user cancelled'))
  releaseGate()
  await assert.rejects(
    () => submission,
    (error) => error instanceof VisionSessionServiceError && error.code === 'VISION_CANCELLED',
  )
  // previous policy was absent, so compare-and-revert removes the row.
  assert.equal(rows.has('session-a'), false)
  assert.equal(agent.steered.length, 0)
})

test('a pre-acceptance steer failure reverts to the previous policy when the revision is untouched', async () => {
  const previous = nextSessionVisionPolicy(undefined, {
    enabled: true,
    source: 'user',
    origin: 'seed',
  })
  const { store, rows } = controlledStore()
  rows.set('session-a', previous)
  const service = createVisionSessionService({ store })
  const agent = makeAgent('session-a', {
    steer() {
      throw new Error('agent is disposed')
    },
  })
  await assert.rejects(
    () => service.submitVisionTask({
      agent,
      question: '分析这张图',
      attachments: [imageBlock()],
      origin: 'command',
    }),
    /agent is disposed/,
  )
  const policy = rows.get('session-a')
  assert.equal(policy.enabled, true)
  assert.equal(policy.updateOrigin, 'command:revert')
  assert.equal(policy.updateRevision, 3)
})

test('a pre-acceptance failure with no prior policy deletes the row it created', async () => {
  const { store, rows } = controlledStore()
  const service = createVisionSessionService({ store })
  const agent = makeAgent('session-a', {
    steer() {
      throw new Error('agent is disposed')
    },
  })
  await assert.rejects(
    () => service.submitVisionTask({
      agent,
      question: '分析这张图',
      attachments: [imageBlock()],
      origin: 'command',
    }),
    /agent is disposed/,
  )
  assert.equal(rows.has('session-a'), false)
})

test('compare-and-revert never clobbers a concurrent policy update', async () => {
  const seed = nextSessionVisionPolicy(undefined, {
    enabled: false,
    source: 'user',
    origin: 'seed',
  })
  const { store, rows } = controlledStore()
  rows.set('session-a', seed)
  const service = createVisionSessionService({ store })
  let concurrentUpdate
  const agent = makeAgent('session-a', {
    steer() {
      // Another surface (model selection) updates the policy between this
      // submission's enable and its revert decision.
      concurrentUpdate = store.apply('session-a', {
        enabled: false,
        source: 'user',
        origin: 'model-selection',
      })
      throw new Error('agent is disposed')
    },
  })
  await assert.rejects(
    () => service.submitVisionTask({
      agent,
      question: '分析这张图',
      attachments: [imageBlock()],
      origin: 'command',
    }),
    /agent is disposed/,
  )
  await concurrentUpdate
  const policy = rows.get('session-a')
  // The competitor owns the row: enabled=false, revision advanced past the
  // submission's own write, and no revert was applied on top of it.
  assert.equal(policy.enabled, false)
  assert.equal(policy.updateOrigin, 'model-selection')
  assert.equal(policy.updateRevision, 3)
})

test('accepted tasks are never rolled back, even when a later error appears', async () => {
  const { store, rows } = controlledStore()
  const service = createVisionSessionService({ store })
  const agent = makeAgent()
  const outcome = await service.submitVisionTask({
    agent,
    question: '分析这张图',
    attachments: [imageBlock()],
    origin: 'command',
  })
  assert.equal(outcome.status, 'accepted')
  assert.equal(rows.get('session-a').enabled, true)
  // No retry is scheduled and the policy keeps the submission's revision.
  assert.equal(outcome.updateRevision, rows.get('session-a').updateRevision)
})
