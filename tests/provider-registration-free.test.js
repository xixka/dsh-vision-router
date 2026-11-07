import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, Config } from '../index.js'

// ── P5 architecture guard (plan §4.2 末条 / §7 P5 第二项) ────────────────────
//
// Vision Router must be provider-registration-free: the plugin never writes
// the Host model directory. Guarded in two complementary layers:
//
// 1. STATIC SCAN over src/**/*.{js,ts}: the canonical plugin-initiated call
//    forms `ctx.llm.registerAdapter(` / `ctx.llm.registerConfigurableProviders(`
//    are absolutely forbidden, and the bare member-call forms are forbidden
//    outside the explicit DEFENSIVE_BOUNDARY_FILES allowlist below. Original
//    adapter metadata write operations (`registration.replace(...)` and
//    `*.adapter.<prop> = …` assignments against Host-registered adapters)
//    are forbidden everywhere.
// 2. RUNTIME FAIL-CLOSED apply(): the real plugin is applied against a mock
//    Host llm whose registration methods THROW and whose registered adapter
//    is frozen. Any dynamic bypass of the static layer inside the plugin's
//    own apply path (variable aliasing, destructuring, string-built dispatch)
//    executes those throwing arms and fails this test.
//
// Detection boundary (honest limits): the static layer is strict text
// matching — it cannot catch registrations whose method names are assembled
// from strings at runtime; that class of bypass is covered only on the
// plugin's own apply() path by the runtime layer, not on later dynamic code.
// The allowlist below is deliberately small: every entry is an interception,
// capability-detection, or read-only boundary that DELEGATES registrations
// initiated by other Host layers through a private context — none of them is
// a registration authored by Vision Router itself.

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Files permitted to mention the guarded member-call tokens. Each is an
// interception/delegation boundary over llm.registerAdapter (or a read-only
// directory reader); a NEW file joining this list must carry the same proof.
const DEFENSIVE_BOUNDARY_FILES = new Set([
  'lib/adapter-update-coalescer.js', // coalesces Host adapter-update emissions, delegates the original call
  'lib/dsh-contract-compat.js', // Host provider-ownership guard: refuses takeovers, delegates others
  'lib/dsh-host-capabilities.js', // read-only capability probe (hasFunction) + documentation comment, no call site
  'lib/local-vision-stabilizer.js', // local schema stabilizer wrapper, delegates registrations from other layers
  'lib/ollama-cold-start.js', // cold-start guard wrapper, delegates registrations from other layers
  'lib/replay-delegation.js', // replay boundary, delegates registrations from other layers
  'lib/runtime-i18n-boundary.js', // i18n boundary, delegates registrations from other layers
  'lib/twin-image-capability-fallback.js', // historical generated-twin interception, delegates every registration
  'lib/vision-tool-runtime-boundary.js', // tool runtime boundary, delegates registrations from other layers
])

function listSourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full))
      continue
    }
    if (entry.endsWith('.js') || entry.endsWith('.ts')) out.push(full)
  }
  return out
}

function scanSourceTree() {
  const violations = []
  const files = listSourceFiles(SRC_ROOT)
  assert.ok(files.length > 50, `expected the src/ tree to be scanned, found ${files.length} files`)
  for (const file of files) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/')
    const source = readFileSync(file, 'utf8')
    const allowed = DEFENSIVE_BOUNDARY_FILES.has(rel)

    for (const token of ['ctx.llm.registerAdapter', 'ctx.llm.registerConfigurableProviders']) {
      if (source.includes(token)) {
        violations.push(`${rel}: forbidden plugin-initiated registration form "${token}"`)
      }
    }
    if (!allowed) {
      for (const token of ['registerAdapter(', 'registerConfigurableProviders(']) {
        if (source.includes(token)) {
          violations.push(`${rel}: registration call "${token}" outside the defensive-boundary allowlist`)
        }
      }
    }
    if (source.includes('registration.replace(')) {
      violations.push(`${rel}: Host registration handle replacement (adapter metadata write)`)
    }
    const adapterWrite = /\.adapter\s*\.\s*[A-Za-z_$][\w$]*\s*=(?![=>])/.exec(source)
    if (adapterWrite) {
      violations.push(`${rel}: Host adapter property write "${adapterWrite[0].trim()}"`)
    }
  }
  return violations
}

test('src/ is provider-registration-free: no llm registration or adapter metadata writes', () => {
  const violations = scanSourceTree()
  assert.deepEqual(violations, [])
})

test('the defensive-boundary allowlist stays minimal and justified', () => {
  // An allowlist that drifts into every file stops being a guard. Pin the
  // exact set so any addition is a deliberate, reviewed decision.
  assert.deepEqual([...DEFENSIVE_BOUNDARY_FILES].sort(), [
    'lib/adapter-update-coalescer.js',
    'lib/dsh-contract-compat.js',
    'lib/dsh-host-capabilities.js',
    'lib/local-vision-stabilizer.js',
    'lib/ollama-cold-start.js',
    'lib/replay-delegation.js',
    'lib/runtime-i18n-boundary.js',
    'lib/twin-image-capability-fallback.js',
    'lib/vision-tool-runtime-boundary.js',
  ])
})

// ── runtime fail-closed guard ───────────────────────────────────────────────
//
// apply() must complete against a Host whose model-directory write methods
// throw, with the full legacy profile shape (all retired fields, whole-turn
// routing, live events). This catches every dynamic form the text scan cannot
// see: aliasing, destructuring, reflection, or string-built dispatch inside
// the plugin's own composition path.

function failClosedHost() {
  const sourceAdapter = Object.freeze({
    providerInfo: Object.freeze((provider) => ({ id: provider, name: 'Mutable Provider' })),
    providerRetryPolicy: Object.freeze(() => undefined),
    listModels: Object.freeze(async (provider) => [
      { provider, id: 'model-a', name: 'model-a', inputModalities: Object.freeze(['text', 'image']) },
    ]),
    resolveModel: Object.freeze(async (provider, model) => {
      if (model !== 'model-a') throw new Error(`unknown model: ${model}`)
      return { provider, id: 'model-a', name: 'model-a', inputModalities: Object.freeze(['text', 'image']) }
    }),
    stream: Object.freeze(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }),
  })
  const adapters = new Map([['mutable-provider', sourceAdapter]])
  const listeners = new Map()
  const userDoc = {}
  let registrationAttempts = 0
  let directoryAttempts = 0

  const refuse = (what) => () => {
    registrationAttempts += 1
    throw new Error(`P5 architecture guard: the plugin attempted a ${what}`)
  }

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
            return { ...scope, get: () => ({ ...Config({}), ...base, ...userDoc }) }
          },
        },
        effect: () => () => {},
      })
    },
    tools: { register: () => () => {} },
    llm: {
      registerAdapter: refuse('llm.registerAdapter'),
      registerConfigurableProviders: () => {
        directoryAttempts += 1
        throw new Error('P5 architecture guard: the plugin attempted a configurable-provider directory write')
      },
      registration(provider) {
        const adapter = adapters.get(provider)
        if (!adapter) throw new Error(`no adapter registered for provider "${provider}"`)
        return { adapter, retryPolicy: undefined }
      },
      listProviders() {
        return [...adapters.keys()].map((id) => ({ id, name: id }))
      },
      async listModels(provider) {
        const adapter = adapters.get(provider)
        return adapter && typeof adapter.listModels === 'function' ? adapter.listModels(provider) : []
      },
      async resolveModelInfo(provider, model) {
        const adapter = adapters.get(provider)
        if (!adapter || typeof adapter.resolveModel !== 'function') {
          throw new Error(`no adapter registered for provider "${provider}"`)
        }
        return adapter.resolveModel(provider, model)
      },
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }

  return { ctx, listeners, userDoc, counts: () => ({ registrationAttempts, directoryAttempts }), sourceAdapter }
}

test('apply() completes against a Host whose model-directory writes throw, and never triggers them', () => {
  const { ctx, listeners, counts } = failClosedHost()
  assert.doesNotThrow(() =>
    apply(
      ctx,
      Config({
        autoWrapProviders: true,
        wrappedProviders: [{ provider: 'mutable-provider', models: [] }],
        wrapperRoute: 'deepseek-vision',
        chainRoute: 'vision-chain',
        routing: true,
      }),
    ),
  )
  assert.deepEqual(counts(), { registrationAttempts: 0, directoryAttempts: 0 })

  // Topology and settings events must not resurrect any registration either.
  for (const emit of listeners.get('llm/adapters-updated') ?? []) emit()
  assert.deepEqual(counts(), { registrationAttempts: 0, directoryAttempts: 0 })
})

test('apply() leaves the Host-registered adapter metadata untouched', () => {
  const { ctx, sourceAdapter, counts } = failClosedHost()
  apply(ctx, Config({ autoWrapProviders: true, routing: true }))
  assert.deepEqual(counts(), { registrationAttempts: 0, directoryAttempts: 0 })
  // Original provider metadata/adapter declarations: identity and shape intact.
  assert.equal(ctx.llm.registration('mutable-provider').adapter, sourceAdapter)
  assert.deepEqual(Object.keys(sourceAdapter).sort(), [
    'listModels',
    'providerInfo',
    'providerRetryPolicy',
    'resolveModel',
    'stream',
  ])
})
