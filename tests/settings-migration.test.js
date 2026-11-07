import assert from 'node:assert/strict'
import test from 'node:test'

import {
  flattenProviderFallbackRows,
  legacySettingsMigrationOps,
  migrateLegacyVisionSettings,
} from '../lib/settings-migration.js'
import { normalizeRuntimeVisionConfig } from '../lib/runtime-config-normalizer.js'
import { Config } from '../index.js'

function descriptor({ user = {}, value = {}, revision = 9 } = {}) {
  return {
    ns: 'vision-router',
    user,
    value: {
      provider: 'vision-http',
      model: 'ovh/Qwen3.5-397B-A17B',
      fallbacks: [],
      providers: [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] }],
      ...value,
    },
    revision,
  }
}

test('legacy shorthand migrates atomically to one visible row per runtime backend', () => {
  const ops = legacySettingsMigrationOps(descriptor({
    user: {
      provider: 'openrouter',
      model: 'qwen-vl',
      fallbacks: ['qwen-vl-backup'],
      visionGuideStep: 'chain',
      instantDescribe: true,
      localDescribeStyle: 'plain',
    },
  }))

  assert.deepEqual(ops[0], {
    op: 'set',
    path: ['providers'],
    value: [
      { provider: 'openrouter', model: 'qwen-vl', fallbacks: [] },
      { provider: 'openrouter', model: 'qwen-vl-backup', fallbacks: [] },
    ],
  })
  assert.deepEqual(
    ops.slice(1).map((op) => op.path[0]),
    ['provider', 'model', 'fallbacks', 'visionGuideStep', 'instantDescribe', 'localDescribeStyle'],
  )
  assert.equal(ops.slice(1).every((op) => op.op === 'unset'), true)
})

test('explicit nested provider fallbacks are flattened without changing execution order', () => {
  const providers = [
    { provider: 'openrouter', model: 'primary', fallbacks: ['backup-1', 'backup-2'] },
    { provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] },
  ]
  assert.deepEqual(flattenProviderFallbackRows(providers), [
    { provider: 'openrouter', model: 'primary', fallbacks: [] },
    { provider: 'openrouter', model: 'backup-1', fallbacks: [] },
    { provider: 'openrouter', model: 'backup-2', fallbacks: [] },
    { provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] },
  ])

  const ops = legacySettingsMigrationOps(descriptor({ user: { providers } }))
  assert.deepEqual(ops, [{
    op: 'set',
    path: ['providers'],
    value: [
      { provider: 'openrouter', model: 'primary', fallbacks: [] },
      { provider: 'openrouter', model: 'backup-1', fallbacks: [] },
      { provider: 'openrouter', model: 'backup-2', fallbacks: [] },
      { provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] },
    ],
  }])
})

test('an explicit already-flat providers chain is never overwritten while shorthand is cleaned', () => {
  const providers = [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] }]
  const ops = legacySettingsMigrationOps(descriptor({
    user: {
      providers,
      provider: 'old-provider',
      model: 'old-model',
      fallbacks: ['old-fallback'],
    },
  }))

  assert.equal(ops.some((op) => op.op === 'set' && op.path[0] === 'providers'), false)
  assert.deepEqual(ops.map((op) => op.path[0]), ['provider', 'model', 'fallbacks'])
})

test('retired fields are cleaned even when no legacy shorthand exists', () => {
  const ops = legacySettingsMigrationOps(descriptor({
    user: {
      providers: [{ provider: 'openrouter', model: 'qwen-vl', fallbacks: [] }],
      instantDescribe: false,
      localDescribeStyle: 'structured',
      visionGuideStep: '',
    },
  }))
  assert.deepEqual(
    ops.map((op) => [op.op, op.path[0]]),
    [
      ['unset', 'visionGuideStep'],
      ['unset', 'instantDescribe'],
      ['unset', 'localDescribeStyle'],
    ],
  )
})

test('migration uses one revision-checked mutate and preserves an already-flat providers chain', async () => {
  const providers = [{ provider: 'zhipu', model: 'glm-4.6v-flash', fallbacks: [] }]
  const calls = []
  const settings = {
    writable: true,
    describe() {
      return [descriptor({
        user: { providers, provider: 'legacy', instantDescribe: true },
        value: { providers },
        revision: 12,
      })]
    },
    async mutate(ns, ops, revision) {
      calls.push({ ns, ops, revision })
    },
  }

  const result = await migrateLegacyVisionSettings(settings)
  assert.equal(result.migrated, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].ns, 'vision-router')
  assert.equal(calls[0].revision, 12)
  assert.equal(calls[0].ops.some((op) => op.op === 'set' && op.path[0] === 'providers'), false)
  assert.deepEqual(calls[0].ops.map((op) => op.path[0]), ['provider', 'instantDescribe'])
})

test('a settings revision conflict is re-described once so legacy custom models are not shadowed by defaults', async () => {
  let describeCount = 0
  const calls = []
  const settings = {
    writable: true,
    describe() {
      describeCount++
      return [descriptor({
        user: { provider: 'openrouter', model: 'qwen-vl' },
        revision: describeCount === 1 ? 20 : 21,
      })]
    },
    async mutate(ns, ops, revision) {
      calls.push({ ns, ops, revision })
      if (calls.length === 1) {
        const error = new Error('revision changed')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
    },
  }

  const result = await migrateLegacyVisionSettings(settings)
  assert.equal(result.migrated, true)
  assert.equal(describeCount, 2)
  assert.deepEqual(calls.map((call) => call.revision), [20, 21])
  assert.deepEqual(calls[1].ops[0].value, [
    { provider: 'openrouter', model: 'qwen-vl', fallbacks: [] },
  ])
})

test('read-only settings never attempt migration', async () => {
  let mutated = false
  const result = await migrateLegacyVisionSettings({
    writable: false,
    describe() { throw new Error('should not describe') },
    async mutate() { mutated = true },
  })
  assert.deepEqual(result, { migrated: false, reason: 'read-only' })
  assert.equal(mutated, false)
})

test('retired compatibility values cannot reach normalized runtime config', () => {
  const normalized = normalizeRuntimeVisionConfig({
    providers: [{ provider: 'openrouter', model: 'qwen-vl', fallbacks: [] }],
    instantDescribe: true,
    localDescribeStyle: 'plain',
    visionGuideStep: 'chain',
    tool: true,
  })
  assert.equal(Object.hasOwn(normalized, 'instantDescribe'), false)
  assert.equal(Object.hasOwn(normalized, 'localDescribeStyle'), false)
  assert.equal(Object.hasOwn(normalized, 'visionGuideStep'), false)
  assert.equal(normalized.tool, true)
})

// ── P5 (plan §4.5): the retired routing/wrapper fields are READ-ONLY profile
// compatibility data — parsed and preserved so old profiles keep resolving,
// never a runtime switch and never a reason for the migration to rewrite the
// visible providers chain. ──────────────────────────────────────────────────

test('P5: retired wrapper/chain/auto-wrap/stealth fields stay read-only profile compatibility data', () => {
  const legacy = Config({
    autoWrapProviders: true,
    wrappedProviders: [{ provider: 'deepseek-official', models: ['deepseek-v4-pro'] }],
    wrapperRoute: 'deepseek-vision',
    chainRoute: 'vision-chain',
    stealth: true,
  })
  assert.equal(legacy.autoWrapProviders, true)
  assert.deepEqual(
    legacy.wrappedProviders,
    [{ provider: 'deepseek-official', models: ['deepseek-v4-pro'] }],
  )
  assert.equal(legacy.wrapperRoute, 'deepseek-vision')
  assert.equal(legacy.chainRoute, 'vision-chain')
  assert.equal(legacy.stealth, true)
})

test('P5: retired-field defaults keep their historical values so old profiles resolve identically', () => {
  const defaults = Config({})
  assert.equal(defaults.autoWrapProviders, true)
  assert.deepEqual(defaults.wrappedProviders, [{ provider: 'deepseek-official', models: [] }])
  assert.equal(defaults.wrapperRoute, 'deepseek-vision')
  assert.equal(defaults.chainRoute, 'vision-chain')
  assert.equal(defaults.stealth, false)
})

test('P5: legacy shorthand migration is unaffected by the retired routing fields', () => {
  const ops = legacySettingsMigrationOps(descriptor({
    user: {
      provider: 'openrouter',
      model: 'qwen-vl',
      wrapperRoute: 'deepseek-vision',
      chainRoute: 'vision-chain',
      stealth: true,
      autoWrapProviders: true,
      wrappedProviders: [{ provider: 'openrouter', models: [] }],
    },
  }))
  // The shorthand providers row migrates exactly as it would without the
  // retired fields, and no later op — set or unset — ever touches the
  // visible providers chain.
  assert.deepEqual(ops[0], {
    op: 'set',
    path: ['providers'],
    value: [{ provider: 'openrouter', model: 'qwen-vl', fallbacks: [] }],
  })
  assert.equal(ops.slice(1).some((op) => op.path[0] === 'providers'), false)
  assert.equal(ops.slice(1).every((op) => op.op === 'unset'), true)
  // t15 finalization: each retired routing field present in the user layer
  // now carries exactly one unset op after the legacy-chain unsets, so the
  // stored layer drops them and the new settings UI never shows them again.
  assert.deepEqual(
    ops.slice(1).map((op) => op.path[0]),
    [
      'provider',
      'model',
      'autoWrapProviders',
      'wrappedProviders',
      'wrapperRoute',
      'chainRoute',
      'stealth',
    ],
  )
})