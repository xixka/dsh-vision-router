import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { CLIENT_PRESENTATION_PRELUDE } from '../lib/client-presentation-boundary.js'

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * #284/#431 effort semantics after the P5 UI retirement. The old world kept an
 * invisible wrapper route active while Vision was on and remapped same-provider
 * /model selections onto it (preserving effort, hiding the wrapper). With the
 * composer toggle and the /model filter retired there is no hidden wrapper to
 * preserve: a user's /model selection is submitted exactly as chosen, and
 * reasoning effort travels with the ordinary Host selection. These tests pin
 * that no selection remapping code remains and that the guide copy stopped
 * explaining wrapper-preservation semantics.
 */
test('issue #284 retirement: no presentation-layer selection remapping exists', () => {
  for (const stale of [
    'mapVisionPresentationSelection',
    'projectVisionModeDirectoryState',
    'wrappedProviders',
    'autoWrapProviders',
    'wrapperRoute',
    'reasoningEffort',
  ]) {
    assert.equal(CLIENT_PRESENTATION_PRELUDE.includes(stale), false, `prelude must not contain ${stale}`)
  }
  const wrapperSource = readFileSync(new URL('../lib/client-presentation-boundary.js', import.meta.url), 'utf8')
  assert.equal(wrapperSource.includes('mapVisionPresentationSelection'), false)
})

test('issue #431 guide copy no longer explains wrapper-preservation semantics', () => {
  // The retired copy described switching models within a model group keeping
  // the hidden wrapper route (and therefore Vision mode) active.
  for (const stale of [
    '同一模型组内切换到另一个支持识图模式的模型也会保持开启',
    'switch to another Vision-enabled model in the same model group',
    '没有对应识图模式的普通模型',
    'normal model with no matching Vision route',
  ]) {
    assert.equal(CLIENT_PRESENTATION_PRELUDE.includes(stale), false, `prelude must not contain ${stale}`)
    assert.equal(clientSource.includes(stale), false, `client bundle must not contain ${stale}`)
  }
})

test('issue #284 retirement: the walkthrough now teaches the /vision command for image turns', () => {
  assert.match(clientSource, /\/vision on 开启识图/)
  assert.match(clientSource, /\/vision <问题> 并附上图片/)
  assert.match(clientSource, /run \/vision on/)
  assert.match(clientSource, /send \/vision <question> with the image attached/)
})

test('issue #284 retirement: no "-vision" twin or lookalike inference ships anywhere in the boundary', () => {
  const mainSource = readFileSync(new URL('../lib/client-presentation-boundary-main.js', import.meta.url), 'utf8')
  for (const stale of [
    "endsWith('-vision')",
    "'-vision'.length",
    '-vision-vision',
    '自动识图',
    'studio-vision',
  ]) {
    assert.equal(mainSource.includes(stale), false, `boundary source must not contain ${stale}`)
    assert.equal(CLIENT_PRESENTATION_PRELUDE.includes(stale), false, `prelude must not contain ${stale}`)
  }
})
