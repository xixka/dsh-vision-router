export const DSH_SUPPORT_WINDOW = Object.freeze({
  dvrTrain: '2.3.x',
  minimum: '0.1.5',
  currentStable: '0.1.5-rc.3',
})

export const DSH_VERIFICATION_EVIDENCE = Object.freeze({
  exactStable: '0.1.5-rc.3',
  exactPreview: '0.2.1-rc.5',
  stableCanaryDistTag: 'latest',
  nextCanaryDistTag: 'next',
  previewCanaryDistTag: 'alpha',
})

/**
 * Hot-install / hot-upgrade support matrix (plan.md §6.2).
 *
 * The cells are honest by construction: unsupported operations never promise a
 * hot effect, and every supported completion is defined by observed evidence
 * (Host application, /vision discoverability, a bounded readiness check) —
 * never by a CLI or pnpm exit code.
 */
export const HOT_INSTALL_SUPPORT_MATRIX = Object.freeze({
  webInAppFirstInstall: Object.freeze({
    supported: true,
    requiresReadinessGate: false,
    completionEvidence: "Host ChangeResult application='applied', /vision discoverable, health check green",
  }),
  externalCliFirstInstall: Object.freeze({
    supported: true,
    requiresReadinessGate: true,
    completionEvidence: 'bounded readiness check (/vision status plus an image smoke); never the CLI exit code',
  }),
  externalCliOverwriteUpgrade: Object.freeze({
    supported: false,
    hotEffective: false,
    completionEvidence: 'honestly reported as not hot-effective; no silent restart',
  }),
  desktopElectron: Object.freeze({
    supported: false,
    hotInstallable: false,
    completionEvidence: 'not hot-installable; honest degraded path without a promise',
  }),
})

/**
 * Node major required for hot install specifically. Ordinary installation
 * keeps its own, looser floor (package.json engines), which must stay in
 * sync with the general support policy and is asserted in tests.
 */
export const HOT_INSTALL_NODE_MINIMUM = 24

export function supportWindowUpgradeAdvice(capabilities = {}) {
  const batchAttachments = capabilities?.batchAttachments
  const maxImageDimension = capabilities?.maxImageDimension

  if (batchAttachments === false || maxImageDimension === false) {
    return Object.freeze({
      level: 'required',
      code: 'HOST_BELOW_CURRENT_FLOOR_CAPABILITIES',
      message: `Host lacks attachment capabilities expected by DVR ${DSH_SUPPORT_WINDOW.dvrTrain}; the minimum supported Host is DSH ${DSH_SUPPORT_WINDOW.minimum}`,
    })
  }

  // Capability evidence is tri-state (`true` / `false` / `'unknown'`). Only an
  // explicit `true` proves the support floor, so a missing field, a wrong-typed
  // value and `'unknown'` all mean "not proven" rather than "capable".
  if (batchAttachments !== true || maxImageDimension !== true) {
    return Object.freeze({
      level: 'unknown',
      code: 'HOST_CURRENT_FLOOR_UNKNOWN',
      message: `DVR ${DSH_SUPPORT_WINDOW.dvrTrain} requires DSH ${DSH_SUPPORT_WINDOW.minimum} or newer, but this read-only probe cannot prove the relevant Host capabilities`,
    })
  }

  return Object.freeze({
    level: 'ok',
    code: 'HOST_CURRENT_FLOOR_CAPABLE',
    message: `Host exposes the attachment capabilities expected by the DVR ${DSH_SUPPORT_WINDOW.dvrTrain} support floor`,
  })
}

export function formatDshSupportWindowLines(capabilities = {}) {
  const advice = supportWindowUpgradeAdvice(capabilities)
  return Object.freeze([
    'DSH Host support window:',
    `  DVR train: ${DSH_SUPPORT_WINDOW.dvrTrain}`,
    `  minimum supported Host: ${DSH_SUPPORT_WINDOW.minimum}`,
    `  current stable Host: ${DSH_SUPPORT_WINDOW.currentStable}`,
    `  support floor: DVR ${DSH_SUPPORT_WINDOW.dvrTrain} -> DSH ${DSH_SUPPORT_WINDOW.minimum}`,
    'DSH compatibility verification evidence:',
    `  exact stable: ${DSH_VERIFICATION_EVIDENCE.exactStable}`,
    `  exact supported 0.2.x boundary: ${DSH_VERIFICATION_EVIDENCE.exactPreview}`,
    `  scheduled stable canary: npm dist-tag ${DSH_VERIFICATION_EVIDENCE.stableCanaryDistTag}`,
    `  scheduled next/rc canary: npm dist-tag ${DSH_VERIFICATION_EVIDENCE.nextCanaryDistTag}`,
    `  scheduled alpha/pre-release canary: npm dist-tag ${DSH_VERIFICATION_EVIDENCE.previewCanaryDistTag}`,
    `  upgrade advice: ${advice.level} (${advice.code}) — ${advice.message}`,
  ])
}
