// Hot upgrade / reset coordinator with snapshot recovery (plan.md §6.4, §6.5).
//
// Every capability this module claims is built on verified DSH 0.2.1-rc.5
// facts (see src/lib/self-update.js and the Host sources):
//
//  - Package-level replacement inside a running Host is NOT hot. The ESM
//    module registry keeps the old generation's code loaded until restart,
//    so a package swap is recorded with `atomic: false` and
//    `restartRequired: true`. The coordinator never claims otherwise.
//  - Config-level reload IS hot: rewriting the profile's cordis.patch.yml
//    recomposes plugin generations inside the same Host process (same PID,
//    same port, same sessions). That is the only supported in-process
//    upgrade/reset path and what the reload e2e drives.
//  - rc.5 does NOT guarantee that a failed candidate generation leaves the
//    previous generation serving. The coordinator therefore validates every
//    candidate in an isolated staging profile BEFORE the running
//    installation is touched, snapshots the exact old version, and restores
//    the snapshot on any execution or verification failure. A failed restore
//    surfaces as an explicit outage with a repair command — never a silent
//    half-state.
//
// Task A interface contract: when src/lib/plugin-hot-install-readiness.js
// exists (inspectInstallReadiness / checkNativeAbi / waitUntilReady), the
// staging validator defers to it. Until that file lands, a coordinator-local
// staging fallback performs the same class of checks. The readiness module
// itself is never created here.
//
// Generation resource ownership (plan.md §6.5): reload-lifetime resources
// (native child processes, timers, subscriptions) are held by the owning
// generation's ctx.effect() through createGenerationResourceTracker, so an
// HMR recompose disposes them completely and asynchronously before the next
// generation mounts.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const HOT_UPGRADE_STATES = Object.freeze({
  IDLE: 'idle',
  VALIDATING: 'validating',
  PREFLIGHT: 'preflight',
  SNAPSHOTTING: 'snapshotting',
  DRAINING: 'draining',
  EXECUTING: 'executing',
  VERIFYING: 'verifying',
  COMMITTED: 'committed',
  ROLLING_BACK: 'rolling-back',
  RECOVERED: 'recovered',
  OUTAGE: 'outage',
  ABORTED: 'aborted',
})

export const HOT_UPGRADE_DRAIN_POLICIES = Object.freeze(['abort-on-timeout', 'require-explicit-cancel'])

const SILENT_LOGGER = Object.freeze({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
})

function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

function tail(text, limit = 2000) {
  const value = typeof text === 'string' ? text : ''
  return value.length > limit ? value.slice(value.length - limit) : value
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ── plan §6.4 step 2: upgrade preflight (P3-lite migration gate) ────────────
//
// Block an upgrade while the profile still has un-run migrations at or below
// the candidate's migration version. The gate is deliberate: rc.5 has no
// transactional settings migration, so an upgrade that silently skips a
// migration would leave the old version's data unreadable after a rollback.
// An operator can explicitly accept the risk with allowPendingMigrations.

/**
 * @param {object} facts
 * @param {number} [facts.candidateMigrationVersion] - migration version the candidate package requires
 * @param {number} [facts.completedMigrationVersion] - last migration version the profile completed
 * @param {Array<string | { id: string }>} [facts.pendingMigrations] - explicitly tracked un-run migrations
 * @param {boolean} [facts.lockfileConsistent] - whether the profile lockfile matches the installed tree
 * @param {boolean} [facts.allowPendingMigrations] - explicit operator acknowledgement
 */
export function checkUpgradePreflight({
  candidateMigrationVersion,
  completedMigrationVersion,
  pendingMigrations = [],
  lockfileConsistent = true,
  allowPendingMigrations = false,
} = {}) {
  const blockers = []
  if (
    !allowPendingMigrations
    && typeof candidateMigrationVersion === 'number'
    && typeof completedMigrationVersion === 'number'
    && candidateMigrationVersion > completedMigrationVersion
  ) {
    blockers.push({
      kind: 'migration-pending',
      detail: `candidate requires migration ${candidateMigrationVersion} but the profile completed ${completedMigrationVersion}`,
      hint: 'finish pending migrations, or pass allowPendingMigrations to accept the risk explicitly',
    })
  }
  if (!allowPendingMigrations) {
    for (const pending of pendingMigrations) {
      const id = typeof pending === 'string' ? pending : pending?.id
      blockers.push({
        kind: 'migration-incomplete',
        id: typeof id === 'string' ? id : undefined,
        detail: `profile reports un-run migration ${typeof id === 'string' ? id : '(unknown id)'}`,
        hint: 'finish pending migrations, or pass allowPendingMigrations to accept the risk explicitly',
      })
    }
  }
  if (lockfileConsistent !== true) {
    blockers.push({
      kind: 'lockfile-mismatch',
      detail: 'profile lockfile does not match the installed tree',
      hint: 'repair the profile installation before upgrading',
    })
  }
  return { ok: blockers.length === 0, blockers }
}

// ── plan §6.5: generation-scoped reload resource ownership ─────────────────

/**
 * Track reload-lifetime resources for one plugin generation and dispose them
 * all, asynchronously, exactly once. Native child processes are SIGTERMed and
 * their actual exit is awaited (SIGKILL after exitTimeoutMs), so a recompose
 * never leaves orphaned native subprocesses behind.
 */
export function createGenerationResourceTracker(generation, { logger, exitTimeoutMs = 10_000 } = {}) {
  const log = logger ?? SILENT_LOGGER
  const resources = new Set()
  let disposed = false

  function track({ kind, dispose, describe }) {
    if (typeof dispose !== 'function') throw new TypeError('generation resource tracker requires a dispose function')
    if (disposed) {
      throw new Error(`generation ${generation}: cannot track a resource after disposeAll`)
    }
    const entry = { generation, kind, describe: describe ?? kind, dispose }
    resources.add(entry)
    return () => {
      resources.delete(entry)
    }
  }

  function trackChildProcess(child, { describe, killSignal = 'SIGTERM' } = {}) {
    const untrack = track({
      kind: 'child-process',
      describe,
      dispose: async () => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return
        const exited = new Promise((resolve) => child.once('exit', () => resolve()))
        child.kill(killSignal)
        const killTimer = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          } catch {
            // The child exited between the check and the kill; nothing to do.
          }
        }, exitTimeoutMs)
        try {
          await exited
        } finally {
          clearTimeout(killTimer)
        }
      },
    })
    if (typeof child?.once === 'function') {
      child.once('exit', untrack)
    }
    return untrack
  }

  function trackTimer(timer) {
    return track({
      kind: 'timer',
      dispose: () => {
        clearTimeout(timer)
      },
    })
  }

  async function disposeAll() {
    if (disposed) return { disposed: 0, failed: 0, alreadyDisposed: true }
    disposed = true
    const pending = [...resources]
    resources.clear()
    const results = await Promise.allSettled(pending.map(async (entry) => {
      await entry.dispose()
      return entry
    }))
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length > 0) {
      log.warn(`vision-router: generation ${generation}: ${failed.length} reload resource(s) failed to dispose`)
    }
    return { disposed: pending.length, failed: failed.length }
  }

  return {
    generation,
    track,
    trackChildProcess,
    trackTimer,
    disposeAll,
    active: () => [...resources].map((entry) => ({ kind: entry.kind, describe: entry.describe })),
  }
}

/**
 * Bind a resource tracker to one plugin generation: the disposers registered
 * through the tracker run when the Host disposes this generation's context
 * (an HMR recompose or a plugin uninstall). When ctx.effect is unavailable
 * the caller owns disposeAll() explicitly; that is reported, not hidden.
 */
export function bindGenerationResources(ctx, { generation = 0, logger, exitTimeoutMs } = {}) {
  const tracker = createGenerationResourceTracker(generation, { logger, exitTimeoutMs })
  const ownsEffect = typeof ctx?.effect === 'function'
  if (ownsEffect) {
    // Cordis ctx.effect(callback, label) runs the callback immediately and
    // treats its return value as the disposer for this generation's teardown.
    // disposeAll must therefore be returned, not invoked, here: invoking it
    // would dispose the tracker at bind time, before any resource is tracked.
    ctx.effect(
      () => () => tracker.disposeAll(),
      `vision-router: generation ${generation} reload resources`,
    )
  }
  return { tracker, effectOwned: ownsEffect }
}

// ── Task A interface: optional install readiness module ─────────────────────

export async function loadInstallReadiness(logger) {
  try {
    return await import('./plugin-hot-install-readiness.js')
  } catch (error) {
    const message = errorMessage(error)
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && message.includes('plugin-hot-install-readiness')) {
      logger?.debug?.('vision-router: plugin-hot-install-readiness not present; using coordinator-local staging fallback')
      return undefined
    }
    throw error
  }
}

// ── Supported entry: the DSH CLI plugin command ─────────────────────────────

/**
 * Run one `dsh plugin ...` command through the only supported entry: the
 * DSH CLI driven by its own tsx loader. Nothing else may mutate a profile.
 */
export function runDshPluginCommand({
  dshRoot,
  args,
  cwd,
  env = process.env,
  timeoutMs = 300_000,
  node = process.execPath,
  tsxLoader,
  spawnImpl = spawn,
}) {
  if (!dshRoot) throw new Error('runDshPluginCommand requires dshRoot (DSH_SOURCE_ROOT)')
  if (!Array.isArray(args) || args.length === 0) throw new Error('runDshPluginCommand requires a non-empty args array')
  const loader = tsxLoader ?? pathToFileURL(createRequire(path.join(dshRoot, 'package.json')).resolve('tsx')).href
  const cli = path.join(dshRoot, 'apps/cli/src/bin.ts')
  return new Promise((resolve, reject) => {
    const child = spawnImpl(node, ['--import', loader, cli, ...args], {
      cwd: cwd ?? dshRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish(reject, new Error(`dsh plugin command timed out after ${timeoutMs}ms: dsh plugin ${args.join(' ')}`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code, signal) => {
      finish(resolve, {
        status: code === null ? -1 : code,
        signal: signal ?? undefined,
        stdout: tail(stdout),
        stderr: tail(stderr),
      })
    })
  })
}

// ── plan §6.4 step 1: staged candidate validation in an isolated profile ────

/**
 * Subprocess bundle-import probe: loads the installed candidate entry in a
 * fresh node process. A module that throws at import time (broken schema
 * construction, missing native binding) fails validation before the running
 * installation is ever touched.
 */
export function createSubprocessImportProbe({ node = process.execPath, spawnImpl = spawn, timeoutMs = 60_000 } = {}) {
  return (entryUrl, { env } = {}) => new Promise((resolve) => {
    const child = spawnImpl(node, ['--input-type=module', '-e', 'await import(process.argv[1])', entryUrl], {
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish({ ok: false, error: `bundle import probe timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => finish({ ok: false, error: errorMessage(error) }))
    child.once('exit', (code) => {
      if (code === 0) finish({ ok: true })
      else finish({ ok: false, error: tail(stderr) || `bundle import probe exited with ${code}` })
    })
  })
}

export function defaultResolveInstalledEntry(profileDir, packageName) {
  try {
    const require = createRequire(path.join(profileDir, 'package.json'))
    return require.resolve(packageName)
  } catch {
    return undefined
  }
}

/**
 * Validate a candidate package in an isolated staging profile:
 *   1. quick manifest checks (a candidate that cannot describe itself never
 *      reaches the installer);
 *   2. install into a throw-away DSH_HOME profile — the same supported CLI
 *      entry the real install uses, never the running profile;
 *   3. bundle-import the installed entry in a subprocess (schema modules
 *      construct at import time);
 *   4. when Task A's plugin-hot-install-readiness is present, defer to
 *      inspectInstallReadiness / checkNativeAbi instead of steps 2-3.
 */
export function createStagingValidator({
  runCommand,
  probeImport,
  resolveInstalledEntry = defaultResolveInstalledEntry,
  profile = 'web',
  packageName = 'dsh-vision-router',
  readManifest = (dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')),
  stagingEnv,
  logger,
}) {
  if (typeof runCommand !== 'function') throw new TypeError('createStagingValidator requires runCommand')
  if (typeof probeImport !== 'function') throw new TypeError('createStagingValidator requires probeImport')
  if (typeof stagingEnv !== 'function') throw new TypeError('createStagingValidator requires stagingEnv(home)')

  return async function validateCandidate(candidate) {
    const dir = typeof candidate === 'string' ? candidate : candidate?.dir
    const stagingHome = (isPlainObject(candidate) && candidate.stagingHome) || undefined
    const checks = []
    const failures = []

    if (typeof dir !== 'string' || dir.length === 0) {
      return { ok: false, failures: [{ kind: 'candidate-dir-missing', detail: 'candidate dir is required' }], checks, readinessSource: 'none' }
    }

    let manifest
    try {
      manifest = readManifest(dir)
    } catch (error) {
      return {
        ok: false,
        failures: [{ kind: 'manifest-unreadable', detail: errorMessage(error) }],
        checks: [{ name: 'manifest', status: 'fail' }],
        readinessSource: 'none',
      }
    }
    const manifestOk = typeof manifest?.name === 'string' && typeof manifest?.version === 'string' && manifest.name.length > 0
    checks.push({ name: 'manifest', status: manifestOk ? 'pass' : 'fail', version: manifest?.version })
    if (!manifestOk) {
      failures.push({ kind: 'manifest-incomplete', detail: 'candidate package.json needs a name and a version' })
      return { ok: false, failures, checks, readinessSource: 'none' }
    }

    const readiness = await loadInstallReadiness(logger)
    if (readiness && typeof readiness.inspectInstallReadiness === 'function') {
      const report = await readiness.inspectInstallReadiness(dir, { logger })
      checks.push({ name: 'install-readiness', status: report?.ok ? 'pass' : 'fail', source: 'plugin-hot-install-readiness' })
      if (report && report.ok !== true) failures.push({ kind: 'install-readiness-failed', detail: report.detail ?? 'inspectInstallReadiness rejected the candidate' })
      if (typeof readiness.checkNativeAbi === 'function') {
        const abi = await readiness.checkNativeAbi(dir, { logger })
        checks.push({ name: 'native-abi', status: abi?.ok ? 'pass' : 'fail', source: 'plugin-hot-install-readiness' })
        if (abi && abi.ok !== true) failures.push({ kind: 'native-abi-failed', detail: abi.detail ?? 'checkNativeAbi rejected the candidate' })
      }
      return { ok: failures.length === 0, failures, checks, readinessSource: 'plugin-hot-install-readiness' }
    }

    if (typeof stagingHome !== 'string') {
      failures.push({ kind: 'staging-home-missing', detail: 'coordinator staging fallback requires candidate.stagingHome' })
      return { ok: false, failures, checks, readinessSource: 'coordinator-staging-fallback' }
    }

    const install = await runCommand({
      args: ['plugin', '--profile', profile, 'add', `file:${dir}`],
      env: stagingEnv(stagingHome),
      timeoutMs: 300_000,
    })
    const installOk = install?.status === 0
    checks.push({ name: 'staging-install', status: installOk ? 'pass' : 'fail' })
    if (!installOk) {
      failures.push({
        kind: 'staging-install-failed',
        detail: `isolated profile install failed (${install?.status ?? 'no status'}): ${tail(install?.stderr ?? install?.stdout ?? '', 600)}`,
      })
      return { ok: false, failures, checks, readinessSource: 'coordinator-staging-fallback' }
    }

    const entry = resolveInstalledEntry(path.join(stagingHome, 'profiles', profile), packageName)
    if (typeof entry !== 'string') {
      failures.push({ kind: 'entry-unresolvable', detail: `installed candidate entry for ${packageName} did not resolve in the staging profile` })
      return { ok: false, failures, checks, readinessSource: 'coordinator-staging-fallback' }
    }

    const probe = await probeImport(pathToFileURL(entry).href, { env: stagingEnv(stagingHome) })
    checks.push({ name: 'bundle-import', status: probe?.ok ? 'pass' : 'fail' })
    if (probe?.ok !== true) {
      failures.push({ kind: 'bundle-import-failed', detail: probe?.error ?? 'bundle import probe failed' })
    }
    return { ok: failures.length === 0, failures, checks, readinessSource: 'coordinator-staging-fallback' }
  }
}

// ── plan §6.4 steps 1-7: the coordinator state machine ──────────────────────

function snapshotIsRecoverySelfContained(snapshot) {
  return Boolean(
    snapshot
    && typeof snapshot === 'object'
    && snapshot.version !== undefined
    && isPlainObject(snapshot.recovery)
    && Array.isArray(snapshot.recovery.steps)
    && snapshot.recovery.steps.length > 0,
  )
}

/**
 * Create a hot upgrade / reset coordinator. Every side-effectful step is an
 * injected adapter so the state machine is fully unit-testable; the e2e
 * suites supply real adapters (DSH CLI runner, HTTP route probes).
 *
 * Adapters:
 *   validateCandidate(candidate) -> { ok, failures, checks, readinessSource }
 *   checkPreflight(request)      -> { ok, blockers } (defaults to checkUpgradePreflight over request.preflightFacts)
 *   createSnapshot(request)      -> { id, version, recovery: { steps, command }, ... } (recovery must be self-contained)
 *   drainActiveAgents(request, { cancelIds }) -> { pending: [{ id, kind }], drained: [{ id }] }
 *   executeUpgrade(request, snapshot)  -> { ok, error?, host, client, atomic, restartRequired, entry }
 *   verifyGeneration(request, { snapshot, restored }) -> { ok, failures, checks }
 *   restoreSnapshot(snapshot, { request, cause }) -> { ok, error?, actions }
 */
export function createHotUpgradeCoordinator(options = {}) {
  const {
    logger = SILENT_LOGGER,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    drainPollIntervalMs = 500,
    drainTimeoutMs = 15_000,
    validateCandidate,
    checkPreflight,
    createSnapshot,
    drainActiveAgents,
    executeUpgrade,
    verifyGeneration,
    restoreSnapshot,
  } = options

  for (const [name, adapter] of [
    ['validateCandidate', validateCandidate],
    ['createSnapshot', createSnapshot],
    ['drainActiveAgents', drainActiveAgents],
    ['executeUpgrade', executeUpgrade],
    ['verifyGeneration', verifyGeneration],
    ['restoreSnapshot', restoreSnapshot],
  ]) {
    if (typeof adapter !== 'function') throw new TypeError(`createHotUpgradeCoordinator requires a ${name} adapter`)
  }

  let activeRun = null
  let runCounter = 0

  function transition(run, state, detail) {
    const at = now()
    const previous = run.phases[run.phases.length - 1]
    if (previous) previous.durationMs = at - previous.at
    run.state = state
    run.phases.push({ state, at, detail })
    logger.debug?.(`vision-router: hot upgrade ${run.kind} #${run.id} -> ${state}${detail ? ` (${detail})` : ''}`)
  }

  function finish(run, state, result) {
    transition(run, state)
    const previous = run.phases[run.phases.length - 1]
    // durationMs of the final phase is filled at finish time; the trace ends here.
    if (previous) previous.durationMs = now() - previous.at
    return {
      ok: result.ok === true,
      kind: run.kind,
      runId: run.id,
      state,
      startedAt: run.startedAt,
      finishedAt: now(),
      phases: run.phases,
      ...result,
    }
  }

  async function drainPhase(run, request) {
    const policy = HOT_UPGRADE_DRAIN_POLICIES.includes(request.drainPolicy)
      ? request.drainPolicy
      : 'abort-on-timeout'
    const timeoutMs = typeof request.drainTimeoutMs === 'number' ? request.drainTimeoutMs : drainTimeoutMs
    const startedAt = now()
    let latest = await drainActiveAgents(request, { cancelIds: [] })
    while (latest.pending.length > 0 && now() - startedAt < timeoutMs) {
      await sleep(drainPollIntervalMs)
      latest = await drainActiveAgents(request, { cancelIds: [] })
    }
    const base = {
      policy,
      waitedMs: now() - startedAt,
      drained: latest.drained ?? [],
      // The coordinator never replays a billed request on its own; a resumed
      // agent run is always a fresh user-visible action.
      replayedRequests: 0,
    }
    if (latest.pending.length === 0) return { ok: true, report: { ...base, timedOut: false, cancelledIds: [] } }

    if (policy === 'abort-on-timeout') {
      return {
        ok: false,
        report: { ...base, timedOut: true, pending: latest.pending },
        blockers: latest.pending.map((agent) => ({
          kind: 'drain-timeout',
          id: agent?.id,
          detail: `busy agent ${agent?.id} did not drain within ${timeoutMs}ms`,
          hint: 'wait for the agent to finish, or re-run with drainPolicy "require-explicit-cancel" and an explicit cancel confirmation',
        })),
      }
    }

    const confirmed = new Set(request.cancelConfirmations ?? [])
    const unconfirmed = latest.pending.filter((agent) => !confirmed.has(agent?.id))
    if (unconfirmed.length > 0) {
      return {
        ok: false,
        report: { ...base, timedOut: true, pending: latest.pending },
        blockers: unconfirmed.map((agent) => ({
          kind: 'drain-requires-explicit-cancel',
          id: agent?.id,
          detail: `busy agent ${agent?.id} can only be cancelled explicitly`,
          hint: 'pass the agent id in request.cancelConfirmations to confirm the interruption',
        })),
      }
    }
    const cancelledIds = latest.pending.map((agent) => agent?.id)
    const afterCancel = await drainActiveAgents(request, { cancelIds: cancelledIds })
    if (afterCancel.pending.length > 0) {
      return {
        ok: false,
        report: { ...base, timedOut: true, pending: afterCancel.pending, cancelledIds },
        blockers: afterCancel.pending.map((agent) => ({
          kind: 'cancel-not-effective',
          id: agent?.id,
          detail: `agent ${agent?.id} was still busy after the confirmed cancel`,
        })),
      }
    }
    return { ok: true, report: { ...base, timedOut: false, cancelledIds } }
  }

  async function rollback(run, request, snapshot, cause) {
    transition(run, HOT_UPGRADE_STATES.ROLLING_BACK, cause)
    let restore
    try {
      restore = await restoreSnapshot(snapshot, { request, cause })
    } catch (error) {
      restore = { ok: false, error: errorMessage(error) }
    }
    if (restore?.ok !== true) {
      return finish(run, HOT_UPGRADE_STATES.OUTAGE, {
        ok: false,
        reason: 'recovery-failed',
        cause,
        recovery: {
          restored: false,
          verified: false,
          error: restore?.error ?? 'restoreSnapshot did not report success',
          snapshotVersion: snapshot?.version,
          steps: snapshot?.recovery?.steps ?? [],
          repairCommand: snapshot?.recovery?.command,
        },
      })
    }
    transition(run, HOT_UPGRADE_STATES.VERIFYING, 'restored snapshot')
    let reverification
    try {
      reverification = await verifyGeneration(request, { snapshot, restored: true })
    } catch (error) {
      reverification = { ok: false, failures: [{ kind: 'verify-threw', detail: errorMessage(error) }] }
    }
    if (reverification?.ok !== true) {
      return finish(run, HOT_UPGRADE_STATES.OUTAGE, {
        ok: false,
        reason: 'recovery-unverified',
        cause,
        recovery: {
          restored: true,
          verified: false,
          snapshotVersion: snapshot?.version,
          steps: snapshot?.recovery?.steps ?? [],
          repairCommand: snapshot?.recovery?.command,
        },
        verification: reverification,
      })
    }
    return finish(run, HOT_UPGRADE_STATES.RECOVERED, {
      ok: false,
      reason: cause,
      recovered: true,
      recovery: {
        restored: true,
        verified: true,
        snapshotVersion: snapshot?.version,
        actions: restore.actions ?? [],
      },
      verification: reverification,
    })
  }

  async function runPipeline(run, request) {
    const { kind } = run

    // Step 1: staged validation in an isolated profile; a failed candidate
    // never touches the running old generation.
    transition(run, HOT_UPGRADE_STATES.VALIDATING)
    const validation = await validateCandidate(request.candidate ?? request)
    run.validation = validation
    if (validation?.ok !== true) {
      return finish(run, HOT_UPGRADE_STATES.ABORTED, {
        ok: false,
        reason: 'candidate-validation-failed',
        failures: validation?.failures ?? [{ kind: 'unknown', detail: 'validator returned no failures' }],
        oldGenerationUntouched: true,
      })
    }

    // Step 2: preflight — migration gate and profile consistency.
    transition(run, HOT_UPGRADE_STATES.PREFLIGHT)
    const preflight = typeof checkPreflight === 'function'
      ? await checkPreflight(request)
      : checkUpgradePreflight({
        ...(request.preflightFacts ?? {}),
        allowPendingMigrations: request.allowPendingMigrations === true,
      })
    if (preflight?.ok !== true) {
      return finish(run, HOT_UPGRADE_STATES.ABORTED, {
        ok: false,
        reason: 'preflight-blocked',
        blockers: preflight?.blockers ?? [],
        oldGenerationUntouched: true,
      })
    }

    // Step 3: snapshot the exact old version. A snapshot without a
    // self-contained recovery plan cannot promise rollback, so it aborts
    // before execution rather than promising an unverifiable restore.
    transition(run, HOT_UPGRADE_STATES.SNAPSHOTTING)
    let snapshot
    try {
      snapshot = await createSnapshot(request)
    } catch (error) {
      return finish(run, HOT_UPGRADE_STATES.ABORTED, {
        ok: false,
        reason: 'snapshot-failed',
        error: errorMessage(error),
        oldGenerationUntouched: true,
      })
    }
    if (!snapshotIsRecoverySelfContained(snapshot)) {
      return finish(run, HOT_UPGRADE_STATES.ABORTED, {
        ok: false,
        reason: 'snapshot-not-recovery-self-contained',
        oldGenerationUntouched: true,
      })
    }
    run.snapshotId = snapshot.id

    // Step 4: drain busy agents. Never silently interrupts and never replays
    // a billed request; see drainPhase.
    transition(run, HOT_UPGRADE_STATES.DRAINING)
    const drain = await drainPhase(run, request)
    run.drain = drain.report
    if (drain.ok !== true) {
      return finish(run, HOT_UPGRADE_STATES.ABORTED, {
        ok: false,
        reason: drain.blockers?.[0]?.kind === 'drain-requires-explicit-cancel' ? 'drain-requires-explicit-cancel' : 'drain-timeout',
        blockers: drain.blockers,
        drain: drain.report,
        oldGenerationUntouched: true,
      })
    }

    // Step 5: execute through the supported entry. Host and Client are
    // recorded separately; the pair is non-atomic in rc.5 and the executor
    // must say so.
    transition(run, HOT_UPGRADE_STATES.EXECUTING)
    let execution
    try {
      execution = await executeUpgrade(request, snapshot)
    } catch (error) {
      execution = { ok: false, error: errorMessage(error) }
    }
    run.execution = execution
    if (execution?.ok !== true) {
      const result = await rollback(run, request, snapshot, `execution-failed: ${execution?.error ?? 'unknown error'}`)
      result.execution = execution
      return result
    }
    if (execution.atomic !== false) {
      logger.warn?.('vision-router: hot upgrade executor did not declare atomic:false; recording the rc.5 fact anyway')
    }

    // Step 6: verify the new generation serves.
    transition(run, HOT_UPGRADE_STATES.VERIFYING)
    let verification
    try {
      verification = await verifyGeneration(request, { snapshot, restored: false })
    } catch (error) {
      verification = { ok: false, failures: [{ kind: 'verify-threw', detail: errorMessage(error) }] }
    }
    run.verification = verification
    if (verification?.ok !== true) {
      const result = await rollback(run, request, snapshot, 'verification-failed')
      result.verification = verification
      result.execution = execution
      return result
    }

    // Step 7: committed.
    return finish(run, HOT_UPGRADE_STATES.COMMITTED, {
      ok: true,
      snapshotId: snapshot.id,
      execution,
      verification,
      drain: run.drain,
      validation,
      phases: run.phases,
    })
  }

  async function run(kind, request = {}) {
    if (activeRun) {
      return {
        ok: false,
        kind,
        state: 'busy',
        error: `another ${activeRun.kind} is in progress (run #${activeRun.id})`,
      }
    }
    const run = {
      id: ++runCounter,
      kind,
      request,
      state: HOT_UPGRADE_STATES.IDLE,
      startedAt: now(),
      phases: [],
    }
    activeRun = run
    try {
      return await runPipeline(run, request)
    } finally {
      activeRun = null
    }
  }

  return {
    upgrade: (request = {}) => run(request.kind === 'reset' ? 'reset' : 'upgrade', { ...request, kind: request.kind === 'reset' ? 'reset' : 'upgrade' }),
    reset: (request = {}) => run('reset', { ...request, kind: 'reset' }),
    state: () => ({
      active: activeRun !== null,
      run: activeRun
        ? { id: activeRun.id, kind: activeRun.kind, state: activeRun.state, phases: activeRun.phases }
        : null,
    }),
  }
}
