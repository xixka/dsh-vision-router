/**
 * Onboarding boundary after the composer Vision toggle retirement (plan §5.2).
 *
 * Vision mode is taught — and controlled — exclusively through the /vision
 * command: `/vision on`, `/vision off`, `/vision status`, and
 * `/vision <question>` with an attached image. The walkthrough copy that used
 * to highlight the retired button now lives in the settings dictionaries
 * (src/lib/client.js, patched by settings-ia-client-prelude.js) and points at
 * the command instead of any composer control, so this installer deliberately
 * registers no browser prelude and injects no guide-highlight script.
 */
export function installVisionOnboarding(ctx) {
  // Intentionally inert: no guide highlight, no composer button teaching.
  return ctx
}
