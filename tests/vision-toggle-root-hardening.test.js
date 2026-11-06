import test from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'

import { injectClientPresentationBoundary } from '../lib/client-presentation-boundary.js'

/**
 * Root hardening after the P5 UI retirement (plan §5.2). The toggle root
 * hardening existed to (a) hide unowned wrapper routes from settings and
 * llm.listProviders, (b) expose a /route-ownership snapshot endpoint, and
 * (c) rewrite the client scripts that consumed that ownership — the composer
 * toggle, the model-visibility filter, and their selection recovery stores.
 * All consumers are retired with the button, so the whole module — ownership
 * view, endpoint, CLIENT_PRELUDE, and script rewriter — is deleted rather
 * than left as dead authority. These tests pin the retirement contract.
 */
test('retirement: the root hardening and guide highlight modules are gone', async () => {
  for (const path of [
    '../lib/vision-toggle-root-hardening.js',
    '../lib/guide-vision-toggle-highlight.js',
  ]) {
    await assert.rejects(
      access(new URL(path, import.meta.url)),
      (error) => error?.code === 'ENOENT',
      `${path} must not exist anymore`,
    )
  }
})

test('retirement: the public entry no longer wires root hardening into the Host boundary', () => {
  const entrySource = readFileSync(new URL('../src/lib/public-entry.js', import.meta.url), 'utf8')
  assert.doesNotMatch(entrySource, /vision-toggle-root-hardening/)
  assert.doesNotMatch(entrySource, /createVisionToggleRootHardening/)
  assert.doesNotMatch(entrySource, /installClientBoundary/)
  assert.doesNotMatch(entrySource, /route-ownership/)
  assert.doesNotMatch(entrySource, /__dshVisionRouterRootHardening/)
  // The settings-composition chain it used to wrap still composes.
  assert.match(entrySource, /contextWithVisionRoutingTopologyRefresh\(sessionSourceCtx\)/)
  assert.match(entrySource, /base\.apply\(runtimeCtx, config, \{ providerTransport: transport \}\)/)
})

test('retirement: no ownership prelude or endpoint marker ships to the browser', () => {
  const html = injectClientPresentationBoundary('<html><head></head><body></body></html>')
  assert.equal(html.includes('__dshVisionRouterRootHardening'), false,
    'the retired ownership prelude must not be injected')
  assert.equal(html.includes('data-vision-router-root-ownership'), false)
  assert.equal(html.includes('/_dsh/vision-router/route-ownership'), false)
  assert.equal(html.includes('data-vision-router-guide-toggle-highlight'), false,
    'the retired guide highlight carrier must not be injected')
})

test('retirement: no client carrier re-introduces the retired ownership or highlight surfaces', () => {
  const boundarySources = [
    '../src/lib/client-presentation-boundary-main.js',
    '../src/lib/client-presentation-boundary.js',
    '../src/lib/public-entry.js',
    '../src/lib/web/index.js',
    '../src/lib/web/onboarding.js',
    '../src/lib/web/model-picker.js',
  ]
  for (const path of boundarySources) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /route-ownership/, `${path} must not register the retired endpoint`)
    assert.doesNotMatch(source, /hardenVisionClientSource|hardenVisionToggleHtml/, `${path} must not rewrite client scripts`)
  }
})
