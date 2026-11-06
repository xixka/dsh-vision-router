import { injectClientCarrierHtml, installClientScriptCarriers } from './client-script-carrier.js'
import {
  CLIENT_PRESENTATION_PRELUDE as BASE_CLIENT_PRESENTATION_PRELUDE,
} from './client-presentation-boundary-main.js'
import {
  installClientHostCompatibility,
} from './client-host-compat-prelude.js'

const CLIENT_PRESENTATION_MARK = 'data-vision-router-presentation-boundary'

const BITMAP_LIMITS_BASE = String.raw`      var maxBitmapSourceBytes = 64 * 1024 * 1024;
      var maxBitmapDimension = 10000;
      var maxBitmapPixels = 100000000;`

const BITMAP_LIMITS_HARDENED = String.raw`      var maxBitmapSourceBytes = 64 * 1024 * 1024;
      var maxBitmapDimension = 10000;
      var maxBitmapPixels = 100000000;
      // Source bytes are not a safe proxy for browser decode cost. A low-bit-depth
      // BMP can be only a few MiB on the clipboard and still expand to hundreds
      // of MiB once createImageBitmap/canvas materializes RGBA pixels.
      var maxBitmapDecodedBytes = 128 * 1024 * 1024;
      var maxBitmapBatchDecodedBytes = 256 * 1024 * 1024;`

const BITMAP_DECODE_ALLOWED_BASE = String.raw`      function bitmapDecodeAllowed(file, info) {
        if (!file || !info) return false;
        if (!Number.isFinite(file.size) || file.size <= 0 || file.size > maxBitmapSourceBytes) return false;
        if (!Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width <= 0 || info.height <= 0) return false;
        if (info.width > maxBitmapDimension || info.height > maxBitmapDimension) return false;
        return info.width * info.height <= maxBitmapPixels;
      }`

const BITMAP_DECODE_ALLOWED_HARDENED = String.raw`      function bitmapDecodeAllowed(file, info) {
        if (!file || !info) return false;
        if (!Number.isFinite(file.size) || file.size <= 0 || file.size > maxBitmapSourceBytes) return false;
        if (!Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width <= 0 || info.height <= 0) return false;
        if (info.width > maxBitmapDimension || info.height > maxBitmapDimension) return false;
        var pixels = info.width * info.height;
        if (!Number.isFinite(pixels) || pixels > maxBitmapPixels) return false;
        return pixels * 4 <= maxBitmapDecodedBytes;
      }`

const BITMAP_NORMALIZE_BASE = String.raw`      function normalizeFile(file) {
        return headType(file).then(function(info) {
          var detected = info && info.type;
          if (detected && supported[detected]) {
            return mediaType(file && file.type) === detected ? file : retypeFile(file, detected);
          }
          if (detected === 'image/bmp' && bitmapDecodeAllowed(file, info)) return bitmapToPng(file);
          return file;
        }, function(){ return file; });
      }`

const BITMAP_NORMALIZE_HARDENED = String.raw`      function normalizeFile(file, decodeBudget) {
        return headType(file).then(function(info) {
          var detected = info && info.type;
          if (detected && supported[detected]) {
            return mediaType(file && file.type) === detected ? file : retypeFile(file, detected);
          }
          if (detected === 'image/bmp' && bitmapDecodeAllowed(file, info)) {
            var decodedBytes = info.width * info.height * 4;
            if (decodeBudget && decodedBytes > decodeBudget.remaining) return file;
            if (decodeBudget) decodeBudget.remaining -= decodedBytes;
            return bitmapToPng(file);
          }
          return file;
        }, function(){ return file; });
      }`

const BITMAP_BATCH_BASE = String.raw`        Promise.all(files.map(function(file){
          return needsInspection(file)
            ? normalizeFile(file).catch(function(){ return file; })
            : Promise.resolve(file);
        })).then(function(normalized) {
          return dedupeBatch(normalized).then(function(deduped) {
            dispatchReplay(target, replayEvent(deduped, textEntries), fallback);
          });
        }, function() {
          dispatchReplay(target, fallback, null);
        });`

const BITMAP_BATCH_HARDENED = String.raw`        // Decode BMPs serially under one paste-scoped RGBA budget. This keeps peak
        // browser memory bounded before the Host attachment governor gets a turn.
        var decodeBudget = { remaining: maxBitmapBatchDecodedBytes };
        var normalized = [];
        var normalizeChain = Promise.resolve();
        files.forEach(function(file){
          normalizeChain = normalizeChain.then(function(){
            if (!needsInspection(file)) {
              normalized.push(file);
              return undefined;
            }
            return normalizeFile(file, decodeBudget).then(function(value){
              normalized.push(value);
            }, function(){
              normalized.push(file);
            });
          });
        });
        normalizeChain.then(function() {
          return dedupeBatch(normalized).then(function(deduped) {
            dispatchReplay(target, replayEvent(deduped, textEntries), fallback);
          });
        }, function() {
          dispatchReplay(target, fallback, null);
        });`

function replaceAllRequired(source, anchor, replacement, label) {
  const parts = source.split(anchor)
  const count = parts.length - 1
  if (count === 0) throw new Error(`${label} transform anchor missing`)
  return parts.join(replacement)
}

export function transformBitmapDecodeBudget(source = BASE_CLIENT_PRESENTATION_PRELUDE) {
  let output = String(source)
  // The legacy prelude intentionally contains more than one clipboard owner.
  // Harden every exact owner, not merely the first string match, so one stale
  // path cannot retain unbounded parallel bitmap decoding.
  output = replaceAllRequired(output, BITMAP_LIMITS_BASE, BITMAP_LIMITS_HARDENED, 'bitmap limits')
  output = replaceAllRequired(
    output,
    BITMAP_DECODE_ALLOWED_BASE,
    BITMAP_DECODE_ALLOWED_HARDENED,
    'bitmap decoded-byte admission',
  )
  output = replaceAllRequired(output, BITMAP_NORMALIZE_BASE, BITMAP_NORMALIZE_HARDENED, 'bitmap normalization')
  output = replaceAllRequired(output, BITMAP_BATCH_BASE, BITMAP_BATCH_HARDENED, 'bitmap batch serialization')
  return output
}

export const CLIENT_PRESENTATION_PRELUDE = transformBitmapDecodeBudget()

export function injectClientPresentationBoundary(html) {
  return injectClientCarrierHtml(html, CLIENT_PRESENTATION_MARK, CLIENT_PRESENTATION_PRELUDE)
}

export function installClientPresentationBoundary(ctx) {
  installClientScriptCarriers(ctx, {
    marker: CLIENT_PRESENTATION_MARK,
    prelude: CLIENT_PRESENTATION_PRELUDE,
    label: 'vision-router: client presentation boundary',
    injectHtml: injectClientPresentationBoundary,
  })
  // Keep Host-version compatibility in its own capability-detected prelude.
  // This lets the large legacy client factory stay byte-stable while alpha/new
  // Hosts expose their current Remote/Connection seams to it.
  installClientHostCompatibility(ctx)
}
