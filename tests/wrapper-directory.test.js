import test from 'node:test'
import assert from 'node:assert/strict'

import {
  installWrapperDirectoryAlias,
  resolveWrapperDirectoryEntry,
} from '../lib/wrapper-directory.js'

// P5 (plan §5.1-5) contract harness: the Host still exposes the full
// configurable-provider directory API so the retirement assertions below prove
// the plugin CHOOSES not to write it, rather than running on a host without it.
function fakeContext({
  visionConfig = {},
  liveProviders = [
    { id: 'deepseek-official', name: 'DeepSeek' },
  ],
  configurableProviders = [
    {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
    },
  ],
} = {}) {
  const listeners = new Map()
  const state = {
    visionConfig,
    liveProviders: [...liveProviders],
    sourceDirectory: configurableProviders.map((entry) => ({ ...entry })),
    ownedDirectory: [],
    registerCalls: 0,
    replaceCalls: 0,
    listenerEvents: 0,
  }

  const emit = (name, ...args) => {
    state.listenerEvents += 1
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }

  const llm = {
    listProviders() {
      return state.liveProviders.map((entry) => ({ ...entry }))
    },
    listConfigurableProviders() {
      return [
        ...state.sourceDirectory.map((entry) => ({ ...entry })),
        ...state.ownedDirectory.map((entry) => ({ ...entry })),
      ]
    },
    registerConfigurableProviders(entries) {
      state.registerCalls += 1
      state.ownedDirectory = entries.map((entry) => ({ ...entry, settingsPath: [...entry.settingsPath] }))
      const handle = () => {
        state.ownedDirectory = []
      }
      handle.replace = (next) => {
        state.replaceCalls += 1
        state.ownedDirectory = next.map((entry) => ({ ...entry, settingsPath: [...entry.settingsPath] }))
      }
      return handle
    },
  }

  const ctx = {
    llm,
    get(name) {
      if (name !== 'settings') return undefined
      return {
        get(ns) {
          return ns === 'vision-router' ? state.visionConfig : undefined
        },
      }
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
    },
    effect(factory) {
      const cleanup = factory()
      return () => (typeof cleanup === 'function' ? cleanup() : undefined)
    },
    logger: { warn() {} },
  }

  return { ctx, state, emit, listeners }
}

test('historical reader resolves the retired wrapper identity without a live wrapper adapter', () => {
  // P5 semantic change: the wrapper route is never registered, so live
  // topology only names official DeepSeek. Historical sessions, exports,
  // compaction and replay must still resolve what the route always was.
  const { ctx } = fakeContext()
  assert.deepEqual(resolveWrapperDirectoryEntry(ctx), {
    provider: 'deepseek-vision',
    displayName: 'DeepSeek + 自动识图',
    settingsNs: 'llm-deepseek',
    settingsPath: [],
  })
})

test('historical reader follows a persisted custom wrapper name but never relabels it via textProvider', () => {
  const { ctx } = fakeContext({
    visionConfig: {
      wrapperRoute: 'relay-auto-vision',
      textProvider: { provider: 'openrouter' },
    },
    configurableProviders: [
      {
        provider: 'openrouter',
        displayName: 'OpenRouter',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openrouter'],
      },
      {
        provider: 'deepseek-official',
        displayName: 'DeepSeek',
        settingsNs: 'llm-deepseek',
        settingsPath: [],
      },
    ],
  })
  assert.deepEqual(resolveWrapperDirectoryEntry(ctx), {
    provider: 'relay-auto-vision',
    displayName: 'DeepSeek + 自动识图',
    settingsNs: 'llm-deepseek',
    settingsPath: [],
  })
})

test('historical reader fails closed when official DeepSeek has no settings address', () => {
  const { ctx } = fakeContext({
    visionConfig: { textProvider: { provider: 'openrouter' } },
    configurableProviders: [
      {
        provider: 'openrouter',
        displayName: 'OpenRouter',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openrouter'],
      },
    ],
  })
  assert.equal(resolveWrapperDirectoryEntry(ctx), undefined)
})

test('historical reader is unavailable on runtimes without the directory read API', () => {
  const ctx = {
    llm: {
      listProviders: () => [],
    },
  }
  assert.equal(resolveWrapperDirectoryEntry(ctx), undefined)
})

test('retired installer never writes the directory on a Host that exposes it', () => {
  const { ctx, state, emit } = fakeContext()
  const dispose = installWrapperDirectoryAlias(ctx, {}, ctx.logger)
  assert.equal(state.registerCalls, 0)
  assert.equal(state.replaceCalls, 0)
  assert.deepEqual(state.ownedDirectory, [])

  // Settings and adapter-topology events must not resurrect any publication.
  state.visionConfig = { wrapperRoute: 'relay-auto-vision' }
  emit('settings/updated', 'vision-router', state.visionConfig, {}, 'update')
  emit('settings/document-updated', 'vision-router')
  emit('llm/adapters-updated')
  assert.equal(state.registerCalls, 0)
  assert.deepEqual(state.ownedDirectory, [])

  // The disposer stays callable and idempotent.
  assert.doesNotThrow(() => dispose())
  assert.doesNotThrow(() => dispose())
  assert.equal(state.registerCalls, 0)
})

test('retired installer registers no listeners and is generation-inert', () => {
  const { ctx, state, listeners, emit } = fakeContext()
  installWrapperDirectoryAlias(ctx, {}, ctx.logger)
  installWrapperDirectoryAlias(ctx, {}, ctx.logger)
  assert.equal(state.registerCalls, 0)
  assert.equal(state.listenerEvents, 0)
  assert.deepEqual([...listeners.entries()].map(([name]) => name), [])

  emit('llm/adapters-updated')
  emit('settings/updated', 'vision-router', {}, {}, 'update')
  assert.equal(state.registerCalls, 0)
  assert.equal(state.replaceCalls, 0)
})

test('retired installer is safe on contexts without any llm surface', () => {
  const ctx = {}
  let dispose
  assert.doesNotThrow(() => {
    dispose = installWrapperDirectoryAlias(ctx, {}, undefined)
  })
  assert.doesNotThrow(() => dispose())
})

test('retired installer never reads live topology to decide publication', () => {
  // The old runtime withdrew/published rows based on live adapter state; the
  // retirement must not depend on it in either direction.
  const { ctx, state } = fakeContext({
    liveProviders: [
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'deepseek-vision', name: 'DeepSeek + 自动识图' },
    ],
  })
  installWrapperDirectoryAlias(ctx, {}, ctx.logger)
  assert.equal(state.registerCalls, 0)
  assert.deepEqual(state.ownedDirectory, [])
})
