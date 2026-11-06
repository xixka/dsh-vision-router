import test from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import {
  CLIENT_PRESENTATION_PRELUDE,
  injectClientPresentationBoundary,
} from '../lib/client-presentation-boundary.js'

const MODEL_SELECTION_TARGET = '@deepseek-ai/dsh-client-ui-model-selection'

/**
 * #284 /model visibility after the P5 UI retirement: the presentation-only
 * projection that hid Vision Router wrapper groups from DSH's stock model
 * picker is gone. There are no wrapper routes to hide anymore (zero-Provider
 * architecture), and hiding catalog rows from the stock /model picker would
 * now only misrepresent the Host. The contract flips: the stock
 * model-selection plugin must observe the raw Host directory by identity,
 * with no decorator, no settingsScope injection, and no selection mapping.
 */
test('issue #284 retirement: the /model visibility boundary modules are gone', async () => {
  for (const path of [
    '../lib/vision-model-visibility-boundary.js',
    '../lib/vision-model-visibility-boundary-main.js',
  ]) {
    await assert.rejects(
      access(new URL(path, import.meta.url)),
      (error) => error?.code === 'ENOENT',
      `${path} must not exist anymore`,
    )
  }
})

test('issue #284 retirement: no /model filter prelude is injected into the browser', () => {
  const html = injectClientPresentationBoundary('<html><head></head><body></body></html>')
  assert.equal(html.includes('data-vision-router-model-visibility-boundary'), false)
  assert.equal(html.includes('projectVisionModeDirectoryState'), false)
  assert.equal(html.includes('mapVisionPresentationSelection'), false)
  // The settings-IA and presentation carriers that remain must not smuggle
  // the retired filter back in.
  const settingsIaSource = readFileSync(new URL('../lib/settings-ia-client-prelude.js', import.meta.url), 'utf8')
  assert.equal(settingsIaSource.includes('projectVisionModeDirectoryState'), false)
  const modelPickerSource = readFileSync(new URL('../lib/web/model-picker.js', import.meta.url), 'utf8')
  assert.equal(modelPickerSource.includes('installVisionModelVisibilityBoundary'), false)
})

test('issue #284 retirement: the stock model-selection plugin receives the raw Host directory', () => {
  let registered
  const loader = {
    load(spec) {
      registered = spec
      return spec
    },
  }
  const window = { __ModuleLoader__: loader }
  // Run the shipped presentation prelude alongside the stock plugin to prove
  // the remaining boundary never targets the model-selection module.
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
      { id: 'vendor', name: 'Vendor', models: [{ id: 'm' }] },
      { id: 'vendor-vision', name: 'Vendor + 自动识图', models: [{ id: 'm' }] },
    ],
    current: { provider: 'vendor-vision', model: 'm', reasoningEffort: 'high' },
    status: 'ready',
    error: null,
    failures: [],
    routable: true,
  }
  const directory = {
    store: {
      subscribe() { return () => {} },
      getSnapshot() { return raw },
    },
    async load() { return raw },
    async select() {},
  }
  const models = { directoryFor() { return directory } }
  const settings = {
    subscribe() { return () => {} },
    getSnapshot() { return { value: { autoWrapProviders: true, wrapperRoute: 'deepseek-vision' } } },
  }

  const observed = {}
  loader.load({
    id: MODEL_SELECTION_TARGET,
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
  assert.equal(plugin.apply.__visionRouterModelVisibility, undefined,
    'no model-visibility decorator may wrap the stock model-selection plugin')
  plugin.apply({
    settingsScope: { bind() { return settings } },
    modelDirectories: models,
    inject(_deps, callback) {
      callback({ modelDirectories: models, get() { return models } })
    },
  })

  // Identity passthrough: the exact Host objects, unprojected and unfiltered.
  assert.equal(observed.directory, directory)
  assert.equal(observed.snapshot, raw)
  assert.deepEqual(
    raw.groups.map((group) => group.id),
    ['vendor', 'vendor-vision'],
    'wrapper-shaped groups must stay visible; hiding is no longer owned by the client',
  )
  assert.equal(raw.current.provider, 'vendor-vision')
  // The retired decorator used to append settingsScope to this plugin's
  // inject list; the retired world must leave the declaration alone.
  assert.deepEqual(plugin.inject, ['commandUi', 'connection', 'locale', 'sessions', 'slots', 'remote'])
})
