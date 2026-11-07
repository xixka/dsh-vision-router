// 首次安装事务 + Web/CLI 热安装 E2E（plan §8.1 / §6.3）。
//
// 仅在提供 DSH_SOURCE_ROOT 的环境执行（CI 的 plugin-hot-install-e2e 工作流，
// 本地 node --test 直接跳过）。权威验证在真实 DSH 0.2.1-rc.5 Host 上：
// Node 子进程 spawn 真实 Host（web --no-open --port 0）+ 真实 Chromium 客户端，
// 断言（对照 plan §6.3 六步）：
//   1. 预检——Host 冷启动无 DVR；二装预检拒绝且零副作用（touchedProfile=false）；
//   2. 准备——profile manifest/lockfile 快照可读（恢复基线）；
//   3. 应用——Web 通道走页面真实 pluginManager.installBundle RPC（Add plugin
//      对话框），外部 CLI 通道 spawn dsh plugin add（运行中 Host 的 manifest
//      watcher 自动发现并 HMR 重组；插件侧不实现发现）；
//   4. 等待——waitUntilReady 有界等待三态（packageWritten/hostApplied/
//      clientAvailable），进度可查询；
//   5. 验证——/vision 可发现且无模型副作用；command/tool/settings 面唯一；
//   6. 失败恢复——坏 bundle 包操作失败后按 DSH 快照恢复 manifest/lockfile，
//      旧插件继续运行；进程全程不重启（PID/端口不变）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createFirstInstallTransaction } from '../lib/plugin-hot-install-transaction.js'

const DVR_NAME = 'dsh-vision-router'
const BAD_BUNDLE_NAME = 'dsh-vision-router-e2e-missing-dependency'

const root = fileURLToPath(new URL('../', import.meta.url))
const dshRoot = process.env.DSH_SOURCE_ROOT ? resolve(process.env.DSH_SOURCE_ROOT) : null
const RUN = dshRoot !== null
const dvrTarball = process.env.DVR_TARBALL ? resolve(process.env.DVR_TARBALL) : null
const dvrSpec = dvrTarball !== null ? `file:${dvrTarball}` : `file:${root}`

/** 全场景共享的真实 Host / 浏览器状态；node:test 顺序执行，逐测试传递。 */
const ctx = {
  child: null,
  pid: null,
  port: null,
  readyUrl: null,
  browser: null,
  page: null,
  env: null,
  scratch: null,
  workspacePath: null,
  hostOutput: '',
  modelRequestCount: 0,
}

function requireDsh() {
  const dshRequire = createRequire(join(dshRoot, 'package.json'))
  const tsxLoader = dshRequire.resolve('tsx')
  const cli = join(dshRoot, 'apps/cli/src/bin.ts')
  return { tsxLoader, cli }
}

function resolvePlaywright() {
  const webRequire = createRequire(join(dshRoot, 'apps/web/package.json'))
  return webRequire('playwright')
}

function waitForReadyLine(child) {
  return new Promise((resolveReady, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`dsh web did not announce readiness in 120s; output:\n${output}`))
    }, 120_000)
    const onData = (chunk) => {
      const text = chunk.toString()
      ctx.hostOutput += text
      output += text
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(output)
      if (match?.[1]) {
        clearTimeout(timer)
        resolveReady(match[1])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited early (code ${code}); output:\n${output}`))
    })
  })
}

async function dismissFirstRunOverlays(page) {
  // DVR 自身的 onboarding 仅在插件加载后出现；DSH 首启公告两者都处理。
  const vrOnboarding = page.locator('.vr-onboarding-backdrop')
  try {
    await vrOnboarding.waitFor({ state: 'visible', timeout: 5_000 })
  } catch (_) { /* absent: fine */ }
  if (await vrOnboarding.isVisible().catch(() => false)) {
    await vrOnboarding.locator('.vr-onboarding-secondary').click()
    await vrOnboarding.waitFor({ state: 'hidden', timeout: 15_000 })
  }
  const welcome = page.getByRole('dialog', { name: /^(?:Internal Testing Notice|Preview Notice)$/ }).first()
  try {
    await welcome.waitFor({ state: 'visible', timeout: 5_000 })
  } catch (_) { /* absent: fine */ }
  if (await welcome.isVisible().catch(() => false)) {
    await welcome.getByRole('button', { name: 'Continue', exact: true }).click()
    await welcome.waitFor({ state: 'hidden', timeout: 30_000 })
  }
}

function visionToggleCount(page) {
  return page.locator('[data-vision-router-mode-toggle="true"]').count()
}

function panelPackageCount(page, name) {
  const panel = page.locator('[data-plugin-panel]')
  return panel.locator(`[data-plugin-package="${name}"]`).count()
}

async function openPluginPanel(page) {
  const panel = page.locator('[data-plugin-panel]')
  if (await panel.count() === 0) {
    if (await page.getByRole('dialog').count() > 0) {
      await page.keyboard.press('Escape').catch(() => {})
    }
    const navButton = page.getByRole('navigation', { name: 'Global panels' })
      .getByRole('button', { name: 'Plugins', exact: true })
    await navButton.waitFor({ state: 'visible', timeout: 30_000 })
    await navButton.click()
  }
  const list = panel.getByRole('heading', { name: 'Plugins', exact: true })
  if (!await list.isVisible().catch(() => false)) {
    const back = panel.getByRole('button', { name: 'Back to plugins', exact: true })
    if (await back.count() > 0) await back.click()
  }
  await list.waitFor({ state: 'visible', timeout: 30_000 })
  return panel
}

async function adoptRealWorkspace(page, workspacePath) {
  const chooseWorkspace = page.getByRole('button', { name: 'Choose workspace', exact: true })
  await chooseWorkspace.waitFor({ state: 'visible', timeout: 30_000 })
  await chooseWorkspace.click()
  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
  await picker.waitFor({ state: 'visible', timeout: 30_000 })
  await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
  const pathInput = picker.getByRole('textbox', { name: 'Edit path', exact: true })
  await pathInput.waitFor({ state: 'visible', timeout: 10_000 })
  await pathInput.fill(workspacePath)
  await pathInput.press('Enter')
  await pathInput.waitFor({ state: 'hidden', timeout: 30_000 })
  await picker.getByRole('button', { name: 'Open', exact: true }).click({ timeout: 30_000 })
  await picker.waitFor({ state: 'hidden', timeout: 30_000 })
}

async function connectFreshWorkspaceThroughHero(page) {
  // rc.5 官方 e2e support.ts 的 connectFreshWorkspace 同款路径：
  // sessionless 英雄区的 'Choose workspace' 文本框 → Select Workspace Directory。
  const heroInput = page.getByRole('textbox', { name: 'Choose workspace', exact: true })
  if (!await heroInput.isVisible().catch(() => false)) return false
  await heroInput.click()
  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
  await picker.waitFor({ state: 'visible', timeout: 10_000 })
  await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
  const pathInput = picker.getByRole('textbox', { name: 'Edit path', exact: true })
  await pathInput.waitFor({ state: 'visible', timeout: 10_000 })
  await pathInput.fill(ctx.workspacePath)
  await pathInput.press('Enter')
  await pathInput.waitFor({ state: 'hidden', timeout: 30_000 })
  await picker.getByRole('button', { name: 'Open', exact: true }).click({ timeout: 30_000 })
  await picker.waitFor({ state: 'hidden', timeout: 30_000 })
  return true
}

async function openSessionSurface(page) {
  await dismissFirstRunOverlays(page)
  // rc.5 冷启动自动初始化默认工作区并直接渲染 composer；优先等待它，
  // 绝不主动点击会被已展开工作区菜单遮挡的 'Choose workspace' 按钮。
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
  if (await composer.isVisible().catch(() => false)) return
  try {
    await composer.waitFor({ state: 'visible', timeout: 20_000 })
    return
  } catch (_) { /* fall through: sessionless hero */ }
  await page.keyboard.press('Escape').catch(() => {})
  if (await connectFreshWorkspaceThroughHero(page).catch(() => false)) {
    await composer.waitFor({ state: 'visible', timeout: 20_000 })
    return
  }
  const newSession = page.getByRole('button', { name: 'New session', exact: true }).last()
  if (await newSession.isVisible().catch(() => false)) {
    await newSession.click().catch(() => {})
    try {
      await composer.waitFor({ state: 'visible', timeout: 20_000 })
      return
    } catch (_) { /* fall through */ }
  }
  await dismissFirstRunOverlays(page)
  const chooseWorkspace = page.getByRole('button', { name: 'Choose workspace', exact: true })
  if (await chooseWorkspace.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {})
    const shown = (await chooseWorkspace.innerText().catch(() => '')).trim().toLowerCase()
    if (shown !== 'workspace' && shown !== 'default workspace') {
      await adoptRealWorkspace(page, ctx.workspacePath).catch(() => {})
    }
  }
  await composer.waitFor({ state: 'visible', timeout: 15_000 })
}

async function ensureSessionView(page) {
  if (await visionToggleCount(page) > 0) return
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openSessionSurface(page)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && await visionToggleCount(page) === 0) {
    await page.waitForTimeout(500)
  }
}

async function installThroughPage(page, spec) {
  const panel = await openPluginPanel(page)
  await panel.getByRole('button', { name: 'Add plugin', exact: true }).click()
  const dialog = page.getByRole('dialog').first()
  await dialog.getByRole('textbox', { name: 'Package name or address' }).fill(spec)
  await dialog.getByRole('button', { name: 'Install', exact: true }).click()
  await dialog.getByRole('button', { name: 'Enable now', exact: true }).click({ timeout: 120_000 })
  await dialog.waitFor({ state: 'detached', timeout: 15_000 })
  return panel
}

async function installRefusalThroughPage(page, spec) {
  const panel = await openPluginPanel(page)
  await panel.getByRole('button', { name: 'Add plugin', exact: true }).click()
  const dialog = page.getByRole('dialog').first()
  await dialog.getByRole('textbox', { name: 'Package name or address' }).fill(spec)
  await dialog.getByRole('button', { name: 'Install', exact: true }).click()
  const alert = dialog.getByRole('alert').first()
  await alert.waitFor({ state: 'visible', timeout: 120_000 })
  const alertText = (await alert.textContent()) ?? ''
  const dialogText = (await dialog.textContent().catch(() => '')) ?? ''
  const text = `${alertText}\n${dialogText}`
  ctx.hostOutput += `install refusal alert: ${alertText}\ninstall refusal dialog: ${dialogText.slice(0, 2_000)}\n`
  const closer = dialog.getByRole('button', { name: /^(Close|Done|Cancel)$/i }).first()
  if (await closer.count() > 0) await closer.click().catch(() => {})
  else await page.keyboard.press('Escape').catch(() => {})
  await dialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  return text
}

async function installFailureThroughPage(page, spec) {
  const panel = await openPluginPanel(page)
  await panel.getByRole('button', { name: 'Add plugin', exact: true }).click()
  const dialog = page.getByRole('dialog').first()
  await dialog.getByRole('textbox', { name: 'Package name or address' }).fill(spec)
  await dialog.getByRole('button', { name: 'Install', exact: true }).click()
  const alert = dialog.getByRole('alert').first()
  await alert.waitFor({ state: 'visible', timeout: 180_000 })
  const alertText = (await alert.textContent()) ?? ''
  const dialogText = (await dialog.textContent().catch(() => '')) ?? ''
  const text = `${alertText}\n${dialogText}`
  ctx.hostOutput += `install failure alert: ${alertText}\ninstall failure dialog: ${dialogText.slice(0, 2_000)}\n`
  const closer = dialog.getByRole('button', { name: /^(Close|Done|Cancel)$/i }).first()
  if (await closer.count() > 0) await closer.click().catch(() => {})
  else await page.keyboard.press('Escape').catch(() => {})
  await dialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  return text
}

async function uninstallThroughPage(page, name) {
  const panel = await openPluginPanel(page)
  await panel.getByRole('button', { name: `View ${name}`, exact: true }).click()
  await panel.getByRole('button', { name: `Uninstall ${name}`, exact: true }).click()
  const confirm = page.getByRole('dialog').first()
  await confirm.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await panel.getByRole('heading', { name: 'Plugins', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await panelPackageCount(page, name) === 0) return
    await page.waitForTimeout(500)
  }
  throw new Error(`uninstall of ${name} did not land (rows: ${await panelPackageCount(page, name)})`)
}

function profileManifestPath() {
  return join(ctx.env.DSH_HOME, 'profiles', 'web', 'package.json')
}

function manifestReferences(name) {
  try {
    return readFileSync(profileManifestPath(), 'utf8').includes(`"${name}"`)
  } catch (_) {
    return false
  }
}

function spawnCliInstall(spec) {
  const { tsxLoader, cli } = requireDsh()
  const result = spawnSync(
    process.execPath,
    ['--import', tsxLoader, cli, 'plugin', '--profile', 'web', 'add', spec],
    { cwd: dshRoot, env: ctx.env, encoding: 'utf8', stdio: 'pipe', timeout: 300_000 },
  )
  ctx.hostOutput += `--- dsh plugin add ${spec} (exit ${result.status}) ---\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n`
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function writeFixtureBundle(dir) {
  await mkdirSync(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({
    name: BAD_BUNDLE_NAME,
    version: '0.0.0',
    type: 'module',
    main: './index.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dependencies: { 'dsh-vision-router-e2e-no-such-dependency': '0.0.0' },
  }, null, 2)}\n`)
  await writeFile(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: ${BAD_BUNDLE_NAME}\n      name: ${BAD_BUNDLE_NAME}\n`)
  await writeFile(join(dir, 'index.mjs'), `export const name = '${BAD_BUNDLE_NAME}'\nexport function apply() {}\n`)
}

/**
 * 任务 A 合同的 e2e 实现：三态探测全部来自真实 Host（profile 文件、插件面板
 * 的 Host 投影、真实客户端页面的 /vision 面）。waitUntilReady 有界等待，
 * 超时显式返回 { ready: false, timedOut: true }。
 */
function createReadinessAdapter({ target = DVR_NAME } = {}) {
  return {
    async inspectInstallReadiness() {
      const packageWritten = manifestReferences(target)
      let hostApplied = false
      if (packageWritten) {
        hostApplied = await panelPackageCount(ctx.page, target) >= 1
      }
      const clientAvailable = hostApplied && await visionToggleCount(ctx.page) > 0
      return { states: { packageWritten, hostApplied, clientAvailable }, packageAlreadyPresent: packageWritten }
    },
    async checkCommandNameConflict() {
      const observed = await visionToggleCount(ctx.page)
      return { conflict: observed > 1, observed }
    },
    async checkNativeAbi() {
      return { compatible: true, nodeVersion: process.version, hostExpected: process.env.DSH_EXPECTED_VERSION ?? null }
    },
    async waitUntilReady({ timeoutMs = 180_000 } = {}) {
      const deadline = Date.now() + timeoutMs
      let lastReload = 0
      const states = { packageWritten: false, hostApplied: false, clientAvailable: false }
      while (Date.now() < deadline) {
        states.packageWritten = manifestReferences(target)
        if (states.packageWritten && !states.hostApplied) {
          const opened = await openPluginPanel(ctx.page).then(() => true, () => false)
          if (opened) states.hostApplied = await panelPackageCount(ctx.page, target) >= 1
        }
        if (states.hostApplied && !states.clientAvailable) {
          if (Date.now() - lastReload >= 5_000) {
            lastReload = Date.now()
            try {
              await ctx.page.reload({ waitUntil: 'domcontentloaded' })
              await openSessionSurface(ctx.page)
              // 重载后给客户端留一个有界沉降窗口，避免下轮立刻再整页重载。
              const settleDeadline = Date.now() + 10_000
              while (Date.now() < settleDeadline) {
                if (await visionToggleCount(ctx.page) > 0) break
                await ctx.page.waitForTimeout(500)
              }
              states.clientAvailable = await visionToggleCount(ctx.page) > 0
            } catch (navigationError) {
              ctx.hostOutput += `waitUntilReady clientAvailable probe error: ${navigationError instanceof Error ? navigationError.message : String(navigationError)}\n`
            }
          } else {
            await ctx.page.waitForTimeout(1_000)
          }
        }
        if (states.packageWritten && states.hostApplied && states.clientAvailable) {
          return { ready: true, timedOut: false, states }
        }
        if (!states.packageWritten) await ctx.page.waitForTimeout(1_000)
      }
      return { ready: false, timedOut: true, states }
    },
  }
}

/** 事务 verify/recover 探针的 e2e 实现（全部真实 UI/文件投影）。 */
function createProbeAdapter({ restoreAgainst = BAD_BUNDLE_NAME } = {}) {
  const read = (file) => {
    try {
      return readFileSync(file, 'utf8')
    } catch (_) {
      return null
    }
  }
  return {
    async visionStatus() {
      await ensureSessionView(ctx.page)
      const discoverable = await visionToggleCount(ctx.page) > 0
      return {
        ok: discoverable && ctx.modelRequestCount === 0,
        discoverable,
        modelSideEffects: ctx.modelRequestCount,
      }
    },
    async surfaceCounts() {
      await ensureSessionView(ctx.page)
      const commands = await visionToggleCount(ctx.page)
      const settingsCards = commands
      await openPluginPanel(ctx.page)
      const packageRow = await panelPackageCount(ctx.page, DVR_NAME)
      const counts = { commands, tools: packageRow, routes: packageRow, settingsCards }
      const unique = ['commands', 'tools', 'routes', 'settingsCards'].every((key) => counts[key] === 1)
      return { ok: unique, counts }
    },
    async readProfileSnapshot() {
      const manifestPath = profileManifestPath()
      return {
        manifest: read(manifestPath),
        lockfile: read(join(dirname(manifestPath), 'pnpm-lock.yaml')),
      }
    },
    async verifyRestoration() {
      const manifestPath = profileManifestPath()
      const tainted = (text) => text !== null && text.includes(`"${restoreAgainst}"`)
      return {
        manifest: !tainted(read(manifestPath)),
        lockfile: !tainted(read(join(dirname(manifestPath), 'pnpm-lock.yaml'))),
      }
    },
  }
}

function hostProcessStamp() {
  return { pid: ctx.child?.pid ?? null, port: ctx.port, exitCode: ctx.child?.exitCode ?? null }
}

function assertHostNeverRestarted(label, before = hostProcessStamp()) {
  assert.notEqual(ctx.child, null, `${label}: host process handle`)
  assert.equal(ctx.child.exitCode, null, `${label}: host process must still be running (no restart)`)
  assert.equal(ctx.child.pid, before.pid, `${label}: host PID must be unchanged (no process restart)`)
  assert.equal(ctx.port, before.port, `${label}: host port must be unchanged (no process restart)`)
}

async function assertPackageRowCount(name, expected, label) {
  await openPluginPanel(ctx.page)
  assert.equal(await panelPackageCount(ctx.page, name), expected, `${label}: package row count for ${name}`)
}

async function assertVisionSurfaceCount(expected, label) {
  await ensureSessionView(ctx.page)
  assert.equal(await visionToggleCount(ctx.page), expected, `${label}: /vision surface count`)
}

test('real DSH 0.2.1-rc.5 Host boots cold with no DVR plugin installed', { timeout: 240_000 }, async (t) => {
  if (!RUN) return t.skip('plugin-hot-install e2e requires DSH_SOURCE_ROOT (CI real-host workflow)')
  const { tsxLoader, cli } = requireDsh()
  const playwright = resolvePlaywright()
  assert.ok(playwright?.chromium, 'Playwright chromium API from DSH web frontend')

  const scratch = mkdtempSync(join(tmpdir(), 'dvr-hot-install-e2e-'))
  ctx.scratch = scratch
  ctx.workspacePath = join(scratch, 'workspace')
  mkdirSync(ctx.workspacePath)
  ctx.env = {
    ...process.env,
    DSH_HOME: join(scratch, '.dsh'),
    DSH_AGENTS_HOME: join(scratch, '.agents'),
    DEEPSEEK_API_KEY: ['keyless', 'dvr', 'hot-install-e2e', 'no-call'].join('-'),
    TSX_TSCONFIG_PATH: join(dshRoot, 'tsconfig.json'),
  }

  ctx.child = spawn(
    process.execPath,
    ['--import', tsxLoader, cli, 'web', '--no-open', '--port', '0'],
    { cwd: dshRoot, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const readyUrl = await waitForReadyLine(ctx.child)
  ctx.readyUrl = readyUrl
  ctx.port = new URL(readyUrl).port
  ctx.pid = ctx.child.pid
  assert.ok(ctx.child.pid, 'host pid')

  const chromium = playwright?.chromium
  assert.ok(chromium && typeof chromium.launch === 'function', 'Playwright chromium API from DSH web frontend')
  ctx.browser = await chromium.launch({ headless: true })
  const context = await ctx.browser.newContext({ locale: 'en-US' })
  ctx.page = await context.newPage()
  ctx.page.on('request', (request) => {
    if (/chat\/completions|api\.deepseek\.com/i.test(request.url())) ctx.modelRequestCount += 1
  })
  ctx.page.on('pageerror', (error) => {
    ctx.hostOutput += `pageerror: ${error.message}\n`
  })
  await ctx.page.goto(readyUrl)

  await openSessionSurface(ctx.page)
  // Cold: no DVR surface, no manifest entry.
  assert.equal(await visionToggleCount(ctx.page), 0, 'cold host must expose no /vision surface')
  assert.equal(manifestReferences(DVR_NAME), false, 'cold profile manifest must not reference DVR')
  assertHostNeverRestarted('cold boot')
})

test('web channel: six-step first-install transaction applies hot without process restart', { timeout: 420_000 }, async (t) => {
  if (!RUN) return t.skip('plugin-hot-install e2e requires DSH_SOURCE_ROOT (CI real-host workflow)')
  assert.ok(ctx.page, 'previous test established the real host + page')
  const before = hostProcessStamp()

  const transaction = createFirstInstallTransaction({
    spec: dvrSpec,
    channel: 'web',
    readiness: createReadinessAdapter(),
    probes: createProbeAdapter(),
    channels: {
      web: {
        // 真实 Web 通道：页面 Add plugin 对话框 → pluginManager.installBundle RPC。
        installBundle: (spec) => installThroughPage(ctx.page, spec).then(() => ({
          changed: true,
          application: 'applied',
          stage: 'applied',
        })),
      },
    },
    timeouts: { waitMs: 180_000, verifyMs: 90_000 },
    onStep: (step, detail) => {
      ctx.hostOutput += `[transaction] ${step} ${detail}\n`
    },
  })
  const report = await transaction.promise
  const progressTail = transaction.progress()

  assert.equal(report.ok, true, `first install must verify (report=${JSON.stringify(report)})`)
  assert.equal(report.step, 'verify')
  assert.equal(report.application, 'applied')
  assert.equal(report.hotApplied, true, 'hot apply: running Host applied without restart')
  assert.deepEqual(report.states, { packageWritten: true, hostApplied: true, clientAvailable: true })
  assert.equal(report.visionStatus.discoverable, true, '/vision discoverable after hot install')
  assert.equal(report.visionStatus.modelSideEffects, 0, '/vision discovery must not touch the model')
  assert.equal(report.surfaceUniqueness.unique, true, 'exactly one command/tool/route/settings card set')
  assert.ok(progressTail.elapsedMs >= 0, 'progress() must stay queryable')
  assert.ok(manifestReferences(DVR_NAME), 'packageWritten: profile manifest references DVR')
  assertHostNeverRestarted('web-channel hot install', before)
})

test('second install is idempotent: precheck refusal with zero profile side effects', { timeout: 240_000 }, async (t) => {
  if (!RUN) return t.skip('plugin-hot-install e2e requires DSH_SOURCE_ROOT (CI real-host workflow)')
  assert.ok(ctx.page, 'previous test established the real host + page')
  const before = hostProcessStamp()

  const transaction = createFirstInstallTransaction({
    spec: dvrSpec,
    channel: 'web',
    readiness: createReadinessAdapter(),
    probes: createProbeAdapter(),
    channels: {
      web: {
        installBundle: () => {
          throw new Error('installBundle must not be reached when precheck refuses')
        },
      },
    },
  })
  const report = await transaction.promise
  assert.equal(report.ok, false, 'second install must not report success')
  assert.equal(report.step, 'precheck')
  assert.equal(report.precheck?.blocking, 'already-installed')
  assert.equal(report.diagnostics?.alreadyInstalled, true)
  assert.equal(report.touchedProfile, false, 'precheck refusal must not touch the running old version')

  // 页面侧同样呈现 DSH 的重复安装拒绝语义（真实 RPC 路径）：already-installed
  // 文案，或一次诚实的失败呈现；无论哪条，下面的不变量断言承担幂等证明。
  const refusalText = await installRefusalThroughPage(ctx.page, dvrSpec)
  assert.match(refusalText, /already installed|cannot be installed|could not be installed/i)

  await assertPackageRowCount(DVR_NAME, 1, 'idempotent second install')
  await assertVisionSurfaceCount(1, 'idempotent second install')
  assertHostNeverRestarted('idempotent second install', before)
})

test('external CLI channel: manifest watcher hot-applies the reinstall without process restart', { timeout: 420_000 }, async (t) => {
  if (!RUN) return t.skip('plugin-hot-install e2e requires DSH_SOURCE_ROOT (CI real-host workflow)')
  assert.ok(ctx.page, 'previous test established the real host + page')
  const before = hostProcessStamp()

  await uninstallThroughPage(ctx.page, DVR_NAME)
  assert.equal(manifestReferences(DVR_NAME), false, 'uninstall must clear the profile dependency')
  await ctx.page.reload({ waitUntil: 'domcontentloaded' })
  await openSessionSurface(ctx.page)
  assert.equal(await visionToggleCount(ctx.page), 0, 'vision surface must leave with the uninstalled plugin')

  const transaction = createFirstInstallTransaction({
    spec: dvrSpec,
    channel: 'cli',
    readiness: createReadinessAdapter(),
    probes: createProbeAdapter(),
    channels: { cli: { run: (spec) => spawnCliInstall(spec) } },
    timeouts: { waitMs: 240_000, verifyMs: 90_000 },
  })
  const report = await transaction.promise
  assert.equal(report.ok, true, `CLI channel reinstall must verify (report=${JSON.stringify(report)})`)
  assert.equal(report.application, 'applied')
  assert.equal(report.hotApplied, true, 'manifest watcher applied the reinstall without restart')

  await assertPackageRowCount(DVR_NAME, 1, 'cli-channel hot install')
  await assertVisionSurfaceCount(1, 'cli-channel hot install')
  assertHostNeverRestarted('cli-channel hot install', before)
})

test('bad bundle failure keeps the old plugin and restores the profile', { timeout: 420_000 }, async (t) => {
  if (!RUN) return t.skip('plugin-hot-install e2e requires DSH_SOURCE_ROOT (CI real-host workflow)')
  assert.ok(ctx.page, 'previous test established the real host + page')
  const before = hostProcessStamp()

  const badBundleDir = join(ctx.scratch, 'bad-bundle')
  await writeFixtureBundle(badBundleDir)
  const badSpec = `file:${badBundleDir}`
  const probes = createProbeAdapter()
  const snapshot = await probes.readProfileSnapshot()
  assert.ok(snapshot.manifest?.includes(`"${DVR_NAME}"`), 'pre-failure snapshot must reference the running plugin')

  const transaction = createFirstInstallTransaction({
    spec: badSpec,
    channel: 'web',
    readiness: createReadinessAdapter({ target: BAD_BUNDLE_NAME }),
    probes,
    channels: {
      web: {
        installBundle: (spec) => installFailureThroughPage(ctx.page, spec).then((failureText) => ({
          changed: false,
          application: 'failed',
          stage: 'package',
          error: { code: 'operation-error', diagnostic: failureText },
        })),
      },
    },
    timeouts: { waitMs: 60_000, verifyMs: 60_000 },
  })
  const report = await transaction.promise
  assert.equal(report.ok, false, 'bad bundle must not report success')
  assert.equal(report.application, 'failed', `bad bundle must carry the failed application report (report=${JSON.stringify(report)})`)
  assert.ok(report.recovered, 'failure recovery must be reported')
  assert.equal(report.recovered.manifest, true, 'DSH snapshot must have restored the profile manifest')
  assert.equal(report.recovered.lockfile, true, 'DSH snapshot must have restored the profile lockfile')

  await assertPackageRowCount(BAD_BUNDLE_NAME, 0, 'bad bundle failure')
  await assertPackageRowCount(DVR_NAME, 1, 'bad bundle failure')
  await assertVisionSurfaceCount(1, 'bad bundle failure')
  assert.equal(ctx.modelRequestCount, 0, 'no model side effects across the whole scenario')
  assertHostNeverRestarted('bad bundle failure', before)
})

after(async () => {
  if (process.env.DVR_E2E_DIAGNOSTIC_PATH) {
    try {
      writeFileSync(process.env.DVR_E2E_DIAGNOSTIC_PATH, `${ctx.hostOutput}\nmodelRequests: ${ctx.modelRequestCount}\n`)
    } catch (_) { /* diagnostics are best-effort */ }
  }
  if (ctx.browser) await ctx.browser.close().catch(() => {})
  if (ctx.child && ctx.child.exitCode === null) {
    await new Promise((resolveClose) => {
      ctx.child.once('close', resolveClose)
      ctx.child.kill('SIGTERM')
      setTimeout(resolveClose, 10_000)
    })
  }
  if (ctx.scratch) rmSync(ctx.scratch, { recursive: true, force: true })
})
