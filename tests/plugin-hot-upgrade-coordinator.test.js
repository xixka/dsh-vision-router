// Hot upgrade coordinator state machine unit tests (plan.md §6.4).
//
// All side-effectful steps are injected adapters, so these tests pin the
// coordination contract itself: staged validation aborts before the running
// generation is touched, the migration preflight blocks, drain timeouts abort
// without silent interruption, verification failure triggers snapshot
// rollback, a failed restore surfaces as an explicit outage, and repeated
// upgrade/reset cycles keep the singleton surfaces (/vision, one tool set)
// unique.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import {
  HOT_UPGRADE_STATES,
  HOT_UPGRADE_DRAIN_POLICIES,
  checkUpgradePreflight,
  createHotUpgradeCoordinator,
  createGenerationResourceTracker,
  bindGenerationResources,
  createStagingValidator,
  createSubprocessImportProbe,
  runDshPluginCommand,
  loadInstallReadiness,
} from '../lib/plugin-hot-upgrade-coordinator.js'

const okResult = (extra = {}) => ({ ok: true, ...extra })

function makeAdapters(overrides = {}) {
  const calls = {
    validate: [],
    snapshot: [],
    drain: [],
    execute: [],
    verify: [],
    restore: [],
  }
  const adapters = {
    calls,
    validateCandidate: async (candidate) => {
      calls.validate.push(candidate)
      return okResult({ checks: [{ name: 'manifest', status: 'pass' }], readinessSource: 'test' })
    },
    checkPreflight: async () => okResult({ blockers: [] }),
    createSnapshot: async () => {
      calls.snapshot.push(true)
      return {
        id: 'snap-1',
        version: '3.1.4',
        recovery: { steps: ['restore patch content'], command: 'dsh plugin --profile web add file:<old-source>' },
      }
    },
    drainActiveAgents: async (request, { cancelIds } = {}) => {
      calls.drain.push({ cancelIds: [...cancelIds] })
      return { pending: [], drained: [] }
    },
    executeUpgrade: async (request, snapshot) => {
      calls.execute.push({ request, snapshot })
      return {
        ok: true,
        host: { pid: 4242, port: 8080, continuity: 'stable' },
        client: { reloaded: true },
        atomic: false,
        restartRequired: false,
        entry: 'dsh-plugin-cli',
      }
    },
    verifyGeneration: async (request, phase) => {
      calls.verify.push(phase)
      return okResult({ failures: [], checks: [{ name: 'dvr-route', status: 'pass' }] })
    },
    restoreSnapshot: async (snapshot, context) => {
      calls.restore.push({ snapshot, context })
      return okResult({ actions: ['restored patch content'] })
    },
    ...overrides,
  }
  return adapters
}

function makeCoordinator(adapters, options = {}) {
  const {
    calls, validateCandidate, checkPreflight, createSnapshot, drainActiveAgents,
    executeUpgrade, verifyGeneration, restoreSnapshot, ...rest
  } = adapters
  return createHotUpgradeCoordinator({
    validateCandidate,
    checkPreflight,
    createSnapshot,
    drainActiveAgents,
    executeUpgrade,
    verifyGeneration,
    restoreSnapshot,
    ...rest,
    ...options,
  })
}

// ── checkUpgradePreflight (P3-lite migration gate) ──────────────────────────

test('preflight blocks when the candidate needs an un-run migration', () => {
  const result = checkUpgradePreflight({
    candidateMigrationVersion: 4,
    completedMigrationVersion: 3,
  })
  assert.equal(result.ok, false)
  assert.equal(result.blockers.length, 1)
  assert.equal(result.blockers[0].kind, 'migration-pending')
})

test('preflight blocks on explicitly tracked un-run migrations and lockfile drift', () => {
  const result = checkUpgradePreflight({
    pendingMigrations: ['settings-2026-11'],
    lockfileConsistent: false,
  })
  assert.equal(result.ok, false)
  const kinds = result.blockers.map((blocker) => blocker.kind).sort()
  assert.deepEqual(kinds, ['lockfile-mismatch', 'migration-incomplete'])
})

test('preflight passes on equal migration versions and with an explicit risk acknowledgement', () => {
  assert.equal(checkUpgradePreflight({ candidateMigrationVersion: 3, completedMigrationVersion: 3 }).ok, true)
  assert.equal(
    checkUpgradePreflight({
      candidateMigrationVersion: 4,
      completedMigrationVersion: 3,
      allowPendingMigrations: true,
    }).ok,
    true,
  )
})

// ── state machine: pre-execution aborts leave the old generation untouched ──

test('validation failure aborts before snapshot or execute', async () => {
  const adapters = makeAdapters({
    validateCandidate: async () => ({ ok: false, failures: [{ kind: 'manifest-unreadable', detail: 'broken json' }] }),
  })
  const coordinator = makeCoordinator(adapters)
  const result = await coordinator.upgrade({ candidate: { dir: '/tmp/broken' } })
  assert.equal(result.ok, false)
  assert.equal(result.state, HOT_UPGRADE_STATES.ABORTED)
  assert.equal(result.reason, 'candidate-validation-failed')
  assert.equal(result.oldGenerationUntouched, true)
  assert.equal(adapters.calls.snapshot.length, 0)
  assert.equal(adapters.calls.execute.length, 0)
})

test('preflight blocker aborts before snapshot and execute', async () => {
  const adapters = makeAdapters({
    checkPreflight: async () => ({ ok: false, blockers: [{ kind: 'migration-pending', detail: 'migration 4 un-run' }] }),
  })
  const coordinator = makeCoordinator(adapters)
  const result = await coordinator.upgrade({})
  assert.equal(result.state, HOT_UPGRADE_STATES.ABORTED)
  assert.equal(result.reason, 'preflight-blocked')
  assert.deepEqual(result.blockers.map((b) => b.kind), ['migration-pending'])
  assert.equal(result.oldGenerationUntouched, true)
  assert.equal(adapters.calls.snapshot.length, 0)
  assert.equal(adapters.calls.execute.length, 0)
})

test('a snapshot without a self-contained recovery plan aborts before execution', async () => {
  const adapters = makeAdapters({
    createSnapshot: async () => ({ id: 'snap-2', version: '3.1.4' }),
  })
  const coordinator = makeCoordinator(adapters)
  const result = await coordinator.upgrade({})
  assert.equal(result.state, HOT_UPGRADE_STATES.ABORTED)
  assert.equal(result.reason, 'snapshot-not-recovery-self-contained')
  assert.equal(adapters.calls.execute.length, 0)
})

// ── drain semantics: never silently interrupt, never auto-replay ────────────

test('drain timeout (default policy) aborts without executing', async () => {
  const adapters = makeAdapters({
    drainActiveAgents: async () => ({ pending: [{ id: 'agent-1', kind: 'vision' }], drained: [] }),
  })
  const coordinator = makeCoordinator(adapters, {
    drainTimeoutMs: 30,
    drainPollIntervalMs: 5,
    sleep: async () => {},
  })
  const result = await coordinator.upgrade({})
  assert.equal(result.state, HOT_UPGRADE_STATES.ABORTED)
  assert.equal(result.reason, 'drain-timeout')
  assert.equal(result.oldGenerationUntouched, true)
  assert.equal(adapters.calls.execute.length, 0)
  assert.equal(result.drain.replayedRequests, 0)
  assert.equal(result.drain.timedOut, true)
  assert.deepEqual(result.drain.pending.map((a) => a.id), ['agent-1'])
})

test('require-explicit-cancel without a confirmation aborts and names the required confirmation', async () => {
  const adapters = makeAdapters({
    drainActiveAgents: async () => ({ pending: [{ id: 'agent-7', kind: 'vision' }], drained: [] }),
  })
  const coordinator = makeCoordinator(adapters, {
    drainTimeoutMs: 10,
    drainPollIntervalMs: 1,
    sleep: async () => {},
  })
  const result = await coordinator.upgrade({ drainPolicy: 'require-explicit-cancel' })
  assert.equal(result.state, HOT_UPGRADE_STATES.ABORTED)
  assert.equal(result.reason, 'drain-requires-explicit-cancel')
  assert.deepEqual(result.blockers.map((b) => b.kind), ['drain-requires-explicit-cancel'])
  assert.equal(adapters.calls.execute.length, 0)
})

test('require-explicit-cancel with a confirmation proceeds and records the cancellation', async () => {
  const pendingById = new Map([['agent-7', { id: 'agent-7', kind: 'vision' }]])
  const adapters = makeAdapters({
    drainActiveAgents: async (request, { cancelIds } = {}) => {
      for (const id of cancelIds) pendingById.delete(id)
      return { pending: [...pendingById.values()], drained: [] }
    },
  })
  const coordinator = makeCoordinator(adapters)
  const result = await coordinator.upgrade({
    drainPolicy: 'require-explicit-cancel',
    cancelConfirmations: ['agent-7'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.state, HOT_UPGRADE_STATES.COMMITTED)
  assert.deepEqual(result.drain.cancelledIds, ['agent-7'])
  assert.equal(result.drain.replayedRequests, 0)
  const cancelCall = adapters.calls.drain.find((call) => call.cancelIds.length > 0)
  assert.ok(cancelCall, 'the drain adapter must observe the explicit cancel')
  assert.deepEqual(cancelCall.cancelIds, ['agent-7'])
})

// ── execution, verification, rollback, outage ───────────────────────────────

test('a successful upgrade commits and records the non-atomic Host/Client pair', async () => {
  const adapters = makeAdapters()
  const coordinator = makeCoordinator(adapters)
  const result = await coordinator.upgrade({})
  assert.equal(result.ok, true)
  assert.equal(result.state, HOT_UPGRADE_STATES.COMMITTED)
  assert.equal(result.execution.atomic, false)
  assert.equal(result.execution.host.pid, 4242)
  assert.equal(result.execution.client.reloaded, true)
  const states = result.phases.map((phase) => phase.state)
  assert.deepEqual(states, [
    HOT_UPGRADE_STATES.VALIDATING,
    HOT_UPGRADE_STATES.PREFLIGHT,
    HOT_UPGRADE_STATES.SNAPSHOTTING,
    HOT_UPGRADE_STATES.DRAINING,
    HOT_UPGRADE_STATES.EXECUTING,
    HOT_UPGRADE_STATES.VERIFYING,
    HOT_UPGRADE_STATES.COMMITTED,
  ])
})

test('verification failure rolls the snapshot back and recovers the old version', async () => {
  const adapters = makeAdapters({
    verifyGeneration: async (request, phase) => {
      if (phase?.restored) return okResult({ failures: [] })
      return { ok: false, failures: [{ kind: 'version-mismatch', detail: 'installed 3.1.4, target 9.9.9' }] }
    },
  })
  const coordinator = makeCoordinator(adapters)
  const result = await coordinator.upgrade({ targetVersion: '9.9.9' })
  assert.equal(result.ok, false)
  assert.equal(result.state, HOT_UPGRADE_STATES.RECOVERED)
  assert.equal(result.recovered, true)
  assert.equal(result.recovery.restored, true)
  assert.equal(result.recovery.verified, true)
  assert.equal(result.recovery.snapshotVersion, '3.1.4')
  assert.equal(adapters.calls.restore.length, 1)
  assert.deepEqual(result.verification.failures.map((f) => f.kind), ['version-mismatch'])
})

test('a failed restore surfaces as an explicit outage with a repair command', async () => {
  const adapters = makeAdapters({
    verifyGeneration: async () => ({ ok: false, failures: [{ kind: 'route-dead' }] }),
    restoreSnapshot: async () => ({ ok: false, error: 'profile reinstall failed' }),
  })
  const coordinator = makeCoordinator(adapters)
  const result = await coordinator.upgrade({})
  assert.equal(result.state, HOT_UPGRADE_STATES.OUTAGE)
  assert.equal(result.reason, 'recovery-failed')
  assert.equal(result.recovery.restored, false)
  assert.equal(result.recovery.repairCommand, 'dsh plugin --profile web add file:<old-source>')
  assert.ok(Array.isArray(result.recovery.steps) && result.recovery.steps.length > 0)
})

test('a restored-but-unverified old version is an outage, not a success', async () => {
  const adapters = makeAdapters({
    verifyGeneration: async () => ({ ok: false, failures: [{ kind: 'route-dead' }] }),
  })
  const coordinator = makeCoordinator(adapters)
  const result = await coordinator.upgrade({})
  assert.equal(result.state, HOT_UPGRADE_STATES.OUTAGE)
  assert.equal(result.reason, 'recovery-unverified')
  assert.equal(result.recovery.restored, true)
  assert.equal(result.recovery.verified, false)
})

test('execution failure triggers rollback and recovery', async () => {
  const adapters = makeAdapters({
    executeUpgrade: async () => ({ ok: false, error: 'pnpm install failed' }),
  })
  const coordinator = makeCoordinator(adapters)
  const result = await coordinator.upgrade({})
  assert.equal(result.ok, false)
  assert.equal(result.state, HOT_UPGRADE_STATES.RECOVERED)
  assert.equal(result.recovery.verified, true)
  assert.equal(result.execution.ok, false)
})

test('single-flight: a second upgrade while one is running is rejected as busy', async () => {
  let releaseExecute
  const gate = new Promise((resolve) => {
    releaseExecute = resolve
  })
  const adapters = makeAdapters({
    executeUpgrade: async () => {
      await gate
      return { ok: true, host: {}, client: {}, atomic: false, restartRequired: false }
    },
  })
  const coordinator = makeCoordinator(adapters)
  const first = coordinator.upgrade({})
  const second = await coordinator.upgrade({})
  assert.equal(second.ok, false)
  assert.equal(second.state, 'busy')
  releaseExecute()
  const settled = await first
  assert.equal(settled.state, HOT_UPGRADE_STATES.COMMITTED)
})

// ── idempotency: 10 upgrade/reset cycles, singleton surfaces stay unique ────

test('ten consecutive upgrade/reset cycles keep exactly one /vision and one tool set', async () => {
  // The mock Host models rc.5 generation semantics: a recompose disposes the
  // previous generation's registrations before the new generation applies,
  // and the registries throw on duplicate names (NamedEntries semantics).
  const commands = new Map()
  const tools = new Map()
  let disposedGenerations = 0
  const registry = {
    registerCommand(def) {
      if (commands.has(def.name)) throw new Error(`duplicate command: ${def.name}`)
      commands.set(def.name, def)
      return () => commands.delete(def.name)
    },
    registerTool(def) {
      if (tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`)
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
    disposeGeneration() {
      disposedGenerations += 1
      for (const dispose of [...commands.values()]) dispose()
      commands.clear()
      for (const dispose of [...tools.values()]) dispose()
      tools.clear()
    },
  }
  const adapters = makeAdapters({
    executeUpgrade: async () => {
      // The Host disposes the previous generation, then the new generation
      // applies: one /vision, one tool set.
      registry.disposeGeneration()
      registry.registerCommand({ name: '/vision' })
      registry.registerTool({ name: 'vision_activate' })
      return { ok: true, host: { continuity: 'stable' }, client: { reloaded: true }, atomic: false, restartRequired: false }
    },
    verifyGeneration: async () => okResult({
      checks: [
        { name: 'command-singleton', status: commands.size === 1 ? 'pass' : 'fail' },
        { name: 'tool-set-singleton', status: tools.size === 1 ? 'pass' : 'fail' },
      ],
    }),
  })
  const coordinator = makeCoordinator(adapters)
  for (let cycle = 1; cycle <= 10; cycle += 1) {
    const kind = cycle % 2 === 1 ? 'upgrade' : 'reset'
    const result = kind === 'upgrade' ? await coordinator.upgrade({}) : await coordinator.reset({})
    assert.equal(result.ok, true, `cycle ${cycle} (${kind}) must commit`)
    assert.equal(result.state, HOT_UPGRADE_STATES.COMMITTED, `cycle ${cycle} state`)
    assert.equal(commands.size, 1, `cycle ${cycle}: exactly one /vision`)
    assert.equal(tools.size, 1, `cycle ${cycle}: exactly one tool`)
    assert.ok(commands.has('/vision'))
    assert.ok(tools.has('vision_activate'))
  }
  assert.equal(disposedGenerations, 10)
})

// ── generation resource tracker (plan.md §6.5) ──────────────────────────────

test('tracker disposes a real child process and awaits its exit', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const tracker = createGenerationResourceTracker(1, { exitTimeoutMs: 5000 })
  tracker.trackChildProcess(child, { describe: 'tesseract-like native child' })
  assert.equal(tracker.active().length, 1)
  const disposed = await tracker.disposeAll()
  assert.equal(disposed.disposed, 1)
  assert.equal(disposed.failed, 0)
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'child must have exited')
  assert.deepEqual(tracker.active(), [])
  // Idempotent dispose.
  const again = await tracker.disposeAll()
  assert.equal(again.disposed, 0)
})

test('tracker escalates to SIGKILL when a child ignores SIGTERM', async () => {
  const child = spawn(process.execPath, ['-e', 'process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const tracker = createGenerationResourceTracker(2, { exitTimeoutMs: 300 })
  tracker.trackChildProcess(child)
  const started = Date.now()
  await tracker.disposeAll()
  assert.ok(Date.now() - started < 10_000)
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

test('bindGenerationResources owns disposal through ctx.effect and reports when it cannot', () => {
  const disposers = []
  const ctx = {
    effect(fn, label) {
      disposers.push({ fn, label })
      return () => {}
    },
  }
  const bound = bindGenerationResources(ctx, { generation: 3 })
  assert.equal(bound.effectOwned, true)
  assert.equal(bound.tracker.generation, 3)
  assert.equal(disposers.length, 1)
  assert.match(disposers[0].label, /generation 3 reload resources/)
  const orphan = bindGenerationResources({}, { generation: 4 })
  assert.equal(orphan.effectOwned, false, 'without ctx.effect the caller owns disposeAll explicitly')
})

test('a timer tracked by a generation stops on disposeAll', async () => {
  const tracker = createGenerationResourceTracker(5)
  let fired = false
  const timer = setTimeout(() => {
    fired = true
  }, 50)
  tracker.trackTimer(timer)
  await tracker.disposeAll()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(fired, false)
})

// ── supported entry runner and staging validator ────────────────────────────

test('runDshPluginCommand drives the DSH CLI through its tsx loader', async () => {
  const spawns = []
  const result = await runDshPluginCommand({
    dshRoot: '/fake/dsh-root',
    tsxLoader: 'file:///fake/tsx.mjs',
    args: ['plugin', '--profile', 'web', 'add', 'file:/tmp/x'],
    env: { PATH: process.env.PATH },
    timeoutMs: 5000,
    spawnImpl: (node, argv, options) => {
      spawns.push({ node, argv, options })
      return spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    },
  })
  assert.equal(result.status, 0)
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].argv[0], '--import')
  assert.equal(spawns[0].argv[1], 'file:///fake/tsx.mjs')
  assert.equal(spawns[0].argv[2], '/fake/dsh-root/apps/cli/src/bin.ts')
  assert.deepEqual(spawns[0].argv.slice(3), ['plugin', '--profile', 'web', 'add', 'file:/tmp/x'])
})

test('runDshPluginCommand rejects a non-zero exit through the caller-visible status', async () => {
  const result = await runDshPluginCommand({
    dshRoot: '/fake/dsh-root',
    tsxLoader: 'file:///fake/tsx.mjs',
    args: ['plugin', '--profile', 'web', 'add', 'file:/tmp/broken'],
    env: { PATH: process.env.PATH },
    timeoutMs: 5000,
    spawnImpl: () => spawn(process.execPath, ['-e', 'console.error("boom"); process.exit(127)'], { stdio: ['ignore', 'pipe', 'pipe'] }),
  })
  assert.equal(result.status, 127)
  assert.match(result.stderr, /boom/)
})

async function stubValidator(overrides = {}) {
  return createStagingValidator({
    runCommand: async () => ({ status: 0, stdout: '', stderr: '' }),
    probeImport: async () => ({ ok: true }),
    resolveInstalledEntry: () => '/staging/entry.js',
    stagingEnv: (home) => ({ DSH_HOME: home }),
    ...overrides,
  })
}

test('staging validator fails fast on an unreadable manifest without installing', async () => {
  const installs = []
  const validate = await stubValidator({
    readManifest: () => {
      throw new Error('Unexpected token in JSON')
    },
    runCommand: async (command) => {
      installs.push(command)
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  const result = await validate({ dir: '/tmp/broken-candidate', stagingHome: '/tmp/staging' })
  assert.equal(result.ok, false)
  assert.equal(result.failures[0].kind, 'manifest-unreadable')
  assert.equal(installs.length, 0, 'a broken manifest must never reach the staging installer')
})

test('staging validator reports a failed isolated install without touching the running profile', async () => {
  const validate = await stubValidator({
    runCommand: async () => ({ status: 1, stdout: '', stderr: 'pnpm install failed' }),
  })
  const result = await validate({ dir: '/tmp/candidate', stagingHome: '/tmp/staging' })
  assert.equal(result.ok, false)
  assert.equal(result.failures[0].kind, 'staging-install-failed')
  assert.equal(result.readinessSource, 'coordinator-staging-fallback')
})

test('staging validator passes a candidate whose isolated install and bundle import succeed', async () => {
  const probed = []
  const validate = await stubValidator({
    probeImport: async (entryUrl) => {
      probed.push(entryUrl)
      return { ok: true }
    },
  })
  const result = await validate({ dir: '/tmp/candidate', stagingHome: '/tmp/staging-home' })
  assert.equal(result.ok, true)
  assert.equal(result.readinessSource, 'coordinator-staging-fallback')
  assert.deepEqual(result.checks.map((check) => check.name), ['manifest', 'staging-install', 'bundle-import'])
  assert.equal(probed[0], 'file:///staging/entry.js')
})

test('subprocess import probe fails on a module that throws at import time', async () => {
  const probe = createSubprocessImportProbe({ timeoutMs: 10_000 })
  const broken = 'data:text/javascript,throw new Error("schema construction failed")'
  const bad = await probe(broken)
  assert.equal(bad.ok, false)
  assert.match(bad.error, /schema construction failed/)
})

test('loadInstallReadiness returns undefined until Task A lands the readiness module', async () => {
  const readiness = await loadInstallReadiness()
  // When plugin-hot-install-readiness.js exists it must expose the agreed
  // surface; until then the coordinator-local fallback owns staging checks.
  if (readiness !== undefined) {
    assert.equal(typeof readiness.inspectInstallReadiness, 'function')
    assert.equal(typeof readiness.checkNativeAbi, 'function')
  } else {
    assert.equal(readiness, undefined)
  }
})

test('drain policies are exactly the two documented semantics', () => {
  assert.deepEqual([...HOT_UPGRADE_DRAIN_POLICIES], ['abort-on-timeout', 'require-explicit-cancel'])
})
