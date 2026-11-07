import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  HOT_INSTALL_NODE_MINIMUM,
  HOT_INSTALL_READINESS_STAGES,
  WAIT_UNTIL_READY_DEPS,
  checkCommandNameConflict,
  checkHmrAvailability,
  checkNativeAbi,
  inspectInstallReadiness,
  waitUntilReady,
} from '../lib/plugin-hot-install-readiness.js'
import {
  HOT_INSTALL_NODE_MINIMUM as WINDOW_NODE_MINIMUM,
  HOT_INSTALL_SUPPORT_MATRIX,
} from '../lib/dsh-support-window.js'
import { inspectHotInstallReadiness } from '../lib/doctor-runtime.js'
import { run as runDoctor } from '../lib/doctor-cli.js'

function makeProfile({ manifest, patch, installed = true, client = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'vr-hot-install-'))
  const dir = path.join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest ?? {}, null, 2))
  if (patch !== undefined) writeFileSync(path.join(dir, 'cordis.patch.yml'), patch)
  if (installed) {
    const pkg = path.join(dir, 'node_modules', 'dsh-vision-router')
    mkdirSync(path.join(pkg, 'lib'), { recursive: true })
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'dsh-vision-router',
      version: '3.1.4',
      ...(client ? { dsh: { client: { platform: 'web', inject: [] } } } : {}),
    }, null, 2))
    if (client) writeFileSync(path.join(pkg, 'lib', 'client.js'), 'export {}\n')
  }
  return { home, dir }
}

function bundleManifest() {
  return {
    dependencies: { 'dsh-vision-router': '^3.1.4' },
    dsh: { profile: { bundles: ['dsh-vision-router'] } },
  }
}

function installSharp(dir, version) {
  const sharpDir = path.join(dir, 'node_modules', 'sharp')
  mkdirSync(sharpDir, { recursive: true })
  writeFileSync(path.join(sharpDir, 'package.json'), JSON.stringify({ name: 'sharp', version }))
}

const HOT_NODE = '24.11.0'

function capture() {
  const stdout = []
  const stderr = []
  return {
    stdout,
    stderr,
    io: {
      log: (...args) => stdout.push(args.join(' ')),
      error: (...args) => stderr.push(args.join(' ')),
    },
  }
}

test('stage constants enumerate the fixed readiness surface', () => {
  assert.deepEqual(HOT_INSTALL_READINESS_STAGES, ['packageWritten', 'hostApplied', 'clientAvailable'])
  assert.deepEqual(WAIT_UNTIL_READY_DEPS, ['hostApplied', 'commandsChange', 'clientAvailable', 'settingsReady'])
  assert.equal(HOT_INSTALL_NODE_MINIMUM, WINDOW_NODE_MINIMUM)
  assert.equal(HOT_INSTALL_NODE_MINIMUM, 24)
  assert.equal(Object.hasOwn(HOT_INSTALL_SUPPORT_MATRIX, 'externalCliOverwriteUpgrade'), true)
})

test('three states are judged independently from on-disk evidence only', () => {
  const empty = makeProfile({ manifest: {}, installed: false })
  const emptyReport = inspectInstallReadiness({ profileDir: empty.dir, nodeVersion: HOT_NODE })
  assert.deepEqual({ ...emptyReport.stages }, { packageWritten: false, hostApplied: false, clientAvailable: false })
  assert.equal(emptyReport.verdict, 'degraded')
  assert.equal(emptyReport.conflicts.length, 0)
  assert.ok(emptyReport.reasons.some((reason) => reason.includes('packageWritten')))
  assert.ok(emptyReport.reasons.some((reason) => reason.includes('hostApplied')))

  // Files on disk without any Host-side declaration: packageWritten is the
  // only verified stage.
  const filesOnly = makeProfile({ manifest: {} })
  const filesReport = inspectInstallReadiness({ profileDir: filesOnly.dir, nodeVersion: HOT_NODE })
  assert.deepEqual({ ...filesReport.stages }, { packageWritten: true, hostApplied: false, clientAvailable: true })
  assert.equal(filesReport.verdict, 'degraded')

  // Host-side declaration without the package on disk: hostApplied is the
  // only verified stage (the manifest parameter is consumed, not the disk).
  const declared = mkdtempSync(path.join(tmpdir(), 'vr-hot-install-'))
  const declaredReport = inspectInstallReadiness({
    profileDir: path.join(declared, 'profiles', 'web'),
    nodeVersion: HOT_NODE,
    manifest: bundleManifest(),
  })
  assert.deepEqual({ ...declaredReport.stages }, { packageWritten: false, hostApplied: true, clientAvailable: false })
  assert.equal(declaredReport.verdict, 'degraded')

  // An installed package that does not carry the client surface keeps the
  // third stage false even though the package itself is present.
  const noClient = makeProfile({ manifest: bundleManifest(), client: false })
  const noClientReport = inspectInstallReadiness({ profileDir: noClient.dir, nodeVersion: HOT_NODE })
  assert.deepEqual({ ...noClientReport.stages }, { packageWritten: true, hostApplied: true, clientAvailable: false })
  assert.equal(noClientReport.verdict, 'degraded')

  const ready = makeProfile({ manifest: bundleManifest() })
  const readyReport = inspectInstallReadiness({ profileDir: ready.dir, nodeVersion: HOT_NODE })
  assert.deepEqual({ ...readyReport.stages }, { packageWritten: true, hostApplied: true, clientAvailable: true })
  assert.equal(readyReport.verdict, 'ready')
  assert.equal(readyReport.reasons.length, 0)
  assert.equal(readyReport.nodeOk, true)
  assert.equal(Object.isFrozen(readyReport), true)
  assert.equal(Object.isFrozen(readyReport.stages), true)
})

test('inspectInstallReadiness requires a profileDir string', () => {
  assert.throws(() => inspectInstallReadiness({ nodeVersion: HOT_NODE }), TypeError)
  assert.throws(() => inspectInstallReadiness({ profileDir: '  ', nodeVersion: HOT_NODE }), TypeError)
})

test('Node gate blocks hot install below the dedicated minimum while staying explicit', () => {
  const profile = makeProfile({ manifest: bundleManifest() })
  const blocked = inspectInstallReadiness({ profileDir: profile.dir, nodeVersion: '22.23.0' })
  assert.equal(blocked.nodeOk, false)
  assert.equal(blocked.verdict, 'blocked')
  assert.ok(blocked.reasons.some((reason) => reason.includes('hot-install minimum')))
  assert.ok(blocked.reasons.some((reason) => reason.includes('ordinary installation stays supported')))

  const exact = inspectInstallReadiness({ profileDir: profile.dir, nodeVersion: `v${HOT_INSTALL_NODE_MINIMUM}.0.0` })
  assert.equal(exact.nodeOk, true)
  assert.equal(exact.verdict, 'ready')

  const unparseable = inspectInstallReadiness({ profileDir: profile.dir, nodeVersion: 'not-a-version' })
  assert.equal(unparseable.nodeOk, false)
  assert.equal(unparseable.verdict, 'blocked')
})

test('static native ABI gate accepts the Node-API sharp train and rejects older pins', () => {
  const modern = makeProfile({ manifest: bundleManifest() })
  installSharp(modern.dir, '0.35.3')
  const modernReport = inspectInstallReadiness({ profileDir: modern.dir, nodeVersion: HOT_NODE })
  assert.equal(modernReport.nativeAbi.compatible, true)
  assert.equal(modernReport.nativeAbi.sharpVersion, '0.35.3')
  assert.equal(modernReport.verdict, 'ready')

  const boundary = makeProfile({ manifest: bundleManifest() })
  installSharp(boundary.dir, '0.33.0')
  assert.equal(inspectInstallReadiness({ profileDir: boundary.dir, nodeVersion: HOT_NODE }).nativeAbi.compatible, true)

  const legacy = makeProfile({ manifest: bundleManifest() })
  installSharp(legacy.dir, '0.32.6')
  const legacyReport = inspectInstallReadiness({ profileDir: legacy.dir, nodeVersion: HOT_NODE })
  assert.equal(legacyReport.nativeAbi.compatible, false)
  assert.equal(legacyReport.nativeAbi.sharpVersion, '0.32.6')
  assert.match(legacyReport.nativeAbi.reason, /Node-API/)
  assert.equal(legacyReport.verdict, 'blocked')
  assert.ok(legacyReport.reasons.some((reason) => reason.startsWith('native ABI gate:')))

  const noSharp = makeProfile({ manifest: bundleManifest() })
  const noSharpReport = inspectInstallReadiness({ profileDir: noSharp.dir, nodeVersion: HOT_NODE })
  assert.equal(noSharpReport.nativeAbi.compatible, true)
  assert.equal(noSharpReport.nativeAbi.sharpVersion, undefined)
  assert.equal(noSharpReport.verdict, 'ready')
})

test('checkNativeAbi verifies a loaded sharp module and Electron ABI targets', () => {
  assert.deepEqual(checkNativeAbi(undefined), { compatible: false, reason: 'sharp module did not load or does not expose its native versions metadata' })

  const incomplete = { versions: { sharp: '0.35.3' } }
  assert.equal(checkNativeAbi(incomplete).compatible, false)
  assert.match(checkNativeAbi(incomplete).reason, /versions metadata is incomplete/)

  const loaded = { versions: { sharp: '0.35.3', vips: '8.15.1' } }
  assert.deepEqual(checkNativeAbi(loaded), { compatible: true })
  assert.deepEqual(checkNativeAbi(loaded, {}), { compatible: true })

  const runtimeAbi = Number(process.versions.modules)
  assert.deepEqual(
    checkNativeAbi(loaded, { modules: runtimeAbi }),
    { compatible: true },
  )
  const mismatch = checkNativeAbi(loaded, { modules: runtimeAbi + 1 })
  assert.equal(mismatch.compatible, false)
  assert.match(mismatch.reason, /native rebuild required/)

  assert.throws(() => checkNativeAbi(loaded, 'electron'), TypeError)
})

function registryOf(existing) {
  return {
    find: (_agent, name) => existing !== undefined && existing.name === name ? existing : undefined,
  }
}

test('checkCommandNameConflict reports foreign owners and recognizes our own generation', () => {
  const ctxOf = (registry) => ({ get: (name) => (name === 'commands' ? registry : undefined) })
  const definitionId = 'dsh-vision-router/vision'

  const foreign = ctxOf(registryOf({ name: 'vision', definitionId: 'someone-else/vision' }))
  assert.deepEqual(checkCommandNameConflict(foreign, definitionId), { conflict: true, owner: 'someone-else/vision' })

  const own = ctxOf(registryOf({ name: 'vision', definitionId }))
  assert.deepEqual(checkCommandNameConflict(own, definitionId), { conflict: false })

  const anonymous = ctxOf(registryOf({ name: 'vision' }))
  assert.deepEqual(checkCommandNameConflict(anonymous, definitionId), { conflict: true })

  const free = ctxOf(registryOf({ name: 'other', definitionId: 'other/x' }))
  assert.deepEqual(checkCommandNameConflict(free, definitionId), { conflict: false })

  // Commands is an optional Host capability: an absent registry cannot
  // conflict, and a registry that cannot be probed stays advisory.
  assert.deepEqual(checkCommandNameConflict(ctxOf(undefined), definitionId), { conflict: false })
  assert.deepEqual(checkCommandNameConflict({}, definitionId), { conflict: false })
  const throwing = ctxOf({ find: () => { throw new Error('probe failed') } })
  assert.deepEqual(checkCommandNameConflict(throwing, definitionId), { conflict: false })

  // The list()-only shape (rc.5 descriptor view) is probed the same way.
  const listed = ctxOf({ list: () => [{ name: 'vision', definitionId: 'list-owner/vision' }] })
  assert.deepEqual(checkCommandNameConflict(listed, definitionId), { conflict: true, owner: 'list-owner/vision' })

  assert.throws(() => checkCommandNameConflict(ctxOf(undefined), ''), TypeError)
  assert.throws(() => checkCommandNameConflict(ctxOf(undefined), undefined), TypeError)
})

test('static conflict evidence: coexisting vision plugins and duplicate registration', () => {
  const coexisting = makeProfile({
    manifest: { dependencies: { 'dsh-vision-router': '^3.1.4', 'dsh-vision-proxy': '^1.0.0' } },
  })
  const coexistingReport = inspectInstallReadiness({ profileDir: coexisting.dir, nodeVersion: HOT_NODE })
  assert.equal(coexistingReport.conflicts.length, 1)
  assert.match(coexistingReport.conflicts[0], /dsh-vision-proxy/)
  assert.match(coexistingReport.conflicts[0], /cannot prove it leaves the name free/)
  assert.equal(coexistingReport.verdict, 'degraded')

  const duplicate = makeProfile({
    manifest: bundleManifest(),
    patch: '- insert:\n    - id: vision-router\n      name: dsh-vision-router\n',
  })
  const duplicateReport = inspectInstallReadiness({ profileDir: duplicate.dir, nodeVersion: HOT_NODE })
  assert.ok(duplicateReport.conflicts.some((entry) => entry.startsWith('duplicate registration')))
  assert.equal(duplicateReport.stages.hostApplied, true)
  assert.equal(duplicateReport.verdict, 'blocked')

  // A user patch row that only disables the hmr row does not prove the
  // plugin itself is applied: hostApplied stays bundle-driven.
  const hmrPatch = makeProfile({
    manifest: bundleManifest(),
    patch: '- id: hmr\n  disabled: true\n',
  })
  const hmrPatchReport = inspectInstallReadiness({ profileDir: hmrPatch.dir, nodeVersion: HOT_NODE })
  assert.equal(hmrPatchReport.conflicts.length, 0)
  assert.equal(hmrPatchReport.stages.hostApplied, true)
  assert.equal(hmrPatchReport.verdict, 'ready')
})

test('checkHmrAvailability only claims what offline evidence can prove', () => {
  const untouched = checkHmrAvailability({})
  assert.equal(untouched.status, 'enabled-by-base-default')
  assert.match(untouched.reason, /Host-decided/)

  const profileDisabled = checkHmrAvailability({
    profilePatch: '# user layer\n- id: hmr\n  disabled: true # explicit opt-out\n',
  })
  assert.equal(profileDisabled.status, 'disabled')
  assert.match(profileDisabled.reason, /profile cordis\.patch\.yml/)

  const homeDisabled = checkHmrAvailability({
    homePatch: '- insert:\n    - id: hmr\n      name: \'@deepseek-ai/dsh-hmr\'\n      disabled: true\n',
  })
  assert.equal(homeDisabled.status, 'disabled')
  assert.match(homeDisabled.reason, /home cordis\.patch\.yml/)

  const notDisabled = checkHmrAvailability({
    profilePatch: '- id: hmr\n  disabled: false\n',
    homePatch: '- id: attachment-local\n  config:\n    maxImageBytes: 1\n',
  })
  assert.equal(notDisabled.status, 'enabled-by-base-default')

  const otherRow = checkHmrAvailability({
    profilePatch: '- id: hmr-something-else\n  disabled: true\n',
  })
  assert.equal(otherRow.status, 'enabled-by-base-default')

  // Calling with no layers at all is legal: nothing disables the row.
  assert.equal(checkHmrAvailability().status, 'enabled-by-base-default')
})

test('waitUntilReady resolves ready only when every provided dep observes true', async () => {
  const ready = await waitUntilReady(
    {
      hostApplied: true,
      commandsChange: () => true,
      clientAvailable: async () => true,
      settingsReady: Promise.resolve(true),
    },
    { timeoutMs: 200, pollMs: 5 },
  )
  assert.equal(ready.status, 'ready')
  assert.deepEqual([...ready.pending], [])
  assert.ok(ready.elapsedMs >= 0)

  const nothingRequired = await waitUntilReady({}, { timeoutMs: 10, pollMs: 1 })
  assert.equal(nothingRequired.status, 'ready')

  const nullDeps = await waitUntilReady({ hostApplied: null }, { timeoutMs: 10, pollMs: 1 })
  assert.equal(nullDeps.status, 'ready')

  const onePending = await waitUntilReady(
    { hostApplied: true, commandsChange: () => false },
    { timeoutMs: 40, pollMs: 5 },
  )
  assert.equal(onePending.status, 'timeout')
  assert.deepEqual([...onePending.pending], ['commandsChange'])
})

test('waitUntilReady reports an explicit timeout, bounded by the deadline and never as success', async () => {
  const stalled = {
    hostApplied: () => false,
    commandsChange: () => false,
    clientAvailable: () => false,
    settingsReady: () => false,
  }
  const result = await waitUntilReady(stalled, { timeoutMs: 80, pollMs: 10 })
  assert.equal(result.status, 'timeout')
  assert.notEqual(result.status, 'ready')
  assert.deepEqual([...result.pending], [...WAIT_UNTIL_READY_DEPS])
  assert.ok(result.elapsedMs >= 80, `elapsed ${result.elapsedMs} must cover the timeout`)
  assert.ok(result.elapsedMs < 500, `elapsed ${result.elapsedMs} must stay bounded`)

  // A poll interval larger than the deadline must never push the wait past
  // the bound: sleeping clamps to the remaining time.
  const clamped = await waitUntilReady({ clientAvailable: () => false }, { timeoutMs: 40, pollMs: 5_000 })
  assert.equal(clamped.status, 'timeout')
  assert.deepEqual([...clamped.pending], ['clientAvailable'])
  assert.ok(clamped.elapsedMs < 1_000, `elapsed ${clamped.elapsedMs} must respect the deadline, not the poll interval`)

  // A probe that throws is an unobserved dependency, never a crash.
  const throwing = await waitUntilReady({ hostApplied: () => { throw new Error('probe crashed') } }, { timeoutMs: 30, pollMs: 5 })
  assert.equal(throwing.status, 'timeout')
  assert.deepEqual([...throwing.pending], ['hostApplied'])

  assert.throws(() => waitUntilReady({}, { timeoutMs: -1, pollMs: 1 }), TypeError)
  assert.throws(() => waitUntilReady({}, { timeoutMs: 'x', pollMs: 1 }), TypeError)
  assert.throws(() => waitUntilReady({}, { timeoutMs: 10, pollMs: 0 }), TypeError)
})

test('doctor-level aggregation composes the three states, gates and HMR evidence', () => {
  const ready = makeProfile({ manifest: bundleManifest() })
  const aggregated = inspectHotInstallReadiness({
    profiles: [{ name: 'web', profileDir: ready.dir }],
    nodeVersion: HOT_NODE,
  })
  assert.equal(aggregated.verdict, 'ready')
  assert.equal(aggregated.nodeOk, true)
  assert.deepEqual(aggregated.reasons, [])
  assert.equal(aggregated.profiles.length, 1)
  assert.equal(aggregated.profiles[0].profile, 'web')
  assert.equal(aggregated.profiles[0].hmr.status, 'enabled-by-base-default')

  const hmrBlocked = makeProfile({
    manifest: bundleManifest(),
    patch: '- id: hmr\n  disabled: true\n',
  })
  const hmrAggregated = inspectHotInstallReadiness({
    profiles: [{ name: 'web', profileDir: hmrBlocked.dir }],
    nodeVersion: HOT_NODE,
  })
  assert.equal(hmrAggregated.verdict, 'degraded')
  assert.ok(hmrAggregated.reasons.some((reason) => reason.includes('Host restart')))

  const oldNode = inspectHotInstallReadiness({
    profiles: [{ name: 'web', profileDir: ready.dir }],
    nodeVersion: '22.23.0',
  })
  assert.equal(oldNode.verdict, 'blocked')
  assert.equal(oldNode.nodeOk, false)
  assert.equal(oldNode.nodeRequirement, `>= ${HOT_INSTALL_NODE_MINIMUM}`)

  // Profiles without a resolvable directory are not inspected.
  const none = inspectHotInstallReadiness({ profiles: [{ name: 'headless' }], nodeVersion: HOT_NODE })
  assert.equal(none.verdict, 'not-inspected')
  assert.equal(none.nodeOk, false)
})

test('doctor prints the hot-install readiness section without affecting the exit code', async () => {
  const profile = makeProfile({ manifest: bundleManifest() })
  const cap = capture()
  const code = await runDoctor(['doctor', '--profile', 'web', '--no-runtime'], cap.io, { DSH_HOME: profile.home })
  assert.equal(code, 0, 'hot-install readiness is advisory and must not fail a healthy installation')
  const text = cap.stdout.join('\n')
  assert.match(text, /Hot-install readiness — (ready|degraded|blocked)/)
  assert.match(text, /Node v\d+\.\d+\.\d+ — hot-install minimum >= 24/)
  assert.match(text, /web — (ready|degraded|blocked) \(packageWritten: (yes|no), hostApplied: (yes|no), clientAvailable: (yes|no)\)/)
  assert.match(text, /HMR — enabled by the dsh-base bundle default/)
})

test('doctor reports a user-disabled HMR row honestly and still exits 0', async () => {
  const profile = makeProfile({
    manifest: bundleManifest(),
    patch: '- id: hmr\n  disabled: true\n',
  })
  const cap = capture()
  const code = await runDoctor(['doctor', '--profile', 'web', '--no-runtime'], cap.io, { DSH_HOME: profile.home })
  assert.equal(code, 0)
  assert.match(cap.stdout.join('\n'), /HMR — disabled by a user layer/)
})

test('doctor JSON report carries the hot-install section without local paths', async () => {
  const profile = makeProfile({ manifest: bundleManifest() })
  const cap = capture()
  const code = await runDoctor(['doctor', '--profile', 'web', '--no-runtime', '--json'], cap.io, { DSH_HOME: profile.home })
  assert.equal(code, 0)
  const report = JSON.parse(cap.stdout.join('\n'))
  assert.ok(report.hotInstall, 'the JSON report must expose hotInstall for applicable profiles')
  assert.equal(report.hotInstall.nodeRequirement, `>= ${HOT_INSTALL_NODE_MINIMUM}`)
  assert.equal(report.hotInstall.profiles.length, 1)
  assert.deepEqual(report.hotInstall.profiles[0].stages, {
    packageWritten: true,
    hostApplied: true,
    clientAvailable: true,
  })
  assert.match(report.hotInstall.profiles[0].hmr.status, /^(enabled-by-base-default|disabled)$/)
  assert.equal(JSON.stringify(report).includes(profile.home), false, 'the shareable report must not contain the local profile path')
})

test('doctor issue template exposes only the allowlisted hot-install verdict', async () => {
  const profile = makeProfile({ manifest: bundleManifest() })
  const cap = capture()
  const code = await runDoctor(['doctor', '--profile', 'web', '--no-runtime', '--issue-template'], cap.io, { DSH_HOME: profile.home })
  assert.equal(code, 0)
  const text = cap.stdout.join('\n')
  assert.match(text, /- Hot-install readiness: (ready|degraded|blocked) \(\d+ reason\(s\); Node gate >= 24\)/)
  assert.equal(text.includes(profile.home), false)
})
