import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import {
  CLIENT_PRESENTATION_PRELUDE,
  injectClientPresentationBoundary,
} from '../lib/client-presentation-boundary.js'

const mainSource = readFileSync(new URL('../lib/client-presentation-boundary-main.js', import.meta.url), 'utf8')

/**
 * #284 after the P5 UI retirement: the composer Vision mode toggle is gone.
 * Vision mode is controlled exclusively by the /vision command. These tests
 * pin the no-button contract of the presentation boundary instead of the
 * removed toggle behavior: no composer slot registration, no toggle locale,
 * no chip stylesheet, and — critically — the generic image surfaces
 * (ImageGallery value, presented-card focus, clipboard paste compatibility)
 * must survive the retirement unchanged.
 */
function createBoundaryHarness({ pluginApply } = {}) {
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

  const React = {
    Fragment: Symbol('Fragment'),
    createElement() {},
    useState() { return [null, () => {}] },
    useEffect() {},
  }
  loader.load({
    id: 'dsh-vision-router',
    factory(require) {
      require('@deepseek-ai/dsh-client-ui-attachment')
      return {
        apply(ctx) {
          if (pluginApply) pluginApply(ctx)
        },
      }
    },
  })

  const requested = []
  const plugin = registered.factory((id) => {
    requested.push(id)
    if (id === 'react') return React
    throw new Error(`unexpected host value request: ${id}`)
  })

  const effects = []
  const injections = []
  const localeRegistrations = []
  const ctx = {
    locale: {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
        return () => {}
      },
    },
    effect(run, label) {
      effects.push(label)
      return run()
    },
    inject(dependencies, callback) {
      injections.push(Array.from(dependencies))
      callback({})
    },
  }
  return { plugin, ctx, effects, injections, localeRegistrations, requested }
}

test('issue #284 retirement: the presentation boundary carries no composer toggle surface', () => {
  for (const stale of [
    'vision-router-mode-toggle',
    'conversation.input.right',
    'vr-vision-toggle',
    'dsh-vision-router/mode-toggle',
    'resolveVisionModePair',
    'settingsScope',
    'Auto Vision',
    '自动识图',
  ]) {
    assert.equal(CLIENT_PRESENTATION_PRELUDE.includes(stale), false, `prelude must not contain ${stale}`)
    assert.equal(mainSource.includes(stale), false, `source must not contain ${stale}`)
  }
  // The toggle icon seam was a transform in client-presentation-boundary.js.
  const wrapperSource = readFileSync(new URL('../lib/client-presentation-boundary.js', import.meta.url), 'utf8')
  assert.equal(wrapperSource.includes('transformVisionModeToggleIcons'), false)
  assert.equal(wrapperSource.includes('vr-vision-toggle'), false)
})

test('issue #284 retirement: the decorated client plugin registers no composer slot and no toggle locale', () => {
  const { plugin, ctx, effects, injections, localeRegistrations, requested } = createBoundaryHarness()
  plugin.apply(ctx)

  assert.deepEqual(injections, [], 'no slots/modelDirectories/sessions/remote dependency may be injected')
  assert.deepEqual(localeRegistrations, [], 'the retired vision-router-mode locale must not be registered')
  assert.ok(
    effects.some((label) => label === 'vision-router: clipboard image paste normalization'),
    'the generic clipboard image paste compatibility must keep installing',
  )
  assert.ok(requested.includes('react'), 'the legacy factory still receives its React value')
  assert.equal(
    requested.includes('@deepseek-ai/dsh-client-ui-primitives'),
    false,
    'the toggle toast primitives dependency must be gone',
  )
  assert.equal(plugin.apply.__visionRouterPasteCompat, true, 'decoration stays idempotent across Host reloads')
})

test('issue #284 retirement: client locale dictionaries pass through unmodified', () => {
  const dictionaries = {
    zh: { quickStartBody: '本页文案', onboardingStep1Body: '步骤文案', guideStep1Body: '引导文案' },
    en: { quickStartBody: 'copy', onboardingStep1Body: 'copy', guideStep1Body: 'copy' },
  }
  const { plugin, ctx, localeRegistrations } = createBoundaryHarness({
    pluginApply(innerCtx) {
      innerCtx.locale.register('vision-router', dictionaries)
    },
  })
  plugin.apply(ctx)

  assert.equal(localeRegistrations.length, 1)
  assert.equal(localeRegistrations[0].namespace, 'vision-router')
  // No runtime copy patching: the exact registered dictionary object ships.
  assert.equal(localeRegistrations[0].dictionaries, dictionaries)
})

test('issue #284 retirement: the generic image preview surfaces survive the toggle removal', () => {
  for (const retained of [
    'function PresentedImage(props)',
    'function ImageGallery(props)',
    '__dvrPresentFocus',
    'installClipboardImagePasteCompat',
    'function scopedRequire(id) {',
  ]) {
    assert.ok(CLIENT_PRESENTATION_PRELUDE.includes(retained), `prelude must retain ${retained}`)
  }
  // The legacy attachment value seam still works through the loader factory.
  const harness = createBoundaryHarness()
  assert.equal(typeof harness.plugin.apply, 'function')
  const html = injectClientPresentationBoundary('<html><head></head><body></body></html>')
  assert.match(html, /data-vision-router-presentation-boundary/)
  assert.equal((html.match(/data-vision-router-presentation-boundary/g) ?? []).length, 1)
})

test('issue #284 retirement: no vision-mode copy patch ships on the #271 guide mutation fence path', () => {
  // The guide mutation fence itself stays: it protects the settings walkthrough
  // observer, which now teaches the /vision command.
  assert.ok(CLIENT_PRESENTATION_PRELUDE.includes('installGuideMutationFence'))
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes('patchVisionModeCopy'), false)
  assert.equal(CLIENT_PRESENTATION_PRELUDE.includes('bindVisionModeSettings'), false)
})
