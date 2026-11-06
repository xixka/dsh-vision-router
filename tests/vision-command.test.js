import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildVisionCommandDefinition,
  installVisionCommand,
  parseVisionCommandInput,
  VISION_COMMAND_DEFINITION_ID,
  VISION_COMMAND_NAME,
} from '../lib/vision-command.js'
import {
  createVisionSessionService,
  VisionSessionServiceError,
} from '../lib/vision-session-service.js'
import {
  createSessionVisionPolicyStore,
  createVolatileSessionVisionPolicyStore,
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

function makeAgent(id = 'session-a') {
  const steered = []
  return {
    id,
    steered,
    steer(message) {
      steered.push(message)
    },
  }
}

function freshSignal() {
  return new AbortController().signal
}

function invoke(definition, overrides = {}) {
  return definition.handler({
    commandId: 'cmd-test',
    agent: overrides.agent ?? makeAgent(),
    rawInput: overrides.rawInput ?? '',
    attachments: overrides.attachments ?? [],
    signal: overrides.signal ?? freshSignal(),
  })
}

function tableService() {
  const table = memoryTable()
  const service = createVisionSessionService({ store: createSessionVisionPolicyStore(table) })
  return { service, rows: table.rows, definition: buildVisionCommandDefinition({ service }) }
}

function makeRegistry() {
  const commands = new Map()
  return {
    commands,
    register(definition) {
      if (commands.has(definition.name)) {
        throw new Error(`command "${definition.name}" is already registered`)
      }
      commands.set(definition.name, definition)
      return () => {
        commands.delete(definition.name)
      }
    },
  }
}

function makeInstallContext(registry, disposers = []) {
  return {
    get(name) {
      return name === 'commands' ? registry : undefined
    },
    effect(factory, label) {
      const dispose = factory()
      disposers.push({ dispose, label })
      return dispose
    },
    logger: { info() {}, warn() {} },
  }
}

function deferred() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

test('parsing keeps only exact status/on/off sub-commands; everything else is one question', () => {
  assert.deepEqual(parseVisionCommandInput(''), { kind: 'status' })
  assert.deepEqual(parseVisionCommandInput('   '), { kind: 'status' })
  assert.deepEqual(parseVisionCommandInput('status'), { kind: 'status' })
  assert.deepEqual(parseVisionCommandInput('  status '), { kind: 'status' })
  assert.deepEqual(parseVisionCommandInput('on'), { kind: 'on' })
  assert.deepEqual(parseVisionCommandInput('  on  '), { kind: 'on' })
  assert.deepEqual(parseVisionCommandInput('off'), { kind: 'off' })
  // Exact match only: casing or extra words degrade to natural language.
  assert.deepEqual(parseVisionCommandInput('ON'), { kind: 'task', question: 'ON' })
  assert.deepEqual(parseVisionCommandInput('on now'), { kind: 'task', question: 'on now' })
  assert.deepEqual(parseVisionCommandInput('status report'), { kind: 'task', question: 'status report' })
  assert.deepEqual(parseVisionCommandInput(' 请读取这张截图 '), {
    kind: 'task',
    question: '请读取这张截图',
  })
})

test('the /vision definition satisfies the rc.5 registry contract', async () => {
  const { definition } = tableService()
  assert.equal(definition.definitionId, VISION_COMMAND_DEFINITION_ID)
  assert.equal(definition.definitionId, 'dsh-vision-router/vision')
  assert.equal(definition.name, VISION_COMMAND_NAME)
  assert.equal(definition.name, 'vision')
  assert.ok(typeof definition.description === 'string' && definition.description.length > 0)
  assert.equal(definition.input.attachments, true)
  assert.ok(typeof definition.input.hint === 'string' && definition.input.hint.length > 0)
  // rc.5 dedup: the steer()'d user message owns the model-visible payload, so
  // command/run must not record a duplicate of rawInput.
  assert.equal(definition.recordInput, false)
  assert.equal(typeof definition.handler, 'function')
  // The handler result contract is structural: kind/text only.
  const result = await invoke(definition, { rawInput: 'status' })
  assert.ok(result.kind === 'success' || result.kind === 'error')
})

test('/vision and /vision status return sanitized status without changing mode', async () => {
  const { rows, definition } = tableService()
  const blank = await invoke(definition, { rawInput: '' })
  assert.equal(blank.kind, 'success')
  assert.match(blank.text, /Vision mode: disabled/)
  assert.match(blank.text, /Usage: \/vision on/)
  const status = await invoke(definition, { rawInput: 'status' })
  assert.match(status.text, /Vision mode: disabled/)
  assert.equal(rows.size, 0)
})

test('status copy stays sanitized: no credentials, endpoints, or local paths', async () => {
  const service = createVisionSessionService({
    store: createSessionVisionPolicyStore(memoryTable()),
    listBackends: () => ['builtin-free-fallback', 'local-ollama'],
  })
  const definition = buildVisionCommandDefinition({ service })
  const result = await invoke(definition, { rawInput: 'status' })
  assert.match(result.text, /builtin-free-fallback, local-ollama/)
  assert.match(result.text, /names only/)
  assert.doesNotMatch(result.text, /apiKeyEnv|baseUrl|http:\/\/|C:\\/)
})

test('/vision on and /vision off persist the mode and only claim "state saved" when durable', async () => {
  const { rows, definition } = tableService()
  const on = await invoke(definition, { rawInput: 'on' })
  assert.equal(on.kind, 'success')
  assert.match(on.text, /Vision mode enabled for this Session \(state saved\)/)
  assert.equal(rows.get('session-a').enabled, true)
  assert.equal(rows.get('session-a').updateOrigin, 'command')
  const off = await invoke(definition, { rawInput: 'off' })
  assert.equal(off.kind, 'success')
  assert.match(off.text, /Vision mode disabled for this Session \(state saved\)/)
  assert.match(off.text, /DSH native vision capabilities are unaffected/)
  assert.equal(rows.get('session-a').enabled, false)
})

test('a degraded store never lets the copy claim "state saved"', async () => {
  const service = createVisionSessionService({ store: createVolatileSessionVisionPolicyStore() })
  const definition = buildVisionCommandDefinition({ service })
  const on = await invoke(definition, { rawInput: 'on' })
  assert.equal(on.kind, 'success')
  assert.doesNotMatch(on.text, /state saved/)
  assert.match(on.text, /process-local/)
  assert.match(on.text, /volatile-session-policy-store/)
})

test('explicit control words reject attachments without changing the mode', async () => {
  const { rows, definition } = tableService()
  for (const rawInput of ['status', 'on', 'off']) {
    const result = await invoke(definition, { rawInput, attachments: [imageBlock()] })
    assert.equal(result.kind, 'error', rawInput)
    assert.match(result.text, /does not accept attachments/)
    assert.match(result.text, /mode is unchanged/)
  }
  assert.equal(rows.size, 0)
})

test('cancellation before the state write leaves the policy untouched', async () => {
  const { rows, definition } = tableService()
  const controller = new AbortController()
  controller.abort(new Error('user cancelled'))
  await assert.rejects(
    () => invoke(definition, { rawInput: 'on', signal: controller.signal }),
    /cancelled/,
  )
  assert.equal(rows.size, 0)
})

test('/vision <question> enables the Session and steers exactly one user message', async () => {
  const { rows, definition } = tableService()
  const agent = makeAgent()
  const image = imageBlock('shot-1')
  const result = await invoke(definition, {
    agent,
    rawInput: ' 请分析这个截图 ',
    attachments: [image],
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /accepted/)
  assert.match(result.text, /not that image analysis succeeded/)
  assert.equal(agent.steered.length, 1)
  const message = agent.steered[0]
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.deepEqual(message.content, [{ type: 'text', text: '请分析这个截图' }, image])
  const policy = rows.get('session-a')
  assert.equal(policy.enabled, true)
  assert.equal(policy.updateOrigin, 'command')
  assert.ok(Number.isInteger(policy.updateRevision) && policy.updateRevision > 0)
})

test('/vision with attachments and no question uses the default prompt', async () => {
  const { definition } = tableService()
  const agent = makeAgent()
  const image = imageBlock()
  const result = await invoke(definition, { agent, rawInput: '', attachments: [image] })
  assert.equal(result.kind, 'success')
  assert.equal(agent.steered.length, 1)
  assert.deepEqual(agent.steered[0].content, [
    { type: 'text', text: '请分析这些图片' },
    image,
  ])
  assert.equal(agent.steered[0].content[0].text, '请分析这些图片')
})

test('a busy agent still receives the steering task without an error', async () => {
  const { definition } = tableService()
  const agent = makeAgent()
  agent.busy = true
  const result = await invoke(definition, {
    agent,
    rawInput: '继续分析',
    attachments: [imageBlock()],
  })
  assert.equal(result.kind, 'success')
  assert.equal(agent.steered.length, 1)
})

test('duplicate submission during the pending window is rejected, then the gate reopens', async () => {
  const gate = deferred()
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
      await gate.promise
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
  const service = createVisionSessionService({ store })
  const agent = makeAgent()
  const first = service.submitVisionTask({
    agent,
    question: '第一张',
    attachments: [imageBlock('a')],
    origin: 'command',
  })
  const second = service.submitVisionTask({
    agent,
    question: '第二张',
    attachments: [imageBlock('b')],
    origin: 'command',
  })
  await assert.rejects(
    () => second,
    (error) => error instanceof VisionSessionServiceError && error.code === 'VISION_DUPLICATE_SUBMISSION',
  )
  gate.release()
  const outcome = await first
  assert.equal(outcome.status, 'accepted')
  assert.equal(agent.steered.length, 1)
  // Once the first task is accepted, the next submission is not a duplicate.
  const third = await service.submitVisionTask({
    agent,
    question: '第三张',
    attachments: [imageBlock('c')],
    origin: 'command',
  })
  assert.equal(third.status, 'accepted')
  assert.equal(agent.steered.length, 2)
})

test('registering /vision holds the disposer in ctx.effect and unregisters on dispose', () => {
  const { service } = tableService()
  const registry = makeRegistry()
  const disposers = []
  const ctx = makeInstallContext(registry, disposers)
  const result = installVisionCommand(ctx, { service })
  assert.deepEqual(result, { installed: true })
  assert.equal(registry.commands.size, 1)
  assert.equal(registry.commands.get('vision').definitionId, VISION_COMMAND_DEFINITION_ID)
  assert.equal(disposers.length, 1)
  assert.match(disposers[0].label, /\/vision command registration/)
  disposers[0].dispose()
  assert.equal(registry.commands.size, 0)
})

test('a conflicting /vision registration propagates the registry error and never overwrites', () => {
  const { service } = tableService()
  const registry = makeRegistry()
  registry.register({
    definitionId: 'other-plugin/vision',
    name: 'vision',
    description: 'foreign owner',
    handler: () => ({ kind: 'success' }),
  })
  const disposers = []
  const ctx = makeInstallContext(registry, disposers)
  assert.throws(
    () => installVisionCommand(ctx, { service }),
    /already registered/,
  )
  // The foreign owner is untouched and no effect was established.
  assert.equal(registry.commands.get('vision').definitionId, 'other-plugin/vision')
  assert.equal(disposers.length, 0)
})

test('a composition without the Commands registry keeps the service layer and reports installed: false', () => {
  const { service } = tableService()
  const infoCalls = []
  const ctx = {
    get: () => undefined,
    effect(factory) {
      return factory()
    },
    logger: { info: (message) => infoCalls.push(message), warn() {} },
  }
  const result = installVisionCommand(ctx, { service })
  assert.deepEqual(result, { installed: false })
  assert.equal(infoCalls.length, 1)
})

test('registering without a usable Context effect fails loud instead of leaking a registration', () => {
  const { service } = tableService()
  const registry = makeRegistry()
  const ctx = { get: (name) => (name === 'commands' ? registry : undefined) }
  assert.throws(() => installVisionCommand(ctx, { service }), /requires a Context with effect/)
  assert.equal(registry.commands.size, 0)
})

test('an invalid agent surfaces the error contract without touching the policy', async () => {
  const { rows, definition } = tableService()
  const result = await invoke(definition, {
    agent: { id: 'no-steer' },
    rawInput: 'on',
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Agent steer/)
  assert.equal(rows.size, 0)
})
