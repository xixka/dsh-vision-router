// 首次安装事务（plan §6.3 六步）：预检 → 准备 → 应用 → 等待 → 验证 → 失败恢复。
//
// 就绪探测本身不属于本文件：按任务 A 的接口合同消费
// src/lib/plugin-hot-install-readiness.js 的四个导出——
//   inspectInstallReadiness / checkCommandNameConflict / checkNativeAbi / waitUntilReady
// （三态 packageWritten / hostApplied / clientAvailable 均验证才 ready；
//   waitUntilReady 有界等待四类信号：包落盘、Host 应用、客户端可见、状态可发现，
//   超时显式返回，不抛异常）。readiness 通过 options.readiness 注入；
//   未注入时按同名语义惰性 import 该模块，模块尚未落地（任务 A 并行中）时
//   预检显式失败，绝不静默降级，也绝不自建同名文件。
//
// 通道语义（plan §6.3 step 3）：
//   - Web 通道：进程内调用 pluginManager.installBundle()（DSH 0.2.1-rc.5 真实
//     API，ChangeResult 语义：applied / restart-required / failed / cancelled /
//     overridden，含 stage / restartReason / error）。本文件不重实现安装，
//     只编排。
//   - 外部 CLI 通道：spawn 外部命令完成包操作；运行中的 Host 由其 manifest
//     watcher 自动发现并 HMR 重组——插件侧不实现发现，只做有界等待。
//
// 硬性诚实约束：
//   - 预检失败不触碰运行中的旧版本（事务在 precheck 阶段零副作用）。
//   - 包操作失败 → 按 DSH 快照恢复 manifest/lockfile（DSH 行为），本事务验证
//     恢复结果并如实上报，未恢复就是未恢复。
//   - 激活失败（包已写入但 Host 未应用/客户端不可见）→ 标记
//     installedNotActivated，绝不显示热应用成功，绝不自动重启 Host。
//   - 任何路径都没有重启逻辑；“restart-required” 只被如实转发。

/** Readiness 接口合同的四个能力（由任务 A 的模块或注入方提供）。 */
export const READINESS_CONTRACT = Object.freeze({
  module: './plugin-hot-install-readiness.js',
  functions: Object.freeze([
    'inspectInstallReadiness',
    'checkCommandNameConflict',
    'checkNativeAbi',
    'waitUntilReady',
  ]),
})

/** plan §6.3 的六步事务步骤名（顺序即执行顺序）。 */
export const FIRST_INSTALL_TRANSACTION_STEPS = Object.freeze([
  'precheck',
  'prepare',
  'apply',
  'wait',
  'verify',
  'recover',
])

/** waitUntilReady 有界等待的缺省预算（毫秒）。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000
/** verify 阶段探测的缺省预算（毫秒）。 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 30_000

const EMPTY_STATES = () => ({ packageWritten: false, hostApplied: false, clientAvailable: false })

function nowMs() {
  return Date.now()
}

function elapsed(sinceMs) {
  return Math.max(0, nowMs() - sinceMs)
}

/** 惰性加载任务 A 的 readiness 模块；尚未落地时返回 null（显式，不静默）。 */
async function loadReadinessModule() {
  try {
    return await import('./plugin-hot-install-readiness.js')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND') return null
    throw error
  }
}

/** 有界重试轮询：超时显式返回 { timedOut: true }，不抛异常。 */
async function pollUntil(probe, timeoutMs, intervalMs = 500) {
  const deadline = nowMs() + timeoutMs
  for (;;) {
    let value
    try {
      value = await probe()
    } catch (error) {
      value = { probeError: error instanceof Error ? error.message : String(error) }
    }
    if (value && !value.probeError && value.ok !== false) return { timedOut: false, value }
    if (nowMs() >= deadline) return { timedOut: true, value }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs))
  }
}

/**
 * 启动一次首次安装事务（plan §6.3 六步）。返回 { promise, progress() }：
 * promise 永远 resolve 为一份事务报告（失败也是报告，不是 rejection——
 * 报告必须诚实可机读）；progress() 在事务运行期间同步返回当前步骤与
 * 最近一次三态快照，进度可查询。
 *
 * options：
 *   spec            安装目标（npm 包名 / file: 路径等），必填。
 *   channel        'web'（默认，进程内 pluginManager.installBundle）或
 *                  'cli'（外部命令，manifest watcher 负责发现与应用）。
 *   installOptions 透传给 web 通道 installBundle 的第二参（rc.5 真实签名）。
 *   readiness      可选注入；缺省按 READINESS_CONTRACT 惰性 import。
 *   channels.web.installBundle(spec, installOptions) → ChangeResult 形状。
 *   channels.cli.run(spec) → { exitCode, stdout, stderr }（CLI 通道）。
 *   probes.visionStatus()    → { discoverable, modelSideEffects }。
 *   probes.surfaceCounts()   → { commands, tools, routes, settingsCards }。
 *   probes.readProfileSnapshot()    → 恢复基线（opaque）。
 *   probes.verifyRestoration(base) → { manifest, lockfile }（true = 已恢复）。
 *   timeouts.waitMs / timeouts.verifyMs 覆盖缺省预算。
 *   onStep(step, detail)     步骤回调（诊断用）。
 */
export function createFirstInstallTransaction(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createFirstInstallTransaction: options object is required')
  }
  if (typeof options.spec !== 'string' || options.spec.length === 0) {
    throw new TypeError('createFirstInstallTransaction: options.spec must be a non-empty string')
  }
  const channel = options.channel === 'cli' ? 'cli' : 'web'
  if (channel === 'web' && typeof options.channels?.web?.installBundle !== 'function') {
    throw new TypeError('createFirstInstallTransaction: web channel requires channels.web.installBundle')
  }
  if (channel === 'cli' && typeof options.channels?.cli?.run !== 'function') {
    throw new TypeError('createFirstInstallTransaction: cli channel requires channels.cli.run')
  }

  const waitTimeoutMs = options.timeouts?.waitMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const verifyTimeoutMs = options.timeouts?.verifyMs ?? DEFAULT_VERIFY_TIMEOUT_MS
  const startedAt = nowMs()
  const state = {
    step: 'precheck',
    channel,
    spec: options.spec,
    states: EMPTY_STATES(),
    startedAt,
    detail: 'starting',
  }
  const report = (partial) => ({
    ok: false,
    step: state.step,
    channel,
    spec: options.spec,
    application: null,
    hotApplied: false,
    ready: false,
    timedOut: false,
    states: { ...state.states },
    visionStatus: null,
    surfaceUniqueness: null,
    installedNotActivated: false,
    restartRequested: false,
    recovered: null,
    touchedProfile: false,
    precheck: null,
    diagnostics: {},
    ...partial,
  })
  const enter = (step, detail) => {
    state.step = step
    state.detail = detail
    options.onStep?.(step, detail)
  }

  const promise = (async () => {
    // ---- step 1: 预检 ------------------------------------------------------
    enter('precheck', 'readiness-resolution')
    let readiness = options.readiness ?? null
    if (readiness === null) {
      readiness = await loadReadinessModule()
      if (readiness === null) {
        return report({
          precheck: {
            readinessModuleAvailable: false,
            blocking: 'readiness-module-missing',
            note: `${READINESS_CONTRACT.module} is not present yet (task A lands it in parallel); inject options.readiness to run the transaction now`,
          },
        })
      }
    }
    for (const name of READINESS_CONTRACT.functions) {
      if (typeof readiness[name] !== 'function') {
        return report({
          precheck: { readinessModuleAvailable: true, blocking: `contract-function-missing:${name}` },
        })
      }
    }

    enter('precheck', 'inspect')
    let inspection
    try {
      inspection = await readiness.inspectInstallReadiness({ spec: options.spec, channel })
    } catch (error) {
      return report({ precheck: { blocking: 'inspect-threw', message: String(error) } })
    }
    state.states = { ...EMPTY_STATES(), ...(inspection?.states ?? {}) }
    if (inspection?.packageAlreadyPresent === true) {
      return report({
        application: 'failed',
        precheck: { blocking: 'already-installed', inspection },
        touchedProfile: false,
        diagnostics: { alreadyInstalled: true },
      })
    }

    enter('precheck', 'command-name-conflict')
    const conflict = await readiness.checkCommandNameConflict({ spec: options.spec }).catch((error) => ({
      conflict: 'unknown',
      message: String(error),
    }))
    if (conflict?.conflict === true || conflict?.conflict === 'unknown') {
      return report({
        precheck: { blocking: conflict.conflict === true ? 'command-name-conflict' : 'conflict-check-unavailable', conflict },
        touchedProfile: false,
      })
    }

    enter('precheck', 'native-abi')
    const abi = await readiness.checkNativeAbi({ spec: options.spec }).catch((error) => ({
      compatible: 'unknown',
      message: String(error),
    }))
    if (abi?.compatible !== true) {
      return report({
        precheck: { blocking: 'native-abi-incompatible', abi, inspection },
        touchedProfile: false,
      })
    }

    const precheck = {
      readinessModuleAvailable: true,
      inspection,
      commandNameConflict: conflict,
      nativeAbi: abi,
    }

    // ---- step 2: 准备 ------------------------------------------------------
    enter('prepare', 'profile-snapshot')
    let snapshot = null
    if (typeof options.probes?.readProfileSnapshot === 'function') {
      snapshot = await options.probes.readProfileSnapshot().catch(() => null)
    }
    const restoreProbe = typeof options.probes?.verifyRestoration === 'function'
      ? options.probes.verifyRestoration.bind(options.probes)
      : null

    // ---- step 3: 应用 ------------------------------------------------------
    enter('apply', `${channel}-channel`)
    let application = null
    let change = null
    let cliResult = null
    if (channel === 'web') {
      change = await options.channels.web.installBundle(options.spec, options.installOptions ?? {})
        .catch((error) => ({ application: 'failed', error: { code: 'install-threw', message: String(error) } }))
      application = change?.application ?? (change?.changed === true ? 'applied' : 'overridden')
      if (application === 'applied' && change?.error) application = 'failed'
    } else {
      cliResult = await options.channels.cli.run(options.spec).catch((error) => ({
        exitCode: 1,
        stderr: String(error),
      }))
      application = cliResult?.exitCode === 0 ? 'applied' : 'failed'
    }
    state.detail = `application:${application}`

    if (application === 'cancelled') {
      return report({ application, precheck, touchedProfile: false, diagnostics: { change, cliResult } })
    }

    // 包操作失败 → 直取 step 6 失败恢复（不进入等待/验证）。
    if (application === 'failed') {
      enter('recover', 'package-operation-failure')
      let recovered = null
      if (restoreProbe !== null) {
        recovered = await restoreProbe(snapshot).catch(() => null)
      }
      return report({
        application,
        precheck,
        touchedProfile: true,
        recovered,
        diagnostics: { change, cliResult, failureKind: 'package-operation' },
      })
    }

    // restart-required：如实转发，绝不自动重启；热应用不可能成立。
    if (application === 'restart-required') {
      return report({
        application,
        precheck,
        touchedProfile: true,
        restartRequested: true,
        installedNotActivated: true,
        diagnostics: { change, restartReason: change?.restartReason ?? null },
      })
    }

    // ---- step 4: 等待 ------------------------------------------------------
    enter('wait', 'bounded-wait')
    const waitOutcome = await readiness.waitUntilReady({
      spec: options.spec,
      channel,
      timeoutMs: waitTimeoutMs,
    }).catch((error) => ({ ready: false, timedOut: false, states: EMPTY_STATES(), error: String(error) }))
    state.states = { ...EMPTY_STATES(), ...(waitOutcome?.states ?? {}) }
    const ready = waitOutcome?.ready === true
    const timedOut = waitOutcome?.timedOut === true
    const states = { ...state.states }

    if (!ready) {
      // ---- step 6: 失败恢复（激活失败分支）--------------------------------
      enter('recover', 'activation-failure')
      return report({
        application,
        precheck,
        touchedProfile: true,
        ready: false,
        timedOut,
        states,
        // 包已写入但 Host 未应用 / 客户端不可见 → 诚实标记，不显示热应用，
        // 不自动重启。
        installedNotActivated: states.packageWritten === true,
        diagnostics: { waitOutcome },
      })
    }

    // ---- step 5: 验证 ------------------------------------------------------
    enter('verify', 'vision-status-discovery')
    let visionStatus = null
    if (typeof options.probes?.visionStatus === 'function') {
      const probed = await pollUntil(options.probes.visionStatus, verifyTimeoutMs)
      visionStatus = probed.value ?? null
      if (probed.timedOut) {
        enter('recover', 'verify-timeout')
        return report({
          application,
          precheck,
          touchedProfile: true,
          ready,
          states,
          timedOut: true,
          installedNotActivated: true,
          visionStatus,
          diagnostics: { verifyTimedOut: 'vision-status' },
        })
      }
    }
    enter('verify', 'surface-uniqueness')
    let surfaceUniqueness = null
    if (typeof options.probes?.surfaceCounts === 'function') {
      const probed = await pollUntil(options.probes.surfaceCounts, verifyTimeoutMs)
      surfaceUniqueness = probed.value ?? null
      if (probed.timedOut) {
        enter('recover', 'verify-timeout')
        return report({
          application,
          precheck,
          touchedProfile: true,
          ready,
          states,
          timedOut: true,
          installedNotActivated: true,
          surfaceUniqueness,
          diagnostics: { verifyTimedOut: 'surface-uniqueness' },
        })
      }
    }
    const counts = surfaceUniqueness?.counts ?? null
    const unique = counts === null
      ? null
      : ['commands', 'tools', 'routes', 'settingsCards'].every((key) => counts[key] === 1)
    const visionDiscoverable = visionStatus?.discoverable === true
    const modelSideEffects = visionStatus?.modelSideEffects ?? null
    const verified = visionDiscoverable
      && modelSideEffects === 0
      && (unique === null || unique === true)

    if (!verified) {
      enter('recover', 'verify-failure')
      return report({
        application,
        precheck,
        touchedProfile: true,
        ready,
        states,
        visionStatus,
        surfaceUniqueness: counts === null ? null : { counts, unique },
        installedNotActivated: true,
        diagnostics: { verifyFailure: { visionDiscoverable, modelSideEffects, unique } },
      })
    }

    enter('verify', 'complete')
    return report({
      ok: true,
      application,
      precheck,
      touchedProfile: true,
      ready,
      states,
      visionStatus,
      surfaceUniqueness: counts === null ? null : { counts, unique },
      hotApplied: application === 'applied',
      diagnostics: { change, cliResult },
    })
  })()

  return {
    promise,
    /** 运行期进度查询（同步）：当前步骤、三态快照、已耗时。 */
    progress() {
      return { ...state, elapsedMs: elapsed(startedAt) }
    },
  }
}
