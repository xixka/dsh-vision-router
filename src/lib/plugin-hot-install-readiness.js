/**
 * Hot-install / hot-upgrade readiness primitives (plan.md §6.1 / §6.2, P4a).
 *
 * The three-state model: "package written to disk", "Host applied the
 * plugin" and "Client surface available" are independent facts. A verdict of
 * "ready" requires all three to be verified plus the runtime gates (Node
 * >= HOT_INSTALL_NODE_MINIMUM, native ABI compatibility, no command-name
 * conflict). CLI / pnpm exit codes are deliberately never an input to any
 * stage or verdict: they prove nothing about Host application or Client
 * availability. Live confirmation is waitUntilReady()'s job, and its timeout
 * is reported as an explicit 'timeout', never as success.
 *
 * Every check in this module is read-only and bounded: profile inputs are
 * size-capped, no child processes are spawned, and no Host context is
 * mutated. Consumers for install transactions (task B) and the upgrade
 * coordinator (task C) must treat these signatures as frozen.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { inspectProfilePatch } from './doctor.js'
import { VISION_ROUTER_PACKAGE, inspectCoexistingVisionPlugins } from './profile-pnpm-diagnostics.js'
import { HOT_INSTALL_NODE_MINIMUM } from './dsh-support-window.js'

export { HOT_INSTALL_NODE_MINIMUM }

export const HOT_INSTALL_READINESS_STAGES = Object.freeze(['packageWritten', 'hostApplied', 'clientAvailable'])

export const WAIT_UNTIL_READY_DEPS = Object.freeze(['hostApplied', 'commandsChange', 'clientAvailable', 'settingsReady'])

const PROFILE_INPUT_MAX_BYTES = 256 * 1024

// First sharp train that ships Node-API prebuilds (@img/sharp-*), which are
// ABI-stable across Node versions. Earlier trains pin one ABI per install.
const SHARP_NAPI_MINIMUM_VERSION = '0.33.0'
const HMR_ROW_ID = 'hmr'
const HMR_ROW_PACKAGE = '@deepseek-ai/dsh-hmr'

function readTextBounded(filePath, maxBytes = PROFILE_INPUT_MAX_BYTES) {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile() || stats.size > maxBytes) return undefined
    return readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

function readJsonBounded(filePath, maxBytes = PROFILE_INPUT_MAX_BYTES) {
  const text = readTextBounded(filePath, maxBytes)
  if (text === undefined) return undefined
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function nodeMajorOf(nodeVersion) {
  const match = /^v?(\d+)/.exec(String(nodeVersion ?? ''))
  return match ? Number(match[1]) : undefined
}

/** Node gate for hot install specifically; ordinary installation keeps its own, looser floor. */
export function nodeSupportsHotInstall(nodeVersion = process.versions.node) {
  const major = nodeMajorOf(nodeVersion)
  return major !== undefined && major >= HOT_INSTALL_NODE_MINIMUM
}

function compareVersionLoose(left, right) {
  const parse = (value) => String(value ?? '').split('.').map((part) => Number(part) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

/**
 * Static native-ABI gate over the sharp package written in one profile.
 *
 * A loaded sharp module proves compatibility with the process that loaded it;
 * offline doctor-style callers only have package metadata, so the honest
 * static facts are the sharp train (Node-API prebuilds vs ABI-pinned) and the
 * absence of any sharp copy to gate. Host-provided sharp outside the profile
 * is deliberately not inspected here.
 */
function inspectProfileSharpNativeAbi(profileDir) {
  const pkg = readJsonBounded(path.join(profileDir, 'node_modules', 'sharp', 'package.json'))
  if (!pkg || typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    // No sharp copy in the profile is not a gate: Host-provided sharp is
    // outside this static inspection and stays load-time proven.
    return Object.freeze({ compatible: true })
  }
  if (compareVersionLoose(pkg.version, SHARP_NAPI_MINIMUM_VERSION) >= 0) {
    return Object.freeze({ compatible: true, sharpVersion: pkg.version })
  }
  return Object.freeze({
    compatible: false,
    sharpVersion: pkg.version,
    reason: `sharp ${pkg.version} predates the Node-API prebuild train (< ${SHARP_NAPI_MINIMUM_VERSION}); hot install across Node versions requires sharp >= ${SHARP_NAPI_MINIMUM_VERSION}`,
  })
}

/**
 * Runtime native-ABI check over an actually loaded sharp module.
 *
 * A module object that loaded under the current process already proves
 * current-runtime compatibility; this function verifies the native versions
 * metadata and, when an Electron target is supplied, compares its modules ABI
 * against the one the module was loaded under. Desktop (Electron) is outside
 * the hot-install support matrix, so a mismatch is reported honestly instead
 * of being promised a rebuild-free path.
 */
export function checkNativeAbi(sharpModule, electronInfo) {
  const versions = sharpModule && (typeof sharpModule === 'object' || typeof sharpModule === 'function')
    ? sharpModule.versions
    : undefined
  if (!versions || typeof versions !== 'object') {
    return Object.freeze({
      compatible: false,
      reason: 'sharp module did not load or does not expose its native versions metadata',
    })
  }
  if (typeof versions.sharp !== 'string' || typeof versions.vips !== 'string') {
    return Object.freeze({
      compatible: false,
      reason: 'sharp native versions metadata is incomplete (sharp/vips missing); the binding cannot be verified',
    })
  }
  if (electronInfo !== undefined && electronInfo !== null) {
    if (typeof electronInfo !== 'object' || Array.isArray(electronInfo)) {
      throw new TypeError('checkNativeAbi electronInfo must be an object when provided')
    }
    const targetAbi = abiNumberOf(electronInfo.modules)
    const runtimeAbi = abiNumberOf(process.versions.modules)
    if (targetAbi !== undefined && runtimeAbi !== undefined && targetAbi !== runtimeAbi) {
      return Object.freeze({
        compatible: false,
        reason: `sharp is loaded under Node modules ABI ${runtimeAbi} but the Electron target reports ABI ${targetAbi}; a native rebuild is required`,
      })
    }
  }
  return Object.freeze({ compatible: true })
}

function abiNumberOf(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function commandNameOfDefinitionId(definitionId) {
  const value = String(definitionId)
  const marker = value.lastIndexOf('/')
  return (marker >= 0 ? value.slice(marker + 1) : value).trim().toLowerCase()
}

/**
 * Preflight the `/vision` command name against the mounted Host registry
 * (rc.5: `ctx.get('commands')`, duplicate names throw from NamedEntries).
 *
 * The probe is advisory and side-effect free: it never registers anything.
 * A name held by a different definitionId is a conflict with `owner` set; a
 * name held by our own definitionId is a re-registration (the previous
 * generation's ctx.effect() disposer owns the teardown), not a conflict. When
 * the Commands capability is not mounted — a legal rc.5 composition — or the
 * probe cannot run, no conflict is observable and the Host register() throw
 * stays the authoritative duplicate check.
 */
export function checkCommandNameConflict(ctx, definitionId) {
  if (typeof definitionId !== 'string' || definitionId.trim() === '') {
    throw new TypeError('checkCommandNameConflict requires a definitionId string')
  }
  const name = commandNameOfDefinitionId(definitionId)
  if (name === '') return Object.freeze({ conflict: false })

  let registry
  try {
    registry = typeof ctx?.get === 'function' ? ctx.get('commands') : undefined
  } catch {
    registry = undefined
  }
  if (!registry || (typeof registry !== 'object' && typeof registry !== 'function')) {
    return Object.freeze({ conflict: false })
  }

  let existing
  try {
    if (typeof registry.find === 'function') {
      existing = registry.find(undefined, name)
    } else if (typeof registry.list === 'function') {
      const listed = registry.list(undefined)
      existing = Array.isArray(listed) ? listed.find((entry) => entry?.name === name) : undefined
    }
  } catch {
    return Object.freeze({ conflict: false })
  }
  if (existing === undefined || existing === null) return Object.freeze({ conflict: false })

  const owner = typeof existing.definitionId === 'string' && existing.definitionId.trim() !== ''
    ? existing.definitionId
    : undefined
  if (owner === definitionId) return Object.freeze({ conflict: false })
  return owner === undefined ? Object.freeze({ conflict: true }) : Object.freeze({ conflict: true, owner })
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function depSatisfied(dep) {
  if (typeof dep === 'function') return (await dep()) === true
  if (dep && typeof dep.then === 'function') return (await dep) === true
  return dep === true
}

/**
 * Bounded readiness wait over the four hot-install live facts (plan §6.1):
 * Host recomposition, the commands/change registration, Client availability
 * and Settings readiness. Each dep accepts a boolean, a (possibly async)
 * probe function, or a thenable; absent deps are not required. A probe that
 * throws counts as unsatisfied. The loop is deadline-bounded: polling never
 * sleeps past the deadline, and on expiry the result is an explicit
 * 'timeout' naming the pending deps — never a success.
 */
export async function waitUntilReady(deps = {}, {
  timeoutMs = 30_000,
  pollMs = 250,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('waitUntilReady timeoutMs must be a non-negative finite number')
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new TypeError('waitUntilReady pollMs must be a positive finite number')
  }
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('waitUntilReady deps must be an object')
  }
  const required = WAIT_UNTIL_READY_DEPS.filter((name) => deps[name] !== undefined && deps[name] !== null)
  const startedAt = now()
  for (;;) {
    const pending = []
    for (const name of required) {
      let satisfied = false
      try {
        satisfied = await depSatisfied(deps[name])
      } catch {
        satisfied = false
      }
      if (satisfied !== true) pending.push(name)
    }
    const elapsedMs = Math.max(0, Math.round(now() - startedAt))
    if (pending.length === 0) {
      return Object.freeze({ status: 'ready', pending: Object.freeze([]), elapsedMs })
    }
    if (elapsedMs >= timeoutMs) {
      return Object.freeze({ status: 'timeout', pending: Object.freeze(pending), elapsedMs })
    }
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - elapsedMs)))
  }
}

/**
 * Offline HMR availability check over the user patch layers.
 *
 * The `hmr` row is owned by the Host's dsh-base bundle and enabled by
 * default; a user layer (profile or home cordis.patch.yml) can disable it.
 * Only an explicit disable is statically observable, so the two honest
 * outcomes are 'disabled' (definite) and 'enabled-by-base-default' (assumed
 * by the base bundle; the final composition stays Host-decided).
 */
export function checkHmrAvailability({ profilePatch, homePatch } = {}) {
  const sources = [
    ['profile cordis.patch.yml', profilePatch],
    ['home cordis.patch.yml', homePatch],
  ]
  for (const [label, text] of sources) {
    if (typeof text !== 'string') continue
    if (patchDisablesHmrRow(text)) {
      return Object.freeze({
        status: 'disabled',
        reason: `${label} disables the ${HMR_ROW_ID} row (${HMR_ROW_PACKAGE}); profile changes apply only after a Host restart`,
      })
    }
  }
  return Object.freeze({
    status: 'enabled-by-base-default',
    reason: `no user layer disables the ${HMR_ROW_ID} row; the dsh-base bundle enables it and the final composition is Host-decided`,
  })
}

function patchDisablesHmrRow(text) {
  const lines = String(text).split('\n').map(stripYamlComment)
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+id:\s*['"]?([A-Za-z0-9._/-]+)['"]?\s*$/.exec(lines[index])
    if (!match || match[2] !== HMR_ROW_ID) continue
    const itemIndent = match[1].length
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const line = lines[scan]
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
      if (line.length - line.trimStart().length <= itemIndent) break
      if (/^disabled:\s*true\s*$/.test(line.trim())) return true
    }
  }
  return false
}

// Same quote-aware strip doctor applies to patch rows: a '#' inside a quoted
// scalar is content, everything after a bare '#' is a comment.
function stripYamlComment(line) {
  let quote
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if ((char === '"' || char === "'") && line[index - 1] !== '\\') {
      quote = quote === char ? undefined : quote ?? char
      continue
    }
    if (char === '#' && quote === undefined) return line.slice(0, index)
  }
  return line
}

/**
 * Static three-state inspection of one DSH profile (plan §6.1).
 *
 * Stages come from on-disk evidence only:
 * - packageWritten: node_modules/dsh-vision-router exists with a version.
 * - hostApplied: the profile composition references the plugin (a
 *   dsh.profile.bundles entry or a cordis.patch.yml row). pnpm having placed
 *   files on disk never proves the Host mounts them.
 * - clientAvailable: the installed package declares its web client surface
 *   (dsh.client.platform "web") and carries lib/client.js.
 *
 * verdict 'ready' requires all three stages plus nodeOk, native ABI
 * compatibility and no conflicts; 'blocked' marks a hard gate failure (Node
 * floor, sharp ABI, duplicate registration); 'degraded' marks an incomplete
 * or unverifiable state. CLI/pnpm exit codes are never consulted.
 */
export function inspectInstallReadiness({
  profileDir,
  nodeVersion = process.versions.node,
  manifest,
} = {}) {
  if (typeof profileDir !== 'string' || profileDir.trim() === '') {
    throw new TypeError('inspectInstallReadiness requires a profileDir string')
  }

  const reasons = []
  const conflicts = []

  const profileManifest = manifest !== undefined
    ? (manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : undefined)
    : readJsonBounded(path.join(profileDir, 'package.json'))
  if (manifest !== undefined && profileManifest === undefined) {
    reasons.push('provided profile manifest is not a usable object')
  }

  const installedManifest = readJsonBounded(
    path.join(profileDir, 'node_modules', VISION_ROUTER_PACKAGE, 'package.json'),
  )
  const packageWritten = typeof installedManifest?.version === 'string' && installedManifest.version.trim() !== ''
  if (!packageWritten) {
    reasons.push(`stage packageWritten unverified: node_modules/${VISION_ROUTER_PACKAGE} is missing or has no version`)
  }

  const bundles = profileManifest?.dsh?.profile?.bundles
  const bundleDeclared = Array.isArray(bundles) && bundles.includes(VISION_ROUTER_PACKAGE)
  const patchReport = inspectProfilePatch(path.join(profileDir, 'cordis.patch.yml'))
  const patchDeclared = patchReport.manualVisionRouter === true
  const hostApplied = bundleDeclared || patchDeclared
  if (!hostApplied) {
    reasons.push('stage hostApplied unverified: the profile declares the plugin neither in dsh.profile.bundles nor in cordis.patch.yml')
  }
  if (bundleDeclared && patchDeclared) {
    conflicts.push('duplicate registration: dsh.profile.bundles and cordis.patch.yml both declare dsh-vision-router')
  }

  const clientDeclaration = installedManifest?.dsh?.client
  const clientEntryExists = existsSync(
    path.join(profileDir, 'node_modules', VISION_ROUTER_PACKAGE, 'lib', 'client.js'),
  )
  const clientAvailable = packageWritten
    && clientDeclaration?.platform === 'web'
    && clientEntryExists
  if (packageWritten && !clientAvailable) {
    reasons.push('stage clientAvailable unverified: the installed package does not declare dsh.client.platform "web" with lib/client.js present')
  }

  // Static /vision conflict evidence. Whether a coexisting vision package
  // actually registers the name cannot be proven offline, so it is reported
  // as an explicit unverifiable risk instead of being assumed away.
  for (const plugin of inspectCoexistingVisionPlugins(profileDir)) {
    conflicts.push(`possible /vision command conflict: coexisting vision plugin ${plugin.name} (${plugin.installedVersion ?? plugin.spec ?? 'unknown version'}) is declared in the profile; an offline check cannot prove it leaves the name free`)
  }

  const nodeOk = nodeSupportsHotInstall(nodeVersion)
  if (!nodeOk) {
    reasons.push(`Node ${nodeVersion} is below the hot-install minimum (>= ${HOT_INSTALL_NODE_MINIMUM}); ordinary installation stays supported, hot install does not`)
  }

  const nativeAbi = inspectProfileSharpNativeAbi(profileDir)
  if (!nativeAbi.compatible) reasons.push(`native ABI gate: ${nativeAbi.reason}`)

  let verdict = 'ready'
  if (!nodeOk || !nativeAbi.compatible || bundleDeclared && patchDeclared) {
    verdict = 'blocked'
  } else if (!packageWritten || !hostApplied || !clientAvailable || conflicts.length > 0) {
    verdict = 'degraded'
  }

  return Object.freeze({
    stages: Object.freeze({ packageWritten, hostApplied, clientAvailable }),
    conflicts: Object.freeze(conflicts),
    nativeAbi,
    nodeOk,
    verdict,
    reasons: Object.freeze(reasons),
  })
}
