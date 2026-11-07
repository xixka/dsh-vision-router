// Real-Host hot reload / upgrade e2e (plan.md §6.4, §8.1).
//
// Drives the coordinator against a real DSH 0.2.1-rc.5 `dsh web` Host, using
// only the two capabilities rc.5 actually provides:
//
//  - config-level HMR recompose (hot, same PID/port) for execution;
//  - `dsh plugin --profile web add` (the supported CLI entry) for staging
//    validation in an isolated DSH_HOME.
//
// Covered, in order:
//  1. baseline boot + authenticated DVR diagnostics route;
//  2. broken candidate → staged validation aborts, running generation
//     untouched (route alive, PID stable, no staging install);
//  3. mis-targeted candidate (requests 9.9.9, installs 3.1.4) → execution
//     succeeds, verification FAILS → snapshot rollback → old version verified
//     functional → RECOVERED (PID/port stable throughout);
//  4. ten consecutive reset cycles → all committed, PID stable, exactly one
//     /vision command and one tool set (rc.5 NamedEntries semantics: a
//     duplicate registration would throw and kill the route).
//
// Explicitly NOT covered here (honest §6.4 limits): package-level hot swap
// inside a running Host (restartRequired by rc.5 design — see
// src/lib/self-update.js), Desktop, and external CLI overwrite.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  createHotUpgradeCoordinator,
  createStagingValidator,
  createSubprocessImportProbe,
} from '../lib/plugin-hot-upgrade-coordinator.js'

const dvrRoot = fileURLToPath(new URL('..', import.meta.url))
const DVR_LOGS_PATH = '/_dsh/vision-router/logs'
const RECOMPOSE_SETTLE_MS = 3_500
const RESET_CYCLES = 10

const dshRoot = process.env.DSH_SOURCE_ROOT
const dvrVersion = JSON.parse(readFileSync(join(dvrRoot, 'package.json'), 'utf8')).version

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function probeDvrRoute(auth, phase) {
  const response = await fetch(new URL(DVR_LOGS_PATH, auth.origin), {
    cache: 'no-store',
    headers: { cookie: auth.cookie },
  })
  if (response.status !== 200) throw new Error(`${phase}: DVR route returned HTTP ${response.status}`)
  const body = await response.json()
  if (body?.ok !== true) throw new Error(`${phase}: DVR route is not healthy`)
  return true
}

test('plugin hot reload e2e (real DSH Host): staged validation, snapshot recovery, idempotent resets', { timeout: 600_000 }, async (t) => {
  if (!dshRoot) return t.skip('DSH_SOURCE_ROOT not set; real-Host reload e2e requires the DSH 0.2.1-rc.5 source tree')

  const root = mkdtempSync(join(tmpdir(), 'dvr-p4c-reload-'))
  mkdirSync(join(root, 'workspace'))
  const env = {
    ...process.env,
    DSH_HOME: join(root, '.dsh'),
    DSH_AGENTS_HOME: join(root, '.agents'),
    DEEPSEEK_API_KEY: ['keyless', 'dvr', 'p4c', 'hot-reload', 'no-call'].join('-'),
    TSX_TSCONFIG_PATH: join(dshRoot, 'tsconfig.json'),
  }
  const profileDir = join(env.DSH_HOME, 'profiles', 'web')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const stagingHome = join(root, 'staging-home')
  const brokenCandidateDir = join(root, 'broken-candidate')
  mkdirSync(brokenCandidateDir, { recursive: true })
  // A candidate whose manifest cannot even be parsed must be rejected by the
  // quick manifest check, before any staging install runs.
  writeFileSync(join(brokenCandidateDir, 'package.json'), 'this is not json {{{')

  const readInstalledVersion = () => {
    const profileRequire = createRequire(join(profileDir, 'package.json'))
    const manifestPath = profileRequire.resolve('dsh-vision-router/package.json')
    return JSON.parse(readFileSync(manifestPath, 'utf8')).version
  }

  const stagingInstallCalls = []
  // One full staging install per distinct successful candidate; reset cycles
  // reuse the same unchanged source tree, so its validation is memoised.
  const stagingValidator = createStagingValidator({
    runCommand: async ({ args, env: commandEnv, timeoutMs }) => {
      stagingInstallCalls.push(args[args.length - 1])
      const { runDshPluginCommand } = await import('../lib/plugin-hot-upgrade-coordinator.js')
      return runDshPluginCommand({ dshRoot, args, env: commandEnv, timeoutMs })
    },
    probeImport: createSubprocessImportProbe({ timeoutMs: 90_000 }),
    stagingEnv: (home) => ({ ...env, DSH_HOME: home }),
  })
  const validatedDirs = new Map()
  const validateCandidate = async (candidate) => {
    const dir = typeof candidate === 'string' ? candidate : candidate?.dir
    if (validatedDirs.has(dir)) return validatedDirs.get(dir)
    const result = await stagingValidator(candidate)
    if (result.ok) validatedDirs.set(dir, result)
    return result
  }

  let child = null
  let bootPid = null
  let bootOrigin = null
  let auth = null
  let progressiveTools = true

  const settleAndGuard = async (label) => {
    await sleep(RECOMPOSE_SETTLE_MS)
    if (child.exitCode !== null) throw new Error(`${label}: dsh web exited with ${child.exitCode}`)
  }

  const executeConfigReload = async (label) => {
    progressiveTools = !progressiveTools
    writeFileSync(patchPath, `# DVR P4c hot-reload ${label}\n- id: vision-router\n  config:\n    progressiveTools: ${progressiveTools}\n`)
    await settleAndGuard(label)
    return {
      ok: true,
      host: { pid: child.pid, origin: bootOrigin, continuity: 'pid-and-port-stable' },
      client: { recompose: 'host-managed' },
      atomic: false,
      restartRequired: false,
      entry: 'config-level HMR recompose (profile cordis.patch.yml)',
    }
  }

  const verifyGeneration = async (request, { snapshot, restored = false } = {}) => {
    const checks = []
    let ok = true
    try {
      await probeDvrRoute(auth, `verify${restored ? '(restored)' : ''}`)
      checks.push({ name: 'dvr-route', status: 'pass' })
    } catch (error) {
      ok = false
      checks.push({ name: 'dvr-route', status: 'fail', detail: String(error?.message ?? error) })
    }
    const installed = readInstalledVersion()
    const expected = restored || request.targetVersion === undefined ? snapshot.version : request.targetVersion
    if (installed !== expected) {
      ok = false
      checks.push({ name: 'installed-version', status: 'fail', detail: `installed ${installed}, expected ${expected}` })
    } else {
      checks.push({ name: 'installed-version', status: 'pass', detail: installed })
    }
    // Singletons: rc.5's command registry (NamedEntries) throws on a duplicate
    // name, so a recompose that leaves this route healthy proves the previous
    // generation's /vision and tool registrations were disposed first — there
    // is exactly one of each. This is the strongest probe available over HTTP.
    checks.push({
      name: 'command-singleton-/vision',
      status: ok ? 'pass' : 'unknown',
      detail: 'conflict-free recompose + healthy route ⇒ exactly one /vision registration',
    })
    checks.push({
      name: 'tool-set-singleton',
      status: ok ? 'pass' : 'unknown',
      detail: 'deep tool disposers are generation ctx.effect-owned (src/index.js); healthy recompose ⇒ one tool set',
    })
    return { ok, failures: checks.filter((item) => item.status === 'fail'), checks }
  }

  const coordinator = createHotUpgradeCoordinator({
    validateCandidate,
    drainActiveAgents: async () => ({ pending: [], drained: [] }),
    createSnapshot: async () => ({
      id: `snapshot-${Date.now()}`,
      version: readInstalledVersion(),
      patch: readFileSync(patchPath, 'utf8'),
      recovery: {
        steps: ['rewrite the profile cordis.patch.yml to the snapshot content', 'wait for the Host recompose debounce'],
        command: `dsh plugin --profile web add file:${dvrRoot}`,
      },
    }),
    executeUpgrade: async (request) => executeConfigReload(request.executeLabel ?? `run-${request.kind}`),
    verifyGeneration,
    restoreSnapshot: async (snapshot) => {
      writeFileSync(patchPath, snapshot.patch)
      await settleAndGuard('rollback')
      return { ok: true, actions: ['cordis.patch.yml restored to snapshot content'] }
    },
    drainTimeoutMs: 5_000,
  })

  try {
    // ── baseline boot ──────────────────────────────────────────────────────
    const { runDshPluginCommand } = await import('../lib/plugin-hot-upgrade-coordinator.js')
    const install = await runDshPluginCommand({ dshRoot, args: ['plugin', '--profile', 'web', 'add', `file:${dvrRoot}`], env, timeoutMs: 420_000 })
    assert.equal(install.status, 0, `DVR install failed:\n${install.stdout}\n${install.stderr}`)
    const tsxLoaderUrl = pathToFileURL(createRequire(join(dshRoot, 'package.json')).resolve('tsx')).href
    child = spawn(process.execPath,
      ['--import', tsxLoaderUrl, join(dshRoot, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--port', '0'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const readyUrl = await new Promise((resolveReady, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error(`dsh web not ready in 90s\n${output}`)), 90_000)
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /dsh web: (http:\/\/[^\s]+)/.exec(output)
        if (!match?.[1]) return
        clearTimeout(timer)
        resolveReady(match[1])
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`dsh web exited before ready (${code ?? signal})\n${output}`))
      })
    })
    bootPid = child.pid
    bootOrigin = new URL(readyUrl).origin
    const login = await fetch(readyUrl, { redirect: 'manual' })
    const setCookie = login.headers.get('set-cookie')
    await login.body?.cancel()
    if (login.status !== 303 || setCookie === null) {
      throw new Error(`dsh web authentication returned HTTP ${login.status}`)
    }
    auth = { origin: bootOrigin, cookie: setCookie.split(';', 1)[0] }
    await probeDvrRoute(auth, 'baseline')
    assert.equal(readInstalledVersion(), dvrVersion)

    // ── phase A: broken candidate aborts in staging, old generation keeps serving ──
    const broken = await coordinator.upgrade({ candidate: brokenCandidateDir, targetVersion: dvrVersion })
    assert.equal(broken.ok, false)
    assert.equal(broken.state, 'aborted')
    assert.equal(broken.reason, 'candidate-validation-failed')
    assert.equal(broken.oldGenerationUntouched, true)
    assert.equal(stagingInstallCalls.length, 0, 'a broken manifest must not reach the staging installer')
    await probeDvrRoute(auth, 'after broken candidate')
    assert.equal(child.pid, bootPid)
    assert.equal(child.exitCode, null)

    // ── phase B: mis-targeted candidate → verify fails → snapshot rollback → recovered ──
    const misTargeted = await coordinator.upgrade({
      candidate: { dir: dvrRoot, stagingHome },
      targetVersion: '9.9.9',
    })
    assert.equal(misTargeted.ok, false)
    assert.equal(misTargeted.state, 'recovered', `expected recovery, got ${JSON.stringify(misTargeted)}`)
    assert.equal(misTargeted.reason, 'verification-failed')
    assert.equal(misTargeted.recovery.restored, true)
    assert.equal(misTargeted.recovery.verified, true)
    assert.equal(misTargeted.execution.atomic, false)
    assert.equal(stagingInstallCalls.length, 1, 'staging validation must run in the isolated profile exactly once')
    assert.equal(child.pid, bootPid)
    assert.equal(child.exitCode, null)
    await probeDvrRoute(auth, 'after snapshot rollback')
    assert.equal(readInstalledVersion(), dvrVersion)

    // ── phase C: ten consecutive reset cycles stay idempotent ────────────────
    for (let cycle = 1; cycle <= RESET_CYCLES; cycle += 1) {
      const result = await coordinator.reset({
        candidate: { dir: dvrRoot, stagingHome },
        executeLabel: `reset cycle ${cycle}`,
      })
      assert.equal(result.ok, true, `reset cycle ${cycle} failed: ${JSON.stringify(result)}`)
      assert.equal(result.state, 'committed')
      assert.equal(result.execution.host.pid, bootPid)
      await probeDvrRoute(auth, `reset cycle ${cycle}`)
    }
    assert.equal(readInstalledVersion(), dvrVersion)
    assert.equal(stagingInstallCalls.length, 1, 'an unchanged candidate must not be re-installed into staging per reset')
    // The same authenticated connection (cookie) survived every recompose.
    await probeDvrRoute(auth, 'final shared-connection probe')
  } finally {
    if (child && child.exitCode === null) {
      const closed = new Promise((resolveClose) => child.once('close', resolveClose))
      child.kill('SIGTERM')
      await closed
    }
    rmSync(root, { recursive: true, force: true })
  }
})
