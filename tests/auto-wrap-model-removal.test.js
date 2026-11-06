import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, Config } from '../index.js'

// P5 (plan §4.2/§4.5) contract harness: a full legacy profile shape (auto-wrap
// on, wrapped providers, wrapper/chain routes, whole-turn routing) applied to
// a Host whose llm registry already serves a real provider. Every counter
// below records a MODEL-DIRECTORY WRITE the plugin could have made before P5.
function autoWrapHarness() {
  const adapters = new Map()
  const registrations = new Map()
  const listeners = new Map()
  const userDoc = {}

  const ctx = {
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
      listeners.set(event, handler)
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
            return { ...scope, get: () => ({ ...Config({}), ...base, ...userDoc }) }
          },
        },
        effect: () => () => {},
      })
    },
    tools: { register: () => () => {} },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) {
          if (adapters.has(provider)) throw new Error(`duplicate adapter: ${provider}`)
        }
        for (const provider of providers) {
          adapters.set(provider, adapter)
          registrations.set(provider, {
            adapter,
            retryPolicy:
              typeof adapter.providerRetryPolicy === 'function'
                ? adapter.providerRetryPolicy(provider)
                : undefined,
          })
        }
        return () => {
          for (const provider of providers) {
            if (adapters.get(provider) === adapter) adapters.delete(provider)
            if (registrations.get(provider)?.adapter === adapter) registrations.delete(provider)
          }
        }
      },
      registration(provider) {
        const registration = registrations.get(provider)
        if (!registration) throw new Error(`no adapter registered for provider "${provider}"`)
        return registration
      },
      registerConfigurableProviders() {
        throw new Error('P5: the plugin must not write the configurable-provider directory')
      },
      listProviders() {
        return [...registrations.entries()].map(([provider, registration]) => {
          let info
          try {
            info = registration.adapter.providerInfo?.(provider)
          } catch {
            info = undefined
          }
          return { id: provider, name: info?.name || provider }
        })
      },
      async listModels(provider) {
        const registration = registrations.get(provider)
        if (!registration || typeof registration.adapter.listModels !== 'function') return []
        return registration.adapter.listModels(provider)
      },
      async resolveModelInfo(provider, model) {
        const registration = registrations.get(provider)
        if (!registration || typeof registration.adapter.resolveModel !== 'function') {
          throw new Error(`no adapter registered for provider "${provider}"`)
        }
        return registration.adapter.resolveModel(provider, model)
      },
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }

  return { ctx, adapters, listeners }
}

const mutableSource = () => {
  const sourceModels = ['model-a', 'model-b']
  return {
    sourceModels,
    adapter: {
      providerInfo: (provider) => ({ id: provider, name: 'Mutable Provider' }),
      providerRetryPolicy: () => undefined,
      listModels: async (provider) =>
        sourceModels.map((id) => ({ provider, id, name: id, inputModalities: ['text'] })),
      resolveModel: async (provider, model) => {
        if (!sourceModels.includes(model)) throw new Error(`unknown model: ${model}`)
        return { provider, id: model, name: model, inputModalities: ['text'] }
      },
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

test('legacy auto-wrap profile is runtime-inert: no twin, wrapper, chain or vision-http route registers', () => {
  const { ctx, adapters } = autoWrapHarness()
  const source = mutableSource()

  ctx.llm.registerAdapter(['mutable-provider'], source.adapter)
  apply(
    ctx,
    Config({
      autoWrapProviders: true,
      wrappedProviders: [{ provider: 'mutable-provider', models: [] }],
      wrapperRoute: 'deepseek-vision',
      chainRoute: 'vision-chain',
      routing: true,
    }),
  )

  // The only registered adapter is the harness-owned source. The legacy
  // auto-wrap/wrapped/wrapper/chain fields registered nothing at all.
  assert.deepEqual([...adapters.keys()], ['mutable-provider'])
  assert.equal(adapters.has('mutable-provider-vision'), false, 'no auto-vision twin')
  assert.equal(adapters.has('deepseek-vision'), false, 'no wrapper route')
  assert.equal(adapters.has('vision-chain'), false, 'no chain route')
  assert.equal(adapters.has('vision-http'), false, 'no vision-http pseudo provider')

  // A source catalog removal can never strand a stale twin: there is no
  // registered mirror route whose snapshot could go stale.
  source.sourceModels.splice(1)
  assert.equal(adapters.has('mutable-provider-vision'), false)
})

test('read-only registry access keeps working after the zero-Provider surgery', async () => {
  const { ctx, adapters } = autoWrapHarness()
  const source = mutableSource()

  ctx.llm.registerAdapter(['mutable-provider'], source.adapter)
  apply(ctx, Config({ autoWrapProviders: true }))

  // ctx.llm.registration()/resolveModelInfo() remain usable read-only seams.
  assert.equal(ctx.llm.registration('mutable-provider').adapter, source.adapter)
  const info = await ctx.llm.resolveModelInfo('mutable-provider', 'model-a')
  assert.equal(info.id, 'model-a')
  assert.equal(adapters.has('vision-http'), false)
})
