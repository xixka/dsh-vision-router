import { installClientPresentationBoundary } from '../client-presentation-boundary.js'
import { installStrictLiveModelClientPrelude } from '../strict-live-model-client-prelude.js'
import { installWrapperScopeClientPrelude } from '../wrapper-scope-client-prelude.js'

export function installVisionModelPickerPresentation(ctx) {
  installClientPresentationBoundary(ctx)
  return ctx
}

export function installVisionModelPickerControls(ctx) {
  // The retired vision-model-visibility boundary (plan §5.2) no longer
  // filters DSH's stock /model picker: the Host catalog is presented as-is
  // and Vision mode is owned by the /vision command, not by hidden wrapper
  // routes. Live-model discovery stays additive and read-only.
  installStrictLiveModelClientPrelude(ctx)
  installWrapperScopeClientPrelude(ctx)
  return ctx
}

export function installVisionModelPicker(ctx) {
  installVisionModelPickerPresentation(ctx)
  installVisionModelPickerControls(ctx)
  return ctx
}
