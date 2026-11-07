// Shared services across plugin hot reload (plan.md §6.4, §6.5, §8.1).
//
// What must NOT be disturbed by a vision-router upgrade/reset/reload:
//   - the shared Host↔Client connection (one authenticated cookie keeps
//     working across recomposes);
//   - other Sessions (busy agents of other plugins are never drained or
//     cancelled by a vision-router upgrade);
//   - unrelated plugins (their routes and registrations stay alive through a
//     failed candidate and its rollback);
//   - uploads / attachment state (Host-owned; DVR only probes the optional
//     attachments capability and never mutates it during reloads);
//   - native subprocesses (sharp is an in-process optional native addon with
//     no child to reap; tesseract runs through bounded execFile calls; any
//     long-lived child a generation spawns must be disposed by that
//     generation's ctx.effect — verified live with a fixture plugin).
//
// Layer 1 (static + mock) always runs. Layer 2 drives a real DSH 0.2.1-rc.5
// `dsh web` Host with DVR plus an unrelated fixture plugin and is gated on
// DSH_SOURCE_ROOT.
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
  createGenerationResourceTracker,
  bindGenerationResources,
  runDshPluginCommand,
} from '../lib/plugin-hot-upgrade-coordinator.js'

const dvrRoot = fileURLToPath(new URL('..', import.meta.url))
const dshRoot = process.env.DSH_SOURCE_ROOT
const RECOMPOSE_SETTLE_MS = 3_500

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ── layer 1a: static ownership facts (plan §6.5) ─────────────────────────────

test('static: reload-lifetime resources stay generation-effect owned', () => {
  const indexSource = readFileSync(join(dvrRoot, 'src', 'index.js'), 'utf8')
  // Deep tool registrations (the whole "one tool set" surface) are disposed by
  // the owning generation's ctx.effect.
  assert.match(indexSource, /'vision-router: deep tools'/, 'deep tool disposers must stay generation ctx.effect-owned')
  // Upload/attachment state is Host-owned: the optional attachments
  // capability is only ever probed, never bare-read, so a reload cannot
  // re-materialise or mutate upload state.
  assert.match(indexSource, /ctx\.get\('attachments'\)/)
  assert.doesNotMatch(indexSource, /ctx\.attachments\b/)

  const coreSource = readFileSync(join(dvrRoot, 'src', 'lib', 'core-primitives.js'), 'utf8')
  // tesseract runs as a bounded one-shot execFile with a timeout — no
  // long-lived native child for a reload to leak.
  const ocr = coreSource.slice(coreSource.indexOf('ocrWithTesseract'))
  assert.match(ocr.slice(0, 2000), /execFile/, 'tesseract OCR must stay a bounded execFile subprocess')

  const pkg = JSON.parse(readFileSync(join(dvrRoot, 'package.json'), 'utf8'))
  // sharp is an optional in-process native addon: no child process, so
  // disposal responsibility is the addon's own GC lifecycle.
  assert.equal(pkg.peerDependenciesMeta?.sharp?.optional, true)
})

// ── layer 1b: mock — native-like child disposal has no residue ───────────────

test('mock: generation tracker disposes exactly its own native-like children', async () => {
  const tracker = createGenerationResourceTracker(1, { exitTimeoutMs: 5_000 })
  const tracked = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const untracked = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  tracker.trackChildProcess(tracked, { describe: 'tesseract-like native child' })
  assert.equal(tracker.active().length, 1)

  const disposal = await tracker.disposeAll()
  assert.equal(disposal.disposed, 1)
  assert.equal(disposal.failed, 0)
  assert.equal(tracker.active().length, 0, 'disposeAll must leave no tracked residue')
  // The disposal promise resolved only after the actual process exit.
  assert.ok(tracked.exitCode !== null || tracked.signalCode !== null, 'tracked child must have exited')
  assert.ok(isAlive(untracked.pid), 'an untracked child of another owner must never be touched')
  untracked.kill('SIGKILL')
  await new Promise((resolve) => untracked.once('exit', resolve))
})

test('mock: bindGenerationResources owns disposal through ctx.effect', async () => {
  let effectDisposer = null
  const ctx = { effect: (register) => { effectDisposer = register() } }
  const bound = bindGenerationResources(ctx, { generation: 7 })
  assert.equal(bound.effectOwned, true)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  bound.tracker.trackChildProcess(child)
  assert.equal(typeof effectDisposer, 'function')
  await effectDisposer()
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'generation teardown must dispose the child')

  const unbound = bindGenerationResources({}, { generation: 8 })
  assert.equal(unbound.effectOwned, false, 'without ctx.effect the caller owns disposeAll — reported, not hidden')
})

// ── layer 1c: mock — drain / rollback never cross plugin boundaries ──────────

function makeMockHost() {
  return {
    agents: [
      { id: 'vision-agent-1', plugin: 'vision-router', busy: true },
      { id: 'vision-agent-2', plugin: 'vision-router', busy: false },
      { id: 'unrelated-agent-1', plugin: 'dvr-hot-reload-fixture', busy: true },
    ],
    cancelled: [],
    routes: {
      '/_dsh/vision-router/logs': true,
      '/_dsh/hot-reload-fixture/status': true,
    },
    touchedAttachments: 0,
  }
}

function makeSharedServicesAdapters(host, { executeBreaksDvr = false } = {}) {
  return {
    validateCandidate: async () => ({ ok: true, failures: [], checks: [] }),
    createSnapshot: async () => ({
      id: 'snap',
      version: '3.1.4',
      recovery: { steps: ['restore DVR routes'], command: 'dsh plugin --profile web add file:<old>' },
    }),
    // The drain adapter only ever sees vision-router agents: other plugins'
    // busy agents and other sessions are outside the upgrade's boundary.
    drainActiveAgents: async (request, { cancelIds }) => {
      host.touchedAttachments += 0
      for (const id of cancelIds ?? []) {
        const agent = host.agents.find((item) => item.id === id && item.plugin === 'vision-router')
        if (agent) {
          agent.busy = false
          host.cancelled.push(id)
        }
      }
      return {
        pending: host.agents.filter((item) => item.busy && item.plugin === 'vision-router'),
        drained: host.agents.filter((item) => !item.busy && item.plugin === 'vision-router').map((item) => ({ id: item.id })),
      }
    },
    executeUpgrade: async () => {
      if (executeBreaksDvr) host.routes['/_dsh/vision-router/logs'] = false
      return {
        ok: true,
        host: { pid: 4242, continuity: 'pid-and-port-stable' },
        client: { recompose: 'host-managed' },
        atomic: false,
        restartRequired: false,
        entry: 'config-level HMR recompose',
      }
    },
    verifyGeneration: async (request, { restored = false } = {}) => {
      if (host.routes['/_dsh/vision-router/logs'] !== true) {
        return { ok: false, failures: [{ kind: 'dvr-route-down' }], checks: [] }
      }
      return {
        ok: true,
        failures: [],
        checks: [{ name: 'dvr-route', status: 'pass' }, { name: 'unrelated-plugin-route', status: host.routes['/_dsh/hot-reload-fixture/status'] ? 'pass' : 'fail' }],
      }
    },
    restoreSnapshot: async () => {
      host.routes['/_dsh/vision-router/logs'] = true
      return { ok: true, actions: ['DVR routes restored'] }
    },
  }
}

test('mock: drain timeout aborts without touching other plugins or sessions', async () => {
  const host = makeMockHost()
  const coordinator = createHotUpgradeCoordinator({
    ...makeSharedServicesAdapters(host),
    sleep: async () => {},
    drainTimeoutMs: 20,
  })
  const result = await coordinator.upgrade({})
  assert.equal(result.state, 'aborted')
  assert.equal(result.reason, 'drain-timeout')
  assert.equal(result.oldGenerationUntouched, true)
  assert.deepEqual(host.cancelled, [], 'no agent may be cancelled by a timed-out drain')
  assert.equal(host.agents.find((item) => item.id === 'unrelated-agent-1').busy, true, 'unrelated plugin agent stays busy and untouched')
  assert.equal(host.routes['/_dsh/hot-reload-fixture/status'], true)
})

test('mock: explicit cancel covers only vision-router agents; the unrelated agent is out of boundary', async () => {
  const host = makeMockHost()
  const coordinator = createHotUpgradeCoordinator({
    ...makeSharedServicesAdapters(host),
    sleep: async () => {},
    drainTimeoutMs: 20,
  })
  const blocked = await coordinator.upgrade({ drainPolicy: 'require-explicit-cancel' })
  assert.equal(blocked.state, 'aborted')
  assert.equal(blocked.reason, 'drain-requires-explicit-cancel')
  assert.deepEqual(host.cancelled, [])

  const confirmed = await coordinator.upgrade({
    drainPolicy: 'require-explicit-cancel',
    cancelConfirmations: ['vision-agent-1'],
  })
  assert.equal(confirmed.state, 'committed', JSON.stringify(confirmed))
  assert.deepEqual(host.cancelled, ['vision-agent-1'])
  assert.equal(confirmed.drain.replayedRequests, 0, 'a cancelled run is never silently replayed')
  assert.equal(host.agents.find((item) => item.id === 'unrelated-agent-1').busy, true, 'the unrelated busy agent was never in the cancel set')
})

test('mock: failed candidate rollback leaves the unrelated plugin serving', async () => {
  const host = makeMockHost()
  const coordinator = createHotUpgradeCoordinator({
    ...makeSharedServicesAdapters(host, { executeBreaksDvr: true }),
  })
  const result = await coordinator.upgrade({})
  assert.equal(result.state, 'recovered', JSON.stringify(result))
  assert.equal(result.recovery.restored, true)
  assert.equal(host.routes['/_dsh/hot-reload-fixture/status'], true, 'the unrelated plugin never left the serving state')
  assert.equal(host.routes['/_dsh/vision-router/logs'], true, 'snapshot recovery restored DVR')
})

// ── layer 2: real Host with an unrelated fixture plugin ──────────────────────

const FIXTURE_PKG = {
  name: 'dvr-hot-reload-fixture',
  version: '0.0.1',
  type: 'module',
  main: 'index.js',
  private: true,
  engines: { dsh: '>=0.1.5-rc.1 <0.2.0-0 || >=0.2.0-rc.2 <0.3.0-0' },
}

// The fixture models an unrelated plugin with a native-like long-lived child.
// Every generation spawns one child and owns its disposal via ctx.effect, so
// a recompose must leave exactly one live fixture child and zero orphans.
const FIXTURE_INDEX = `import { spawn } from 'node:child_process'

const state = (globalThis.__dvrHotReloadFixture ??= { generations: 0, pids: [], currentPid: null })

export const name = 'dvr-hot-reload-fixture'

export function apply(ctx) {
  state.generations += 1
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  state.pids.push(child.pid)
  state.currentPid = child.pid
  ctx.effect(() => () => {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    return exited
  }, 'fixture: native-like child process')
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/_dsh/hot-reload-fixture/status',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, generations: state.generations, currentPid: state.currentPid, pids: state.pids }))
      },
    }), 'fixture: status route')
  })
}
`

test('e2e (real Host): shared connection, unrelated plugin, native child disposal across reloads', { timeout: 480_000 }, async (t) => {
  if (!dshRoot) return t.skip('DSH_SOURCE_ROOT not set; real-Host shared-services e2e requires the DSH 0.2.1-rc.5 source tree')

  const root = mkdtempSync(join(tmpdir(), 'dvr-p4c-shared-'))
  mkdirSync(join(root, 'workspace'))
  const fixtureDir = join(root, 'fixture')
  mkdirSync(fixtureDir)
  writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify(FIXTURE_PKG, null, 2))
  writeFileSync(join(fixtureDir, 'index.js'), FIXTURE_INDEX)

  const env = {
    ...process.env,
    DSH_HOME: join(root, '.dsh'),
    DSH_AGENTS_HOME: join(root, '.agents'),
    DEEPSEEK_API_KEY: ['keyless', 'dvr', 'p4c', 'shared', 'no-call'].join('-'),
    TSX_TSCONFIG_PATH: join(dshRoot, 'tsconfig.json'),
  }
  const patchPath = join(env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')

  const probeJson = async (auth, pathname, phase) => {
    const response = await fetch(new URL(pathname, auth.origin), {
      cache: 'no-store',
      headers: { cookie: auth.cookie },
    })
    if (response.status !== 200) throw new Error(`${phase}: ${pathname} returned HTTP ${response.status}`)
    return response.json()
  }

  let child = null
  try {
    const dvrInstall = await runDshPluginCommand({ dshRoot, args: ['plugin', '--profile', 'web', 'add', `file:${dvrRoot}`], env, timeoutMs: 420_000 })
    assert.equal(dvrInstall.status, 0, `DVR install failed:\n${dvrInstall.stdout}\n${dvrInstall.stderr}`)
    const fixtureInstall = await runDshPluginCommand({ dshRoot, args: ['plugin', '--profile', 'web', 'add', `file:${fixtureDir}`], env, timeoutMs: 180_000 })
    assert.equal(fixtureInstall.status, 0, `fixture install failed:\n${fixtureInstall.stdout}\n${fixtureInstall.stderr}`)

    const tsxLoaderUrl = pathToFileURL(createRequire(join(dshRoot, 'package.json')).resolve('tsx')).href
    const bootPidHolder = {}
    child = spawn(process.execPath,
      ['--import', tsxLoaderUrl, join(dshRoot, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--port', '0'],
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    bootPidHolder.pid = child.pid
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
    const login = await fetch(readyUrl, { redirect: 'manual' })
    const setCookie = login.headers.get('set-cookie')
    await login.body?.cancel()
    if (login.status !== 303 || setCookie === null) {
      throw new Error(`dsh web authentication returned HTTP ${login.status}`)
    }
    // One authenticated connection (cookie) shared across every recompose.
    const auth = { origin: new URL(readyUrl).origin, cookie: setCookie.split(';', 1)[0] }

    const baseline = await probeJson(auth, '/_dsh/hot-reload-fixture/status', 'baseline')
    assert.equal(baseline.ok, true)
    // Boot itself may compose the plugin tree more than once; what matters is
    // that exactly one fixture child is live and every earlier one is gone.
    assert.ok(baseline.generations >= 1, 'fixture must have applied at least once')
    assert.ok(isAlive(baseline.currentPid), 'fixture child must be alive at baseline')
    for (const pid of baseline.pids) {
      if (pid === baseline.currentPid) continue
      assert.equal(isAlive(pid), false, 'baseline: superseded fixture children must already be disposed')
    }
    await probeJson(auth, '/_dsh/vision-router/logs', 'baseline')

    // Three reload cycles touching BOTH plugins' config entries: DVR toggles
    // progressiveTools, the fixture gets a fresh config marker, so both
    // generations recompose inside the same Host process.
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const progressiveTools = cycle % 2 === 1
      writeFileSync(patchPath, [
        `# DVR P4c shared-services reload cycle ${cycle}`,
        '- id: vision-router',
        '  config:',
        `    progressiveTools: ${progressiveTools}`,
        '- id: dvr-hot-reload-fixture',
        '  config:',
        `    cycle: ${cycle}`,
        '',
      ].join('\n'))
      await sleep(RECOMPOSE_SETTLE_MS)
      if (child.exitCode !== null) throw new Error(`cycle ${cycle}: dsh web exited with ${child.exitCode}`)
      assert.equal(child.pid, bootPidHolder.pid, `cycle ${cycle}: Host PID must be stable across the reload`)

      const status = await probeJson(auth, '/_dsh/hot-reload-fixture/status', `cycle ${cycle}`)
      assert.equal(status.ok, true, `cycle ${cycle}: fixture route must stay alive`)
      assert.ok(status.generations >= cycle + 1, `cycle ${cycle}: fixture generation must have recomposed (got ${status.generations})`)
      assert.ok(isAlive(status.currentPid), `cycle ${cycle}: the current generation's native-like child must be alive`)
      for (const pid of status.pids) {
        if (pid === status.currentPid) continue
        assert.equal(isAlive(pid), false, `cycle ${cycle}: previous generation child ${pid} must be disposed without residue`)
      }
      // DVR keeps serving on the same shared connection.
      await probeJson(auth, '/_dsh/vision-router/logs', `cycle ${cycle}`)
    }

    // Note (honest coverage boundary): real upload traffic and live Session
    // journals are Host-owned surfaces that would need a model credential to
    // drive end-to-end; their reload isolation is pinned at the static/mock
    // layer above (optional attachments probe only, drain boundary, unrelated
    // agent survival) rather than claimed as e2e-verified here.
  } finally {
    if (child && child.exitCode === null) {
      const closed = new Promise((resolveClose) => child.once('close', resolveClose))
      child.kill('SIGTERM')
      await closed
    }
    rmSync(root, { recursive: true, force: true })
  }
})
