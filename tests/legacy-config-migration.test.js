import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, Config } from '../index.js'
import {
  localProvidersOf,
  orderedHttpProviders,
  DEFAULT_HTTP_PROVIDERS,
} from '../lib/core-primitives.js'

// ── P5 legacy configuration migration contract (plan §4.5 / §5.1) ─────────────
//
// Old profiles must keep resolving, their retired fields must stay READ-ONLY
// compatibility data with no runtime registration footprint, and their
// `vision-http/...` rows must behave as DIRECT-BACKEND entries: they ride the
// provider transport through the vision tools and never become Host
// providers. The read-side helpers below assert the direct-backend mapping
// without touching the Host llm registry at all.

function failClosedLlm() {
  const adapters = new Map([
    [
      'mutable-provider',
      {
        providerInfo: (provider) => ({ id: provider, name: 'Mutable Provider' }),
        providerRetryPolicy: () => undefined,
        listModels: async () => [],
        resolveModel: async () => {
          throw new Error('unexpected resolveModel')
        },
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    ],
  ])
  const listeners = new Map()
  const userDoc = {}
  const scopes = []
  return {
    ctx: {
      get(name) {
        if (name === 'settings') return { get: () => undefined }
        if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
        return undefined
      },
      logger: { warn() {}, info() {}, error() {} },
      effect(factory) {
        if (typeof factory === 'function') factory()
        return () => {}
      },
      on(event, handler) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
      },
      inject(_deps, callback) {
        const scope = {
          get: () => ({ ...Config({}), ...userDoc }),
          watch() {},
        }
        callback({
          settings: {
            register: (_name, _schema, options) => {
              const base = options && options.base ? options.base : {}
              const registered = { ...scope, get: () => ({ ...Config({}), ...base, ...userDoc }) }
              scopes.push(registered)
              return registered
            },
          },
          effect: () => () => {},
        })
      },
      tools: { register: () => () => {} },
      llm: {
        registerAdapter() {
          throw new Error('legacy migration contract: vision-http rows must never become Host providers')
        },
        registerConfigurableProviders() {
          throw new Error('legacy migration contract: no configurable-provider directory writes')
        },
        registration(provider) {
          const adapter = adapters.get(provider)
          if (!adapter) throw new Error(`no adapter registered for provider "${provider}"`)
          return { adapter, retryPolicy: undefined }
        },
        listProviders() {
          return [...adapters.keys()].map((id) => ({ id, name: id }))
        },
        listModels: async () => [],
        resolveModelInfo(provider) {
          const adapter = adapters.get(provider)
          if (!adapter) throw new Error(`no adapter registered for provider "${provider}"`)
          return { provider, id: 'model-a', inputModalities: ['text', 'image'] }
        },
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    },
    listeners,
    userDoc,
    scopes,
  }
}

// ── group 1: the five retired fields are read-only profile compatibility data ─

test('legacy wrapper/chain/auto-wrap/stealth values parse and are preserved verbatim', () => {
  const legacy = Config({
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'opencode-go', models: ['qwen3.6-plus'] }],
    wrapperRoute: 'relay-auto-vision',
    chainRoute: 'relay-chain',
    stealth: true,
  })
  assert.equal(legacy.autoWrapProviders, false)
  assert.deepEqual(legacy.wrappedProviders, [{ provider: 'opencode-go', models: ['qwen3.6-plus'] }])
  assert.equal(legacy.wrapperRoute, 'relay-auto-vision')
  assert.equal(legacy.chainRoute, 'relay-chain')
  assert.equal(legacy.stealth, true)
})

test('retired-field defaults keep their historical values so old profiles resolve identically', () => {
  const defaults = Config({})
  assert.equal(defaults.autoWrapProviders, true)
  assert.deepEqual(defaults.wrappedProviders, [{ provider: 'deepseek-official', models: [] }])
  assert.equal(defaults.wrapperRoute, 'deepseek-vision')
  assert.equal(defaults.chainRoute, 'vision-chain')
  assert.equal(defaults.stealth, false)
})

// ── group 2: legacy vision-http rows are direct-backend entries ─────────────

test('the default vision-http chain stays the built-in free direct backend row', () => {
  const defaults = Config({})
  assert.equal(defaults.provider, 'vision-http')
  assert.deepEqual(defaults.providers, [
    { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] },
  ])
  // The built-in free endpoint remains the keyless direct-backend fallback the
  // vision tools walk after the configured rows.
  assert.ok(
    DEFAULT_HTTP_PROVIDERS.some((entry) => entry.name === 'ovh'),
    'the built-in OVH free direct backend stays available out of the box',
  )
})

test('local backend rows stay direct-backend entries served by the provider transport', () => {
  const config = Config({
    localOllama: { enabled: true, baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl' },
    localLmStudio: { enabled: true, baseURL: 'http://localhost:1234/v1', model: 'glm-4.6v' },
  })
  const local = localProvidersOf(config)
  assert.deepEqual(
    local.map((entry) => entry.name).sort(),
    ['local-lmstudio', 'local-ollama'],
  )
  // Configured custom HTTP providers join the same direct-backend list.
  const http = orderedHttpProviders(
    Config({ httpProviders: [{ name: 'zhipu', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6v-flash' }] }),
    false,
  )
  assert.ok(http.some((entry) => entry.name === 'zhipu'))
})

// ── group 3: legacy values produce no runtime Provider side effects ────────

test('a full legacy profile applies without any Host registration or directory write', () => {
  const { ctx, listeners } = failClosedLlm()
  assert.doesNotThrow(() =>
    apply(
      ctx,
      Config({
        provider: 'vision-http',
        model: 'ovh/Qwen3.5-397B-A17B',
        providers: [
          { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] },
          { provider: 'vision-http', model: 'local-ollama/qwen2.5vl', fallbacks: [] },
        ],
        autoWrapProviders: true,
        wrappedProviders: [{ provider: 'mutable-provider', models: [] }],
        wrapperRoute: 'deepseek-vision',
        chainRoute: 'vision-chain',
        routing: true,
        localOllama: { enabled: true },
      }),
    ),
  )
  for (const emit of listeners.get('llm/adapters-updated') ?? []) emit()
  // Any attempt to register vision-http / a twin / the wrapper / the chain, or
  // to write the configurable-provider directory, would have thrown inside
  // apply() and failed the doesNotThrow above.
})

test('old profile values read back compatibly through the live settings seam', () => {
  const { ctx, userDoc, scopes } = failClosedLlm()
  Object.assign(userDoc, {
    wrapperRoute: 'relay-auto-vision',
    chainRoute: 'relay-chain',
    autoWrapProviders: false,
    stealth: true,
  })
  apply(ctx, Config({}))
  // The settings seam resolved the live document: the old values survive the
  // schema resolution unchanged — read-back compatible, never rewritten.
  assert.ok(scopes.length === 1, 'the settings seam registered exactly one scope')
  const live = scopes[0].get()
  assert.equal(live.wrapperRoute, 'relay-auto-vision')
  assert.equal(live.chainRoute, 'relay-chain')
  assert.equal(live.autoWrapProviders, false)
  assert.equal(live.stealth, true)
})
