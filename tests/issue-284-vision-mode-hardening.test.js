import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import vm from 'node:vm'

import { CLIENT_PRESENTATION_PRELUDE } from '../lib/client-presentation-boundary.js'

/**
 * #284 hardening after the P5 UI retirement: the wrapper/twin pair resolver
 * (resolveVisionModePair) and its DeepSeek wrapper inference are gone together
 * with the composer toggle. The client must not re-derive a Vision ON/OFF
 * pair from the model directory at all: Vision mode is owned by the /vision
 * command, and the Host directory is presented as-is. Fails-closed pair
 * inference, custom wrapper routes, and auto-wrap permissions no longer have
 * any client-side representation to trust or reject.
 */
test('issue #284 retirement: the wrapper/twin pair resolver and its module are gone', async () => {
  await assert.rejects(
    access(new URL('../lib/vision-model-visibility-boundary.js', import.meta.url)),
    (error) => error?.code === 'ENOENT',
    'the /model visibility boundary must not exist anymore',
  )
  await assert.rejects(
    access(new URL('../lib/vision-model-visibility-boundary-main.js', import.meta.url)),
    (error) => error?.code === 'ENOENT',
  )
})

test('issue #284 retirement: the client prelude performs no twin or wrapper inference', () => {
  for (const stale of [
    'resolveVisionModePair',
    'visionModeOwnedTwin',
    'visionModeWrapperRoute',
    'visionModeOwnedWrapper',
    'visionModeTwinIntended',
    "endsWith('-vision')",
    "'-vision'.length",
    '-vision-vision',
    'wrapperRoute',
    'wrappedProviders',
    'autoWrapProviders',
    'deepseek-vision',
  ]) {
    assert.equal(CLIENT_PRESENTATION_PRELUDE.includes(stale), false, `prelude must not contain ${stale}`)
  }
})

test('issue #284 retirement: wrapper-shaped directories pass through to the Host untouched', () => {
  // Even if a foreign Host still lists "+ Auto Vision"-shaped groups, the
  // client neither hides them nor derives a mode from them. The stock
  // model-selection plugin observes exactly the directory it is given.
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

  const raw = {
    groups: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro' }] },
      { id: 'deepseek-vision', name: 'DeepSeek + 自动识图', models: [{ id: 'deepseek-v4-pro' }] },
    ],
    current: { provider: 'deepseek-vision', model: 'deepseek-v4-pro' },
    status: 'ready',
    error: null,
  }
  const directory = {
    store: {
      subscribe() { return () => {} },
      getSnapshot() { return raw },
    },
  }
  const models = { directoryFor() { return directory } }

  const observed = {}
  loader.load({
    id: '@deepseek-ai/dsh-client-ui-model-selection',
    factory() {
      return {
        inject: ['commandUi', 'connection', 'locale', 'sessions', 'slots', 'remote'],
        apply(ctx) {
          observed.directory = ctx.modelDirectories.directoryFor('chat')
          observed.snapshot = observed.directory.store.getSnapshot()
        },
      }
    },
  })
  const plugin = registered.factory(() => ({}))
  // The presentation boundary only decorates its own client factory: the
  // stock model-selection plugin must not be wrapped at all.
  assert.equal(plugin.apply.__visionRouterModelVisibility, undefined)
  assert.equal(plugin.apply.__visionRouterPasteCompat, undefined)
  plugin.apply({
    modelDirectories: models,
    inject(_deps, callback) {
      callback({ modelDirectories: models })
    },
  })

  assert.equal(observed.directory, directory, 'the Host directory object must pass through by identity')
  assert.equal(observed.snapshot, raw, 'no projected or filtered snapshot may be substituted')
  assert.equal(observed.snapshot.current.provider, 'deepseek-vision')
  assert.equal(observed.snapshot.groups.length, 2)
  // The retired visibility decorator used to append settingsScope to the
  // model-selection plugin's inject list; nothing may mutate it now.
  assert.deepEqual(
    plugin.inject,
    ['commandUi', 'connection', 'locale', 'sessions', 'slots', 'remote'],
  )
})
