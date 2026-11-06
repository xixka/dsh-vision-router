import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'

import {
  createVisionImageProjection,
  classifyImageOccurrences,
  hasProjectableImageOccurrences,
  isProjectedImageText,
  projectedImageHandle,
  projectImagesForTextRoute,
  resolveRouteProjectionPolicy,
} from '../lib/vision-image-projection.js'
import { createVisionProviderTransport } from '../lib/vision-provider-transport.js'

// Image-projection coverage for the provider-free execution chain (plan §4.4
// preferred scheme, the highest functional-risk item). The mock boundary
// below mirrors the verified DSH 0.2.1-rc.5 contract
// (packages/llm/llm/src/index.ts adapterStream): a route whose declared
// inputModalities exclude 'image' has every image occurrence projected to the
// Host's deterministic text-only placeholder BEFORE adapter dispatch, so the
// text adapter receives zero image bytes; a route with undisclosed
// modalities passes images through and the adapter rejects them
// (llm-deepseek/src/images.ts: UNSUPPORTED_CONTENT), which is the upstream
// per-route contract gap plan §4.4 names; an image-capable route receives the
// original durable image blocks natively.

const ATTACHMENT_ID = 'sha256:9f2c3a41be7d5c0102030405060708'
const CANONICAL_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

const attachmentRef = {
  attachmentId: ATTACHMENT_ID,
  name: 'chart.png',
  width: 800,
  height: 600,
  mediaType: 'image/png',
}

const userImageMessage = Object.freeze({
  id: 'user-image-1',
  role: 'user',
  source: { kind: 'user' },
  content: Object.freeze([
    Object.freeze({ type: 'text', text: 'Please read this chart.' }),
    Object.freeze({ type: 'image', attachment: attachmentRef }),
  ]),
})

const userTextMessage = Object.freeze({
  id: 'user-text-1',
  role: 'user',
  source: { kind: 'user' },
  content: Object.freeze([Object.freeze({ type: 'text', text: 'And summarize it.' })]),
})

const toolImageMessage = Object.freeze({
  id: 'tool-image-1',
  role: 'user',
  source: { kind: 'tool' },
  content: Object.freeze([
    Object.freeze({ type: 'image', attachment: attachmentRef }),
  ]),
})

const offloadedImageMessage = Object.freeze({
  id: 'user-image-offloaded-1',
  role: 'user',
  source: { kind: 'user' },
  content: Object.freeze([
    Object.freeze({ type: 'image', attachment: attachmentRef, offloaded: true }),
  ]),
})

// Canonical attachment store mock: the same durable bytes the session keeps
// and the vision tools read through the Session attachment boundary.
const attachmentStore = new Map([[ATTACHMENT_ID, CANONICAL_BYTES]])

function deepCountImages(content, found, depth = 0) {
  if (!Array.isArray(content) || depth > 4) return
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'image') {
      found.push(block)
      continue
    }
    if (Array.isArray(block.content)) deepCountImages(block.content, found, depth + 1)
  }
}

function imageBytesReceived(messages) {
  const found = []
  for (const message of messages ?? []) deepCountImages(message?.content, found)
  return found.reduce((total, block) => {
    const id = block?.attachment?.attachmentId
    const bytes = attachmentStore.get(id)
    return total + (bytes !== undefined ? bytes.length : 0)
  }, 0)
}

// DSH's own deterministic text-only placeholder
// (packages/llm/llm/src/content.ts textOnlyImageText).
function dshTextOnlyImageText(ref) {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `[image omitted because this model accepts text only; attachment sha256:${digest}]`
}

function boundaryProjectForTextModel(messages) {
  return messages.map((message) => {
    const found = []
    deepCountImages(message?.content, found)
    if (found.length === 0) return message
    const content = message.content.map((block) =>
      block?.type === 'image'
        ? { type: 'text', text: dshTextOnlyImageText(block.attachment) }
        : block)
    return { ...message, content }
  })
}

function mockAdapter(name) {
  const state = { name, requests: [], imageBytes: 0, imageBlocks: 0, rejection: undefined }
  return {
    state,
    dispatch(request) {
      const found = []
      for (const message of request.messages ?? []) deepCountImages(message?.content, found)
      state.imageBlocks += found.length
      state.imageBytes += imageBytesReceived(request.messages)
      state.requests.push(request)
      if (found.length > 0) {
        // Mirrors llm-deepseek prepareImages rejecting image content for a
        // model whose modalities do not admit images.
        const rejection = new Error(`${name}: DeepSeek Messages image input requires a vision model and attachment service`)
        rejection.code = 'UNSUPPORTED_CONTENT'
        state.rejection = rejection
        throw rejection
      }
      return { role: 'assistant', text: `${name} ok` }
    },
  }
}

// The DSH runtime boundary subset: projection for declared text-only routes
// happens here, BEFORE adapter dispatch.
function dispatchThroughBoundary(request, route) {
  const declared = route.declared
  let messages = request.messages
  if (declared !== undefined && !declared.includes('image')
    && (messages ?? []).some((message) => hasProjectableImageOccurrences(message?.content))) {
    messages = boundaryProjectForTextModel(messages)
  }
  return route.adapter.dispatch({ ...request, messages })
}

const TEXT_ROUTE = { declared: ['text'], adapter: mockAdapter('text-chat-adapter') }
const VISION_ROUTE = { declared: ['text', 'image'], adapter: mockAdapter('vision-adapter') }
const UNDECLARED_ROUTE = { declared: undefined, adapter: mockAdapter('text-adapter-undeclared') }

const routeAcceptsImages = (provider, model) => {
  if (provider === 'hostvision') return true
  if (provider === 'deepseek-official') return model === 'deepseek-vision-pro' ? true : false
  return undefined
}

test('the projection kernel replaces every image occurrence with deterministic text and never mutates durable messages', () => {
  const durable = [userImageMessage, toolImageMessage, userTextMessage]
  const snapshot = structuredClone(durable)
  const { messages, projected } = projectImagesForTextRoute(durable)
  assert.equal(projected, 2, 'one retained user occurrence and one retained tool occurrence project')
  assert.equal(imageBytesReceived(messages), 0, 'the projected request carries zero image bytes')
  assert.ok(messages !== durable, 'the kernel returns request-only copies')
  assert.notEqual(messages[0], durable[0], 'the projected user message is a request copy, not the durable object')
  assert.notEqual(messages[1], durable[1], 'the projected tool message is a request copy, not the durable object')
  assert.deepEqual(durable, snapshot, 'the durable messages are unchanged')
  const handle = messages[0].content.find((block) => block.type === 'text' && isProjectedImageText(block.text))
  assert.ok(handle, 'the user occurrence is projected to a recognizable handle')
  assert.ok(handle.text.includes(`attachmentIds: [${JSON.stringify(ATTACHMENT_ID)}]`),
    'the handle names the full attachment id so vision tools can read it')
  assert.equal(messages[2], userTextMessage, 'text-only messages keep their identity')
})

test('handles are deterministic across repeated projection, replay and compaction', () => {
  const first = projectedImageHandle(attachmentRef)
  const second = projectedImageHandle(attachmentRef)
  assert.equal(first, second)
  assert.ok(first.startsWith('[vision-router image projection:'))
  const again = projectImagesForTextRoute([userImageMessage])
  const againHandle = again.messages[0].content.find((block) => block.type === 'text' && isProjectedImageText(block.text))
  assert.equal(againHandle.text, first)
  const counts = classifyImageOccurrences(again.messages[0].content)
  assert.deepEqual({ ...counts }, { retained: 0, offloaded: 0, projected: 1 },
    'projected occurrences are recognized instead of double-handled')
  assert.equal(hasProjectableImageOccurrences(again.messages[0].content), false)
})

test('classification distinguishes retained, offloaded and projected occurrences in mixed history', () => {
  const mixed = [
    { type: 'image', attachment: attachmentRef },
    { type: 'image', attachment: attachmentRef, offloaded: true },
    { type: 'text', text: projectedImageHandle(attachmentRef) },
    { type: 'text', text: 'plain text' },
  ]
  assert.deepEqual({ ...classifyImageOccurrences(mixed) }, { retained: 1, offloaded: 1, projected: 1 })
  assert.equal(hasProjectableImageOccurrences(mixed), true)
  const { messages, projected } = projectImagesForTextRoute([offloadedImageMessage, userImageMessage])
  assert.equal(projected, 2, 'an offloaded occurrence is also projected for a text route')
  assert.equal(imageBytesReceived(messages), 0)
  const original = [...offloadedImageMessage.content]
  assert.equal(original[0].offloaded, true, 'the durable offloaded mark is never cleared or copied onto new blocks')
})

test('route policy projects only attested text-only routes and never misreports modalities', () => {
  assert.deepEqual({ ...resolveRouteProjectionPolicy({ provider: 'hostvision', model: 'vision-pro' }, routeAcceptsImages) },
    { mode: 'native', project: false })
  assert.deepEqual({ ...resolveRouteProjectionPolicy({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, routeAcceptsImages) },
    { mode: 'text-only', project: true })
  assert.deepEqual({ ...resolveRouteProjectionPolicy({ provider: 'unknown-host', model: 'mystery' }, routeAcceptsImages) },
    { mode: 'unknown', project: false })
  assert.deepEqual({ ...resolveRouteProjectionPolicy(undefined, routeAcceptsImages) },
    { mode: 'unknown', project: false })
  assert.deepEqual({ ...resolveRouteProjectionPolicy({ provider: 'hostvision', model: 'vision-pro' }, undefined) },
    { mode: 'unknown', project: false })
  assert.deepEqual({ ...resolveRouteProjectionPolicy({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, () => { throw new Error('catalog fault') }) },
    { mode: 'unknown', project: false }, 'a failing attestation fails closed instead of projecting')
})

test('pre-step projection keeps durable user images, projects tool contexts, and adds one deterministic notice', () => {
  const projection = createVisionImageProjection({ routeAcceptsImages })
  const decision = { kind: 'enter', messages: [userImageMessage, toolImageMessage, userTextMessage] }
  const result = projection.applyToPreStep({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, decision)
  assert.ok(result !== decision, 'the text-only route rewrites the admitted batch')
  const messages = result.messages
  // Durable user image block is preserved in the admitted batch: the UI keeps
  // rendering it and the session keeps the canonical reference.
  assert.equal(messages[0], userImageMessage, 'user image blocks are never rewritten at admission')
  const toolContent = messages[1].content
  assert.equal(imageBytesReceived([{ content: toolContent }]), 0, 'tool-produced image contexts are projected before admission')
  assert.ok(toolContent[0].type === 'text' && isProjectedImageText(toolContent[0].text))
  const notice = messages[3]
  assert.ok(notice, 'exactly one projection notice is appended')
  assert.equal(notice.source.kind, 'plugin:dsh-vision-router')
  assert.ok(notice.content[0].text.includes(`attachmentIds: [${JSON.stringify(ATTACHMENT_ID)}]`))
  assert.ok(notice.content[0].text.includes('vision_describe'))
  // Idempotence: re-applying never duplicates the notice or handles.
  const reapplied = projection.applyToPreStep({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, result)
  assert.equal(reapplied, result)
})

test('the composed pipeline hands the mock text adapter zero image bytes while the durable image survives for UI and tools', () => {
  const projection = createVisionImageProjection({ routeAcceptsImages })
  const decision = { kind: 'enter', messages: [userImageMessage, toolImageMessage] }
  const admitted = projection.applyToPreStep({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, decision)
  // The Host admits the batch durably and derives the request from it.
  const durableSurface = [...admitted.messages]
  const request = { provider: 'deepseek-official', model: 'deepseek-v4-pro', messages: durableSurface }
  const outcome = dispatchThroughBoundary(request, TEXT_ROUTE)
  assert.equal(outcome.role, 'assistant')
  assert.equal(TEXT_ROUTE.adapter.state.imageBytes, 0, 'the text adapter received zero image bytes')
  assert.equal(TEXT_ROUTE.adapter.state.imageBlocks, 0)
  assert.equal(TEXT_ROUTE.adapter.state.rejection, undefined, 'no adapter image-capability rejection happened')
  // UI/canonical preservation: the durable surface still carries the image
  // block and the attachment store still serves the same canonical bytes.
  assert.deepEqual(durableSurface[0], userImageMessage)
  assert.equal(attachmentStore.get(ATTACHMENT_ID), CANONICAL_BYTES)
  const received = TEXT_ROUTE.adapter.state.requests[0]
  const placeholder = received.messages[0].content.find((block) => block.type === 'text'
    && block.text.startsWith('[image omitted because this model accepts text only'))
  assert.ok(placeholder, 'the Host text-only projection ran before the adapter boundary')
})

test('native vision is never degraded: the vision adapter receives the original image blocks after a text-projected request', () => {
  const projection = createVisionImageProjection({ routeAcceptsImages })
  // First, the same durable history is projected for the text-only route.
  const textDecision = { kind: 'enter', messages: [userImageMessage] }
  projection.applyToPreStep({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, textDecision)
  assert.equal(userImageMessage.content[1].type, 'image', 'a one-time text projection never rewrote durable history')
  // Then the route switches to the real vision model: mixed history keeps the
  // original image occurrences and the native adapter receives them.
  const visionDecision = { kind: 'enter', messages: [userImageMessage, userTextMessage] }
  const admitted = projection.applyToPreStep({ provider: 'hostvision', model: 'vision-pro' }, visionDecision)
  assert.equal(admitted, visionDecision, 'a native route is admitted unchanged')
  const outcome = dispatchThroughBoundary({ provider: 'hostvision', model: 'vision-pro', messages: admitted.messages }, VISION_ROUTE)
  assert.equal(outcome.role, 'assistant')
  assert.equal(VISION_ROUTE.adapter.state.imageBlocks, 1)
  assert.equal(VISION_ROUTE.adapter.state.imageBytes, CANONICAL_BYTES.length)
})

test('a route with undisclosed modalities fails closed: no projection, no misreported capability, durable image intact', () => {
  const projection = createVisionImageProjection({ routeAcceptsImages })
  const decision = { kind: 'enter', messages: [userImageMessage] }
  const admitted = projection.applyToPreStep({ provider: 'unknown-host', model: 'mystery' }, decision)
  assert.equal(admitted, decision, 'unknown routes are never projected (plan §4.4: no misreported modalities)')
  assert.throws(
    () => dispatchThroughBoundary({ provider: 'unknown-host', model: 'mystery', messages: decision.messages }, UNDECLARED_ROUTE),
    /image input requires a vision model/,
    'the rc.5 adapter boundary rejects the image instead of the plugin faking admission',
  )
  assert.equal(userImageMessage.content[1].type, 'image', 'no destructive rewrite happened to the durable image')
})

test('the free vision endpoint receives the same canonical pixels through the Router-owned transport', async () => {
  // Mock 免费视觉端点 per tests/vision-provider-transport.test.js: a real
  // loopback HTTP server speaking the OpenAI chat-completions shape, reached
  // only through createVisionProviderTransport.
  const received = []
  const server = createHttpServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'free-vision: a red chart' } }] }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const transport = createVisionProviderTransport({ fetchImpl: globalThis.fetch.bind(globalThis) })
  try {
    // The tool chain reads the canonical attachment through the Session
    // attachment boundary — the same bytes the UI kept — and posts them to the
    // free endpoint via the private transport, not a registered provider.
    const canonical = attachmentStore.get(ATTACHMENT_ID)
    const response = await transport.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'free-vision',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${canonical.toString('base64')}` } },
            { type: 'text', text: 'describe' },
          ],
        }],
        max_tokens: 64,
      }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.choices[0].message.content, 'free-vision: a red chart')
    const imageData = received[0].messages[0].content[0].image_url.url
    assert.equal(Buffer.from(imageData.slice('data:image/png;base64,'.length), 'base64').toString('hex'),
      canonical.toString('hex'), 'the endpoint received the exact canonical bytes the session kept')
  } finally {
    await transport.dispose()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
