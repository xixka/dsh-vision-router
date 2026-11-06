import { injectClientCarrierHtml, installClientScriptCarriers } from './client-script-carrier.js'
const CLIENT_PRESENTATION_MARK = 'data-vision-router-presentation-boundary'
/**
 * Browser prelude for the compatibility surface still owned by the
 * hand-maintained 1.7.x client factory.
 *
 * 1. DSH rc.8 made @deepseek-ai/dsh-client-ui-attachment a dynamic
 *    presentation plugin and deliberately stopped exporting its React
 *    implementation as package values. Vision Router therefore supplies its own
 *    narrow ImageGallery value only to its own legacy factory.
 *
 * 2. The composer-side Vision mode toggle is retired (plan §5.2): Vision mode
 *    is controlled exclusively by the /vision command. This boundary keeps only
 *    the generic image surfaces — the ImageGallery value, the presented-card
 *    focus helper, and the #138 clipboard image paste compatibility — and
 *    deliberately registers no composer button, state chip, highlight, locale
 *    override, or model-switch linkage.
 *
 * Rewriting the entire generated client artifact for either concern would
 * create a much larger compatibility diff. This boundary intercepts only the
 * dsh-vision-router factory before it reaches the DSH module table and survives
 * rc.8's queue -> live loader replacement.
 */
export const CLIENT_PRESENTATION_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET = 'dsh-vision-router';
  var LEGACY_ATTACHMENT_VALUE = '@deepseek-ai/dsh-client-ui-attachment';

  // #271 pre-release regression fence: #210 made the walkthrough runtime lazy,
  // but its document.body MutationObserver still invalidates the 250ms target
  // cache for every class mutation. DSH toggles transient scroll/shadow classes
  // while the settings modal moves, turning an otherwise cheap rAF scroll frame
  // back into several querySelectorAll passes + forced layout. Keep the observer
  // fully authoritative for child-list and aria mutations, but suppress class-
  // only batches for the one exact Vision Router guide observer. Normal scroll
  // frames will still refresh the cached geometry at the existing 250ms bound.
  function installGuideMutationFence() {
    var NativeObserver = window.MutationObserver;
    var doc = window.document;
    if (
      typeof NativeObserver !== 'function' ||
      NativeObserver.__visionRouterGuideMutationFence ||
      !doc || !doc.body ||
      typeof Proxy !== 'function'
    ) return;

    function isGuideObservation(callback, target, options) {
      if (!callback || callback.name !== 'resolveSync') return false;
      if (
        target !== doc.body || !options ||
        options.childList !== true || options.subtree !== true || options.attributes !== true
      ) return false;
      var filter = Array.isArray(options.attributeFilter) ? options.attributeFilter.slice().sort() : [];
      return filter.length === 3 &&
        filter[0] === 'aria-expanded' && filter[1] === 'aria-hidden' && filter[2] === 'class';
    }

    function withoutTransientClassMutations(records) {
      if (!records || typeof records.filter !== 'function') return records;
      return records.filter(function(record){
        return !(record && record.type === 'attributes' && record.attributeName === 'class');
      });
    }

    var WrappedObserver = new Proxy(NativeObserver, {
      construct: function(Target, args) {
        var callback = args && args[0];
        var guideObservation = false;
        var wrappedObserver;
        var nativeObserver = new Target(function(records) {
          var next = guideObservation ? withoutTransientClassMutations(records) : records;
          if (!next || next.length === 0) return;
          return callback(next, wrappedObserver || nativeObserver);
        });
        wrappedObserver = new Proxy(nativeObserver, {
          get: function(target, property) {
            if (property === 'observe') {
              return function(node, options) {
                guideObservation = isGuideObservation(callback, node, options);
                return target.observe(node, options);
              };
            }
            if (property === 'takeRecords') {
              return function() {
                var records = target.takeRecords();
                return guideObservation ? withoutTransientClassMutations(records) : records;
              };
            }
            var value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
        return wrappedObserver;
      }
    });
    Object.defineProperty(WrappedObserver, '__visionRouterGuideMutationFence', { value: true });
    window.MutationObserver = WrappedObserver;
  }

  function createPresentation(React) {
    function PresentedImage(props) {
      var attachment = props.attachment;
      var load = props.load;
      var labels = props.labels;
      var tile = props.tile === true;
      var state = React.useState(null);
      var src = state[0];
      var setSrc = state[1];
      var failedState = React.useState(false);
      var failed = failedState[0];
      var setFailed = failedState[1];
      var attemptState = React.useState(0);
      var attempt = attemptState[0];
      var setAttempt = attemptState[1];
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];

      React.useEffect(function(){
        var live = true;
        setSrc(null);
        setFailed(false);
        Promise.resolve().then(function(){ return load(attachment); }).then(
          function(url){ if (live) setSrc(url); },
          function(){ if (live) setFailed(true); }
        );
        return function(){ live = false; };
      }, [attachment, load, attempt]);

      React.useEffect(function(){
        if (!open || typeof document === 'undefined') return undefined;
        var onKeyDown = function(event){ if (event && event.key === 'Escape') setOpen(false); };
        document.addEventListener('keydown', onKeyDown);
        return function(){ document.removeEventListener('keydown', onKeyDown); };
      }, [open]);

      var label = attachment && attachment.name ? attachment.name : labels.image;
      var box = tile
        ? { width: 64, height: 64 }
        : { maxWidth: 240, maxHeight: 240 };
      var frameStyle = Object.assign({
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-3)',
        padding: 0,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: src ? 'zoom-in' : failed ? 'pointer' : 'default'
      }, box);

      if (failed) {
        return React.createElement('button', {
          type: 'button',
          title: labels.loadFailed,
          onClick: function(){ setAttempt(function(value){ return value + 1; }); },
          style: Object.assign({}, frameStyle, {
            minWidth: tile ? 64 : 120,
            minHeight: tile ? 64 : 72,
            color: 'var(--dsw-alias-label-tertiary)',
            font: 'inherit',
            fontSize: 12,
            padding: 8
          })
        }, labels.loadFailed);
      }

      var thumb = React.createElement('button', {
        type: 'button',
        title: labels.open,
        'aria-label': labels.openNamed(label),
        disabled: !src,
        onClick: function(){ if (src) setOpen(true); },
        style: frameStyle
      }, src
        ? React.createElement('img', {
            src: src,
            alt: label,
            style: tile
              ? { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }
              : { maxWidth: 240, maxHeight: 240, width: 'auto', height: 'auto', display: 'block' }
          })
        : React.createElement('span', {
            style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, padding: 10 }
          }, labels.loading)
      );

      if (!open || !src) return thumb;
      var overlay = React.createElement('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': labels.lightbox.dialog,
        onClick: function(event){ if (event.target === event.currentTarget) setOpen(false); },
        style: {
          position: 'fixed', inset: 0, zIndex: 11000, background: '#000b',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          boxSizing: 'border-box'
        }
      },
        React.createElement('img', {
          src: src,
          alt: label,
          style: { maxWidth: '92vw', maxHeight: '88vh', objectFit: 'contain', borderRadius: 8 }
        }),
        React.createElement('button', {
          type: 'button',
          'aria-label': labels.lightbox.close,
          title: labels.lightbox.close,
          onClick: function(){ setOpen(false); },
          style: {
            position: 'fixed', top: 16, right: 18, width: 36, height: 36,
            borderRadius: 18, border: '1px solid #ffffff55', background: '#111c',
            color: '#fff', font: 'inherit', fontSize: 22, cursor: 'pointer'
          }
        }, '×')
      );
      return React.createElement(React.Fragment, null, thumb, overlay);
    }

    function ImageGallery(props) {
      var images = Array.isArray(props.images) ? props.images : [];
      if (images.length === 0) return null;
      var tile = images.length > 1;
      return React.createElement('div', {
        style: {
          display: 'flex', flexWrap: 'wrap', gap: 6,
          justifyContent: props.align === 'end' ? 'flex-end' : 'flex-start',
          alignItems: 'flex-start', maxWidth: '100%'
        }
      }, images.map(function(image, index){
        var attachment = image && image.attachment;
        var key = attachment && attachment.attachmentId
          ? String(attachment.attachmentId) + ':' + index
          : String(index);
        return React.createElement(PresentedImage, {
          key: key,
          attachment: attachment,
          load: props.load,
          labels: props.labels,
          tile: tile
        });
      }));
    }

    return { ImageGallery: ImageGallery };
  }

  // #138 Windows clipboard compatibility: desktop clipboards may expose an
  // image as BMP/empty MIME, or may declare a supported MIME that disagrees with
  // the actual bytes (for example .png + image/png carrying JPEG bytes). DSH
  // validates the declaration before/while creating the draft, and its local
  // attachment store rejects declaration/content mismatches. Inspect image-like
  // clipboard files by magic bytes before Lexical's CRITICAL paste handler sees
  // them; canonical files keep the original File object and are never re-encoded.
  function installClipboardImagePasteCompat(ctx) {
    if (!ctx || typeof ctx.effect !== 'function') return;
    ctx.effect(function() {
      var doc = window.document;
      if (!doc || typeof doc.addEventListener !== 'function') return function(){};
      if (
        typeof window.DataTransfer !== 'function' ||
        typeof window.ClipboardEvent !== 'function' ||
        typeof window.File !== 'function' ||
        typeof WeakSet !== 'function'
      ) return function(){};

      var replayed = new WeakSet();
      var supported = {
        'image/png': true,
        'image/jpeg': true,
        'image/webp': true,
        'image/gif': true
      };
      var bitmapTypes = {
        'image/bmp': true,
        'image/x-bmp': true,
        'image/x-ms-bmp': true
      };

      function mediaType(value) {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
      }

      function imageLikeName(value) {
        return typeof value === 'string' && /\.(?:png|jpe?g|webp|gif|bmp|dib)$/i.test(value.trim());
      }

      function needsInspection(file) {
        if (!file) return false;
        var type = mediaType(file.type);
        return type === '' || type.indexOf('image/') === 0 || imageLikeName(file.name);
      }

      var normalizedBitmapFiles = new WeakSet();
      var maxExactDedupeBytes = 8 * 1024 * 1024;
      var maxVisualDedupeSourceBytes = 16 * 1024 * 1024;
      var maxVisualDedupeDimension = 4096;
      var maxVisualDedupePixels = 9000000;
      var visualDedupeTile = 256;

      function supportedImage(file) {
        return !!file && supported[mediaType(file.type)] === true;
      }

      function syntheticClipboardName(name) {
        var value = typeof name === 'string' ? name.trim() : '';
        if (value === '') return true;
        return /^(?:image|clipboard)(?:[ _-]?\d+)?\.(?:png|jpe?g|webp|gif)$/i.test(value);
      }

      function syntheticClipboardFile(file) {
        return !!file && (normalizedBitmapFiles.has(file) || syntheticClipboardName(file.name));
      }

      function hasDedupeSignal(files) {
        var images = files.filter(supportedImage);
        for (var i = 0; i < images.length; i += 1) {
          for (var j = i + 1; j < images.length; j += 1) {
            var left = images[i];
            var right = images[j];
            if (
              (Number.isFinite(left.size) && left.size > 0 && left.size === right.size) ||
              (mediaType(left.type) === mediaType(right.type) &&
                (syntheticClipboardFile(left) || syntheticClipboardFile(right)))
            ) return true;
          }
        }
        return false;
      }

      function bytesOf(file) {
        if (!file || typeof file.arrayBuffer !== 'function') return Promise.resolve(undefined);
        try {
          return Promise.resolve(file.arrayBuffer()).then(function(buffer) {
            return new Uint8Array(buffer);
          }, function(){ return undefined; });
        } catch (_) {
          return Promise.resolve(undefined);
        }
      }

      function sameBytes(left, right) {
        if (
          !left || !right ||
          !Number.isFinite(left.size) || left.size <= 0 || left.size !== right.size ||
          left.size > maxExactDedupeBytes
        ) return Promise.resolve(false);
        return Promise.all([bytesOf(left), bytesOf(right)]).then(function(values) {
          var a = values[0];
          var b = values[1];
          if (!a || !b || a.length !== b.length) return false;
          for (var i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
          return true;
        }, function(){ return false; });
      }

      function visualPairAllowed(left, right) {
        if (!left || !right) return false;
        if (mediaType(left.type) !== 'image/png' || mediaType(right.type) !== 'image/png') return false;
        if (!(syntheticClipboardFile(left) || syntheticClipboardFile(right))) return false;
        return Number.isFinite(left.size) && left.size > 0 && left.size <= maxVisualDedupeSourceBytes &&
          Number.isFinite(right.size) && right.size > 0 && right.size <= maxVisualDedupeSourceBytes;
      }

      function closeBitmap(bitmap) {
        try { if (bitmap && typeof bitmap.close === 'function') bitmap.close(); } catch (_) {}
      }

      function visualInfoAllowed(leftInfo, rightInfo) {
        if (!leftInfo || !rightInfo || leftInfo.type !== 'image/png' || rightInfo.type !== 'image/png') return false;
        var width = leftInfo.width;
        var height = leftInfo.height;
        return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 &&
          width === rightInfo.width && height === rightInfo.height &&
          width <= maxVisualDedupeDimension && height <= maxVisualDedupeDimension &&
          width * height <= maxVisualDedupePixels;
      }

      function bitmapPixelsMatch(left, right) {
        if (!visualPairAllowed(left, right) || typeof window.createImageBitmap !== 'function') return Promise.resolve(false);
        return Promise.all([headType(left), headType(right)]).then(function(infos) {
          if (!visualInfoAllowed(infos[0], infos[1])) return false;
          return Promise.resolve(window.createImageBitmap(left)).then(function(leftBitmap) {
          return Promise.resolve(window.createImageBitmap(right)).then(function(rightBitmap) {
            try {
              var width = leftBitmap && leftBitmap.width;
              var height = leftBitmap && leftBitmap.height;
              if (
                !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
                width !== rightBitmap.width || height !== rightBitmap.height ||
                width > maxVisualDedupeDimension || height > maxVisualDedupeDimension ||
                width * height > maxVisualDedupePixels
              ) return false;
              var canvas = doc.createElement('canvas');
              var context = canvas.getContext && canvas.getContext('2d', { willReadFrequently: true });
              if (!context || typeof context.drawImage !== 'function' || typeof context.getImageData !== 'function') return false;
              for (var y = 0; y < height; y += visualDedupeTile) {
                for (var x = 0; x < width; x += visualDedupeTile) {
                  var tileWidth = Math.min(visualDedupeTile, width - x);
                  var tileHeight = Math.min(visualDedupeTile, height - y);
                  canvas.width = tileWidth;
                  canvas.height = tileHeight;
                  context.drawImage(leftBitmap, x, y, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight);
                  var leftPixels = context.getImageData(0, 0, tileWidth, tileHeight).data;
                  context.drawImage(rightBitmap, x, y, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight);
                  var rightPixels = context.getImageData(0, 0, tileWidth, tileHeight).data;
                  if (!leftPixels || !rightPixels || leftPixels.length !== rightPixels.length) return false;
                  for (var i = 0; i < leftPixels.length; i += 1) {
                    if (leftPixels[i] !== rightPixels[i]) return false;
                  }
                }
              }
              return true;
            } catch (_) {
              return false;
            } finally {
              closeBitmap(leftBitmap);
              closeBitmap(rightBitmap);
            }
          }, function() {
            closeBitmap(leftBitmap);
            return false;
          });
          }, function(){ return false; });
        }, function(){ return false; });
      }

      function duplicatePair(left, right) {
        if (!supportedImage(left) || !supportedImage(right)) return Promise.resolve(false);
        return sameBytes(left, right).then(function(exact) {
          return exact ? true : bitmapPixelsMatch(left, right);
        }, function(){ return false; });
      }

      function preferredDuplicate(left, right) {
        if (syntheticClipboardFile(left) && !syntheticClipboardFile(right)) return right;
        return left;
      }

      function dedupeBatch(files) {
        if (!hasDedupeSignal(files)) return Promise.resolve(files);
        var kept = [];
        var chain = Promise.resolve();
        files.forEach(function(file) {
          chain = chain.then(function() {
            var index = 0;
            function compareNext() {
              if (index >= kept.length) {
                kept.push(file);
                return Promise.resolve();
              }
              var current = index;
              index += 1;
              return duplicatePair(kept[current], file).then(function(duplicate) {
                if (!duplicate) return compareNext();
                kept[current] = preferredDuplicate(kept[current], file);
                return undefined;
              }, function(){ return compareNext(); });
            }
            return compareNext();
          });
        });
        return chain.then(function(){ return kept; }, function(){ return files; });
      }

      function composerEditable(target) {
        var element = target && target.nodeType === 1
          ? target
          : target && target.parentElement;
        if (!element || typeof element.closest !== 'function') return null;
        var editable = element.closest('[data-composer-input]');
        if (!editable || typeof editable.closest !== 'function') return null;
        return editable.closest('[data-composer-card]') ? editable : null;
      }

      function snapshotText(data) {
        var entries = [];
        var types = data && data.types ? Array.from(data.types) : [];
        types.forEach(function(type) {
          if (type === 'Files') return;
          try {
            var value = data.getData(type);
            if (typeof value === 'string' && value !== '') entries.push([type, value]);
          } catch (_) {}
        });
        return entries;
      }

      var maxBitmapSourceBytes = 64 * 1024 * 1024;
      var maxBitmapDimension = 10000;
      var maxBitmapPixels = 100000000;

      function sniffImageInfo(bytes) {
        if (!bytes || bytes.length < 2) return undefined;
        if (
          bytes.length >= 8 &&
          bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
          bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
        ) {
          if (bytes.length < 24 || typeof DataView !== 'function') return { type: 'image/png' };
          try {
            var pngView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            return {
              type: 'image/png',
              width: pngView.getUint32(16, false),
              height: pngView.getUint32(20, false)
            };
          } catch (_) {
            return { type: 'image/png' };
          }
        }
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image/jpeg' };
        if (
          bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
          bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
) return { type: 'image/gif' };
        if (
          bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
) return { type: 'image/webp' };
        if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
          if (bytes.length < 26 || typeof DataView !== 'function') return { type: 'image/bmp' };
          try {
            var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            var dibSize = bytes.length >= 18 ? view.getUint32(14, true) : 0;
            if (dibSize < 40) return { type: 'image/bmp' };
            return {
              type: 'image/bmp',
              width: Math.abs(view.getInt32(18, true)),
              height: Math.abs(view.getInt32(22, true))
            };
          } catch (_) {
            return { type: 'image/bmp' };
          }
        }
        return undefined;
      }

      function headType(file) {
        try {
          var blob = typeof file.slice === 'function' ? file.slice(0, 32) : file;
          if (!blob || typeof blob.arrayBuffer !== 'function') return Promise.resolve(undefined);
          return Promise.resolve(blob.arrayBuffer()).then(function(buffer) {
            return sniffImageInfo(new Uint8Array(buffer));
          }, function(){ return undefined; });
        } catch (_) {
          return Promise.resolve(undefined);
        }
      }

      function fileNameFor(type, original) {
        var name = typeof original === 'string' ? original : '';
        var suffix = type === 'image/png' ? '.png'
          : type === 'image/jpeg' ? '.jpg'
          : type === 'image/gif' ? '.gif'
          : type === 'image/webp' ? '.webp'
          : '';
        if (!name) return suffix ? 'clipboard' + suffix : 'clipboard-image';
        if (!suffix) return name;
        return /\.(?:png|jpe?g|webp|gif|bmp|dib)$/i.test(name)
          ? name.replace(/\.(?:png|jpe?g|webp|gif|bmp|dib)$/i, suffix)
          : name;
      }

      function retypeFile(file, type) {
        return new window.File([file], fileNameFor(type, file && file.name), {
          type: type,
          lastModified: file && Number.isFinite(file.lastModified) ? file.lastModified : Date.now()
        });
      }

      function bitmapDecodeAllowed(file, info) {
        if (!file || !info) return false;
        if (!Number.isFinite(file.size) || file.size <= 0 || file.size > maxBitmapSourceBytes) return false;
        if (!Number.isFinite(info.width) || !Number.isFinite(info.height) || info.width <= 0 || info.height <= 0) return false;
        if (info.width > maxBitmapDimension || info.height > maxBitmapDimension) return false;
        return info.width * info.height <= maxBitmapPixels;
      }

      function bitmapToPng(file) {
        if (typeof window.createImageBitmap !== 'function') return Promise.reject(new Error('createImageBitmap unavailable'));
        return Promise.resolve(window.createImageBitmap(file)).then(function(bitmap) {
          return new Promise(function(resolve, reject) {
            var close = function() {
              try { if (bitmap && typeof bitmap.close === 'function') bitmap.close(); } catch (_) {}
            };
            try {
              var canvas = doc.createElement('canvas');
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
              var context = canvas.getContext && canvas.getContext('2d');
              if (!context || typeof context.drawImage !== 'function' || typeof canvas.toBlob !== 'function') {
                close();
                reject(new Error('canvas PNG conversion unavailable'));
                return;
              }
              context.drawImage(bitmap, 0, 0);
              canvas.toBlob(function(blob) {
                close();
                if (!blob) {
                  reject(new Error('canvas PNG conversion failed'));
                  return;
                }
                try {
                  var normalized = new window.File([blob], fileNameFor('image/png', file && file.name), {
                    type: 'image/png',
                    lastModified: file && Number.isFinite(file.lastModified) ? file.lastModified : Date.now()
                  });
                  normalizedBitmapFiles.add(normalized);
                  resolve(normalized);
                } catch (error) {
                  reject(error);
                }
              }, 'image/png');
            } catch (error) {
              close();
              reject(error);
            }
          });
        });
      }

      function normalizeFile(file) {
        return headType(file).then(function(info) {
          var detected = info && info.type;
          if (detected && supported[detected]) {
            return mediaType(file && file.type) === detected ? file : retypeFile(file, detected);
          }
          if (detected === 'image/bmp' && bitmapDecodeAllowed(file, info)) return bitmapToPng(file);
          return file;
        }, function(){ return file; });
      }

      function replayEvent(files, textEntries) {
        try {
          var transfer = new window.DataTransfer();
          if (!transfer.items || typeof transfer.items.add !== 'function') return null;
          files.forEach(function(file){ transfer.items.add(file); });
          textEntries.forEach(function(entry){ transfer.setData(entry[0], entry[1]); });
          var event = new window.ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
            composed: true
          });
          return event && event.clipboardData === transfer ? event : null;
        } catch (_) {
          return null;
        }
      }

      function dispatchReplay(target, preferred, fallback) {
        var event = preferred || fallback;
        if (!event || !target || typeof target.dispatchEvent !== 'function') return;
        replayed.add(event);
        try {
          target.dispatchEvent(event);
        } catch (_) {
          if (fallback && fallback !== event) {
            replayed.add(fallback);
            try { target.dispatchEvent(fallback); } catch (_) {}
          }
        }
      }

      function onPaste(event) {
        if (!event || replayed.has(event)) return;
        var target = composerEditable(event.target);
        if (!target) return;
        var data = event.clipboardData;
        if (!data || !data.items) return;
        var files = Array.from(data.items)
          .filter(function(item){ return item && item.kind === 'file'; })
          .map(function(item){ try { return item.getAsFile(); } catch (_) { return null; } })
          .filter(function(file){ return !!file; });
        if (!files.some(needsInspection) && !hasDedupeSignal(files)) return;

        // Snapshot every string flavor while the trusted paste event still owns
        // a readable clipboard data store. Build a known-good fallback replay
        // before canceling the original event so conversion failure never eats
        // the user's text or files.
        var textEntries = snapshotText(data);
        var fallback = replayEvent(files, textEntries);
        if (!fallback) return;

        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

        Promise.all(files.map(function(file){
          return needsInspection(file)
            ? normalizeFile(file).catch(function(){ return file; })
            : Promise.resolve(file);
        })).then(function(normalized) {
          return dedupeBatch(normalized).then(function(deduped) {
            dispatchReplay(target, replayEvent(deduped, textEntries), fallback);
          });
        }, function() {
          dispatchReplay(target, fallback, null);
        });
      }

      doc.addEventListener('paste', onPaste, true);
      return function(){ doc.removeEventListener('paste', onPaste, true); };
    }, 'vision-router: clipboard image paste normalization');
  }

  // A fresh presented image below the reader is the same as not being shown. Centre only that
  // card; visible cards and history on either side of a restored viewport stay untouched.
  function focusPresentedCard(node, viewportHeight) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return false;
    var rect = node.getBoundingClientRect();
    if (rect.top <= viewportHeight) return false;
    var scroller = node.parentElement;
    var hops = 0;
    while (scroller && hops < 20) {
      var style = typeof getComputedStyle === 'function' ? getComputedStyle(scroller) : undefined;
      var scrollable = /(auto|scroll)/.test(String(style && style.overflowY)) &&
        scroller.scrollHeight > scroller.clientHeight + 4;
      if (scrollable) {
        var box = scroller.getBoundingClientRect();
        scroller.scrollTop += (rect.top - box.top) - (box.height / 2 - rect.height / 2);
        return true;
      }
      scroller = scroller.parentElement;
      hops += 1;
    }
    return false;
  }

  // New Hosts expose phase; supported DSH 0.1.5 instead marks settled blocks as
  // 'tool-result'. Normalize the [phase, block kind] tuple without raising the Host floor.
  function isPresentedResultState(state) {
    var phase = state && state[0];
    return phase !== undefined ? phase === 'result' : !!state && state[1] === 'tool-result';
  }

  // Restored history starts settled on both sides of the comparison. Only a live transition into
  // an image-bearing result is fresh presentation.
  function shouldFocusPresentedCard(previousState, state, imageCount) {
    return imageCount > 0 &&
      isPresentedResultState(state) &&
      !isPresentedResultState(previousState);
  }

  try {
    globalThis.__dvrPresentFocus = function (node, previousState, state, imageCount) {
      return shouldFocusPresentedCard(previousState, state, imageCount) &&
        focusPresentedCard(node, globalThis.innerHeight || 0);
    };
  } catch (_) {}

  function decorateVisionRouterPlugin(plugin) {
    if (!plugin || typeof plugin !== 'object' || typeof plugin.apply !== 'function') return plugin;
    if (plugin.apply.__visionRouterPasteCompat) return plugin;
    var originalApply = plugin.apply;
    function apply(ctx) {
      var result = originalApply.apply(this, arguments);
      try {
        installClipboardImagePasteCompat(ctx);
      } catch (error) {
        try { console.warn('vision-router: failed to install clipboard image paste compatibility', error); } catch (_) {}
      }
      return result;
    }
    try { Object.defineProperty(apply, '__visionRouterPasteCompat', { value: true }); } catch (_) {}
    plugin.apply = apply;
    return plugin;
  }

  function patchLoader(loader) {
    if (!loader || (typeof loader !== 'object' && typeof loader !== 'function')) return;

    if (typeof loader.load === 'function' && !loader.load.__visionRouterPresentationBoundary) {
      var original = loader.load;
      function load(spec) {
        if (spec && spec.id === TARGET && typeof spec.factory === 'function') {
          var factory = spec.factory;
          spec = Object.assign({}, spec, {
            factory: function(require) {
              var React = require('react');
              var presentation = createPresentation(React);
              function scopedRequire(id) {
                if (id === LEGACY_ATTACHMENT_VALUE) return presentation;
                return require(id);
              }
              return decorateVisionRouterPlugin(factory(scopedRequire));
            }
          });
        }
        return original.call(this, spec);
      }
      Object.defineProperty(load, '__visionRouterPresentationBoundary', { value: true });
      loader.load = load;
    }

    // rc.8's parser installs a queue-mode facade first. When the Web shell
    // later calls create(), ClientModuleSystem switches that *same object* to
    // live mode by assigning a brand-new loader.load function. That assignment
    // necessarily erases every queue-time wrapper. Wrap create itself so the
    // boundary is re-applied immediately after the official queue -> live
    // transition and before lazy third-party bundles can register.
    if (typeof loader.create === 'function' && !loader.create.__visionRouterPresentationBoundary) {
      var originalCreate = loader.create;
      function create() {
        var result = originalCreate.apply(this, arguments);
        patchLoader(loader);
        return result;
      }
      Object.defineProperty(create, '__visionRouterPresentationBoundary', { value: true });
      loader.create = create;
    }
  }

  function install() {
    installGuideMutationFence();
    if (window.__ModuleLoader__) {
      patchLoader(window.__ModuleLoader__);
      return;
    }
    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
    if (descriptor && descriptor.configurable === false) return;
    var stored;
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true,
      enumerable: true,
      get: function(){ return stored; },
      set: function(value) {
        stored = value;
        patchLoader(value);
        Object.defineProperty(window, '__ModuleLoader__', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: stored
        });
      }
    });
  }

  install();
})();`

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
}
