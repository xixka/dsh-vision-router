import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { CLIENT_PRESENTATION_PRELUDE } from '../lib/client-presentation-boundary.js'
import { CLIENT_HOST_COMPAT_PRELUDE } from '../lib/client-host-compat-prelude.js'

/**
 * Composer injection after the P5 UI retirement (plan §1.1: the composer no
 * longer registers a Vision button). The retired prelude used to inject
 * ['slots', 'modelDirectories', 'sessions', 'remote'] and register the
 * 'vision-router-mode-toggle' control in the 'conversation.input.right' slot,
 * resolving cold ModelDirectory namespaces along the way. The retired world
 * must inject nothing: no slot registration, no directory resolution, no
 * remote.session probing, and no subagent gating — while the remaining generic
 * aids (Host compatibility + clipboard paste normalization) keep installing.
 */
function createHarness() {
  const reads = []
  const injections = []
  const effects = []
  const slotCalls = []
  let registered
  const loader = {
    load(spec) {
      registered = spec
      return spec
    },
  }
  const window = { __ModuleLoader__: loader }
  vm.runInNewContext(CLIENT_PRESENTATION_PRELUDE, {
    window,
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    Proxy,
    Reflect,
    console,
  })
  vm.runInNewContext(CLIENT_HOST_COMPAT_PRELUDE, {
    window,
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    Proxy,
    Reflect,
    console,
  })

  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return { apply() {} }
    },
  })
  const plugin = registered.factory((id) => {
    if (id === 'react') return {}
    throw new Error(`unexpected require: ${id}`)
  })

  const services = {
    slots: {
      inject(name, entries) {
        slotCalls.push(name)
        if (typeof entries === 'function') void entries
        return () => {}
      },
      register() { return () => {} },
    },
    sessions: {
      binding() { return { session: {} } },
      subagentAddress() { return undefined },
    },
    remote: {},
  }
  const declared = new Set(['settingsScope', 'slots', 'locale', 'sessions', 'remote'])
  const ctx = new Proxy({
    locale: { register() { return () => {} } },
    effect(run, label) {
      effects.push(label)
      return run()
    },
    settingsScope: { bind() { return undefined } },
  }, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
      reads.push(String(property))
      if (!declared.has(String(property))) {
        throw new Error(`cannot get property "${String(property)}" without inject`)
      }
      return services[property]
    },
  })
  return { plugin, ctx, reads, injections, effects, slotCalls }
}

test('retirement: the decorated client plugin never injects a composer slot scope', () => {
  const { plugin, ctx, reads, injections, effects, slotCalls } = createHarness()
  assert.equal(typeof plugin.apply, 'function')
  assert.doesNotThrow(() => plugin.apply(ctx))

  // No dependency injection of any kind: the retired toggle scope (slots,
  // modelDirectories, sessions, remote / remote.session) must stay untouched.
  assert.deepEqual(injections, [])
  assert.deepEqual(slotCalls, [], 'no conversation.input.right registration may happen')
  assert.equal(reads.includes('modelDirectories'), false,
    'the retired toggle must not resolve model directories')
  assert.equal(reads.includes('remote.session'), false,
    'the retired toggle must not probe the alpha remote session namespace')
  assert.equal(reads.includes('sessions'), false,
    'the retired subagent gate must not read sessions')
  // The generic paste compatibility keeps installing through ctx.effect.
  assert.ok(effects.some((label) => label === 'vision-router: clipboard image paste normalization'))
})

test('retirement: a Host without slot or directory services still applies cleanly', () => {
  let registered
  const loader = {
    load(spec) {
      registered = spec
      return spec
    },
  }
  const window = { __ModuleLoader__: loader }
  vm.runInNewContext(CLIENT_PRESENTATION_PRELUDE, {
    window,
    Object,
    Promise,
    Array,
    String,
    Map,
    Set,
    WeakMap,
    Proxy,
    Reflect,
    console,
  })
  loader.load({
    id: 'dsh-vision-router',
    factory() {
      return { apply() {} }
    },
  })
  const plugin = registered.factory((id) => {
    if (id === 'react') return {}
    throw new Error(`unexpected require: ${id}`)
  })
  // A minimal legacy Host: no slots, no sessions, no remote, no model seat.
  // The retired toggle used to tolerate this; the retired world must not even
  // reach for those services.
  const touched = []
  const ctx = new Proxy({
    locale: { register() { return () => {} } },
    effect(run) { return run() },
  }, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
      touched.push(String(property))
      return undefined
    },
  })
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(touched.includes('slots'), false)
  assert.equal(touched.includes('modelDirectories'), false)
  assert.equal(touched.includes('sessions'), false)
})
