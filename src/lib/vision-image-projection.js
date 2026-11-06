// Per-route temporary image projection (plan §4.4 preferred scheme, P2).
//
// Host contracts verified against the DSH 0.2.1-rc.5 reference source
// (tag dsh-v0.2.1-rc.5):
// - ImageBlock is `{ type: 'image', attachment: ImageAttachmentRef,
//   offloaded?: true }` and FileBlock is `{ type: 'file', attachment }`
//   (packages/llm/llm/src/types.ts). `ImageBlock.offloaded` is derived from a
//   durable image-budget decision: every route renders such occurrences as
//   placeholder text instead of image bytes. It is therefore a permanent,
//   cross-route surface fact owned by the Host — DVR must never set it to
//   fake text-model admission or a temporary projection (plan §4.4), and this
//   module only ever READS the mark.
// - `LlmRuntime.adapterStream` is the final adapter boundary
//   (packages/llm/llm/src/index.ts): after the public read-only `llm/stream`
//   waterfall it projects files to handle text unconditionally and projects
//   images to deterministic text (`projectImagesForTextModel`) whenever the
//   resolved route's declared `inputModalities` exclude 'image'. Both happen
//   BEFORE adapter dispatch, so a route with declared text-only modalities
//   never lets image bytes reach the provider wire; adapters reject retained
//   images only when modalities are undisclosed
//   (llm-deepseek/src/images.ts: UNSUPPORTED_CONTENT).
// - The public `llm/stream` waterfall takes `next()` without arguments and
//   loop-built requests arrive deep-frozen, and `agent/request` cannot mutate
//   messages; the one public message-shaping extension point is
//   `agent/pre-step`. DVR therefore owns projection only for request inputs
//   it admits itself (tool/plugin-produced contexts) plus the deterministic
//   handle text that tells the model how to read a durable image through
//   vision tools; durable user image blocks stay untouched in the session and
//   the Host's own adapter-boundary projection keeps text routes byte-free.

const PROJECTION_HANDLE_PREFIX = '[vision-router image projection:'
const PROJECTION_NOTICE_PREFIX = '[vision-router image projection notice:'
const DEFAULT_PROJECTION_TOOL = 'vision_describe'

// Mirrors image-offload-compat.ts MAX_CONTENT_NESTING_DEPTH: the walker only
// needs message -> content -> nested content; unbounded recursion would turn
// a pathological tree into a stack overflow.
const MAX_CONTENT_NESTING_DEPTH = 4

// Bounded per-process handle cache. Handles are deterministic in the
// attachment identity, so the cache only avoids recomputing the same text for
// replayed or repeated occurrences, never observability of the decision.
const HANDLE_CACHE_LIMIT = 512

function objectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
}

function attachmentRefOf(block) {
  return objectRecord(objectRecord(block)?.attachment)
}

function attachmentIdOf(block) {
  const attachment = attachmentRefOf(block)
  const raw = attachment?.attachmentId ?? attachment?.id
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  return raw.trim().slice(0, 256)
}

function quoted(value) {
  return JSON.stringify(value)
}

/**
 * Stable marker prefix of one projected image-handle text block. Recognition
 * lets image-turn detection, compaction and replay distinguish projected text
 * from retained and offloaded occurrences instead of double-submitting them.
 * @param {string} text - one text block's content.
 * @returns {boolean} whether the text is a DVR image-projection handle.
 */
export function isProjectedImageText(text) {
  return typeof text === 'string' && text.startsWith(PROJECTION_HANDLE_PREFIX)
}

/**
 * Deterministic model-facing handle for one durable image occurrence on a
 * text-only route. The text is a pure function of the attachment identity, so
 * every projection of the same occurrence — including compaction and replay
 * re-assembly — produces byte-identical text with no image bytes.
 * @param {unknown} attachmentRef - the occurrence's durable attachment reference.
 * @param {object} [options]
 * @param {string} [options.toolName] - recovery tool named in the handle.
 * @param {boolean} [options.offloaded] - provenance note for a Host-offloaded occurrence.
 * @returns {string} deterministic handle text containing zero image bytes.
 */
export function projectedImageHandle(attachmentRef, options = {}) {
  const attachment = objectRecord(attachmentRef)
  const id = typeof attachment?.attachmentId === 'string' && attachment.attachmentId.trim() !== ''
    ? attachment.attachmentId.trim().slice(0, 256)
    : typeof attachment?.id === 'string' && attachment.id.trim() !== ''
      ? attachment.id.trim().slice(0, 256)
      : 'unknown'
  const name = typeof attachment?.name === 'string' && attachment.name.trim() !== ''
    ? attachment.name.trim()
    : undefined
  const toolName = typeof options.toolName === 'string' && options.toolName.trim() !== ''
    ? options.toolName.trim()
    : DEFAULT_PROJECTION_TOOL
  const dims = Number.isSafeInteger(attachment?.width) && Number.isSafeInteger(attachment?.height)
    ? `${attachment.width}x${attachment.height}px`
    : undefined
  const mediaType = typeof attachment?.mediaType === 'string' ? attachment.mediaType : undefined
  const meta = [
    dims,
    mediaType,
  ].filter(Boolean).join(', ')
  const identity = `image ${name === undefined ? '' : `${quoted(name)} `}(attachment ${id}${meta === '' ? '' : `, ${meta}`})`
  const because = options.offloaded === true
    ? 'omitted by the host request image budget (offloaded occurrence)'
    : 'omitted because this model accepts text only'
  return `${PROJECTION_HANDLE_PREFIX} ${identity} ${because}; ` +
    `the durable image is preserved in the session. To inspect it, call ${toolName} with attachmentIds: [${quoted(id)}].]`
}

/**
 * Count image occurrences of typed message content by projection state.
 * Nested tool-result content is walked with the same bounded depth as the
 * retained-image walker in image-offload-compat.ts, so detection cannot
 * silently diverge between the two image policies.
 * @param {unknown} content - one message's content array.
 * @param {number} [depth] - current nesting depth.
 * @returns {{retained: number, offloaded: number, projected: number}} frozen occurrence counts.
 */
export function classifyImageOccurrences(content, depth = 0) {
  const counts = { retained: 0, offloaded: 0, projected: 0 }
  if (!Array.isArray(content) || depth > MAX_CONTENT_NESTING_DEPTH) {
    return Object.freeze(counts)
  }
  for (const block of content) {
    const value = objectRecord(block)
    if (value === undefined) continue
    if (value.type === 'image') {
      if (value.offloaded === true) counts.offloaded += 1
      else counts.retained += 1
      continue
    }
    if (value.type === 'text' && isProjectedImageText(value.text)) {
      counts.projected += 1
      continue
    }
    if (Array.isArray(value.content)) {
      const nested = classifyImageOccurrences(value.content, depth + 1)
      counts.retained += nested.retained
      counts.offloaded += nested.offloaded
      counts.projected += nested.projected
    }
  }
  return Object.freeze(counts)
}

/**
 * True when content carries an image occurrence a text route must not send:
 * either a retained (`offloaded !== true`) or a Host-offloaded block. Both
 * carry zero bytes only after projection; already-projected text alone does
 * not make a step projectable.
 * @param {unknown} content - one message's content array.
 * @returns {boolean} whether a projectable image occurrence exists.
 */
export function hasProjectableImageOccurrences(content) {
  const counts = classifyImageOccurrences(content)
  return counts.retained > 0 || counts.offloaded > 0
}

function projectBlocks(blocks, handle, depth) {
  if (depth > MAX_CONTENT_NESTING_DEPTH) return blocks
  let next
  for (const [index, block] of blocks.entries()) {
    const value = objectRecord(block)
    if (value === undefined) {
      next?.push(block)
      continue
    }
    if (value.type === 'image') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: handle(value) })
      continue
    }
    if (Array.isArray(value.content)) {
      const nested = projectBlocks(value.content, handle, depth + 1)
      if (nested !== value.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...value, content: nested })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks
}

/**
 * Per-route temporary request projection kernel: replace every retained and
 * offloaded image occurrence with its deterministic text handle, producing
 * request-only shallow copies. Durable inputs are never mutated, `offloaded`
 * is never added or cleared, and already-projected text passes through
 * untouched, so mixed history, compaction and replay stay idempotent and no
 * occurrence is submitted twice.
 * @param {readonly unknown[]} messages - request messages to project.
 * @param {object} [options]
 * @param {(block: unknown) => string} [options.handle] - handle builder override.
 * @param {string} [options.toolName] - recovery tool named in generated handles.
 * @returns {{messages: unknown[], projected: number}} request copies and the number of projected occurrences.
 */
export function projectImagesForTextRoute(messages, options = {}) {
  const toolName = options.toolName
  const handle = typeof options.handle === 'function'
    ? options.handle
    : (block) => projectedImageHandle(attachmentRefOf(block), {
      toolName,
      offloaded: objectRecord(block)?.offloaded === true,
    })
  if (!Array.isArray(messages)) return { messages, projected: 0 }
  let projected = 0
  let changed = false
  const projectedMessages = messages.map((message) => {
    const value = objectRecord(message)
    const content = Array.isArray(value?.content) ? value.content : undefined
    if (content === undefined) return message
    const before = classifyImageOccurrences(content)
    if (before.retained === 0 && before.offloaded === 0) return message
    const nextContent = projectBlocks(content, (block) => {
      projected += 1
      return handle(block)
    }, 0)
    if (nextContent === content) return message
    changed = true
    return { ...value, content: nextContent }
  })
  return { messages: changed ? projectedMessages : messages, projected }
}

/**
 * Route-level projection decision. `routeAcceptsImages` mirrors the Host's
 * declared model metadata (`LlmModelInfo.inputModalities`: absent means
 * unknown, explicit omission is negative capability):
 * - attested image-capable -> native: never project, native vision must not degrade;
 * - attested text-only -> text-only: project;
 * - unknown or no attestation -> unknown: never project (fail-safe; DVR must
 *   not misreport a model's modalities in either direction).
 * @param {{provider?: string, model?: string}} [route] - provider/model pair of the request route.
 * @param {(provider: string, model: string) => boolean | undefined} [routeAcceptsImages]
 * @returns {{mode: 'native'|'text-only'|'unknown', project: boolean}} frozen policy.
 */
export function resolveRouteProjectionPolicy(route, routeAcceptsImages) {
  if (typeof routeAcceptsImages !== 'function'
    || typeof route?.provider !== 'string' || typeof route?.model !== 'string') {
    return Object.freeze({ mode: 'unknown', project: false })
  }
  let accepts
  try {
    accepts = routeAcceptsImages(route.provider, route.model)
  } catch {
    return Object.freeze({ mode: 'unknown', project: false })
  }
  if (accepts === true) return Object.freeze({ mode: 'native', project: false })
  if (accepts === false) return Object.freeze({ mode: 'text-only', project: true })
  return Object.freeze({ mode: 'unknown', project: false })
}

function defaultToolProducedMessage(message) {
  const source = objectRecord(message)?.source
  const kind = source?.kind
  return typeof kind === 'string' && (kind === 'tool' || kind.startsWith('plugin:'))
}

function isProjectionNotice(message) {
  const value = objectRecord(message)
  if (!Array.isArray(value?.content)) return false
  return value.content.some((block) =>
    objectRecord(block)?.type === 'text' && typeof block.text === 'string'
    && block.text.startsWith(PROJECTION_NOTICE_PREFIX))
}

function retainedAttachmentRefs(content, into, depth) {
  if (!Array.isArray(content) || depth > MAX_CONTENT_NESTING_DEPTH) return
  for (const block of content) {
    const value = objectRecord(block)
    if (value === undefined) continue
    if (value.type === 'image' && value.offloaded !== true) {
      const ref = attachmentRefOf(block)
      if (ref !== undefined) into.push(ref)
      continue
    }
    if (Array.isArray(value.content)) retainedAttachmentRefs(value.content, into, depth + 1)
  }
}

/**
 * Coordinator piece of the provider-free execution chain: the routing module
 * applies it at its pre-step integration point, so the durable user image
 * blocks stay in the session (UI and vision tools keep canonical pixels)
 * while tool/plugin-produced contexts are projected before admission and the
 * model receives one deterministic notice naming the vision tool and the
 * attachment ids to read.
 * @param {object} [options]
 * @param {(provider: string, model: string) => boolean | undefined} [options.routeAcceptsImages]
 * @param {(message: unknown) => boolean} [options.isToolProducedMessage]
 * @param {string} [options.toolName]
 * @returns {object} the projection coordinator bound to the given attestations.
 */
export function createVisionImageProjection(options = {}) {
  const toolName = typeof options.toolName === 'string' && options.toolName.trim() !== ''
    ? options.toolName.trim()
    : DEFAULT_PROJECTION_TOOL
  const routeAcceptsImages = typeof options.routeAcceptsImages === 'function'
    ? options.routeAcceptsImages
    : undefined
  const isToolProducedMessage = typeof options.isToolProducedMessage === 'function'
    ? options.isToolProducedMessage
    : defaultToolProducedMessage
  const handleCache = new Map()
  let noticeCounter = 0

  const handleFor = (block) => {
    const id = attachmentIdOf(block) ?? 'unknown'
    const offloaded = objectRecord(block)?.offloaded === true
    const key = `${offloaded ? 'o' : 'r'}:${id}`
    const cached = handleCache.get(key)
    if (cached !== undefined) return cached
    const text = projectedImageHandle(attachmentRefOf(block), { toolName, offloaded })
    if (handleCache.size >= HANDLE_CACHE_LIMIT) handleCache.clear()
    handleCache.set(key, text)
    return text
  }

  const projectionNotice = (attachmentRefs) => {
    const seen = new Set()
    const ids = []
    for (const ref of attachmentRefs) {
      const raw = ref?.attachmentId ?? ref?.id
      const id = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().slice(0, 256) : undefined
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    if (ids.length === 0) return undefined
    noticeCounter += 1
    const idList = ids.map((id) => JSON.stringify(id)).join(', ')
    return {
      id: `vision-router-image-projection-${noticeCounter}`,
      role: 'user',
      source: { kind: 'plugin:dsh-vision-router' },
      content: [{
        type: 'text',
        text: `${PROJECTION_NOTICE_PREFIX} ${ids.length} durable image attachment(s) from this step are ` +
          `preserved in the session (the user still sees them and vision tools can still read them), ` +
          `but this model accepts text only, so requests carry deterministic text handles instead of image bytes. ` +
          `To inspect an image, call ${toolName} with attachmentIds: [${idList}].]`,
      }],
    }
  }

  /**
   * Project one admitted pre-step batch for the resolved request route. User
   * image blocks are preserved durably; tool/plugin-produced image contexts
   * are replaced by deterministic handles; a text-only route additionally
   * receives one idempotent notice naming the readable attachment ids.
   * Native and unknown routes pass through unchanged (no misreported
   * modalities, no degraded native vision).
   * @param {{provider?: string, model?: string}} [route] - resolved provider/model route.
   * @param {object} decision - pre-step decision (`{ kind: 'enter', messages }`).
   * @returns {object} the original decision or a shallow copy with projected messages.
   */
  const applyToPreStep = (route, decision) => {
    if (!objectRecord(decision) || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
      return decision
    }
    const policy = resolveRouteProjectionPolicy(route, routeAcceptsImages)
    if (policy.mode !== 'text-only') return decision
    const messages = decision.messages
    if (messages.some(isProjectionNotice)) return decision
    const userAttachments = []
    let changed = false
    const nextMessages = messages.map((message) => {
      if (isToolProducedMessage(message)) {
        const { messages: projected } = projectImagesForTextRoute([message], { handle: handleFor })
        const projectedMessage = projected[0]
        if (projectedMessage !== message) changed = true
        return projectedMessage
      }
      if (objectRecord(message) !== undefined) {
        retainedAttachmentRefs(message.content, userAttachments, 0)
      }
      return message
    })
    const notice = projectionNotice(userAttachments)
    if (notice !== undefined) {
      changed = true
      nextMessages.push(notice)
    }
    if (!changed) return decision
    return { ...decision, messages: nextMessages }
  }

  /**
   * Kernel application for one concrete request: request-only copies of the
   * given messages with every image occurrence projected for a text-only
   * route. Durable inputs stay untouched.
   * @param {readonly unknown[]} messages - request messages.
   * @param {{provider?: string, model?: string}} [route] - request route.
   * @returns {{messages: unknown[], projected: number}} projected request copies.
   */
  const projectRequestForRoute = (messages, route) => {
    const policy = resolveRouteProjectionPolicy(route, routeAcceptsImages)
    if (policy.mode !== 'text-only') return { messages, projected: 0 }
    return projectImagesForTextRoute(messages, { handle: handleFor })
  }

  return Object.freeze({
    applyToPreStep,
    projectRequestForRoute,
    resolvePolicy: (route) => resolveRouteProjectionPolicy(route, routeAcceptsImages),
  })
}
