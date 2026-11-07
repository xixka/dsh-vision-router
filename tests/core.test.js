import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import sharp from 'sharp'
import { parseVersionComparator } from '../lib/version-range.js'
import { VISION_SUCCESS_GUIDANCE, visionDescribeSuccessContext } from '../lib/vision-evidence-guidance.js'
import { directSessionAffinityHeaders, sessionIdentityOf, wireSessionAffinityId } from '../lib/session-affinity.js'
import { currentVisionSessionAffinityId } from '../lib/session-affinity-runtime.js'
import { createSessionVisionStateStore } from '../lib/session-vision-state.js'
import { isOffloadedImageBlock, offloadedImagePlaceholder } from '../lib/image-offload-compat.js'
import {
  mediaTypeOf,
  sniffMediaType,
  isAttachmentIdInput,
  artifactStemOf,
  boxesToSvg,
  annotateBoxesBuffer,
  visionDetectInstruction,
  describeStructuredInstruction,
  normalizeDetectResult,
  normalizeDescribeResult,
  posterizeSvgColor,
  basenameOf,
  blocksHaveImage,
  eventHasImage,
  classifyFailure,
  createChunkAssembler,
  providersOf,
  rewriteImageBlocks,
  rewriteImagesDeep,
  sanitizeToolResultImages,
  sanitizeToolResultMessage,
  planToolResultImageShadows,
  toolImageMarker,
  deepFreezeLocal,
  collectEventAttachmentRefs,
  parseVersionParts,
  versionSatisfies,
  looksLikeVisionModel,
  looksLikeNonGenerativeVisionModel,
  decideVisionBackendCapability,
  resolveChannelBridgeTransport,
  renderVisionPresent,
  extractJson,
  createCache,
  downscaleImage,
  toOpenAIContent,
  toRealPath,
  chromiumCandidates,
  callOpenAICompatible,
  cacheKeyFor,
  adapterAvailable,
  httpProvidersOf,
  DEFAULT_HTTP_PROVIDERS,
  httpProviderFallbackWeight,
  weightedFallbackBudget,
  reverseRouteTarget,
  stripImageBlocks,
  replaceImageBlocksWithMemory,
  rewriteHistoryImages,
  dedupeHttpProviders,
  collectImageBlocks,
  lastUserText,
  switchRoute,
  hostMatchesAny,
  DEFAULT_PROXY_HOSTS,
  createStealthAdapter,
  estimateTokens,
  estimateMessages,
  trimMessagesToBudget,
  parseBox,
  longOcrWindows,
  computePixelDiff,
  renderDiffHeatmap,
  quantizeColors,
  boxToSvg,
  floodFillBackground,
  bitmapOfGray,
  posterizeSvg,
  apply,
  Config,
} from '../index.js'

test('sniffMediaType detects formats from magic bytes', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex')
  assert.equal(sniffMediaType(png), 'image/png')
  const jpeg = Buffer.from('ffd8ffe000104a464946000101000001', 'hex')
  assert.equal(sniffMediaType(jpeg), 'image/jpeg')
  const webp = Buffer.from('524946461200000057454250565038', 'hex')
  assert.equal(sniffMediaType(webp), 'image/webp')
  const gif = Buffer.from('474946383961000000000000000000', 'hex')
  assert.equal(sniffMediaType(gif), 'image/gif')
  assert.equal(sniffMediaType(Buffer.from('000102030405060708090a0b', 'hex')), undefined)
  assert.equal(sniffMediaType(Buffer.alloc(4)), undefined)
})

test('mediaTypeOf maps extensions', () => {
  assert.equal(mediaTypeOf('/a/b.PNG'), 'image/png')
  assert.equal(mediaTypeOf('x.jpeg'), 'image/jpeg')
  assert.equal(mediaTypeOf('x.jpg'), 'image/jpeg')
  assert.equal(mediaTypeOf('x.webp'), 'image/webp')
  assert.equal(mediaTypeOf('x.gif'), 'image/gif')
  assert.equal(mediaTypeOf('x.tiff'), undefined)
  assert.equal(mediaTypeOf('x.heic'), undefined)
  assert.equal(mediaTypeOf('noext'), undefined)
})

test('basenameOf returns the last path segment', () => {
  assert.equal(basenameOf('/a/b/c.png'), 'c.png')
  assert.equal(basenameOf('c.png'), 'c.png')
})

test('blocksHaveImage detects image blocks and nested tool results', () => {
  assert.equal(blocksHaveImage([]), false)
  assert.equal(blocksHaveImage([{ type: 'text', text: 'hi' }]), false)
  assert.equal(blocksHaveImage([{ type: 'image' }]), true)
  assert.equal(blocksHaveImage([{ type: 'tool-result', content: [{ type: 'image' }] }]), true)
  assert.equal(
    blocksHaveImage([{ type: 'tool-result', content: [{ type: 'text', text: 'nope' }] }]),
    false,
  )
  assert.equal(blocksHaveImage('not an array'), false)
  assert.equal(blocksHaveImage(undefined), false)
})

test('eventHasImage scans the three known event shapes', () => {
  assert.equal(eventHasImage({ data: { content: [{ type: 'image' }] } }), true)
  assert.equal(eventHasImage({ data: { message: { content: [{ type: 'image' }] } } }), true)
  assert.equal(
    eventHasImage({ data: { inserted: [{ content: [{ type: 'text', text: 'x' }] }] } }),
    false,
  )
  assert.equal(eventHasImage({ data: { inserted: [{ content: [{ type: 'image' }] }] } }), true)
  assert.equal(eventHasImage({ data: {} }), false)
  assert.equal(eventHasImage({}), false)
  assert.equal(eventHasImage(undefined), false)
})

test('classifyFailure recognizes the provider failure vocabulary', () => {
  assert.equal(classifyFailure('This model is not available in your region.'), 'region')
  assert.equal(
    classifyFailure('The request is prohibited due to a violation of provider Terms Of Service.'),
    'tos',
  )
  assert.equal(classifyFailure('Insufficient credits: balance 0'), 'quota')
  assert.equal(classifyFailure('402 Payment Required'), 'quota')
  assert.equal(classifyFailure('429 rate limited'), 'rate-limit')
  assert.equal(classifyFailure('fetch failed ECONNREFUSED'), 'network')
  assert.equal(classifyFailure('something entirely different'), 'other')
})

test('chunk assembler builds text from the raw chunk protocol', () => {
  const a = createChunkAssembler()
  a.push({ type: 'block-start', index: 0, blockType: 'text' })
  a.push({ type: 'text-delta', index: 0, text: 'hel' })
  a.push({ type: 'text-delta', index: 0, text: 'lo' })
  a.push({ type: 'block-start', index: 1, blockType: 'reasoning' })
  a.push({ type: 'reasoning-delta', index: 1, text: 'ignored' })
  a.push({ type: 'usage', usage: {} })
  a.push({ type: 'finish', reason: { kind: 'stop' } })
  assert.equal(a.finish(), 'hello')
})

test('chunk assembler keeps partial text on max-tokens', () => {
  const a = createChunkAssembler()
  a.push({ type: 'block-start', index: 0, blockType: 'text' })
  a.push({ type: 'text-delta', index: 0, text: 'partial' })
  a.push({ type: 'finish', reason: { kind: 'max-tokens' } })
  assert.equal(a.finish(), 'partial')
})

test('chunk assembler throws the failure message carried by the finish chunk', () => {
  const a = createChunkAssembler()
  a.push({
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'Insufficient credits', code: 'QUOTA' } },
  })
  assert.throws(() => a.finish(), /Insufficient credits/)
})

test('chunk assembler throws on unexpected finish kinds', () => {
  const a = createChunkAssembler()
  a.push({ type: 'finish', reason: { kind: 'weird' } })
  assert.throws(() => a.finish(), /weird/)
})

test('chunk assembler ignores unknown chunk types and malformed chunks', () => {
  const a = createChunkAssembler()
  a.push(null)
  a.push({ type: 'mystery' })
  a.push({})
  a.push({ type: 'block-start', index: 0, blockType: 'text' })
  a.push({ type: 'text-delta', index: 0, text: 'ok' })
  a.push({ type: 'finish', reason: undefined })
  assert.equal(a.finish(), 'ok')
})

test('providersOf flattens the single-provider shorthand', () => {
  assert.deepEqual(
    providersOf({ provider: 'openrouter', model: 'm1', fallbacks: ['m2'] }),
    [
      { provider: 'openrouter', model: 'm1' },
      { provider: 'openrouter', model: 'm2' },
    ],
  )
  assert.deepEqual(providersOf({}), [{ provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B' }])
})

test('providersOf flattens the multi-provider form and prefers it', () => {
  assert.deepEqual(
    providersOf({
      provider: 'ignored',
      model: 'ignored',
      providers: [
        { provider: 'p1', model: 'a', fallbacks: ['b'] },
        { provider: 'p2', model: 'c' },
      ],
    }),
    [
      { provider: 'p1', model: 'a' },
      { provider: 'p1', model: 'b' },
      { provider: 'p2', model: 'c' },
    ],
  )
})

test('rewriteImageBlocks replaces image blocks with attachment markers', () => {
  const ref = { attachmentId: 'att-1', mediaType: 'image/png' }
  const { messages, attachments } = rewriteImageBlocks([
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: ref }] },
  ])
  assert.equal(messages[0].content[0].type, 'text')
  assert.match(messages[0].content[1].text, /att-1/)
  assert.match(messages[0].content[1].text, /vision_describe/)
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0], ref)
})

test('rewriteImageBlocks leaves image-less messages untouched', () => {
  const input = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  const { messages, attachments } = rewriteImageBlocks(input)
  assert.equal(messages, input)
  assert.equal(attachments.length, 0)
})

test('extractJson tolerates fences and surrounding prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('here you go: [1,2,3] trailing'), [1, 2, 3])
  assert.equal(extractJson('no json here'), undefined)
  assert.equal(extractJson(''), undefined)
})

test('createCache applies TTL and LRU eviction', async () => {
  const cache = createCache(2, 50)
  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
  await new Promise((resolve) => setTimeout(resolve, 70))
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('c'), undefined)
  assert.equal(cache.size, 0)
})

test('createCache with ttl 0 keeps entries forever', () => {
  const cache = createCache(10, 0)
  cache.set('a', 1)
  assert.equal(cache.get('a'), 1)
})

test('downscaleImage shrinks oversized images and keeps small ones', async () => {
  const big = await sharp({
    create: { width: 4000, height: 3000, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer()
  const shrunk = await downscaleImage(big, 8000000)
  assert.ok(shrunk.length > 0)
  assert.ok(shrunk.length < big.length)
  const meta = await sharp(shrunk).metadata()
  assert.ok(meta.width * meta.height <= 8000000)

  const small = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer()
  assert.equal(await downscaleImage(small, 8000000), small)
})

test('downscaleImage returns original bytes for corrupt input', async () => {
  const bytes = Buffer.from('not an image')
  assert.equal(await downscaleImage(bytes, 8000000), bytes)
})

test('toOpenAIContent converts harness blocks to OpenAI wire content', () => {
  const ref = { attachmentId: 'a1', mediaType: 'image/png' }
  const blocks = [
    { type: 'image', attachment: ref },
    { type: 'text', text: 'describe' },
  ]
  const content = toOpenAIContent(blocks, () => Buffer.from('PNGBYTES'))
  assert.equal(content[0].type, 'image_url')
  assert.equal(
    content[0].image_url.url,
    `data:image/png;base64,${Buffer.from('PNGBYTES').toString('base64')}`,
  )
  assert.deepEqual(content[1], { type: 'text', text: 'describe' })
})

test('toOpenAIContent preserves DSH image-offload decisions without resolving bytes', () => {
  let reads = 0
  const content = toOpenAIContent([
    {
      type: 'image',
      offloaded: true,
      attachment: { attachmentId: 'sha256:abcdef0123456789', mediaType: 'image/png' },
    },
  ], () => {
    reads += 1
    return Buffer.from('must-not-be-read')
  })
  assert.equal(reads, 0)
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /image omitted to fit request image limits/)
  assert.match(content[0].text, /sha256:abcdef0123456789/)
})

test('callOpenAICompatible posts keyless when apiKeyEnv is empty', async () => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const text = await callOpenAICompatible(
      { name: 't', baseURL: 'https://example.com/v1/', model: 'm' },
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    )
    assert.equal(text, 'OK')
    assert.equal(captured.url, 'https://example.com/v1/chat/completions')
    assert.equal(captured.init.headers.authorization, undefined)
    assert.equal(JSON.parse(captured.init.body).stream, false)
  } finally {
    globalThis.fetch = original
  }
})

test('session identity keeps internal DSH authority separate from HTTP wire admission', () => {
  assert.equal(sessionIdentityOf({ id: 'session-abc-123' }), 'session-abc-123')
  assert.equal(sessionIdentityOf({ header: { id: 'persisted-session' } }), 'persisted-session')
  assert.equal(sessionIdentityOf({ requestHeader: () => ({ id: 'request-session' }) }), 'request-session')
  const longA = 'A'.repeat(513)
  const longB = 'B'.repeat(513)
  assert.equal(sessionIdentityOf({ id: longA }), longA)
  assert.equal(sessionIdentityOf({ id: longB }), longB)
  assert.notEqual(sessionIdentityOf({ id: longA }), sessionIdentityOf({ id: longB }))
  assert.equal(sessionIdentityOf({ id: 'bad\r\nid' }), 'bad\r\nid')
  assert.equal(wireSessionAffinityId('session-opaque-value'), 'session-opaque-value')
  assert.equal(wireSessionAffinityId(' bad-space '), undefined)
  assert.equal(wireSessionAffinityId('会话-123'), undefined)
  assert.equal(wireSessionAffinityId('session-😀'), undefined)
  assert.equal(wireSessionAffinityId(longA), undefined)
  assert.deepEqual(
    directSessionAffinityHeaders(
      { name: 'custom-name', baseURL: 'https://opencode.ai/zen/go/v1' },
      'session-opaque-value',
    ),
    { 'x-opencode-session': 'session-opaque-value' },
  )
  assert.deepEqual(
    directSessionAffinityHeaders({ name: 'ordinary', baseURL: 'https://example.com/v1' }, undefined),
    {},
  )
  assert.deepEqual(
    directSessionAffinityHeaders(
      { name: 'opencode-go', baseURL: 'https://example.com/v1' },
      'must-not-leak',
    ),
    {},
  )
})

test('callOpenAICompatible sends x-opencode-session only on the direct OpenCode Go transport', async () => {
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init.headers }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const text = await callOpenAICompatible(
      { name: 'opencode-go', baseURL: 'https://opencode.ai/zen/go/v1', model: 'm', apiKeyEnv: '' },
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      { sessionId: 'session-410-direct' },
    )
    assert.equal(text, 'OK')
    assert.equal(captured.headers['x-opencode-session'], 'session-410-direct')
  } finally {
    globalThis.fetch = original
  }
})

test('direct OpenCode Go transport fails before fetch when no stable session identity exists', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('must not fetch')
  }
  try {
    await assert.rejects(
      callOpenAICompatible(
        { name: 'opencode-go', baseURL: 'https://opencode.ai/zen/go/v1', model: 'm', apiKeyEnv: '' },
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ),
      (error) => error?.code === 'OPENCODE_SESSION_REQUIRED',
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
})


test('direct OpenCode Go rejects non-ByteString or rewritten session ids before fetch', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new Error('must not fetch') }
  try {
    for (const sessionId of ['会话-123', 'session-😀', ' padded ']) {
      await assert.rejects(
        callOpenAICompatible(
          { name: 'opencode-go', baseURL: 'https://opencode.ai/zen/go/v1', model: 'm', apiKeyEnv: '' },
          [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          { sessionId },
        ),
        (error) => error?.code === 'OPENCODE_SESSION_INVALID',
      )
    }
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('direct-backend entries preserve the DSH sessionId into the provider-transport request', async () => {
  // P5 (plan §4.2/§4.5): `vision-http` is no longer a Host provider. The same
  // opencode-go affinity contract now rides the direct provider transport —
  // the transport call below is exactly what the vision tools execute for a
  // configured direct-backend row, and no Host adapter is involved.
  const config = {
    freeFallback: false,
    httpProviders: [
      {
        name: 'opencode-go',
        baseURL: 'https://opencode.ai/zen/go/v1',
        model: 'vision-model',
        apiKeyEnv: '',
      },
    ],
  }
  const { ctx } = mockHarnessCtx({ config0: config })
  apply(ctx, Config(config))
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (_url, init) => {
    captured = init.headers
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const text = await callOpenAICompatible(
      { name: 'opencode-go', baseURL: 'https://opencode.ai/zen/go/v1', model: 'vision-model', apiKeyEnv: '' },
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      { sessionId: 'session-410-direct-backend' },
    )
    assert.equal(text, 'OK')
    assert.equal(captured?.['x-opencode-session'], 'session-410-direct-backend')
  } finally {
    globalThis.fetch = original
  }
})

test('the offloaded history contract keeps placeholder semantics with no Host registry behind direct-backend rows', async () => {
  // P5 (plan §4.2/§4.5): the whole-turn vision-http serializer is retired with
  // the route. The surviving request-image contracts are: (a) a direct-backend
  // row is never served through the Host llm registry, and (b) an offloaded
  // occurrence stays deterministic placeholder text — the same primitive the
  // direct executor and the pre-step projection (vision-image-projection) use.
  const config = {
    freeFallback: false,
    httpProviders: [
      {
        name: 'offload-test',
        baseURL: 'https://example.test/v1',
        model: 'vision-model',
        apiKeyEnv: '',
      },
    ],
  }
  // Deliberately omit the attachment service: nothing in the direct-backend
  // chain may try to read an offloaded occurrence's bytes.
  const { ctx, captured } = mockHarnessCtx({ config0: config, attachments: false })
  apply(ctx, Config(config))
  assert.throws(() => ctx.llm.registration('vision-http'), /no adapter registered/,
    'vision-http must not be a Host provider anymore')
  assert.equal(captured.streamCalls.length, 0, 'no Host llm.stream call backs a direct-backend row')

  const block = {
    type: 'image',
    offloaded: true,
    attachment: { attachmentId: 'sha256:fedcba9876543210', mediaType: 'image/png' },
  }
  const placeholder = offloadedImagePlaceholder(block)
  assert.match(placeholder, /sha256:fedcba9876543210/)
  assert.match(placeholder, /image omitted/i)
  assert.equal(placeholder.includes('data:image'), false)
  // Non-offloaded retained occurrences keep requiring real bytes: only the
  // Host-owned offloaded mark authorizes the placeholder path.
  assert.equal(isOffloadedImageBlock(block), true)
  assert.equal(isOffloadedImageBlock({ ...block, offloaded: false }), false)
})

test('callOpenAICompatible surfaces non-ok responses as errors', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('{"message":"quota"}', { status: 402, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(
      () =>
        callOpenAICompatible(
          { name: 't', baseURL: 'https://example.com/v1', model: 'm' },
          [{ role: 'user', content: [] }],
        ),
      /402/,
    )
  } finally {
    globalThis.fetch = original
  }
})

test('callOpenAICompatible throws a typed 429 immediately instead of waiting and retrying', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('{"message":"API rate limit exceeded"}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '2' },
    })
  }
  try {
    await assert.rejects(
      callOpenAICompatible(
        { name: 't', baseURL: 'https://example.com/v1', model: 'm' },
        [{ role: 'user', content: [] }],
      ),
      (error) => {
        assert.equal(error.status, 429)
        assert.equal(error.code, 'RATE_LIMIT')
        assert.equal(error.providerRetryAfterMs, 2000)
        assert.match(error.message, /429/)
        return true
      },
    )
    // The circuit breaker owns the cooldown now: no blind in-band retry wait.
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('adapterAvailable reports registered adapters only', () => {
  const llm = {
    registration(provider) {
      if (provider === 'nope') throw new Error('NO_ADAPTER')
      return {}
    },
  }
  assert.equal(adapterAvailable(llm, 'openrouter'), true)
  assert.equal(adapterAvailable(llm, 'nope'), false)
})

test('cacheKeyFor covers chains, content, mode and question without retaining plaintext', () => {
  const base = {
    pairs: [{ provider: 'p', model: 'm' }],
    httpProviders: [{ name: 'ovh', model: 'qwen' }],
    contentIds: ['b', 'a'],
    wantJson: false,
    question: 'plain-question-marker',
  }
  const k1 = cacheKeyFor(base)
  assert.match(k1, /^v2:[a-f0-9]{64}$/)
  assert.equal(k1, cacheKeyFor({ ...base, contentIds: ['a', 'b'] }))
  assert.notEqual(k1, cacheKeyFor({ ...base, wantJson: true }))
  assert.notEqual(k1, cacheKeyFor({ ...base, httpProviders: [] }))
  assert.notEqual(k1, cacheKeyFor({ ...base, contentIds: ['b'] }))
  assert.notEqual(k1, cacheKeyFor({ ...base, question: 'different-question' }))
  assert.equal(k1.includes('plain-question-marker'), false)
})

test('httpProvidersOf keeps built-in OVH as final fallback unless disabled', () => {
  assert.equal(httpProvidersOf({}), DEFAULT_HTTP_PROVIDERS)
  assert.deepEqual(httpProvidersOf({}, false), [])
  const custom = [{ name: 'x', baseURL: 'https://x/v1', model: 'm' }]
  const withFallback = httpProvidersOf({ httpProviders: custom })
  assert.equal(withFallback[0], custom[0])
  assert.deepEqual(withFallback.slice(1), DEFAULT_HTTP_PROVIDERS)
  assert.deepEqual(httpProvidersOf({ httpProviders: custom }, false), custom)
})

test('dedupeHttpProviders also drops entries duplicating a chain provider name', () => {
  const http = [{ name: 'zhipu', baseURL: 'https://x/v1', model: 'glm-4v-flash' }]
  // a pair already covers provider zhipu through the adapter
  assert.deepEqual(
    dedupeHttpProviders([{ provider: 'zhipu', model: 'glm-4.6v-flash' }], http),
    [],
  )
  // an unrelated provider name keeps the http entry
  assert.equal(
    dedupeHttpProviders([{ provider: 'openrouter', model: 'qwen' }], http).length,
    1,
  )
})

test('dedupeHttpProviders drops only entries the vision-http chain covers', () => {
  // The default chain pair names the default OVH entry: the tool fallback must
  // drop it (never ask the free endpoint twice), while the RAW list feeding
  // the vision-http route keeps it so the pair has an adapter at all.
  const pairs = [{ provider: 'vision-http', model: 'ovh/Qwen2.5-VL-72B-Instruct' }]
  const raw = httpProvidersOf({})
  const deduped = dedupeHttpProviders(pairs, raw)
  assert.ok(raw.length > 0)
  assert.equal(raw.some((p) => `${p.name}/${p.model}` === 'ovh/Qwen2.5-VL-72B-Instruct'), true)
  assert.equal(deduped.some((p) => `${p.name}/${p.model}` === 'ovh/Qwen2.5-VL-72B-Instruct'), false)
  const unrelated = [{ name: 'ovh', baseURL: 'x', model: 'Other-VL' }]
  assert.equal(dedupeHttpProviders(pairs, unrelated).length, 1)
})

test('reverseRouteTarget rewrites vision-entry text turns back to the text provider', () => {
  const opts = {
    pairs: [{ provider: 'openrouter', model: 'qwen-vl' }],
    textProvider: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    hasAdapter: (provider) => provider === 'deepseek-official',
  }
  assert.deepEqual(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, opts),
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  )
  // already on the text provider — untouched
  assert.equal(
    reverseRouteTarget({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }, opts),
    undefined,
  )
  // a non-vision provider must never be hijacked
  assert.equal(reverseRouteTarget({ provider: 'some-other', model: 'x' }, opts), undefined)
  // text provider without an adapter — fall through untouched
  assert.equal(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, {
      ...opts,
      hasAdapter: () => false,
    }),
    undefined,
  )
})

test('switchRoute drops reasoningEffort and keeps the rest', () => {
  assert.deepEqual(
    switchRoute({ provider: 'a', model: 'm', reasoningEffort: 'max', maxTokens: 4096 }, 'b', 'n'),
    { provider: 'b', model: 'n', maxTokens: 4096 },
  )
  assert.deepEqual(switchRoute({ provider: 'a', model: 'm' }, 'b', 'n'), { provider: 'b', model: 'n' })
})

test('reverseRouteTarget keeps wrapper entries native and routes vision entries through the wrapper', () => {
  const base = {
    pairs: [{ provider: 'openrouter', model: 'qwen-vl' }],
    wrapperRoute: 'deepseek-vision',
    wrapperRegistered: true,
    textProvider: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    hasAdapter: () => true,
  }
  // wrapper entry handles text natively (strips images) — no rewrite
  assert.equal(
    reverseRouteTarget({ provider: 'deepseek-vision', model: 'deepseek-v4-pro' }, base),
    undefined,
  )
  // openrouter entry -> text turns go through the wrapper (strips + delegates)
  assert.deepEqual(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, base),
    { provider: 'deepseek-vision', model: 'deepseek-v4-pro' },
  )
  // wrapper disabled -> fall back to the text provider directly
  assert.deepEqual(
    reverseRouteTarget({ provider: 'openrouter', model: 'qwen-vl' }, {
      ...base,
      wrapperRoute: undefined,
      wrapperRegistered: false,
    }),
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  )
  // non-vision providers are never hijacked
  assert.equal(
    reverseRouteTarget({ provider: 'some-other', model: 'x' }, base),
    undefined,
  )
})

test('stripImageBlocks removes image blocks and leaves the rest', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { attachmentId: 'a' } }] },
    { role: 'user', content: [{ type: 'text', text: 'plain' }] },
  ]
  const out = stripImageBlocks(messages)
  assert.equal(out[0].content.length, 1)
  assert.equal(out[0].content[0].type, 'text')
  assert.equal(out[1], messages[1])
  assert.deepEqual(stripImageBlocks(undefined), [])
})

test('estimateTokens and trimMessagesToBudget fit long conversations', () => {
  const big = (n) => ({
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(n) }],
  })
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    big(3000),
    big(3000),
    big(3000),
    big(3000),
    { role: 'user', content: [{ type: 'text', text: 'last question' }, { type: 'image', attachment: { attachmentId: 'a' } }] },
  ]
  const trimmed = trimMessagesToBudget(messages, 5000)
  assert.equal(trimmed[0].role, 'system')
  assert.equal(trimmed[trimmed.length - 1].content[0].text, 'last question')
  const used = trimmed.reduce((sum, m) => sum + estimateTokens(m), 0)
  assert.ok(used <= 5000, `used ${used} > budget`)
  assert.ok(trimmed.length < messages.length)
})

test('estimateTokens counts image blocks at a fixed cost', () => {
  const withImage = estimateTokens({ content: [{ type: 'image', attachment: {} }] })
  assert.ok(withImage >= 1445)
})

test('estimateTokens prices DSH-offloaded images as text placeholders instead of image payloads', () => {
  const retained = estimateTokens({
    role: 'user',
    content: [{ type: 'image', attachment: { attachmentId: 'sha256:retained' } }],
  })
  const offloaded = estimateTokens({
    role: 'user',
    content: [{
      type: 'image',
      offloaded: true,
      attachment: { attachmentId: 'sha256:offloaded' },
    }],
  })
  assert.ok(offloaded > 0)
  assert.ok(offloaded < retained / 10)
})

test('estimateMessages sums the array (the call-site bug guard)', () => {
  const messages = [
    { content: [{ type: 'text', text: 'x'.repeat(300) }] },
    { content: [{ type: 'text', text: 'y'.repeat(300) }] },
  ]
  assert.ok(estimateMessages(messages) > 0)
  assert.equal(estimateTokens(messages), 0) // an array alone must not be counted
})

test('replaceImageBlocksWithMemory substitutes cached descriptions and honest placeholders', () => {
  const memory = new Map([['img-1', '一只戴帽子的猫']])
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } },
        { type: 'image', attachment: { attachmentId: 'img-2', name: 'b.png' } },
        { type: 'text', text: '两张图' },
      ],
    },
  ]
  const out = replaceImageBlocksWithMemory(messages, memory)
  const blocks = out[0].content
  assert.equal(blocks.filter((b) => b.type === 'image').length, 0)
  assert.ok(blocks[0].text.includes('戴帽子的猫'))
  assert.ok(blocks[0].text.includes('a.png'))
  assert.ok(blocks[1].text.includes('b.png'))
  assert.ok(blocks[1].text.includes('未随本次文本请求发送'))
  assert.equal(blocks[2].text, '两张图')
})

test('replaceImageBlocksWithMemory accepts a plain object map', () => {
  const out = replaceImageBlocksWithMemory(
    [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] }],
    { x: '内容' },
  )
  assert.ok(out[0].content[0].text.includes('内容'))
})

test('rewriteHistoryImages uses cached descriptions and markers for the rest', () => {
  const memory = new Map([['img-1', '一只戴帽子的猫']])
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } },
        { type: 'image', attachment: { attachmentId: 'img-2', name: 'b.png' } },
        { type: 'text', text: '两张图' },
      ],
    },
  ]
  const out = rewriteHistoryImages(messages, memory)
  const blocks = out.messages[0].content
  assert.equal(blocks.filter((b) => b.type === 'image').length, 0)
  assert.ok(blocks[0].text.includes('戴帽子的猫'))
  assert.ok(blocks[1].text.includes('vision_describe'))
  assert.ok(blocks[1].text.includes('img-2'))
  assert.equal(blocks[2].text, '两张图')
  assert.equal(out.attachments.length, 1)
  assert.equal(out.attachments[0].attachmentId, 'img-2')
})

test('rewriteHistoryImages returns the same messages array when nothing changed', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: '纯文本' }] }]
  const out = rewriteHistoryImages(messages, new Map())
  assert.equal(out.messages, messages)
  assert.equal(out.attachments.length, 0)
  const empty = rewriteHistoryImages(undefined, new Map())
  assert.equal(empty.messages, undefined)
})

test('rewriteImagesDeep descends into tool-result content and preserves identity', () => {
  const ref = { attachmentId: 'img-n', name: 'n.png' }
  const input = [
    {
      type: 'tool-result',
      toolCallId: 'c1',
      content: [
        { type: 'text', text: 'Read image n.png' },
        { type: 'image', attachment: ref },
      ],
    },
    { type: 'text', text: 'tail' },
  ]
  const out = rewriteImagesDeep(input, (block) => ({
    type: 'text',
    text: `marker:${block.attachment.attachmentId}`,
  }))
  assert.equal(out.changed, true)
  assert.equal(out.content[0].type, 'tool-result')
  assert.equal(out.content[0].content[0].type, 'text')
  assert.equal(out.content[0].content[1].text, 'marker:img-n')
  assert.equal(out.content[1], input[1])
  // untouched input keeps the same array identity
  const untouched = rewriteImagesDeep([{ type: 'text', text: 'x' }], () => ({ type: 'text' }))
  assert.equal(untouched.changed, false)
  assert.equal(untouched.content[0].type, 'text')
})

test('rewriteImageBlocks rewrites images nested inside tool results', () => {
  const ref = { attachmentId: 'att-2', mediaType: 'image/png' }
  const { messages, attachments } = rewriteImageBlocks([
    {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [
            { type: 'text', text: 'Read image shot.png (1200x800)' },
            { type: 'image', attachment: ref },
          ],
        },
        { type: 'text', text: '继续' },
      ],
    },
  ])
  const blocks = messages[0].content
  const result = blocks[0]
  assert.equal(result.type, 'tool-result')
  assert.equal(result.content[0].type, 'text')
  assert.equal(result.content.filter((b) => b.type === 'image').length, 0)
  assert.match(result.content[1].text, /att-2/)
  assert.match(result.content[1].text, /vision_describe/)
  assert.equal(blocks[1].text, '继续')
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0], ref)
})

test('stripImageBlocks removes nested tool-result images too', () => {
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c',
          content: [
            { type: 'text', text: 't' },
            { type: 'image', attachment: { attachmentId: 'a' } },
          ],
        },
      ],
    },
  ]
  const out = stripImageBlocks(messages)
  assert.equal(out[0].content[0].type, 'tool-result')
  assert.deepEqual(out[0].content[0].content, [{ type: 'text', text: 't' }])
})

test('collectImageBlocks finds nested tool-result images and dedupes', () => {
  const ref = { attachmentId: 'img-x', name: 'x.png' }
  const blocks = collectImageBlocks([
    { role: 'user', content: [{ type: 'tool-result', content: [{ type: 'image', attachment: ref }] }] },
    { role: 'user', content: [{ type: 'image', attachment: ref }] },
  ])
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].id, 'img-x')
})

test('replaceImageBlocksWithMemory rewrites nested tool-result images', () => {
  const memory = new Map([['img-1', '一只戴帽子的猫']])
  const out = replaceImageBlocksWithMemory(
    [
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            content: [
              { type: 'text', text: 'ok' },
              { type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } },
            ],
          },
        ],
      },
    ],
    memory,
  )
  const nested = out[0].content[0].content
  assert.equal(nested.filter((b) => b.type === 'image').length, 0)
  assert.ok(nested[1].text.includes('戴帽子的猫'))
})

test('rewriteHistoryImages rewrites nested tool-result images (UNSUPPORTED_CONTENT guard)', () => {
  const memory = new Map()
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-read',
          content: [
            { type: 'text', text: 'Read image shot.png (1200x800)' },
            { type: 'image', attachment: { attachmentId: 'img-9', name: 'shot.png' } },
          ],
        },
      ],
    },
  ]
  const out = rewriteHistoryImages(messages, memory)
  const nested = out.messages[0].content[0].content
  assert.equal(nested.filter((b) => b.type === 'image').length, 0)
  assert.ok(nested[1].text.includes('img-9'))
  assert.ok(nested[1].text.includes('vision_describe'))
  assert.equal(out.attachments.length, 1)
  assert.equal(out.attachments[0].attachmentId, 'img-9')
})

test('stealth stream strips nested tool-result images before the text-only delegate', async () => {
  let delegateCall
  const ctx = {
    logger: { warn() {} },
    llm: {
      async *stream(options) {
        delegateCall = options
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const adapter = createStealthAdapter(ctx, {
    native: {
      providerInfo: () => ({ id: 'x', name: 'DeepSeek' }),
      providerRetryPolicy: () => undefined,
      listModels: async () => [],
      resolveModel: async (p, m) => ({ provider: p, id: m, name: m }),
    },
    imageMemory: new Map(),
    delegateProvider: 'deepseek-official-native',
  })
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [
            { type: 'text', text: 'Read image x.png' },
            { type: 'image', attachment: { attachmentId: 'img-7', name: 'x.png' } },
          ],
        },
        { type: 'text', text: '下一轮' },
      ],
    },
  ]
  for await (const _chunk of adapter.stream({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    messages,
  })) {
    /* drain */
  }
  const sent = delegateCall.messages[0]
  assert.equal(sent.content[0].type, 'tool-result')
  assert.equal(sent.content[0].content.filter((b) => b.type === 'image').length, 0)
  assert.ok(sent.content[0].content[1].text.includes('img-7'))
  assert.ok(sent.content[0].content[1].text.includes('vision_describe'))
  // the original log keeps the nested image so the Web UI can still show it
  assert.equal(messages[0].content[0].content[1].type, 'image')
})

test('lastUserText returns the current user question', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '旧问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
    { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'i' } }, { type: 'text', text: '新问题' }] },
  ]
  assert.equal(lastUserText(messages), '新问题')
  assert.equal(lastUserText([{ role: 'assistant', content: [] }]), '')
})

test('longOcrWindows slices with overlap and covers the full height', () => {
  // 3000px tall, 1200px chunks, 120px overlap -> tops 0, 1080, 2160 (last clamps to 3000)
  const windows = longOcrWindows(3000, 1200, 120)
  assert.deepEqual(windows, [
    { top: 0, bottom: 1200 },
    { top: 1080, bottom: 2280 },
    { top: 2160, bottom: 3000 },
  ])
  // single short image -> one window
  assert.deepEqual(longOcrWindows(600, 1200, 120), [{ top: 0, bottom: 600 }])
  // exact multiple with overlap lands the last chunk clamped at height
  assert.deepEqual(longOcrWindows(2400, 1200, 0), [
    { top: 0, bottom: 1200 },
    { top: 1200, bottom: 2400 },
  ])
})

test('parseBox validates string and object forms', () => {
  assert.deepEqual(parseBox('10,20,110,120'), { x1: 10, y1: 20, x2: 110, y2: 120 })
  assert.deepEqual(parseBox({ x1: 1, y1: 2, x2: 3, y2: 4 }), { x1: 1, y1: 2, x2: 3, y2: 4 })
  assert.equal(parseBox('10,20,110'), undefined)
  assert.equal(parseBox('10,20,10,30'), undefined) // x2 <= x1
  assert.equal(parseBox('-1,0,10,10'), undefined)
  assert.equal(parseBox(undefined), undefined)
})

test('computePixelDiff counts differing pixels and worst grid cells', () => {
  // 4x4 image, left half identical, right half fully different
  const a = Buffer.alloc(4 * 4 * 4, 10)
  const b = Buffer.alloc(4 * 4 * 4, 10)
  for (let y = 0; y < 4; y++) {
    for (let x = 2; x < 4; x++) {
      b[(y * 4 + x) * 4] = 200
    }
  }
  const diff = computePixelDiff(a, b, 16, 4, 4)
  assert.equal(diff.total, 16)
  assert.equal(diff.differing, 8)
  assert.equal(diff.ratio, 0.5)
  assert.ok(diff.cells.length > 0)
  assert.ok(diff.mask[0] === 0 && diff.mask[2] === 1)
})

test('renderDiffHeatmap marks differing pixels red on a grayscale base', () => {
  const raw = Buffer.alloc(2 * 2 * 4, 255)
  const mask = new Uint8Array([0, 1, 0, 0])
  const out = renderDiffHeatmap(raw, mask, 2, 2)
  assert.deepEqual([out[0], out[1], out[2], out[3]], [255, 255, 255, 255]) // gray
  assert.deepEqual([out[4], out[5], out[6], out[7]], [255, 0, 0, 255]) // red
})

test('quantizeColors returns dominant hex colors with shares', () => {
  const raw = Buffer.alloc(100 * 4)
  for (let i = 0; i < 80; i++) {
    raw[i * 4] = 10
    raw[i * 4 + 1] = 20
    raw[i * 4 + 2] = 30
    raw[i * 4 + 3] = 255
  }
  for (let i = 80; i < 100; i++) {
    raw[i * 4] = 200
    raw[i * 4 + 1] = 210
    raw[i * 4 + 2] = 220
    raw[i * 4 + 3] = 255
  }
  const colors = quantizeColors(raw, 2)
  assert.equal(colors.length, 2)
  assert.equal(colors[0].count, 80)
  assert.ok(colors[0].hex.startsWith('#'))
})

test('boxToSvg draws a rect with pixel coordinates', () => {
  const svg = boxToSvg({ x1: 5, y1: 6, x2: 15, y2: 26 }, 100, 100).toString()
  assert.ok(svg.includes('x="5" y="6"'))
  assert.ok(svg.includes('width="10" height="20"'))
})

test('createStealthAdapter mirrors the stock catalog but declares image input', async () => {
  const native = {
    providerInfo: (p) => ({ id: p, name: 'DeepSeek' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: 'DeepSeek-V4-Pro' }),
  }
  const ctx = {
    logger: { warn() {} },
    llm: {
      async *stream() {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const imageMemory = new Map()
  const adapter = createStealthAdapter(ctx, {
    native,
    imageMemory,
    pairs: () => [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    chainRoute: () => 'vision-chain',
    delegateProvider: 'deepseek-official-native',
  })
  assert.equal(adapter.providerInfo('deepseek-official').name, 'DeepSeek')
  assert.equal(adapter.providerRetryPolicy('deepseek-official'), 'retry')
  const listed = await adapter.listModels('deepseek-official')
  assert.equal(listed[0].id, 'deepseek-v4-pro')
  assert.deepEqual(listed[0].inputModalities, ['text', 'image'])
  assert.deepEqual(await adapter.listModels('deepseek-vision'), [])
  const info = await adapter.resolveModel('deepseek-official', 'deepseek-v4-pro')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
})

test('stealth stream delegates text turns to the native route with memory substitution', async () => {
  let delegateCall
  const ctx = {
    logger: { warn() {} },
    llm: {
      async *stream(options) {
        delegateCall = options
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const imageMemory = new Map([['img-1', '一只猫']])
  const adapter = createStealthAdapter(ctx, {
    native: {
      providerInfo: () => ({ id: 'x', name: 'DeepSeek' }),
      providerRetryPolicy: () => undefined,
      listModels: async () => [],
      resolveModel: async (p, m) => ({ provider: p, id: m, name: m }),
    },
    imageMemory,
    pairs: () => [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    chainRoute: () => 'vision-chain',
    delegateProvider: 'deepseek-official-native',
  })
  const messages = [
    {
      role: 'user',
      content: [{ type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } }, { type: 'text', text: '这张图是什么' }],
    },
  ]
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'deepseek-official', model: 'deepseek-v4-pro', messages })) {
    chunks.push(chunk)
  }
  assert.equal(delegateCall.provider, 'deepseek-official-native')
  assert.equal(delegateCall.model, 'deepseek-v4-pro')
  assert.ok(delegateCall.messages[0].content[0].text.includes('一只猫'))
  assert.equal(delegateCall.messages[0].content.filter((b) => b.type === 'image').length, 0)
  assert.equal(chunks[0].type, 'finish')
})

test('stealth stream keeps the log intact and hands the model a tool-hint marker', async () => {
  let streamCalls = 0
  let delegateCall
  const ctx = {
    logger: { warn() {} },
    llm: {
      async *stream(options) {
        streamCalls += 1
        delegateCall = options
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const adapter = createStealthAdapter(ctx, {
    native: {
      providerInfo: () => ({ id: 'x', name: 'DeepSeek' }),
      providerRetryPolicy: () => undefined,
      listModels: async () => [],
      resolveModel: async (p, m) => ({ provider: p, id: m, name: m }),
    },
    imageMemory: new Map(),
    delegateProvider: 'deepseek-official-native',
  })
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'img-9', name: 'b.png' } },
        { type: 'text', text: '看看这张图' },
      ],
    },
  ]
  for await (const _chunk of adapter.stream({ provider: 'deepseek-official', model: 'deepseek-v4-pro', messages })) {
    /* drain */
  }
  // exactly one llm call: the delegate. No automatic vision pass burns quota.
  assert.equal(streamCalls, 1)
  // the logged messages keep the image block (the Web UI still shows it)
  assert.equal(messages[0].content[0].type, 'image')
  // the model's input carries a compact marker pointing at the vision tools
  const head = delegateCall.messages[0].content[0]
  assert.equal(head.type, 'text')
  assert.ok(head.text.includes('img-9'))
  assert.ok(head.text.includes('vision_describe'))
  assert.equal(delegateCall.messages[0].content.filter((b) => b.type === 'image').length, 0)
})

// ── apply() end-to-end: the harness-shaped mock ────────────────────────────
//
// Regression guard: apply() once crashed with "Cannot access 'chainRoute'
// before initialization" because the stealth/wrapper blocks referenced the
// `chainRoute` const before its declaration (the TDZ bug that shipped a dead
// plugin). These tests apply the full plugin against a harness-shaped mock
// ctx, so ordering bugs inside apply() fail loudly here instead of at boot.

function mockHarnessCtx({ stockRoute = false, config0 = {}, skills = false, attachments = false, opencodeGo = false } = {}) {
  const adapters = new Map() // provider -> adapter
  const registrations = new Map() // provider -> { adapter, retryPolicy }
  const directories = [] // configurable-provider registrations (directory seam)
  const captured = { skills: [], tools: [], guards: [], streamCalls: [], settingsReads: [], on: new Map() }
  // The mutable user document and the watch seam: tests flip config0 fields
  // and fire the watchers to simulate a settings-card save.
  const userDoc = config0
  const settingsWatchers = []
  if (stockRoute) {
    const stock = {
      providerInfo: (p) => ({ id: p, name: 'DeepSeek' }),
      providerRetryPolicy: () => 'retry',
      listModels: async (p) => [
        { provider: p, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
        { provider: p, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
      ],
      resolveModel: async (p, m) => ({
        provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 1000000 },
      }),
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    adapters.set('deepseek-official', stock)
    registrations.set('deepseek-official', {
      adapter: stock,
      provider: { id: 'deepseek-official', name: 'DeepSeek' },
      retryPolicy: 'retry',
    })
  }
  if (opencodeGo) {
    // A pi-ai-shaped adapter for the opencode-go route: the catalog-correction
    // seam feature-detects `adapter.config.profiles().get(provider).piProvider`.
    // `opencodeGo === 'fixed'` serves the upstream-fixed catalog (anthropic),
    // so corrections must stand down and the harness path keeps the call.
    const piProfile = {
      piProvider: {
        auth: { apiKey: { resolve: async () => ({ auth: { apiKey: ['sk', 'opencode'].join('-') } }) } },
        getModels: () =>
          opencodeGo === 'fixed'
            ? [{ id: 'qwen3.6-plus', api: 'anthropic-messages', baseUrl: 'https://opencode.ai/zen/go' }]
            : [{ id: 'qwen3.6-plus', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1' }],
      },
    }
    const adapter = {
      config: {
        profiles: () => {
          const map = new Map()
          map.set('opencode-go', piProfile)
          return map
        },
      },
      providerInfo: (p) => ({ id: p, name: 'OpenCode Go' }),
      providerRetryPolicy: () => undefined,
      listModels: async (p) => [
        { provider: p, id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', inputModalities: ['text', 'image'] },
      ],
      resolveModel: async (p, m) => ({
        provider: p,
        id: m,
        name: m,
        inputModalities: ['text', 'image'],
        context: { contextWindow: 1000000 },
      }),
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    adapters.set('opencode-go', adapter)
    registrations.set('opencode-go', {
      adapter,
      provider: { id: 'opencode-go', name: 'OpenCode Go' },
      retryPolicy: undefined,
    })
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return { get: (namespace) => { captured.settingsReads.push(namespace); return undefined } }
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
      if (name === 'attachments' && attachments) {
        const store = {
          readImage: async (ref) => ({ ref, data: Buffer.from('not-a-real-image') }),
          saveImage: async ({ data, mediaType, name }) => ({
            attachmentId: `saved-${data.length}`,
            mediaType,
            name,
          }),
        }
        if (attachments === 'batch') {
          store.saveImages = async (items) => Promise.all(items.map((item) => store.saveImage(item)))
        }
        return store
      }
      if (name === 'skills' && skills) {
        return {
          register: (skill) => {
            captured.skills.push(skill)
            return () => {}
          },
        }
      }
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
    effect(fn) {
      const dispose = typeof fn === 'function' ? fn() : undefined
      let active = true
      return () => {
        if (!active) return
        active = false
        return typeof dispose === 'function' ? dispose() : undefined
      }
    },
    on(event, handler) {
      captured.on.set(event, handler)
    },
    inject(deps, callback) {
      const effect = (factory) => {
        const dispose = typeof factory === 'function' ? factory() : undefined
        let active = true
        return () => {
          if (!active) return
          active = false
          return typeof dispose === 'function' ? dispose() : undefined
        }
      }
      if (Array.isArray(deps) && deps.includes('webServer')) {
        callback({
          webServer: { register() { return () => {} } },
          effect,
        })
        return
      }
      // settings seam: run synchronously against a mock settings service that
      // mirrors the real one — schema defaults over the composition entry
      // (apply's `config`, passed as `base`) over the user document (userDoc).
      const scope = {
        get: () => ({ ...Config({}), ...userDoc }),
        watch: (fn) => {
          settingsWatchers.push(fn)
          return () => {
            const index = settingsWatchers.indexOf(fn)
            if (index !== -1) settingsWatchers.splice(index, 1)
          }
        },
      }
      callback({
        settings: {
          register: (_name, _schema, options) => {
            const base = options && options.base ? options.base : {}
            return { ...scope, get: () => ({ ...Config({}), ...base, ...userDoc }) }
          },
        },
        effect,
      })
    },
    tools: {
      register: (tool) => { captured.tools.push(tool); return () => {} },
      guard: (guard) => { captured.guards.push(guard); return () => {} },
    },
    llm: {
      registerAdapter(providers, adapter) {
        const owned = new Set()
        let released = false
        const prepare = (next) => {
          const prepared = []
          const seen = new Set()
          for (const provider of next) {
            if (seen.has(provider) || (adapters.has(provider) && !owned.has(provider))) {
              const error = new Error(`an adapter for provider "${provider}" is already registered`)
              error.code = 'DUPLICATE_ADAPTER'
              throw error
            }
            const info = adapter.providerInfo ? adapter.providerInfo(provider) : { id: provider, name: provider }
            if (!info || info.id !== provider || typeof info.name !== 'string' || info.name === '') {
              const error = new Error(`invalid adapter metadata for provider "${provider}"`)
              error.code = 'INVALID_ADAPTER'
              throw error
            }
            seen.add(provider)
            prepared.push({
              provider,
              info: { id: info.id, name: info.name },
              retryPolicy: adapter.providerRetryPolicy ? adapter.providerRetryPolicy(provider) : undefined,
            })
          }
          return prepared
        }
        const commit = (prepared) => {
          for (const provider of owned) {
            if (adapters.get(provider) === adapter) adapters.delete(provider)
            const registration = registrations.get(provider)
            if (registration && registration.adapter === adapter) registrations.delete(provider)
          }
          owned.clear()
          for (const entry of prepared) {
            adapters.set(entry.provider, adapter)
            registrations.set(entry.provider, {
              adapter,
              provider: entry.info,
              retryPolicy: entry.retryPolicy,
            })
            owned.add(entry.provider)
          }
        }
        commit(prepare(providers))
        // Mirror DSH's registration handle closely enough to catch snapshot
        // metadata regressions: providerInfo/retryPolicy are captured at commit
        // time, and replace() re-reads them before an atomic same-route swap.
        const handle = () => {
          if (released) return
          released = true
          commit([])
        }
        handle.replace = (next) => {
          if (released) {
            const error = new Error('registration disposed')
            error.code = 'REGISTRATION_DISPOSED'
            throw error
          }
          commit(prepare(next))
        }
        return handle
      },
      registration(provider) {
        const hit = registrations.get(provider)
        if (hit === undefined) throw new Error(`no adapter registered for provider "${provider}"`)
        return hit
      },
      registerConfigurableProviders: (entries) => {
        directories.push({ entries })
        return { replace: () => {} }
      },
      listProviders() {
        return [...registrations.values()].map((registration) => ({ ...registration.provider }))
      },
      async listModels(provider) {
        const hit = registrations.get(provider)
        if (hit === undefined || typeof hit.adapter.listModels !== 'function') return []
        return hit.adapter.listModels(provider)
      },
      async resolveModelInfo(provider, model) {
        const hit = registrations.get(provider)
        if (hit === undefined || typeof hit.adapter.resolveModel !== 'function') {
          throw new Error(`no adapter registered for provider "${provider}"`)
        }
        return hit.adapter.resolveModel(provider, model)
      },
      stream: async function* (options) {
        captured.streamCalls.push(options)
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  return { ctx, adapters, captured, directories, userDoc, settingsWatchers }
}

test('apply wires the degraded local-evidence Host tool guard when supported', () => {
  const { ctx, captured } = mockHarnessCtx()
  apply(ctx, Config({}))
  assert.equal(captured.guards.length, 1)
  assert.equal(captured.guards[0]({ name: 'bash', arguments: { command: 'npm test' } }), undefined)
})

test('vision describe success context is agent-scoped trusted metadata and preserves exact-text verification', () => {
  const exec = { name: 'vision_describe', callId: 'call-42', agent: { session: { header: { version: 4 } } } }
  const result = { isError: false, value: '{"x":1}', content: [{ type: 'text', text: '{"x":1}' }] }
  const context = visionDescribeSuccessContext(exec, result)
  assert.equal(context.id, 'vision-router-evidence-success-call-42')
  // #727 lands in two independent PRs: normalize source first (#731),
  // then stamp ContextFormed notice at its producer (#728). Enforce the exact
  // notice pair whenever present without rejecting the prior canonical source.
  assert.deepEqual(context.source, {
    kind: 'plugin:dsh-vision-router',
    ...(context.source.form === 'notice'
      ? { form: 'notice', summary: 'vision_describe succeeded' }
      : {}),
  })
  assert.match(context.content[0].text, /trusted execution metadata/)
  assert.match(VISION_SUCCESS_GUIDANCE, /continue the remaining user task/)
  assert.match(VISION_SUCCESS_GUIDANCE, /exactly the format the user requested/)
  assert.match(VISION_SUCCESS_GUIDANCE, /exact-text tasks/)
  assert.match(VISION_SUCCESS_GUIDANCE, /must not overwrite a more exact transcription/)
  assert.equal(visionDescribeSuccessContext({ ...exec, name: 'vision_ocr' }, result), undefined)
  assert.equal(visionDescribeSuccessContext({ ...exec, agent: undefined }, result), undefined)
  assert.equal(visionDescribeSuccessContext(exec, { ...result, isError: true }), undefined)
  assert.equal(visionDescribeSuccessContext(exec, { ...result, value: '' }), undefined)
  assert.equal(visionDescribeSuccessContext(exec, { ...result, value: '   ' }), undefined)
  assert.equal(
    visionDescribeSuccessContext(exec, {
      ...result,
      value: JSON.stringify({
        ok: false,
        code: 'VISION_BACKEND_UNAVAILABLE',
        retryable: false,
        reason: 'all backends failed',
      }),
    }),
    undefined,
    'Vision Router business failures are successful DSH dispatches but must not receive success guidance',
  )
  assert.notEqual(
    visionDescribeSuccessContext(exec, {
      ...result,
      value: JSON.stringify({ ok: false, code: 'USER_DATA', label: 'visible JSON' }),
    }),
    undefined,
    'arbitrary user-requested JSON must not be mistaken for a Vision Router failure envelope',
  )
})

test('vision describe post-execute guidance preserves canonical tool result and downstream policy', async () => {
  const { ctx, captured } = mockHarnessCtx()
  apply(ctx, Config({ freeFallback: false }))
  const post = captured.on.get('tools/post-execute')
  assert.equal(typeof post, 'function')
  const exec = { name: 'vision_describe', callId: 'call-99', agent: { session: { header: { version: 4 } } } }
  const result = { isError: false, value: '{"x":1}', content: [{ type: 'text', text: '{"x":1}' }] }
  const prior = { role: 'user', id: 'prior', content: [{ type: 'text', text: 'prior' }], source: { kind: 'plugin', plugin: 'other' } }
  const accepted = await post(exec, result, async () => ({ kind: 'accept', additionalContexts: [prior] }))
  assert.equal(accepted.kind, 'accept')
  assert.equal(Object.hasOwn(accepted, 'value'), false)
  assert.equal(Object.hasOwn(accepted, 'content'), false)
  assert.equal(accepted.additionalContexts.length, 2)
  assert.equal(accepted.additionalContexts[0].id, 'vision-router-evidence-success-call-99')
  assert.deepEqual(accepted.additionalContexts[0].source, {
    kind: 'plugin:dsh-vision-router',
    ...(accepted.additionalContexts[0].source.form === 'notice'
      ? { form: 'notice', summary: 'vision_describe succeeded' }
      : {}),
  })
  assert.equal(accepted.additionalContexts[1], prior)
  assert.equal(result.value, '{"x":1}', 'canonical tool value must remain byte-exact')

  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }
  assert.equal(await post(exec, result, async () => blocked), blocked)
  const other = { kind: 'accept', additionalContexts: [prior] }
  assert.equal(await post({ ...exec, name: 'vision_ocr' }, result, async () => other), other)
  assert.equal(await post(exec, { ...result, isError: true }, async () => other), other)
  const businessFailure = {
    ...result,
    value: JSON.stringify({
      ok: false,
      code: 'VISION_RATE_LIMITED',
      retryable: false,
      reason: 'rate limited',
    }),
  }
  assert.equal(
    await post(exec, businessFailure, async () => other),
    other,
    'post-execute must not label a Vision Router failure envelope as successful evidence',
  )

})

// ── P5 whole-turn routing: real-Host selection + legacy route retirement ────
//
// P5 (plan §4.2/§4.5): the wrapper/twin/chain adapters are retired and whole-
// turn routing selects REAL Host vision models only. The mock harness llm
// below is the HOST side; the plugin under test must never write into it —
// every assertion here also proves the plugin composed no route of its own.

test('apply selects no route: whole-turn routing rides real Host models only', () => {
  const { ctx, adapters, directories, captured } = mockHarnessCtx({ attachments: 'batch' })
  apply(ctx, Config({}))
  // Tools-first philosophy: the plugin mounts no routes at all. vision-http
  // and the wrapper/chain routes are retired (plan §4.2/§4.5) — legacy rows
  // resolve as direct-backend entries served by the provider transport, and
  // the settings schema keeps only compatibility data.
  assert.equal(adapters.size, 0)
  assert.deepEqual(directories, [])
  // No Host registration seam was touched (the mock throws on replace()).
  assert.equal(captured.on.get('llm/adapters-updated') !== undefined, true)
  // The retired whole-turn route ids stay unregistered while the legacy
  // compatibility fields keep their historical defaults for old profiles.
  assert.equal(adapters.has('vision-chain'), false)
  assert.equal(adapters.has('vision-http'), false)
  assert.equal(adapters.has('deepseek-vision'), false)
  assert.equal(adapters.has('deepseek-official-native'), false)
  assert.deepEqual(Config({}).providers, [
    { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] },
  ])
})

test('stealth defaults to false (issue #34: explicit opt-in, no stealth takeover by default)', () => {
  assert.equal(Config({}).stealth, false)
  assert.equal(Config({ stealth: undefined }).stealth, false)
})

test('wrappedProviders pre-fills the stock deepseek-official row out of the box', () => {
  // Retired compat data (plan §4.5): the row keeps its historical default so
  // old profiles resolve identically, but it no longer materializes a route.
  assert.deepEqual(Config({}).wrappedProviders, [{ provider: 'deepseek-official', models: [] }])
})


test('autoWrapProviders defaults to true', () => {
  assert.equal(Config({}).autoWrapProviders, true)
  assert.equal(Config({ autoWrapProviders: false }).autoWrapProviders, false)
})
test('the vision chain ships with the built-in free model as its first row', () => {
  assert.deepEqual(Config({}).providers, [
    { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B', fallbacks: [] },
  ])
})

test('legacy stealth/ownership intents never write routes, never resurrect the official route', async () => {
  // The old takeover tests asserted the plugin would mount/rebuild routes.
  // P5 flips the contract: with stealth on, a Host-owned official route, or a
  // late-arriving stock route, the plugin performs NO model-directory write —
  // the stock adapter (registered by the Host below) stays the only provider
  // and the settings seam is never read to reconstruct anything.
  const { ctx, adapters, directories, captured } = mockHarnessCtx({ attachments: 'batch' })
  apply(ctx, Config({ stealth: true }))
  assert.equal(adapters.has('deepseek-official-native'), false)
  assert.equal(adapters.has('deepseek-official'), false)
  assert.equal(
    captured.settingsReads.includes('llm-deepseek'),
    false,
    'supported ownership must never read stock settings to reconstruct a provider',
  )
  assert.deepEqual(
    directories.filter((entry) => entry.entries.some((row) => row && row.provider === 'deepseek-official')),
    [],
    'modern DVR must never claim the official provider directory when Host ownership is active',
  )
  assert.equal(adapters.size, 0, 'no route may be mounted by the plugin itself')

  // If the Host-owned row appears later, the adapter stays Host-owned: the
  // plugin never mirrors, twins or resurrects it (its catalog is read only).
  const lateStock = {
    providerInfo: (provider) => ({ id: provider, name: 'DeepSeek' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (provider) => [
      { provider, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
    ],
    resolveModel: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'] }),
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
  }
  ctx.llm.registerAdapter(['deepseek-official'], lateStock)
  assert.equal(adapters.has('deepseek-official-native'), false)
  assert.equal(ctx.llm.listProviders().length, 1)
  assert.equal(ctx.llm.listProviders()[0].id, 'deepseek-official')
})

test('stealth off + alive stock route performs no takeover at all', async () => {
  const { ctx, adapters } = mockHarnessCtx({ stockRoute: true })
  apply(ctx, Config({ stealth: false }))
  // the stock adapter keeps owning deepseek-official; the plugin registers no
  // hidden native route and performs no public takeover or directory write
  assert.equal(adapters.has('deepseek-official-native'), false)
  const stock = adapters.get('deepseek-official')
  const listed = await stock.listModels('deepseek-official')
  assert.deepEqual(listed[0].inputModalities, ['text'])
  assert.equal(adapters.size, 1, 'the Host stock route is the only registered provider')
  await assert.throws(
    () => ctx.llm.registration('deepseek-vision'),
    /no adapter registered/,
    'the retired wrapper route must not exist',
  )
})

// ── catalog routing corrections (issue: opencode-go qwen3.6-plus) ──────────
//
// The pi-ai catalog routes opencode-go/qwen3.6-plus to openai-completions
// while the gateway only serves it on /v1/messages; the correction dispatches
// the pair directly over the Anthropic protocol and stands down the moment
// the resolved catalog agrees. P5: the correction is exercised through the
// REAL execution path — the vision_describe tool's backend walk over the
// provider transport — not through a registered Host route (none exists).

const opencodeGoChainConfig = {
  providers: [{ provider: 'opencode-go', model: 'qwen3.6-plus' }],
  routing: true,
  downscale: false,
}

const driveDescribe = async ({ opencodeGoMode = true, config0 = opencodeGoChainConfig, sessionId = 'session-410-corrected', paths = ['/tmp/fake.png'], extraExec = {} } = {}) => {
  const { ctx, captured, adapters, directories } = mockHarnessCtx({
    opencodeGo: opencodeGoMode,
    attachments: true,
    config0,
  })
  const originalGet = ctx.get.bind(ctx)
  ctx.get = (name) => {
    if (name === 'fs') {
      return {
        resolve: async (value) => value,
        readBytes: async () => Buffer.from('fake-png-bytes'),
      }
    }
    return originalGet(name)
  }
  let hostStreamCalls = 0
  ctx.llm.stream = async function* () {
    hostStreamCalls += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'HOST ANSWER' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'HOST ANSWER' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  apply(ctx, Config(config0))
  const activate = captured.tools.find((entry) => entry?.name === 'vision_activate')
  assert.ok(activate)
  await activate.execute({}, {})
  const describe = captured.tools.find((entry) => entry?.name === 'vision_describe')
  assert.ok(describe)
  const exec = { agent: { session: { id: sessionId, events: [] } }, ...extraExec }
  return {
    ctx,
    captured,
    adapters,
    directories,
    hostStreamCalls: () => hostStreamCalls,
    run: (args = {}) => describe.execute({ paths, question: 'What is this?', ...args }, exec),
  }
}

test('catalog correction answers opencode-go/qwen3.6-plus on the Anthropic endpoint', async () => {
  const driver = await driveDescribe()
  const original = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  let answer
  try {
    answer = await driver.run()
  } finally {
    globalThis.fetch = original
  }
  // The answer came from the tool walk, and it went straight to the Anthropic
  // Messages endpoint, not through the harness adapter's openai-completions
  // route and not through any Host llm call.
  assert.equal(answer, 'OK')
  assert.equal(captured.url, 'https://opencode.ai/zen/go/v1/messages')
  assert.equal(captured.headers['x-api-key'], 'sk-opencode')
  assert.equal(captured.headers['anthropic-version'], '2023-06-01')
  assert.equal(captured.headers['x-opencode-session'], 'session-410-corrected')
  assert.equal(captured.body.model, 'qwen3.6-plus')
  assert.ok(
    captured.body.messages[0].content.some((block) => block.type === 'image'),
    'expected the image to reach the Anthropic payload as a base64 block',
  )
  assert.equal(driver.hostStreamCalls(), 0, 'the Host llm service never serves a configured vision row')
  assert.equal(driver.adapters.size, 0, 'no Host route may exist for the corrected pair')
})

test('vision backends never attribute a successful answer to any history image', async () => {
  const store = createSessionVisionStateStore()
  const owner = { id: 'session-offload-memory-owner' }
  const offloadedId = 'sha256:1111111111111111'
  const retainedId = 'sha256:2222222222222222'
  store.recordAttachments(owner, [
    { attachmentId: offloadedId, mediaType: 'image/png' },
    { attachmentId: retainedId, mediaType: 'image/png' },
  ])

  const driver = await driveDescribe({ sessionId: 'session-offload-memory-wire' })
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ content: [{ type: 'text', text: 'retained image answer' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  let answer
  try {
    answer = await driver.run()
  } finally {
    globalThis.fetch = original
  }
  // The answer itself is real backend output, but the tool walk never writes
  // it back into the session visual memory — attribution belongs to the
  // dedicated bootstrap/projection owners, so a stale or offloaded history
  // image can never inherit a fresh answer (issue #446-era whole-turn write-
  // back retired with the chain route).
  assert.equal(answer, 'retained image answer')
  assert.equal(store.hasDescription(owner, offloadedId), false)
  assert.equal(store.hasDescription(owner, retainedId), false)
  assert.equal(driver.hostStreamCalls(), 0)
})

test('the plugin never writes cross-turn descriptions into a Host-provided session store', async () => {
  // P5 write-back retirement, runtime-owned seam edition: even when the
  // composition supplies a sessionVision state store, the tool walk returns
  // the backend answer verbatim and records NOTHING into the store. The
  // precondition proves the describe execution path actually ran (a bootstrap
  // gate or any plugin state could otherwise mask the assertion).
  const store = createSessionVisionStateStore()
  const owner = { id: 'session-write-back-owner' }
  const attachmentId = 'sha256:3333333333333333'
  store.recordAttachments(owner, [{ attachmentId, mediaType: 'image/png' }])
  const config0 = {
    providers: [{ provider: 'opencode-go', model: 'qwen3.6-plus' }],
    downscale: false,
    structuredVisionBootstrap: false,
  }
  const { ctx, captured } = mockHarnessCtx({
    opencodeGo: 'fixed',
    attachments: true,
    config0,
  })
  const originalGet = ctx.get.bind(ctx)
  ctx.get = (name) => {
    if (name === 'fs') {
      return {
        resolve: async (value) => value,
        readBytes: async () => Buffer.from('fake-png-bytes'),
      }
    }
    return originalGet(name)
  }
  apply(ctx, Config(config0), { sessionVision: { stateStore: store } })
  const activate = captured.tools.find((entry) => entry?.name === 'vision_activate')
  assert.ok(activate)
  await activate.execute({}, {})
  const describe = captured.tools.find((entry) => entry?.name === 'vision_describe')
  assert.ok(describe)
  const answer = await describe.execute(
    { paths: ['/tmp/fake.png'], question: 'What is this?' },
    { agent: { session: { id: 'session-write-back-owner', events: [] } } },
  )
  assert.equal(answer, 'HOST ANSWER')
  // The walk returned a real backend answer, yet nothing was attributed to
  // the image (nor to any other attachment) in the runtime-owned store.
  assert.equal(store.hasDescription(owner, attachmentId), false)
})

test('vision_describe threads the live DSH session id into its child Harness call', async () => {
  const config = {
    providers: [{ provider: 'opencode-go', model: 'qwen3.6-plus' }],
    downscale: false,
  }
  const { ctx, captured } = mockHarnessCtx({
    opencodeGo: 'fixed',
    attachments: true,
    config0: config,
  })
  const originalGet = ctx.get.bind(ctx)
  ctx.get = (name) => {
    if (name === 'fs') {
      return {
        resolve: async (value) => value,
        readBytes: async () => Buffer.from('fake-png-bytes'),
      }
    }
    return originalGet(name)
  }
  let seen
  let seenAffinityScope
  ctx.llm.stream = async function* (options) {
    seen = options
    seenAffinityScope = currentVisionSessionAffinityId()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'saw it' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'saw it' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  apply(ctx, Config(config))
  const activate = captured.tools.find((entry) => entry?.name === 'vision_activate')
  assert.ok(activate)
  await activate.execute({}, {})
  const describe = captured.tools.find((entry) => entry?.name === 'vision_describe')
  assert.ok(describe)
  const result = await describe.execute(
    { paths: ['/tmp/fake.png'], question: 'what is here?' },
    { agent: { session: { header: { id: 'session-410-tool' }, events: [] } } },
  )
  assert.equal(result, 'saw it')
  assert.equal(seen?.provider, 'opencode-go')
  assert.equal(seen?.model, 'qwen3.6-plus')
  assert.equal(seen?.sessionId, 'session-410-tool')
  assert.equal(seenAffinityScope, 'session-410-tool')
})

test('Host OpenCode Go path rejects a non-wire-safe session before any egress', async () => {
  const driver = await driveDescribe({ sessionId: '会话-123' })
  const original = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('the affinity guard must fire before any HTTP egress')
  }
  let result
  try {
    result = await driver.run()
  } finally {
    globalThis.fetch = original
  }
  // The affinity validation aborts the attempt before pi-ai or any transport
  // runs; the walk degrades to the structured failure contract, never to a
  // silent pass-through and never to a Host route.
  assert.equal(fetchCalls, 0)
  assert.equal(driver.hostStreamCalls(), 0)
  const parsed = JSON.parse(result)
  assert.equal(parsed.ok, false)
  assert.match(parsed.attemptedProviders?.[0]?.error ?? result, /not safe for an HTTP header/)
})

test('the correction stands down once the catalog routes the pair correctly', async () => {
  const driver = await driveDescribe({ opencodeGoMode: 'fixed' })
  const original = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'SHOULD NOT RUN' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  let answer
  try {
    answer = await driver.run({ paths: ['/tmp/fake.png'] })
  } finally {
    globalThis.fetch = original
  }
  assert.equal(fetchCalls, 0, 'the corrected Anthropic path must not run once upstream is fixed')
  // With the upstream catalog already correct, the row rides the REAL Host
  // adapter through the harness llm service (with the session id threaded),
  // and the tool returns its answer — no composed Host route involved.
  assert.equal(answer, 'HOST ANSWER')
  assert.equal(driver.hostStreamCalls(), 1)
})

// ── legacy routing fallback (routing: true, chainRoute: '') ────────────────
//
// Regression guard: the agent/request fallback used to read current.provider /
// current.model, but `current` is a function — so every image turn in legacy
// routing mode was switched to provider/model undefined. It must route to the
// first chain pair instead, and leave the config alone when it is already on
// that pair.

function legacyRoutingHarness(configOverrides = {}) {
  const config = {
    provider: 'openrouter',
    providers: [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    routing: true,
    chainRoute: '',
    autoActivateOnImage: false,
    ...configOverrides,
  }
  const { ctx, captured } = mockHarnessCtx({ config0: config })
  apply(ctx, Config(config))
  const session = { events: [] }
  const payload = {
    agent: { session },
    turn: 7,
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } }],
      },
    ],
  }
  return {
    ctx,
    captured,
    session,
    payload,
    preStep: captured.on.get('agent/pre-step'),
    request: captured.on.get('agent/request'),
  }
}


function modernMidTurnRoutingHarness(tailSteps) {
  const config = {
    provider: 'openrouter',
    providers: [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    routing: true,
    chainRoute: '',
    autoActivateOnImage: false,
  }
  const { ctx, captured } = mockHarnessCtx({ config0: config })
  let syncReads = 0
  const session = {
    id: 'modern-midturn-session',
    snapshotEvents() { syncReads += 1; throw new Error('deprecated sync history read') },
  }
  Object.defineProperty(session, 'events', {
    get() { syncReads += 1; throw new Error('deprecated bare history read') },
  })
  const tailCalls = []
  let tailIndex = 0
  const sessionEventTailReader = async (_session, anchorSeq, options) => {
    tailCalls.push({ anchorSeq, options })
    const step = tailSteps[tailIndex++]
    if (step instanceof Error) throw step
    return step
  }
  apply(ctx, Config(config), {
    sessionTurnResolver: {
      turnOf: () => 7,
      eventAnchorOf: () => 5,
    },
    sessionEventTailReader,
  })
  const payload = {
    agent: { session },
    turn: 7,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }],
  }
  return {
    payload,
    preStep: captured.on.get('agent/pre-step'),
    request: captured.on.get('agent/request'),
    tailCalls,
    syncReads: () => syncReads,
  }
}

test('agent/request detects a modern mid-turn tool image through async Session tail reads only', async () => {
  const toolImage = {
    seq: 7,
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          content: [{ type: 'image', attachment: { attachmentId: 'sha256:0123456789abcdef0123456789abcdef' } }],
        }],
      },
    },
  }
  const harness = modernMidTurnRoutingHarness([
    { supported: true, events: [], capturedThroughSeq: 6, truncated: false },
    { supported: true, events: [toolImage], capturedThroughSeq: 7, truncated: false },
  ])
  await harness.preStep(harness.payload, async () => ({ messages: harness.payload.messages }))
  const routed = await harness.request(harness.payload, async () => ({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  }))
  assert.equal(routed.provider, 'openrouter')
  assert.equal(routed.model, 'qwen/qwen3-vl-235b-a22b-instruct')
  assert.equal(harness.syncReads(), 0)
  assert.deepEqual(harness.tailCalls, [
    { anchorSeq: 5, options: { collect: false } },
    { anchorSeq: 6, options: undefined },
  ])
})

test('agent/request keeps a modern text-only turn on the text route after an empty async tail scan', async () => {
  const harness = modernMidTurnRoutingHarness([
    { supported: true, events: [], capturedThroughSeq: 6, truncated: false },
    { supported: true, events: [{ seq: 7, type: 'step/start', data: {} }], capturedThroughSeq: 7, truncated: false },
  ])
  await harness.preStep(harness.payload, async () => ({ messages: harness.payload.messages }))
  const routed = await harness.request(harness.payload, async () => ({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  }))
  assert.equal(routed.provider, 'deepseek-official')
  assert.equal(routed.model, 'deepseek-v4-pro')
  assert.equal(harness.syncReads(), 0)
})

test('agent/request routes conservatively to vision when an advertised modern tail read fails', async () => {
  const harness = modernMidTurnRoutingHarness([
    { supported: true, events: [], capturedThroughSeq: 6, truncated: false },
    new Error('SessionQuery transient failure'),
  ])
  await harness.preStep(harness.payload, async () => ({ messages: harness.payload.messages }))
  const routed = await harness.request(harness.payload, async () => ({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  }))
  assert.equal(routed.provider, 'openrouter')
  assert.equal(routed.model, 'qwen/qwen3-vl-235b-a22b-instruct')
  assert.equal(harness.syncReads(), 0)
})

test('agent/request legacy routing sends image turns to the first chain pair', async () => {
  const { payload, preStep, request } = legacyRoutingHarness()
  assert.equal(typeof preStep, 'function')
  assert.equal(typeof request, 'function')
  await preStep(payload, async () => ({ messages: payload.messages }))
  const routed = await request(payload, async () => ({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  }))
  assert.equal(routed.provider, 'openrouter')
  assert.equal(routed.model, 'qwen/qwen3-vl-235b-a22b-instruct')
  // the effort belongs to the previous provider and must be dropped on switch
  assert.equal(routed.reasoningEffort, undefined)
})

test('agent/request legacy routing keeps the config when already on the first pair', async () => {
  const { payload, preStep, request } = legacyRoutingHarness()
  await preStep(payload, async () => ({ messages: payload.messages }))
  const config0 = {
    provider: 'openrouter',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
  }
  const routed = await request(payload, async () => ({ ...config0 }))
  assert.deepEqual(routed, config0)
})

// ── P5 direct-backend transport contract (replaces the retired vision-http
//    adapter cluster) ────────────────────────────────────────────────────────
//
// P5 (plan §4.2/§4.5): `vision-http` is no longer a Host provider — there is
// no adapter to resolveModel/stream. The surviving contracts are:
//   (a) a `vision-http/...` row must NEVER be registered with or served by
//       the Host llm registry (fail-closed negative assertions);
//   (b) the tool-side chain executes direct-backend rows through the
//       provider transport with the FULL harness chunk protocol.

test('a vision-http row is never a Host provider and never touches the llm registry', async () => {
  const { ctx, adapters, directories, captured } = mockHarnessCtx()
  apply(ctx, Config({
    providers: [{ provider: 'vision-http', model: 'ovh/Qwen2.5-VL-72B-Instruct' }],
  }))
  await assert.throws(
    () => ctx.llm.registration('vision-http'),
    /no adapter registered/,
    'vision-http must not be a Host provider anymore',
  )
  assert.equal(adapters.size, 0)
  assert.deepEqual(directories, [])
  // The Host llm service itself never receives a vision-http request either:
  // the default config only walks the direct-backend rows in the vision tools.
  assert.equal(captured.streamCalls.length, 0)
})

test('the direct-backend walk emits the indexed block protocol the assemblers need', async () => {
  const { ctx, captured } = mockHarnessCtx()
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  let chunks
  try {
    const text = await callOpenAICompatible(
      { name: 'ovh', baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', model: 'Qwen2.5-VL-72B-Instruct', apiKeyEnv: '' },
      [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    )
    assert.equal(text, 'hi')
    // The direct-backend executor (visionAnswer over the transport stream)
    // wraps the answer in the indexed chunk protocol; the tool assembler must
    // recover exactly that text.
    const blockStart = { type: 'block-start', index: 0, blockType: 'text' }
    const delta = { type: 'text-delta', index: 0, text }
    const blockEnd = { type: 'block-end', index: 0, block: { type: 'text', text } }
    const finish = { type: 'finish', reason: { kind: 'stop' } }
    const assembler = createChunkAssembler()
    for (const chunk of [blockStart, delta, blockEnd, finish]) assembler.push(chunk)
    assert.equal(assembler.finish(), 'hi')
    chunks = { text }
  } finally {
    globalThis.fetch = original
  }
  assert.equal(chunks.text, 'hi')
  assert.equal(captured.streamCalls.length, 0, 'no Host llm.stream call backs a direct-backend row')
})

test('apply registers the vision-tools skill with source and content', () => {
  const { ctx, captured } = mockHarnessCtx({ skills: true })
  apply(ctx, Config({}))
  const skill = captured.skills.find((s) => s.name === 'vision-tools')
  assert.ok(skill, 'expected the vision-tools skill registration')
  // the skill registry validates the LOADED definition against these fields
  assert.equal(typeof skill.source, 'string')
  assert.ok(skill.source.length > 0)
  assert.equal(typeof skill.content, 'string')
  assert.ok(skill.content.includes('vision_describe') || skill.content.includes('vision_ground'))
})

// ── retired auto-wrap/twin machine (plan §4.2): the guarded retirements ─────
//
// The old tests asserted the twin/wrapper directory machine. P5 removes that
// machine, so the same behavioral intents are now guarded as negative
// contracts: legacy intents stay inert (read-only schema data) and never
// write the Host directory, on apply, on adapters-updated, or on settings
// watch fires.

test('auto-wrap discovers nothing: the machine is retired and legacy intent stays inert', async () => {
  const { ctx, adapters, directories, captured } = mockHarnessCtx()
  const mixed = {
    providerInfo: (p) => ({ id: p, name: 'MiniMax' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'minimax-m2.7', name: 'MiniMax M2.7', inputModalities: ['text'] },
      { provider: p, id: 'minimax-vision-native', name: 'MiniMax Vision', inputModalities: ['text', 'image'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p,
      id: m,
      name: m,
      inputModalities: m === 'minimax-vision-native' ? ['text', 'image'] : ['text'],
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['minimax'], mixed)
  apply(ctx, Config({ autoWrapProviders: true }))
  assert.equal(adapters.has('minimax-vision'), false, 'no auto twin may be published (plan §4.2)')
  assert.equal(adapters.size, 0, 'no route may be mounted by the plugin itself')
  assert.deepEqual(directories, [])
  // Topology churn must not resurrect the retired machine either.
  const fire = captured.on.get('llm/adapters-updated')
  assert.ok(fire)
  fire()
  assert.equal(adapters.size, 0)
  // The native image-capable model stays attested as-is for the pre-step
  // router: the Host route itself is the vision route now.
  assert.deepEqual(
    await ctx.llm.resolveModelInfo('minimax', 'minimax-vision-native'),
    { provider: 'minimax', id: 'minimax-vision-native', name: 'MiniMax Vision', inputModalities: ['text', 'image'] },
  )
})

test('auto-wrap intent never follows providers that become live after plugin apply', async () => {
  const { ctx, adapters, captured } = mockHarnessCtx()
  apply(ctx, Config({ autoWrapProviders: true }))
  const thirdParty = {
    providerInfo: (p) => ({ id: p, name: 'Opencode' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['opencode-go'], thirdParty)
  const fire = captured.on.get('llm/adapters-updated')
  assert.ok(fire)
  fire()
  assert.equal(adapters.has('opencode-go-vision'), false, 'no twin may follow a late provider (plan §4.2)')
  assert.equal(adapters.size, 0)
})

test('explicit wrappedProviders intent stays read-only and produces no directory write', async () => {
  const { ctx, adapters, directories } = mockHarnessCtx()
  const thirdParty = {
    providerInfo: (p) => ({ id: p, name: p }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [{ provider: p, id: 'm1', name: 'm1', inputModalities: ['text'] }],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['minimax'], thirdParty)
  ctx.llm.registerAdapter(['opencode-go'], thirdParty)
  apply(ctx, Config({
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'opencode-go', models: [] }],
  }))
  assert.equal(adapters.has('minimax-vision'), false)
  assert.equal(adapters.has('opencode-go-vision'), false)
  assert.equal(adapters.size, 0)
  assert.deepEqual(directories, [])
})

test('wrappedProviders never registers an image-capable twin route for any intent', async () => {
  const { ctx, adapters, directories } = mockHarnessCtx()
  const thirdParty = {
    providerInfo: (p) => ({ id: p, name: 'Opencode' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['opencode-go'], thirdParty)
  apply(ctx, Config({
    wrappedProviders: [{ provider: 'opencode-go', models: ['deepseek-v4-flash'] }],
  }))
  assert.equal(adapters.has('opencode-go-vision'), false, 'the twin route is retired (plan §4.2)')
  assert.equal(adapters.size, 0)
  assert.deepEqual(directories, [])
  // The source route keeps its Host-owned identity untouched — the exact
  // adapter instance and metadata that the Host registered survive apply().
  const registration = ctx.llm.registration('opencode-go')
  assert.equal(registration.adapter, thirdParty)
  assert.deepEqual(
    await ctx.llm.resolveModelInfo('opencode-go', 'deepseek-v4-flash'),
    { provider: 'opencode-go', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'], context: { contextWindow: 100000 } },
  )
})

test('retired twin machinery never mirrors source reasoning metadata', async () => {
  const { ctx, adapters, directories } = mockHarnessCtx({
    config0: { wrappedProviders: [{ provider: 'opencode-go', models: [] }] },
  })
  const source = {
    providerInfo: (p) => ({ id: p, name: 'Opencode' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      {
        provider: p, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'],
        reasoning: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 100000 },
      reasoning: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['opencode-go'], source)
  apply(ctx, Config({}))
  await assert.throws(() => ctx.llm.registration('opencode-go-vision'), /no adapter registered/)
  assert.equal(adapters.size, 0)
  assert.deepEqual(directories, [])
  // The SOURCE metadata stays byte-identical — the retired mirror machine
  // must not have mutated it while scanning.
  const resolved = await ctx.llm.resolveModelInfo('opencode-go', 'deepseek-v4-flash')
  assert.deepEqual(resolved.reasoning, { efforts: ['low', 'high', 'max'], defaultEffort: 'high' })
})

test('twin effort re-injection is retired: the Host adapter owns every reasoning effort', async () => {
  // Issue #103's wrapper remembered per-route reasoningEffort because the
  // twin had no default. P5: whole-turn routing selects the REAL Host route,
  // so the Host adapter receives the user's selection untouched — there is
  // no plugin-owned state that could re-inject or drop an effort.
  const { ctx, captured } = mockHarnessCtx({
    config0: { wrappedProviders: [{ provider: 'opencode-go', models: [] }] },
  })
  const source = {
    providerInfo: (p) => ({ id: p, name: 'Opencode' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'm', name: 'M', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['opencode-go'], source)
  apply(ctx, Config({}))
  const calls = []
  ctx.llm.stream = async function* (options) {
    calls.push({ ...options })
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  // A direct Host-route call passes the caller's selection through 1:1: the
  // plugin owns no injected effort state on the transport path.
  for await (const _c of ctx.llm.stream({ provider: 'opencode-go', model: 'm', messages: [], reasoningEffort: 'max' })) {
    /* drain */
  }
  assert.equal(calls[0].reasoningEffort, 'max')
  assert.equal(calls[0].provider, 'opencode-go')
  assert.equal(captured.streamCalls.length, 1)
})

test('twin wrapper stand-down is retired: no plugin effort state exists at all', async () => {
  const { ctx, adapters, directories } = mockHarnessCtx({
    config0: { wrappedProviders: [{ provider: 'opencode-go', models: [] }] },
  })
  const source = {
    providerInfo: (p) => ({ id: p, name: 'Opencode' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [{ provider: p, id: 'm', name: 'M', inputModalities: ['text'] }],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['opencode-go'], source)
  apply(ctx, Config({}))
  assert.equal(adapters.size, 0)
  assert.deepEqual(directories, [])
  await assert.throws(() => ctx.llm.registration('opencode-go-vision'), /no adapter registered/)
})

test('issue #446 keeps dormant wrapper intent dormant forever: no ghost route on late adapters', async () => {
  // The old contract published a twin only after the source adapter went
  // live. P5 tightens it: the twin machine is retired, so even a live source
  // route never materializes a ghost entry in the Host registry.
  const { ctx, adapters, directories, captured } = mockHarnessCtx()
  apply(ctx, Config({
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'ctyun', models: [] }],
  }))
  assert.equal(adapters.has('ctyun-vision'), false, 'dormant intent must not publish a ghost twin')
  const thirdParty = {
    providerInfo: (p) => ({ id: p, name: '天翼云' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
      { provider: p, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['ctyun'], thirdParty)
  const fire = captured.on.get('llm/adapters-updated')
  assert.ok(fire, 'expected the adapters-updated listener to be registered')
  fire()
  await assert.throws(() => ctx.llm.registration('ctyun-vision'), /no adapter registered/)
  assert.equal(
    ctx.llm.listProviders().find((entry) => entry.id === 'ctyun-vision'),
    undefined,
  )
  assert.deepEqual(directories, [])
  assert.equal(ctx.llm.listProviders().length, 1)
})

test('issue #446 adapter instance preservation now guards the SOURCE registration itself', () => {
  const { ctx, adapters, directories, captured } = mockHarnessCtx()
  let displayName = '天翼云'
  const source = {
    providerInfo: (p) => ({ id: p, name: displayName }),
    providerRetryPolicy: () => 'retry',
    listModels: async () => [],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const sourceHandle = ctx.llm.registerAdapter(['ctyun'], source)
  apply(ctx, Config({
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'ctyun', models: [] }],
  }))
  const fire = captured.on.get('llm/adapters-updated')
  assert.ok(fire)
  // Metadata refresh on the Host side keeps the Host-owned adapter instance
  // and its presentation name untouched — the retired twin reconciler must
  // not snapshot or rewrite anything.
  displayName = '天翼云模型服务'
  sourceHandle.replace(['ctyun'])
  fire()
  assert.equal(adapters.has('ctyun-vision'), false)
  assert.equal(adapters.size, 0)
  assert.deepEqual(directories, [])
  const registration = ctx.llm.registration('ctyun')
  assert.strictEqual(registration.adapter, source)
  assert.deepEqual(registration.provider, { id: 'ctyun', name: '天翼云' })
})

test('issue #446 withdraw/restore now covers only Host-owned registrations', () => {
  const { ctx, adapters, directories, captured } = mockHarnessCtx()
  const makeSource = (name) => ({
    providerInfo: (p) => ({ id: p, name }),
    providerRetryPolicy: () => 'retry',
    listModels: async () => [],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  let sourceHandle = ctx.llm.registerAdapter(['ctyun'], makeSource('天翼云'))
  apply(ctx, Config({
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'ctyun', models: [] }],
  }))
  const fire = captured.on.get('llm/adapters-updated')
  assert.ok(fire)
  assert.equal(adapters.has('ctyun-vision'), false)

  sourceHandle()
  fire()
  assert.equal(adapters.has('ctyun-vision'), false)

  sourceHandle = ctx.llm.registerAdapter(['ctyun'], makeSource('天翼云重载'))
  fire()
  assert.equal(adapters.has('ctyun-vision'), false)
  assert.equal(
    ctx.llm.listProviders().find((entry) => entry.id === 'ctyun-vision'),
    undefined,
  )
  assert.equal(ctx.llm.listProviders()[0].id, 'ctyun')
  assert.deepEqual(directories, [])
  sourceHandle()
})

test('issue #446 reconciliation re-entry converges without plugin-side registry writes', () => {
  const { ctx, adapters, directories, captured } = mockHarnessCtx()
  apply(ctx, Config({
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'ctyun', models: [] }],
  }))
  const fire = captured.on.get('llm/adapters-updated')
  assert.ok(fire)

  // The real DSH registry emits adapters-updated synchronously from register,
  // replace and disposal. Decorate this test mock after apply so the retired
  // reconciliation would re-enter exactly while the outer pass runs.
  const rawRegister = ctx.llm.registerAdapter.bind(ctx.llm)
  ctx.llm.registerAdapter = (providers, adapter) => {
    const rawHandle = rawRegister(providers, adapter)
    const handle = () => {
      rawHandle()
      fire()
    }
    handle.replace = (next) => {
      rawHandle.replace(next)
      fire()
    }
    fire()
    return handle
  }

  let displayName = '天翼云'
  const source = {
    providerInfo: (p) => ({ id: p, name: displayName }),
    providerRetryPolicy: () => 'retry',
    listModels: async () => [],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const sourceHandle = ctx.llm.registerAdapter(['ctyun'], source)
  assert.equal(adapters.has('ctyun-vision'), false)

  displayName = '天翼云模型服务'
  sourceHandle.replace(['ctyun'])
  assert.equal(
    ctx.llm.listProviders().find((entry) => entry.id === 'ctyun-vision'),
    undefined,
  )
  assert.equal(adapters.size, 0)
  assert.deepEqual(directories, [])

  sourceHandle()
  assert.equal(adapters.has('ctyun-vision'), false)
})

test('settings-filtered wrapper intent stays read-only under settings watch fires', async () => {
  const userDoc = {
    autoWrapProviders: false,
    wrappedProviders: [{ provider: 'ctyun', models: ['model-a'] }],
  }
  const { ctx, adapters, directories, settingsWatchers } = mockHarnessCtx({ config0: userDoc })
  const source = {
    providerInfo: (p) => ({ id: p, name: '天翼云' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'model-a', name: 'A', inputModalities: ['text'] },
      { provider: p, id: 'model-b', name: 'B', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['ctyun'], source)
  apply(ctx, Config(userDoc))
  assert.equal(adapters.has('ctyun-vision'), false)
  assert.deepEqual(directories, [])

  // Settings-card edits (model-filter changes) must not resurrect the twin.
  userDoc.wrappedProviders = [{ provider: 'ctyun', models: ['model-b'] }]
  assert.ok(settingsWatchers.length > 0)
  for (const watch of settingsWatchers) watch()
  await assert.throws(() => ctx.llm.registration('ctyun-vision'), /no adapter registered/)
  assert.equal(adapters.size, 0)
})

test('retired auto-wrap never publishes a twin for an already image-capable model', async () => {
  const { ctx, adapters, directories } = mockHarnessCtx()
  const glm = {
    providerInfo: (p) => ({ id: p, name: 'Zhipu GLM' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash', inputModalities: ['text', 'image'] },
      { provider: p, id: 'glm-4v-flash', name: 'GLM-4V-Flash', inputModalities: ['text', 'image'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text', 'image'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['zhipu'], glm)
  apply(ctx, Config({ autoWrapProviders: true }))
  await assert.throws(() => ctx.llm.registration('zhipu-vision'), /no adapter registered/)
  assert.equal(adapters.size, 0)
  assert.deepEqual(directories, [])
})

test('native multimodal Host routes keep their original image blocks: no twin conversion layer exists', async () => {
  const { ctx, captured, adapters } = mockHarnessCtx()
  const glm = {
    providerInfo: (p) => ({ id: p, name: 'Zhipu GLM' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash', inputModalities: ['text', 'image'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text', 'image'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['zhipu'], glm)
  apply(ctx, Config({ autoWrapProviders: true }))
  assert.equal(adapters.size, 0, 'no twin route exists that could rewrite the turn')
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'glm-img', name: 'glm.png' } },
        { type: 'text', text: '直接看看这张图' },
      ],
    },
  ]
  // A whole-turn image turn on the real Host route reaches the adapter with
  // the ORIGINAL message array and its image blocks untouched.
  for await (const _c of ctx.llm.stream({ provider: 'zhipu', model: 'glm-4.6v-flash', messages })) {
    /* drain */
  }
  assert.equal(captured.streamCalls.length, 1)
  assert.strictEqual(captured.streamCalls[0].messages, messages)
  assert.equal(captured.streamCalls[0].messages[0].content.filter((b) => b.type === 'image').length, 1)
  assert.equal(captured.streamCalls[0].messages[0].content[0].attachment.attachmentId, 'glm-img')
})

test('twin sync idempotency is retired: repeated topology events write nothing', async () => {
  const { ctx, adapters, directories, captured } = mockHarnessCtx()
  apply(ctx, Config({ wrappedProviders: [{ provider: 'opencode-go', models: [] }] }))
  const fire = captured.on.get('llm/adapters-updated')
  assert.ok(fire, 'expected the adapters-updated listener to be registered')
  const thirdParty = {
    providerInfo: (p) => ({ id: p, name: 'Opencode' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
      { provider: p, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 100000 },
    }),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.llm.registerAdapter(['opencode-go'], thirdParty)
  // Repeated adapter changes re-run whatever listeners exist; the retired
  // machine must never re-enter a DUPLICATE_ADAPTER throw or publish a route.
  fire()
  fire()
  fire()
  assert.equal(adapters.has('opencode-go-vision'), false)
  assert.equal(adapters.size, 0)
  assert.deepEqual(directories, [])
})

// ── retired wrapper route (plan §4.2): the whole-turn presentation shim ─────

test('no wrapper route exists: the stock catalog and chain pairs are never mirrored', async () => {
  const { ctx, adapters, directories } = mockHarnessCtx({ stockRoute: true })
  apply(ctx, Config({
    provider: 'openrouter',
    providers: [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
  }))

  // the stock adapter keeps owning deepseek-official (Host-owned, untouched)
  const listed = await adapters.get('deepseek-official').listModels('deepseek-official')
  assert.deepEqual(listed.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.deepEqual(listed[0].inputModalities, ['text'])
  await assert.throws(
    () => ctx.llm.registration('deepseek-vision'),
    /no adapter registered/,
    'the retired wrapper route must not mirror the stock catalog',
  )
  assert.deepEqual(directories, [])
})

test('issue #479 retired: the main DeepSeek wrapper no longer mirrors any catalog', async () => {
  const { ctx, adapters, directories, captured } = mockHarnessCtx({
    stockRoute: true,
    opencodeGo: true,
    config0: { textProvider: { provider: 'opencode-go', model: 'qwen3.6-plus' } },
  })
  const official = adapters.get('deepseek-official')
  official.listModels = async (provider) => [
    { provider, id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
    { provider, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
    {
      provider,
      id: 'deepseek-v4.1-flash-expires-on-0910',
      name: 'DeepSeek-V4.1-Flash',
      inputModalities: ['text'],
    },
  ]

  apply(ctx, Config({}))
  await assert.throws(() => ctx.llm.registration('deepseek-vision'), /no adapter registered/)
  // The live official catalog itself stays exactly as the Host published it.
  const listed = await ctx.llm.listModels('deepseek-official')
  assert.deepEqual(listed.map((model) => model.id), [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-v4.1-flash-expires-on-0910',
  ])
  assert.equal(listed.every((model) => model.provider === 'deepseek-official'), true)
  assert.deepEqual(directories, [])
  // The catalog-legacy wrapper route must not hijack Host calls either.
  assert.equal(captured.streamCalls.length, 0)
})

test('wrapper listing of vision-chain pairs is retired: routing rows stay Host rows', async () => {
  const { ctx, adapters, directories } = mockHarnessCtx({ stockRoute: true, config0: { routing: true } })
  ctx.llm.registerAdapter(['openrouter'], {
    providerInfo: (p) => ({ id: p, name: 'OpenRouter' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'qwen/qwen3-vl-235b-a22b-instruct', name: 'Qwen3-VL', inputModalities: ['text', 'image'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text', 'image'], context: { contextWindow: 100000 },
    }),
  })
  apply(ctx, Config({
    provider: 'openrouter',
    providers: [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    routing: true,
  }))
  await assert.throws(() => ctx.llm.registration('deepseek-vision'), /no adapter registered/)
  assert.equal(adapters.size, 2, 'only the Host-owned routes exist (stock + openrouter)')
  assert.deepEqual(directories, [])
  // The real Host image route keeps its declared modalities — that is what
  // whole-turn routing selects now.
  const resolved = await ctx.llm.resolveModelInfo('openrouter', 'qwen/qwen3-vl-235b-a22b-instruct')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  assert.equal(resolved.id, 'qwen/qwen3-vl-235b-a22b-instruct')
})
test('floodFillBackground clears border-connected background pixels', () => {
  // 4x4: white background, black 2x2 square in the middle
  const raw = Buffer.alloc(4 * 4 * 4)
  for (let i = 0; i < 16; i++) {
    raw[i * 4] = 255
    raw[i * 4 + 1] = 255
    raw[i * 4 + 2] = 255
    raw[i * 4 + 3] = 255
  }
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
    const o = (y * 4 + x) * 4
    raw[o] = 0
    raw[o + 1] = 0
    raw[o + 2] = 0
  }
  const out = floodFillBackground(raw, 4, 4, 40)
  assert.equal(out[3], 0) // corner cleared
  const center = (1 * 4 + 1) * 4
  assert.equal(out[center + 3], 255) // foreground kept opaque
})

test('bitmapOfGray marks dark pixels as foreground', () => {
  const raw = Buffer.alloc(2 * 2 * 3, 255)
  raw[3] = 0; raw[4] = 0; raw[5] = 0
  const bitmap = bitmapOfGray(raw, 2, 2)
  assert.deepEqual([...bitmap], [0, 1, 0, 0])
})

test('posterizeSvg vectorizes a tiny PNG into SVG', async () => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: Buffer.from('<svg width="8" height="8"><rect x="2" y="2" width="4" height="4" fill="black"/></svg>') }])
    .png()
    .toBuffer()
  const svg = await posterizeSvg(png, 2)
  assert.ok(svg.includes('<svg'))
  assert.ok(svg.length > 100)
})


test('dedupeHttpProviders drops endpoints already covered by vision-http pairs', () => {
  const http = [{ name: 'ovh', model: 'Qwen2.5-VL-72B-Instruct', baseURL: 'https://x/v1' }]
  assert.deepEqual(
    dedupeHttpProviders([{ provider: 'vision-http', model: 'ovh/Qwen2.5-VL-72B-Instruct' }], http),
    [],
  )
  assert.deepEqual(
    dedupeHttpProviders([{ provider: 'openrouter', model: 'qwen' }], http),
    http,
  )
})


test('hostMatchesAny matches exact hosts and subdomains only', () => {
  const hosts = ['api.openrouter.ai', 'openrouter.ai']
  assert.equal(hostMatchesAny('api.openrouter.ai', hosts), true)
  assert.equal(hostMatchesAny('openrouter.ai', hosts), true)
  assert.equal(hostMatchesAny('api.openrouter.ai.evil.com', hosts), false)
  assert.equal(hostMatchesAny('api.deepseek.com', hosts), false)
  assert.equal(hostMatchesAny('API.OPENROUTER.AI.', [' api.openrouter.ai ']), true)
  assert.equal(hostMatchesAny('xn--bcher-kva.de', ['BÜCHER.DE']), true)
  assert.equal(hostMatchesAny('api.openrouter.ai.evil.com.', [' OPENROUTER.AI ']), false)
  assert.equal(hostMatchesAny('openrouter.ai', []), false)
  assert.equal(hostMatchesAny('openrouter.ai', undefined), false)
})

test('DEFAULT_PROXY_HOSTS covers the common foreign AI API domains', () => {
  const proxyHosts = new Set(DEFAULT_PROXY_HOSTS)
  for (const host of ['api.openrouter.ai', 'openrouter.ai', 'api.openai.com', 'api.anthropic.com', 'api.mistral.ai', 'api.together.xyz']) {
    assert.equal(proxyHosts.has(host), true, `missing ${host}`)
  }
  assert.equal(proxyHosts.has('api.deepseek.com'), false, 'DeepSeek stays direct')
})

// ── batch 1: vision_detect + structured describe ────────────────────────────

test('boxesToSvg draws a numbered box per inventory element', () => {
  const svg = boxesToSvg(
    [{ x1: 10, y1: 20, x2: 60, y2: 80 }, { x1: 100, y1: 100, x2: 200, y2: 180 }],
    640,
    480,
  ).toString()
  assert.ok(svg.includes('<svg'))
  assert.equal((svg.match(/<rect /g) || []).length, 2)
  assert.equal((svg.match(/<circle /g) || []).length, 2)
  assert.ok(svg.includes('>1</text>'))
  assert.ok(svg.includes('>2</text>'))
})

test('annotateBoxesBuffer composites numbered boxes onto the image', async () => {
  const png = await sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer()
  const annotated = await annotateBoxesBuffer(png, [{ x1: 2, y1: 2, x2: 30, y2: 30 }])
  assert.ok(annotated.length > 0)
  const meta = await sharp(annotated).metadata()
  assert.equal(meta.width, 64)
  assert.equal(meta.height, 48)
  const passthrough = await annotateBoxesBuffer(png, [])
  assert.deepEqual(passthrough, png)
})

test('visionDetectInstruction demands the fixed inventory schema', () => {
  const text = visionDetectInstruction('buttons', 640, 480)
  assert.ok(text.includes('640x480'))
  assert.ok(text.includes('buttons'))
  assert.ok(text.includes('{"elements":'))
  assert.ok(text.includes('x1'))
  assert.ok(text.includes('ORIGINAL image pixels'))
})

test('describeStructuredInstruction demands the evidence contract', () => {
  const text = describeStructuredInstruction('what is wrong')
  assert.ok(text.includes('what is wrong'))
  assert.ok(text.includes('summary'))
  assert.ok(text.includes('layout'))
  assert.ok(text.includes('entities'))
  assert.ok(text.includes('text'))
})

test('normalizeDetectResult preserves explicit zero detections but rejects partial element schemas', () => {
  const parsed = {
    elements: [
      { label: '发送按钮', box: { x1: -5, y1: 2, x2: 30, y2: 40 } },
      { label: '搜索框', box: { x1: 100.2, y1: 100.4, x2: 300.4, y2: 200.2 } },
    ],
  }
  const out = normalizeDetectResult(parsed, 640, 480)
  assert.equal(out.elements.length, 2)
  assert.equal(out.elements[0].number, 1)
  assert.deepEqual(out.elements[0].box, { x1: 0, y1: 2, x2: 30, y2: 40 })
  assert.equal(out.elements[1].label, '搜索框')
  assert.deepEqual(normalizeDetectResult({ elements: [] }, 640, 480), { width: 640, height: 480, elements: [] })
  assert.equal(normalizeDetectResult({}, 640, 480), undefined)
  assert.equal(normalizeDetectResult({ elements: 'nope' }, 640, 480), undefined)
  assert.equal(normalizeDetectResult({ elements: [{ label: 'button' }] }, 640, 480), undefined)
  assert.equal(normalizeDetectResult({ elements: [{ label: '', box: { x1: 1, y1: 1, x2: 10, y2: 10 } }] }, 640, 480), undefined)
  assert.equal(normalizeDetectResult({ elements: [{ label: 'button', box: { x1: '1', y1: 1, x2: 10, y2: 10 } }] }, 640, 480), undefined)
  assert.equal(normalizeDetectResult({ elements: [{ label: 'button', box: { x1: 50, y1: 50, x2: 10, y2: 10 } }] }, 640, 480), undefined)
  // Small overlaps are clampable, but fully out-of-frame boxes are not real
  // detections and must never collapse into synthetic edge evidence.
  assert.deepEqual(
    normalizeDetectResult({ elements: [{ label: 'button', box: { x1: -5, y1: 2, x2: 30, y2: 40 } }] }, 640, 480),
    { width: 640, height: 480, elements: [{ number: 1, label: 'button', box: { x1: 0, y1: 2, x2: 30, y2: 40 } }] },
  )
  assert.deepEqual(
    normalizeDetectResult({ elements: [{ label: 'button', box: { x1: 630, y1: 2, x2: 650, y2: 40 } }] }, 640, 480),
    { width: 640, height: 480, elements: [{ number: 1, label: 'button', box: { x1: 630, y1: 2, x2: 640, y2: 40 } }] },
  )
  for (const box of [
    { x1: -100, y1: 10, x2: -50, y2: 20 },
    { x1: 700, y1: 10, x2: 750, y2: 20 },
    { x1: 10, y1: -100, x2: 20, y2: -50 },
    { x1: 10, y1: 500, x2: 20, y2: 550 },
  ]) {
    assert.equal(normalizeDetectResult({ elements: [{ label: 'button', box }] }, 640, 480), undefined)
  }
})

test('normalizeDescribeResult fills the documented keys', () => {
  const out = normalizeDescribeResult({
    summary: 'a lake',
    layout: [{ region: 'top', content: 'title' }, { bad: true }],
    entities: [{ type: 'button', label: 'Go' }, { type: 'nope' }],
  })
  assert.equal(out.summary, 'a lake')
  assert.equal(out.layout.length, 1)
  assert.equal(out.entities.length, 1)
  assert.equal(out.text, '')
  assert.equal(normalizeDescribeResult('nope'), undefined)
  assert.equal(normalizeDescribeResult([1, 2]), undefined)
})

test('posterizeSvg rejects on timeout instead of hanging forever', async () => {
  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer()
  await assert.rejects(() => posterizeSvg(png, 4, 'dominant', 0), /timed out/)
})

test('posterizeSvg resolves normally when potrace finishes in time', async () => {
  const png = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: Buffer.from('<svg width="8" height="8"><rect x="2" y="2" width="4" height="4" fill="black"/></svg>') }])
    .png()
    .toBuffer()
  const svg = await posterizeSvg(png, 2, 'dominant', 30000)
  assert.ok(svg.includes('<svg'))
})

test('posterizeSvg keeps the main thread responsive while potrace computes', async () => {
  const noise = Buffer.alloc(1024 * 1024 * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 31 + 17) % 256
  const png = await sharp(noise, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer()
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 50)
  await assert.rejects(
    () => posterizeSvg(png, 16, 'dominant', 1000),
    /timed out/,
  )
  clearInterval(timer)
  // the main loop must keep ticking while the worker computes
  assert.ok(ticks > 5, `expected main-thread ticks during the compute, got ${ticks}`)
})

// ── color-preserving trace ──────────────────────────────────────────────────

test('posterizeSvgColor emits one colored path per dominant color', async () => {
  // 64x48: white background with a red square
  const raw = Buffer.alloc(64 * 48 * 4)
  for (let i = 0; i < 64 * 48; i++) {
    const o = i * 4
    raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255; raw[o + 3] = 255
  }
  for (let y = 10; y < 30; y++) {
    for (let x = 20; x < 40; x++) {
      const o = (y * 64 + x) * 4
      raw[o] = 220; raw[o + 1] = 30; raw[o + 2] = 30
    }
  }
  const palette = quantizeColors(raw, 2)
  assert.ok(palette.length >= 2)
  const svg = await posterizeSvgColor(raw, { width: 64, height: 48 }, palette, 30000)
  assert.ok(svg.includes('<svg'))
  assert.ok(svg.includes('fill="#'))
  assert.ok(svg.includes('<path '))
  // the red square color is in the palette and must appear as a fill
  const red = palette.find((p) => p.hex !== '#ffffff')
  assert.ok(red, 'expected a non-white palette entry')
  assert.ok(svg.includes(red.hex))
})

test('posterizeSvgColor rejects on timeout', async () => {
  const raw = Buffer.alloc(64 * 64 * 4, 255)
  await assert.rejects(
    () => posterizeSvgColor(raw, { width: 64, height: 64 }, [{ hex: '#ffffff', count: 1, share: 1 }], 0),
    /timed out/,
  )
})

test('toRealPath converts fs resolve results to real paths', () => {
  assert.equal(toRealPath(null, '/abs/page.html'), '/abs/page.html')
  assert.equal(toRealPath(null, 'rel/page.html'), 'rel/page.html')
  assert.equal(
    toRealPath({ processPath: (t) => String(t.targetKey) }, { targetKey: '/abs/page.html', displayPath: '/abs/page.html' }),
    '/abs/page.html',
  )
  assert.equal(toRealPath({}, { targetKey: '/abs/page.html' }), '/abs/page.html')
  assert.equal(toRealPath(null, { targetKey: '/abs/page.html' }), '/abs/page.html')
  assert.equal(toRealPath({}, { targetKey: '' }), '[object Object]')
})


test('vision_present renders a durable image for UI and sanitizer removes it from text-model input', () => {
  const attachment = {
    attachmentId: 'present-1',
    mediaType: 'image/png',
    bytes: 123,
    width: 320,
    height: 200,
    name: 'Preview',
  }
  const rendered = renderVisionPresent({
    path: '/workspace/present.png',
    label: 'Preview',
    width: 320,
    height: 200,
    bytes: 123,
    safePresentation: true,
    attachment,
  })
  assert.equal(rendered.length, 2)
  assert.equal(rendered[1].type, 'image')
  assert.equal(rendered[1].attachment, attachment)
  assert.match(rendered[0].text, /present-1/)

  const wrapped = [{
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call-1', content: rendered }],
  }]
  const sanitized = sanitizeToolResultImages(wrapped)
  assert.equal(sanitized.changed, true)
  assert.equal(sanitized.messages[0].content[0].content.some((block) => block.type === 'image'), false)
  assert.match(sanitized.messages[0].content[0].content.at(-1).text, /present-1/)
})

test('vision_present hands back a reply-ready image snippet so the reader sees it at full size', () => {
  const rendered = renderVisionPresent({
    path: '/workspace/artifacts/before-after.png',
    label: 'Chip [before/after]',
    width: 800,
    height: 200,
    bytes: 456,
    safePresentation: true,
    attachment: { attachmentId: 'present-2', mediaType: 'image/png', bytes: 456, width: 800, height: 200, name: 'Chip before/after' },
  })
  const payload = JSON.parse(rendered[0].text)
  // The tool card renders a 240px thumbnail that later messages push out of view. The host renders
  // an absolute image path inside a message as a full-size api/file image, so the result hands back
  // a paste-ready snippet for the visible reply.
  assert.equal(payload.replyImage, '![Chip before/after](</workspace/artifacts/before-after.png>)')
  assert.match(payload.replyImageHint, /visible reply/)
  assert.equal(rendered[1].type, 'image')
  assert.equal(payload.attachmentId, 'present-2')
})
test('sanitizeToolResultImages removes nested read_image-style images but preserves user images', () => {
  const userRef = { attachmentId: 'user-1', name: 'upload.png' }
  const toolRef = { attachmentId: 'tool-1', name: 'generated.png' }
  const input = [{
    role: 'user',
    content: [
      { type: 'image', attachment: userRef },
      {
        type: 'tool-result',
        content: [
          { type: 'text', text: 'preview' },
          { type: 'image', attachment: toolRef },
        ],
      },
    ],
  }]
  const out = sanitizeToolResultImages(input)
  assert.equal(out.changed, true)
  assert.equal(out.messages[0].content[0].type, 'image')
  const nested = out.messages[0].content[1].content
  assert.equal(nested.some((block) => block.type === 'image'), false)
  assert.match(nested[1].text, /tool-1/)
  assert.match(nested[1].text, /vision_present/)
})

test('sanitizeToolResultImages is identity-preserving when there is no nested image', () => {
  const input = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
  const out = sanitizeToolResultImages(input)
  assert.equal(out.changed, false)
  assert.equal(out.messages, input)
})

test('chromiumCandidates covers Windows, macOS, Linux and explicit overrides', () => {
  const win = chromiumCandidates({
    CHROME_PATH: 'D:\\Portable\\chrome.exe',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  }, 'win32')
  assert.equal(win[0], 'D:\\Portable\\chrome.exe')
  assert.ok(win.some((value) => value.endsWith('Google\\Chrome\\Application\\chrome.exe')))
  assert.ok(win.some((value) => value.endsWith('Microsoft\\Edge\\Application\\msedge.exe')))

  const mac = chromiumCandidates({}, 'darwin')
  assert.ok(mac.some((value) => value.includes('Google Chrome.app')))

  const linux = chromiumCandidates({}, 'linux')
  assert.ok(linux.includes('/usr/bin/google-chrome'))
  assert.ok(linux.includes('/usr/bin/chromium'))
})


test('built-in OVH anonymous fallback is largest-first across independent model buckets', () => {
  assert.deepEqual(DEFAULT_HTTP_PROVIDERS.map((provider) => provider.model), [
    'Qwen3.5-397B-A17B',
    'Qwen2.5-VL-72B-Instruct',
    'Qwen3.6-27B',
    'Qwen3.5-9B',
  ])
  assert.ok(DEFAULT_HTTP_PROVIDERS.every((provider) => provider.apiKeyEnv === ''))
  // OVH announced this model's retirement for 2026-11-04. It must no longer
  // be added implicitly to anonymous fallback attempts (#717).
  assert.equal(DEFAULT_HTTP_PROVIDERS.some((provider) => provider.model === 'Mistral-Small-3.2-24B-Instruct-2506'), false)
})

test('anonymous OVH 429 surfaces immediately so the next model can run', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('{"message":"API rate limit exceeded"}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '60' },
    })
  }
  const started = Date.now()
  try {
    await assert.rejects(
      () => callOpenAICompatible(
        {
          name: 'ovh',
          baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
          model: 'Qwen3.5-397B-A17B',
          apiKeyEnv: '',
        },
        [{ role: 'user', content: [] }],
      ),
      /429/,
    )
    assert.equal(calls, 1)
    assert.ok(Date.now() - started < 1000)
  } finally {
    globalThis.fetch = original
  }
})


test('httpProvidersOf appends built-in OVH fallback after configured HTTP providers', () => {
  const custom = { name: 'custom', baseURL: 'https://example.test/v1', model: 'vision-x', apiKeyEnv: '' }
  const withFallback = httpProvidersOf({ httpProviders: [custom] }, true)
  assert.equal(withFallback[0], custom)
  assert.equal(withFallback.length, 1 + DEFAULT_HTTP_PROVIDERS.length)
  assert.equal(withFallback[1].model, DEFAULT_HTTP_PROVIDERS[0].model)
  assert.deepEqual(httpProvidersOf({ httpProviders: [custom] }, false), [custom])
})

test('isAttachmentIdInput recognizes durable attachment ids but not file paths', () => {
  assert.equal(
    isAttachmentIdInput('sha256:7d76d1467c6545675325558168712483a5d71c4bd639c44d6bc27b1d70ba5dc5'),
    true,
  )
  assert.equal(isAttachmentIdInput('  sha256:7d76d1467c6545675325558168712483a5d71c4bd639c44d6bc27b1d70ba5dc5  '), true)
  assert.equal(isAttachmentIdInput('md5:098f6bcd4621d373cade4e832627b4f6'), true)
  assert.equal(isAttachmentIdInput('sha1:a9993e364706816aba3e25717850c26c9cd0d89d'), true)
  assert.equal(isAttachmentIdInput('/Users/y/.dsh/attachments/v1/objects/7d/7d76d1467c6545675325558168712483a5d71c4bd639c44d6bc27b1d70ba5dc5'), false)
  assert.equal(isAttachmentIdInput('image.png'), false)
  assert.equal(isAttachmentIdInput('./artifacts/photo.png'), false)
  assert.equal(isAttachmentIdInput('sha256:'), false)
  assert.equal(isAttachmentIdInput('sha256:zzzz'), false)
  assert.equal(isAttachmentIdInput(123), false)
  assert.equal(isAttachmentIdInput(undefined), false)
})

test('artifactStemOf keeps long content-addressed inputs distinct', () => {
  const upload =
    '/Users/y/.dsh/attachments/v1/objects/7d/7d76d1467c6545675325558168712483a5d71c4bd639c44d6bc27b1d70ba5dc5'
  const cropA =
    '/Users/y/artifacts/7d76d1467c6545675325558168712483a5d71c4bd639c44d-crop-0-1400-2662-2226.png'
  const cropB =
    '/Users/y/artifacts/7d76d1467c6545675325558168712483a5d71c4bd639c44d-crop-1950-1200-2350-1500.png'
  const groundUpload = artifactStemOf(upload, 'ground')
  const groundCropA = artifactStemOf(cropA, 'ground')
  const groundCropB = artifactStemOf(cropB, 'ground')
  // Before the fingerprint, the 48-char truncation of the 64-char sha256 name
  // made all three collapse onto one stem and overwrite each other.
  assert.notEqual(groundUpload, groundCropA)
  assert.notEqual(groundUpload, groundCropB)
  assert.notEqual(groundCropA, groundCropB)
  for (const stem of [groundUpload, groundCropA, groundCropB]) {
    assert.match(stem, /-ground$/)
    assert.ok(stem.length <= 80)
  }
  // Stable for the same input, different for different suffixes.
  assert.equal(artifactStemOf(upload, 'ground'), groundUpload)
  assert.notEqual(artifactStemOf(upload, 'ground'), artifactStemOf(upload, 'detect'))
})

// ── issue #72: attachment refs from the session event log ───────────────────

const imageRef = (id, name) => ({
  attachmentId: id,
  mediaType: 'image/png',
  bytes: 1234,
  width: 10,
  height: 10,
  name,
})

test('collectEventAttachmentRefs collects refs from user/assistant/tool-result events', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'image', attachment: imageRef('sha256:aaa', 'a.png') }] } },
    {
      seq: 2,
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'no image' }] } },
    },
    {
      seq: 3,
      type: 'tool/result',
      data: {
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              content: [
                { type: 'text', text: 'read output' },
                { type: 'image', attachment: imageRef('sha256:bbb', 'b.png') },
              ],
            },
          ],
        },
      },
    },
    { seq: 4, type: 'turn/start', data: { turn: 1 } },
  ]
  const refs = collectEventAttachmentRefs(events)
  assert.deepEqual(
    refs.map((ref) => ref.attachmentId),
    ['sha256:aaa', 'sha256:bbb'],
  )
  // Full metadata survives so attachments.readImage(ref) can verify bytes.
  assert.equal(refs[1].mediaType, 'image/png')
  assert.equal(refs[1].bytes, 1234)
})

test('collectEventAttachmentRefs dedups by attachment id in first-seen order', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'image', attachment: imageRef('sha256:dup', 'a') }] } },
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: [{ type: 'image', attachment: imageRef('sha256:dup', 'a') }] }] } } },
    { type: 'user/message', data: { content: [{ type: 'image', attachment: imageRef('sha256:other', 'b') }] } },
  ]
  const refs = collectEventAttachmentRefs(events)
  assert.deepEqual(refs.map((ref) => ref.attachmentId), ['sha256:dup', 'sha256:other'])
})

test('collectEventAttachmentRefs tolerates missing events and data', () => {
  assert.deepEqual(collectEventAttachmentRefs(undefined), [])
  assert.deepEqual(collectEventAttachmentRefs([null, {}, { type: 'user/message' }, { type: 'tool/result', data: {} }]), [])
})

// ── issue #74: surface shadow sanitization of tool-result images ────────────

const toolResultEvent = (seq, content, callSeq) => ({
  seq,
  type: 'tool/result',
  data: {
    turn: 1,
    step: 1,
    message: {
      id: `msg-${seq}`,
      role: 'user',
      source: { kind: 'tool', callId: 'call-1' },
      content: [{ type: 'tool-result', toolCallId: 'call-1', content, isError: false }],
    },
  },
  sourceEventSeqs: callSeq === undefined ? undefined : [callSeq],
})

test('planToolResultImageShadows plans replacements only for image-bearing tool results', () => {
  const events = [
    toolResultEvent(0, [{ type: 'text', text: 'plain' }]),
    toolResultEvent(1, [
      { type: 'text', text: '{"safePresentation":true}' },
      { type: 'image', attachment: imageRef('sha256:show', 'shown.png') },
    ]),
    { seq: 2, type: 'user/message', data: { role: 'user', content: [{ type: 'image', attachment: imageRef('sha256:user', 'u.png') }] } },
    toolResultEvent(3, [{ type: 'text', text: 'another plain one' }]),
  ]
  const plans = planToolResultImageShadows(events, [0, 1, 2, 3], (seq, event) => seq === 1)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].seq, 1)
  const message = plans[0].message
  // The replacement keeps the tool-result envelope and drops the image.
  assert.equal(message.id, 'msg-1')
  assert.equal(message.content[0].type, 'tool-result')
  assert.equal(blocksHaveImage(message.content), false)
  const texts = message.content[0].content.filter((block) => block.type === 'text').map((block) => block.text)
  assert.equal(texts.some((text) => text.includes('sha256:show')), true)
  // The original event is untouched (the caller replaces it by appending).
  assert.equal(blocksHaveImage(events[1].data.message.content), true)
})

test('planToolResultImageShadows respects the shouldStrip decision', () => {
  const events = [toolResultEvent(0, [{ type: 'image', attachment: imageRef('sha256:keep', 'k.png') }])]
  assert.deepEqual(planToolResultImageShadows(events, [0], () => false), [])
  assert.equal(planToolResultImageShadows(events, [0], () => true).length, 1)
})

test('sanitizeToolResultMessage is identity-preserving without images and frozen with them', () => {
  const plain = toolResultEvent(0, [{ type: 'text', text: 'plain' }]).data.message
  assert.equal(sanitizeToolResultMessage(plain), plain)
  const withImage = toolResultEvent(1, [{ type: 'image', attachment: imageRef('sha256:x', 'x.png') }]).data.message
  const sanitized = sanitizeToolResultMessage(withImage)
  assert.notEqual(sanitized, withImage)
  assert.equal(Object.isFrozen(sanitized), true)
  assert.equal(Object.isFrozen(sanitized.content[0]), true)
  assert.equal(blocksHaveImage(sanitized.content), false)
})

test('toolImageMarker names the attachment id and points at vision_describe', () => {
  const marker = toolImageMarker({ attachment: imageRef('sha256:marker', 'm.png') })
  assert.equal(marker.type, 'text')
  assert.match(marker.text, /sha256:marker/)
  assert.match(marker.text, /vision_describe/)
})

test('deepFreezeLocal freezes nested structures', () => {
  const tree = { a: { b: [{ c: 1 }] } }
  const frozen = deepFreezeLocal(tree)
  assert.equal(frozen, tree)
  assert.equal(Object.isFrozen(tree), true)
  assert.equal(Object.isFrozen(tree.a), true)
  assert.equal(Object.isFrozen(tree.a.b), true)
})

// ── issue #75: sharp peer-range diagnostics ─────────────────────────────────

test('parseVersionParts handles releases, partial versions and prereleases', () => {
  assert.deepEqual(parseVersionParts('0.35.3'), { major: 0, minor: 35, patch: 3, pre: undefined })
  assert.deepEqual(parseVersionParts('1.2.3-beta.4'), { major: 1, minor: 2, patch: 3, pre: 'beta.4' })
  // Partial versions pad to zero like semver ("1" means ">=1.0.0").
  assert.deepEqual(parseVersionParts('1'), { major: 1, minor: 0, patch: 0, pre: undefined })
  assert.deepEqual(parseVersionParts('1.2'), { major: 1, minor: 2, patch: 0, pre: undefined })
  assert.equal(parseVersionParts('1.2.3.4'), undefined)
  assert.equal(parseVersionParts('nonsense'), undefined)
  assert.equal(parseVersionParts(undefined), undefined)
})

test('versionSatisfies evaluates the plugin peer range shape', () => {
  const range = '>=0.35.3 <1'
  assert.equal(versionSatisfies('0.34.0', range), false) // stale v1.1.x-era sharp
  assert.equal(versionSatisfies('0.35.2', range), false)
  assert.equal(versionSatisfies('0.35.3', range), true)
  assert.equal(versionSatisfies('0.35.4', range), true)
  assert.equal(versionSatisfies('1.0.0', range), false)
  // Prereleases of the upper bound still satisfy "<1" (semver ordering).
  assert.equal(versionSatisfies('1.0.0-beta.1', range), true)
  // Alternatives and bare versions.
  assert.equal(versionSatisfies('0.34.5', '>=0.35.3 <1 || 0.34.5'), true)
  assert.equal(versionSatisfies('0.34.5', '0.34.5'), true)
  assert.equal(versionSatisfies('0.35.3', '<=0.35.3'), true)
  assert.equal(versionSatisfies('0.35.3', '>0.35.2'), true)
  assert.equal(versionSatisfies('0.35.3', '>0.35.3'), false)
  assert.equal(versionSatisfies('0.35.3', '=0.35.3'), true)
  assert.equal(versionSatisfies('0.34.5', ''), false)
  assert.equal(versionSatisfies('0.34.5', undefined), false)
  assert.equal(versionSatisfies(undefined, range), false)
})

test('version comparator parsing is linear and malformed ranges fail safe', () => {
  assert.deepEqual(parseVersionComparator('>=0.35.3'), { op: '>=', version: '0.35.3' })
  assert.deepEqual(parseVersionComparator('<=1'), { op: '<=', version: '1' })
  assert.deepEqual(parseVersionComparator('>0.35.3'), { op: '>', version: '0.35.3' })
  assert.deepEqual(parseVersionComparator('<1'), { op: '<', version: '1' })
  assert.deepEqual(parseVersionComparator('=0.35.3'), { op: '=', version: '0.35.3' })
  assert.deepEqual(parseVersionComparator('0.35.3'), { op: '=', version: '0.35.3' })

  const adversarial = `>=${'1'.repeat(100_000)}x`
  assert.equal(parseVersionComparator(adversarial).version.length, 100_001)
  assert.equal(versionSatisfies('1.0.0', adversarial), false)

  for (const malformed of ['>=', '<=', '>', '<', '=', '==1', '=>1', '>>1']) {
    assert.equal(versionSatisfies('1.0.0', malformed), false)
  }
})

// ── vision-backend capability recognition (Zhipu feedback) ──────────────────

test('looksLikeVisionModel recognizes well-known multimodal families conservatively', () => {
  // Zhipu VLM family — the reported case.
  assert.equal(looksLikeVisionModel('glm-4.6v'), true)
  assert.equal(looksLikeVisionModel('glm-4.6v-flash'), true)
  assert.equal(looksLikeVisionModel('glm-4v-plus'), true)
  assert.equal(looksLikeVisionModel('glm-4.5v-plus'), true)
  // Plain glm-4.6 is NOT in the VLM family: no image-input evidence.
  assert.equal(looksLikeVisionModel('glm-4.6'), false)
  assert.equal(looksLikeVisionModel('glm-4.5'), false)
  // Other well-known families.
  assert.equal(looksLikeVisionModel('qwen2.5-vl-72b-instruct'), true)
  assert.equal(looksLikeVisionModel('Qwen/Qwen3-VL-32B-Instruct'), true)
  assert.equal(looksLikeVisionModel('Qwen/Qwen3-VL-Embedding-8B'), false)
  assert.equal(looksLikeVisionModel('Qwen/Qwen3-VL-Reranker-8B'), false)
  assert.equal(looksLikeNonGenerativeVisionModel('Qwen3-VL-Embedding-8B'), true)
  assert.equal(looksLikeNonGenerativeVisionModel('Qwen3-VL-Reranker-8B'), true)
  assert.equal(looksLikeVisionModel('qvq-72b'), true)
  assert.equal(looksLikeVisionModel('gpt-4o-mini'), true)
  assert.equal(looksLikeVisionModel('gpt-4.1'), true)
  assert.equal(looksLikeVisionModel('gpt-5.1'), true)
  assert.equal(looksLikeVisionModel('gemini-2.0-flash'), true)
  assert.equal(looksLikeVisionModel('claude-3-5-sonnet'), true)
  assert.equal(looksLikeVisionModel('internvl3-38b'), true)
  assert.equal(looksLikeVisionModel('doubao-1.5-vision-pro'), true)
  assert.equal(looksLikeVisionModel('step-1v-8k'), true)
  // Text-only names must not match.
  assert.equal(looksLikeVisionModel('deepseek-v4-pro'), false)
  assert.equal(looksLikeVisionModel('qwen3-14b'), false)
  assert.equal(looksLikeVisionModel('glm-4-plus'), false)
  assert.equal(looksLikeVisionModel('gpt-4-mini'), false)
  assert.equal(looksLikeVisionModel('claude-2'), false)
  assert.equal(looksLikeVisionModel(''), false)
  assert.equal(looksLikeVisionModel(undefined), false)
  // Provider-prefixed ids match on the last segment.
  assert.equal(looksLikeVisionModel('openrouter/zhipu/glm-4.6v'), true)
})

test('decideVisionBackendCapability treats metadata as advisory but keeps structural exclusions', () => {
  const declared = { inputModalities: ['text', 'image'] }
  assert.deepEqual(decideVisionBackendCapability(declared, 'zhipu-glm', 'glm-4.6v', []), {
    image: true,
    attemptable: true,
    inputModalities: ['text', 'image'],
    inferred: false,
    reason: undefined,
  })
  // Undeclared glm-4.6v: recognized by name.
  assert.deepEqual(decideVisionBackendCapability({ inputModalities: ['text'] }, 'zhipu-glm', 'glm-4.6v', []), {
    image: true,
    attemptable: true,
    inputModalities: ['text', 'image'],
    hostInputModalities: ['text'],
    inferred: 'name',
    reason: undefined,
  })
  // Undeclared plain glm-4.6: forced via the override list (bare model id).
  assert.deepEqual(
    decideVisionBackendCapability({ inputModalities: ['text'] }, 'zhipu-glm', 'glm-4.6', ['glm-4.6']),
    { image: true, attemptable: true, inputModalities: ['text', 'image'], hostInputModalities: ['text'], inferred: 'override', reason: undefined },
  )
  // "provider/model" override entries match too.
  assert.equal(
    decideVisionBackendCapability(undefined, 'zhipu-glm', 'glm-4.6', ['zhipu-glm/glm-4.6']).image,
    true,
  )
  // Metadata lookup failure still falls back to inference.
  assert.equal(decideVisionBackendCapability(undefined, 'zhipu-glm', 'glm-4.6v', []).image, true)
  // A text-only declaration is advisory: the user may explicitly try it.
  assert.deepEqual(decideVisionBackendCapability({ inputModalities: ['text'] }, 'zhipu-glm', 'glm-4.6', []), {
    image: false,
    attemptable: true,
    inputModalities: ['text'],
    inferred: false,
    reason: 'model metadata declares no image input',
  })
  // Missing input metadata is also advisory rather than an admission failure.
  const unknown = decideVisionBackendCapability({}, 'zhipu-glm', 'glm-4.6', [])
  assert.equal(unknown.image, false)
  assert.equal(unknown.attemptable, true)
})


test('non-generative VL endpoints stay hidden unless explicitly forced', () => {
  const metadata = { inputModalities: ['text', 'image'] }
  const rejected = decideVisionBackendCapability(
    metadata,
    'siliconflow',
    'Qwen/Qwen3-VL-Embedding-8B',
    [],
  )
  assert.equal(rejected.image, false)
  assert.match(rejected.reason, /embedding\/reranker/)
  const forced = decideVisionBackendCapability(
    { inputModalities: ['text'] },
    'siliconflow',
    'Qwen/Qwen3-VL-Reranker-8B',
    ['siliconflow/Qwen/Qwen3-VL-Reranker-8B'],
  )
  assert.equal(forced.image, true)
  assert.equal(forced.inferred, 'override')
})

test('channel bridge transport uses resolved pi-ai catalog model facts', () => {
  const resolved = {
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    piProvider: {
      baseUrl: 'https://provider.example/v1',
      getModels: () => [
        {
          id: 'Qwen/Qwen3-VL-32B-Instruct',
          api: 'openai-completions',
          baseUrl: 'https://model.example/v1',
        },
      ],
    },
  }
  assert.deepEqual(
    resolveChannelBridgeTransport(
      { apiKeyEnv: 'RAW_KEY_ONLY' },
      resolved,
      'Qwen/Qwen3-VL-32B-Instruct',
    ),
    {
      baseURL: 'https://model.example/v1',
      api: 'openai-completions',
      apiKeyEnv: 'RAW_KEY_ONLY',
    },
  )
  assert.deepEqual(
    resolveChannelBridgeTransport(
      { baseURL: 'https://raw.example/v1', api: 'anthropic-messages' },
      undefined,
      'claude-4-sonnet',
    ),
    {
      baseURL: 'https://raw.example/v1',
      api: 'anthropic-messages',
      apiKeyEnv: undefined,
    },
  )
})

// ── strict-upstream audit, P5 execution chain ───────────────────────────────
// The retired twin/wrapper fabricated capability hints (reasoning defaults,
// image declarations on wrapper routes). The P5 execution chain must never
// fabricate anything: the describe walk forwards no invented effort to the
// Host adapter, and whole-turn image routing selects only REAL Host routes
// attested as image-capable (fail-closed on unattested/text-only metadata).

test('strict upstream: the describe walk never forwards a fabricated reasoning effort', async () => {
  const driver = await driveDescribe({ opencodeGoMode: 'fixed' })
  const seen = []
  driver.ctx.llm.stream = async function* (options) {
    // A strict upstream rejects anything it did not declare — including an
    // invented reasoning effort the plugin has no authority to add. The walk
    // must pass only provider/model/messages/maxTokens/signal/sessionId.
    if (options.reasoningEffort !== undefined) {
      throw new Error(`strict upstream rejects fabricated reasoningEffort "${options.reasoningEffort}"`)
    }
    if (options.provider !== 'opencode-go' || options.model !== 'qwen3.6-plus') {
      throw new Error(`unexpected Host route ${options.provider}/${options.model}`)
    }
    seen.push({ ...options })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const answer = await driver.run()
  assert.equal(answer, 'ok')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sessionId, 'session-410-corrected')
})

test('strict upstream: an unattested text-only route never receives an image turn', async () => {
  const config = {
    providers: [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    routing: true,
    downscale: false,
  }
  const { ctx, captured } = mockHarnessCtx({ config0: config, attachments: true })
  // The Host's openrouter adapter declares TEXT only.
  ctx.llm.registerAdapter(['openrouter'], {
    providerInfo: (p) => ({ id: p, name: 'OpenRouter' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'qwen/qwen3-vl-235b-a22b-instruct', name: 'Qwen3-VL', inputModalities: ['text'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 100000 },
    }),
  })
  // The Agent inbox projection seam (the last synchronously observable input
  // before the modern Host freezes the step model).
  const inboxBySession = new Map()
  const originalGet = ctx.get.bind(ctx)
  ctx.get = (name) => {
    if (name === 'sessionProjections') {
      return { stateOf: (session, kind) => (kind === 'inbox' ? inboxBySession.get(session) : undefined) }
    }
    return originalGet(name)
  }
  apply(ctx, Config(config))
  const onStatus = captured.on.get('agent/status')
  assert.equal(typeof onStatus, 'function')
  const agent = {
    status: 'running',
    session: { id: 'strict-unattested-session' },
    model: {
      current: () => ({ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }),
      select: () => { throw new Error('strict upstream: no image route may ever be selected') },
    },
  }
  inboxBySession.set(agent.session, {
    'next-turn': [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } }] }],
    'next-step': [],
  })
  // Let the declared-modality attestation pass (apply() kicks it off async).
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  onStatus({ agent, status: 'running' })
  // The whole-turn router failed closed: the text-only-declared route stays
  // selected and the image turn is served by the vision tools instead.
  assert.equal(captured.streamCalls.length, 0, 'no Host stream may be issued from a routing probe')
})

test('strict upstream: an attested image-capable route receives the temporary selection', async () => {
  const config = {
    // The chat model stays on the text-only Host row; the image-capable row
    // joins the routing pairs.
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    providers: [
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' },
    ],
    routing: true,
    downscale: false,
  }
  const { ctx, captured } = mockHarnessCtx({ config0: config, attachments: true })
  ctx.llm.registerAdapter(['openrouter'], {
    providerInfo: (p) => ({ id: p, name: 'OpenRouter' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'qwen/qwen3-vl-235b-a22b-instruct', name: 'Qwen3-VL', inputModalities: ['text', 'image'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text', 'image'], context: { contextWindow: 100000 },
    }),
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
  })
  ctx.llm.registerAdapter(['deepseek-official'], {
    providerInfo: (p) => ({ id: p, name: 'DeepSeek' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [{ provider: p, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] }],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text'], context: { contextWindow: 100000 },
    }),
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
  })
  const inboxBySession = new Map()
  const originalGet = ctx.get.bind(ctx)
  ctx.get = (name) => {
    if (name === 'sessionProjections') {
      return { stateOf: (session, kind) => (kind === 'inbox' ? inboxBySession.get(session) : undefined) }
    }
    return originalGet(name)
  }
  apply(ctx, Config(config))
  const onStatus = captured.on.get('agent/status')
  const selections = []
  const agent = {
    status: 'running',
    session: { id: 'strict-attested-session' },
    model: {
      current: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
      select: (selection) => selections.push({ ...selection }),
    },
  }
  inboxBySession.set(agent.session, {
    'next-turn': [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } }] }],
    'next-step': [],
  })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  onStatus({ agent, status: 'running' })
  // The REAL Host image route was selected — a registered provider/model with
  // declared image input, never a composed route id.
  assert.deepEqual(selections, [
    { provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' },
  ])
})

test('strict upstream: the tool walk fails over when a forced extraVisionModels backend rejects the image', async () => {
  // The expert escape hatch forces a text-only-declared model into the vision
  // walk — the strict upstream rejects it, and the walk must fall through to
  // the genuinely image-capable backend, then stop (never reaching the free
  // OVH fallback behind healthy configured rows).
  const config = {
    routing: true,
    downscale: false,
    providers: [
      { provider: 'forced', model: 'qwen-vl-forced' },
      { provider: 'good', model: 'qwen-vl' },
    ],
    extraVisionModels: ['forced/qwen-vl-forced'],
  }
  const driver = await driveDescribe({ opencodeGoMode: false, config0: config })
  const hostAttempts = []
  driver.ctx.llm.stream = async function* (options) {
    hostAttempts.push(options.provider)
    if (options.provider === 'forced') throw new Error('forced backend rejects images')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const original = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('the free fallback must not run behind healthy configured rows')
  }
  let answer
  try {
    answer = await driver.run()
  } finally {
    globalThis.fetch = original
  }
  assert.equal(answer, 'ok')
  assert.deepEqual(hostAttempts, ['forced', 'good'])
  assert.equal(fetchCalls, 0)
  // Both rows are Host-owned adapters; the plugin mounted nothing itself.
  assert.equal(driver.adapters.size, 2)
})

test('whole-turn routing selection follows the settings document without a restart', async () => {
  const config = {
    provider: 'openrouter',
    providers: [{ provider: 'openrouter', model: 'qwen/qwen3-vl-235b-a22b-instruct' }],
    routing: false,
    chainRoute: '',
    autoActivateOnImage: false,
  }
  const { ctx, captured, userDoc, settingsWatchers } = mockHarnessCtx({ config0: config, attachments: true })
  ctx.llm.registerAdapter(['openrouter'], {
    providerInfo: (p) => ({ id: p, name: 'OpenRouter' }),
    providerRetryPolicy: () => 'retry',
    listModels: async (p) => [
      { provider: p, id: 'qwen/qwen3-vl-235b-a22b-instruct', name: 'Qwen3-VL', inputModalities: ['text', 'image'] },
    ],
    resolveModel: async (p, m) => ({
      provider: p, id: m, name: m, inputModalities: ['text', 'image'], context: { contextWindow: 100000 },
    }),
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
  })
  apply(ctx, Config(config))
  // The agent/request hook is registered unconditionally and gates at
  // runtime, so the settings switch reaches it immediately.
  const request = captured.on.get('agent/request')
  const preStep = captured.on.get('agent/pre-step')
  assert.equal(typeof request, 'function')
  assert.equal(typeof preStep, 'function')
  const payload = {
    agent: { session: { id: 'settings-live-session', events: [] } },
    turn: 7,
    messages: [
      { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'img-1', name: 'a.png' } }] },
    ],
  }
  const next = async () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  // routing off: the image turn keeps the chat model
  await preStep(payload, async () => ({ messages: payload.messages }))
  assert.deepEqual(await request(payload, next), { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  // the user flips the routing switch in the settings card
  userDoc.routing = true
  for (const watch of settingsWatchers) watch()
  await preStep(payload, async () => ({ messages: payload.messages }))
  const routed = await request(payload, next)
  assert.equal(routed.provider, 'openrouter', 'image turns route to the first real Host vision row')
  assert.equal(routed.model, 'qwen/qwen3-vl-235b-a22b-instruct')
  assert.equal(routed.reasoningEffort, undefined, 'the previous provider effort must be dropped on switch')
  // and off again
  userDoc.routing = false
  for (const watch of settingsWatchers) watch()
  await preStep(payload, async () => ({ messages: payload.messages }))
  assert.deepEqual(await request(payload, next), { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
})

test('retired wrapperRoute stays read-only compat data under settings edits', async () => {
  const { ctx, adapters, directories, userDoc, settingsWatchers } = mockHarnessCtx({
    stockRoute: true,
    config0: { wrapperRoute: '' },
  })
  apply(ctx, Config({}))
  assert.equal(adapters.size, 1, 'only the Host stock route exists')
  userDoc.wrapperRoute = 'deepseek-vision'
  for (const watch of settingsWatchers) watch()
  await assert.throws(() => ctx.llm.registration('deepseek-vision'), /no adapter registered/)
  userDoc.wrapperRoute = 'my-wrapper'
  for (const watch of settingsWatchers) watch()
  await assert.throws(() => ctx.llm.registration('my-wrapper'), /no adapter registered/)
  assert.equal(adapters.size, 1)
  assert.deepEqual(directories, [])
})

test('httpProviderFallbackWeight charges one slice for built-in OVH, a full tier for locals', () => {
  const builtIn = { ...DEFAULT_HTTP_PROVIDERS[0] }
  assert.equal(httpProviderFallbackWeight(builtIn), 1)
  // A local LM Studio / Ollama backend is worth the whole built-in tier, so a
  // healthy local model keeps half of a local→OVH fallback budget.
  const local = {
    name: 'lmstudio',
    baseURL: 'http://127.0.0.1:1234/v1',
    model: 'qwen2.5-vl',
    apiKeyEnv: '',
    maxTokens: 4096,
  }
  assert.equal(httpProviderFallbackWeight(local), DEFAULT_HTTP_PROVIDERS.length)
  // Trailing-slash differences do not disqualify a built-in match.
  assert.equal(httpProviderFallbackWeight({ ...builtIn, baseURL: builtIn.baseURL + '/' }), 1)
  // A built-in row carrying a credential or a changed endpoint is user-owned.
  assert.equal(
    httpProviderFallbackWeight({ ...builtIn, apiKeyEnv: 'OVH_KEY' }),
    DEFAULT_HTTP_PROVIDERS.length,
  )
  assert.equal(
    httpProviderFallbackWeight({ ...builtIn, baseURL: 'https://example.com/v1' }),
    DEFAULT_HTTP_PROVIDERS.length,
  )
  assert.equal(httpProviderFallbackWeight(undefined), DEFAULT_HTTP_PROVIDERS.length)
})

test('weightedFallbackBudget allocates fair shares and clamps to the limits', () => {
  // 60s left, 20s per call, weight 1 of 3 → a 20s fair share.
  assert.equal(weightedFallbackBudget(60000, 20000, 1, 3), 20000)
  // The per-call timeout caps a larger fair share.
  assert.equal(weightedFallbackBudget(60000, 10000, 1, 3), 10000)
  // The last candidate (weight === remainingWeight) may keep the whole rest,
  // still capped by the per-call limit.
  assert.equal(weightedFallbackBudget(45000, 20000, 3, 3), 20000)
  // The remaining budget wins when smaller than the fair share.
  assert.equal(weightedFallbackBudget(9000, 20000, 1, 3), 3000)
  // Degenerate inputs never return less than 1 ms.
  assert.equal(weightedFallbackBudget(0, 0, 0, 0), 1)
  assert.equal(weightedFallbackBudget(-5, NaN, 0, 0), 1)
})

// ── direct-backend local rows: wire conversion through the provider transport
//
// P5: a configured local backend executes through the direct-backend walk
// (vision_describe tool) over the Router-owned provider transport. The walk's
// ordering still puts the configured local backend ahead of the built-in free
// rows, and each wire format keeps its system text and image blocks.

test('the describe walk serves the configured local backend ahead of the free rows', async () => {
  const config = {
    downscale: false,
    localOllama: { enabled: true, baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl' },
  }
  const { ctx, captured, adapters } = mockHarnessCtx({ attachments: true, config0: config })
  const transportCalls = []
  const providerTransport = {
    async fetch(input, init) {
      transportCalls.push({ url: String(input), body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'LOCAL OK' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
  apply(ctx, Config(config), { providerTransport })
  const activate = captured.tools.find((entry) => entry?.name === 'vision_activate')
  assert.ok(activate)
  await activate.execute({}, {})
  const describe = captured.tools.find((entry) => entry?.name === 'vision_describe')
  assert.ok(describe)
  const result = await describe.execute(
    { paths: ['/tmp/fake.png'], question: 'What is this?' },
    { agent: { session: { id: 'local-first-session', events: [] } } },
  )
  // The configured local backend answered FIRST — before any built-in free
  // endpoint could burn the anonymous quota behind a healthy local row.
  assert.equal(result, 'LOCAL OK')
  assert.equal(transportCalls.length, 1)
  assert.equal(transportCalls[0].url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(transportCalls[0].body.model, 'qwen2.5vl')
  assert.equal(adapters.size, 0, 'no Host route may back the local backend')
})

test('anthropic-format local backend keeps system text and image blocks on the provider transport', async () => {
  const config = {
    downscale: false,
    localOllama: {
      enabled: true,
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5vl',
      format: 'anthropic',
    },
  }
  const { ctx, captured, adapters } = mockHarnessCtx({ attachments: true, config0: config })
  const transportCalls = []
  const providerTransport = {
    async fetch(input, init) {
      transportCalls.push({ url: String(input), headers: init.headers, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ANTH OK' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
  apply(ctx, Config(config), { providerTransport })
  const activate = captured.tools.find((entry) => entry?.name === 'vision_activate')
  assert.ok(activate)
  await activate.execute({}, {})
  const describe = captured.tools.find((entry) => entry?.name === 'vision_describe')
  assert.ok(describe)
  const result = await describe.execute(
    { paths: ['/tmp/fake.png'], question: 'What is this?' },
    { agent: { session: { id: 'local-anthropic-session', events: [] } } },
  )
  assert.equal(result, 'ANTH OK')
  assert.equal(transportCalls.length, 1)
  assert.equal(transportCalls[0].url, 'http://127.0.0.1:11434/v1/messages')
  assert.equal(transportCalls[0].body.model, 'qwen2.5vl')
  // The walk's image block survives the Anthropic conversion as base64.
  const imageBlocks = transportCalls[0].body.messages[0].content.filter((block) => block.type === 'image')
  assert.equal(imageBlocks.length, 1)
  assert.equal(imageBlocks[0].source.type, 'base64')
  assert.equal(imageBlocks[0].source.media_type, 'image/png')
  assert.ok(imageBlocks[0].source.data.length > 0)
  // The focused question rides the user content (the walk has no system
  // frame; the vision instruction must not be lost in conversion either).
  const textBlocks = transportCalls[0].body.messages[0].content.filter((block) => block.type === 'text')
  assert.ok(textBlocks.some((block) => block.text.includes('What is this?')))
  assert.equal(transportCalls[0].headers['x-api-key'], undefined, 'keyless local backend omits the header')
  assert.equal(adapters.size, 0)
  // The Anthropic conversion primitive the walk delegates to keeps SYSTEM
  // text on the dedicated wire field (regression guard for local callers
  // that do send a system frame, e.g. vision_screenshot identify).
  const converted = await callLocalBackend(
    { name: 'local-ollama', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl', format: 'anthropic', apiKeyEnv: '' },
    [
      { role: 'system', content: [{ type: 'text', text: 'Be terse.' }] },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'text', text: 'What is this?' },
        ],
      },
    ],
    { providerTransport },
  )
  assert.equal(converted, 'ANTH OK')
  const wire = transportCalls[1]
  assert.equal(wire.body.system, 'Be terse.')
  assert.equal(wire.body.messages[0].role, 'user')
  assert.equal(wire.body.messages[0].content.filter((block) => block.type === 'image').length, 1)
})


test('vision_materialize exposes an authorized attachment as a workspace file (issue #153)', async () => {
  const artifactsDir = '.tmp-vision-materialize-test'
  const config = { artifactsDir, freeFallback: false, progressiveTools: false }
  const { ctx, captured } = mockHarnessCtx({ attachments: true, config0: config })
  apply(ctx, Config(config))
  const tool = captured.tools.find((entry) => entry && entry.name === 'vision_materialize')
  assert.ok(tool, 'expected vision_materialize to be registered')
  assert.match(tool.description, /NO vision model\/network call/)

  const attachment = { attachmentId: 'sha256:40716778ccda05db57befec33e5af91973ecc810b4d5a8076b2c229421f388c2', mediaType: 'image/png', name: 'image.png' }
  const session = { id: 'issue-153', events: [], header: { cwd: process.cwd() } }
  const messages = [{ role: 'user', content: [{ type: 'image', attachment }, { type: 'text', text: 'look' }] }]
  const preStep = captured.on.get('agent/pre-step')
  assert.equal(typeof preStep, 'function')
  await preStep({ agent: { session }, messages, turn: 1 }, async () => ({ messages }))

  const output = JSON.parse(await tool.execute({ image: attachment.attachmentId }, { agent: { session } }))
  assert.equal(output.mediaType, 'image/png')
  assert.equal(output.safeWorkspaceCopy, true)
  assert.equal(output.source, attachment.attachmentId)
  const portablePath = output.path.split(path.sep).join('/')
  assert.match(portablePath, /\/\.runs\/\.vision-run-handoff\/materialized\/[0-9a-f]{20}\.png$/u)
  assert.equal(
    output.workspaceRelativePath.startsWith(`${artifactsDir}/.runs/.vision-run-handoff/materialized/`),
    true,
  )
  assert.match(output.workspaceRelativePath, /[0-9a-f]{20}\.png$/u)
  const { readFile, rm } = await import('node:fs/promises')
  assert.deepEqual(await readFile(output.path), Buffer.from('not-a-real-image'))
  assert.deepEqual(
    await readFile(path.resolve(session.header.cwd, output.workspaceRelativePath)),
    Buffer.from('not-a-real-image'),
  )
  const repeated = JSON.parse(await tool.execute({ image: attachment.attachmentId }, { agent: { session } }))
  assert.equal(repeated.path, output.path)
  assert.equal(repeated.workspaceRelativePath, output.workspaceRelativePath)
  await rm(new URL('../' + artifactsDir + '/', import.meta.url), { recursive: true, force: true })
})

test('vision_describe failure contract points attachment ids at vision_materialize (issue #153)', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /degradedAccess/)
  assert.match(source, /tool: 'vision_materialize'/)
  assert.match(source, /vision_ocr with \{\"image\":\"<attachment id>\"/)
  assert.match(source, /Use vision_materialize only when a separate non-Vision-Router local parser genuinely requires a filesystem path/)
  assert.match(source, /Do not guess a filename or the attachment store path/)
})


test('batch3: JSON extraction is one-pass and cache retention is byte-bounded', () => {
  const originalParse = JSON.parse
  let parses = 0
  JSON.parse = (...args) => {
    parses += 1
    return originalParse(...args)
  }
  try {
    const parsed = extractJson('{"a":[1,{"text":"} ]"}]}'+ 'x'.repeat(200_000))
    assert.deepEqual(parsed, { a: [1, { text: '} ]' }] })
    assert.equal(parses, 1, 'one balanced candidate should be parsed once, never one suffix at a time')
  } finally {
    JSON.parse = originalParse
  }

  const cache = createCache(100, 0, { maxBytes: 80, maxEntryBytes: 64 })
  assert.equal(cache.set('a', 'x'.repeat(40)), true)
  assert.equal(cache.set('b', 'y'.repeat(40)), true)
  assert.ok(cache.bytes <= 80)
  assert.equal(cache.get('a'), undefined, 'byte pressure evicts LRU entries before count pressure')
  assert.equal(cache.set('too-big', 'z'.repeat(1000)), false)
  assert.ok(cache.bytes <= 80)

  const key = cacheKeyFor({
    pairs: [{ provider: 'p', model: 'm' }],
    httpProviders: [],
    contentIds: ['sha256:x'],
    wantJson: false,
    question: 'secret-question-'.repeat(100_000),
  })
  assert.match(key, /^v2:[a-f0-9]{64}$/)
  assert.equal(key.includes('secret-question'), false)
})

test('batch3: direct OpenAI success bodies are rejected before oversized JSON allocation', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('{"choices":[]}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) },
  })
  try {
    await assert.rejects(
      callOpenAICompatible(
        { name: 'bounded', baseURL: 'https://example.com/v1', model: 'm' },
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ),
      (error) => error && error.code === 'HTTP_RESPONSE_TOO_LARGE',
    )
  } finally {
    globalThis.fetch = original
  }
})

// ── direct-backend local rows: format dispatch over the provider transport ─
//
// Regression for the #550 follow-up, P5 edition: the settings surfaces expose
// the LM Studio native transport (`format: 'lmstudio'`), and callLocalBackend
// maps it to POST {apiRoot}/api/v1/chat, while format='anthropic' keeps the
// Anthropic wire and the default rides the OpenAI-compatible /chat/completions.
// P5: the walk is driven through the vision_describe tool (no Host route),
// local rows execute through the Router-owned provider transport, and the
// tool-side ordering still puts the configured local backend ahead of the
// built-in free rows.

test('the describe walk routes format=lmstudio through the native local transport', async () => {
  const { ctx, captured } = mockHarnessCtx()
  const transportCalls = []
  const providerTransport = {
    async fetch(input, init) {
      transportCalls.push({ url: String(input), body: JSON.parse(init.body) })
      return new Response(JSON.stringify({
        output: [{ type: 'message', content: 'native-ok' }],
        stats: { total_output_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
  apply(ctx, Config({
    localLmStudio: { enabled: true, model: 'qwen2.5-vl', format: 'lmstudio' },
  }), { providerTransport })
  const original = globalThis.fetch
  let bareFetchCalls = 0
  globalThis.fetch = async () => {
    bareFetchCalls += 1
    throw new Error('bare fetch must not own provider egress')
  }
  let result
  try {
    const activate = captured.tools.find((entry) => entry?.name === 'vision_activate')
    assert.ok(activate)
    await activate.execute({}, {})
    const describe = captured.tools.find((entry) => entry?.name === 'vision_describe')
    assert.ok(describe)
    result = await describe.execute(
      { paths: ['/tmp/fake.png'], question: 'What is this?' },
      { agent: { session: { id: 'lmstudio-native-session', events: [] } } },
    )
  } finally {
    globalThis.fetch = original
  }
  assert.equal(bareFetchCalls, 0)
  assert.equal(transportCalls.length, 1)
  assert.ok(transportCalls[0].url.endsWith('/api/v1/chat'), `native endpoint expected, got ${transportCalls[0].url}`)
  assert.equal(transportCalls[0].body.reasoning, 'off')
  assert.equal(transportCalls[0].body.max_output_tokens, 4096)
  assert.equal(result, 'native-ok')
})

test('the describe walk keeps format=openai local backends on the compatible endpoint', async () => {
  const { ctx, captured } = mockHarnessCtx()
  const transportCalls = []
  const providerTransport = {
    async fetch(input, init) {
      transportCalls.push({ url: String(input) })
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'compat-ok' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
  apply(ctx, Config({
    localLmStudio: { enabled: true, model: 'qwen2.5-vl' },
  }), { providerTransport })
  const original = globalThis.fetch
  let bareFetchCalls = 0
  globalThis.fetch = async () => {
    bareFetchCalls += 1
    throw new Error('bare fetch must not own provider egress')
  }
  let result
  try {
    const activate = captured.tools.find((entry) => entry?.name === 'vision_activate')
    assert.ok(activate)
    await activate.execute({}, {})
    const describe = captured.tools.find((entry) => entry?.name === 'vision_describe')
    assert.ok(describe)
    result = await describe.execute(
      { paths: ['/tmp/fake.png'], question: 'What is this?' },
      { agent: { session: { id: 'lmstudio-compat-session', events: [] } } },
    )
  } finally {
    globalThis.fetch = original
  }
  assert.equal(bareFetchCalls, 0)
  assert.equal(transportCalls.length, 1)
  assert.ok(transportCalls[0].url.endsWith('/chat/completions'), `compatible endpoint expected, got ${transportCalls[0].url}`)
  assert.equal(result, 'compat-ok')
})

test('issue #646 pre-step instant describe uses the Router-owned provider transport', async () => {
  const config = {
    routing: false,
    rewriteImages: true,
    instantDescribe: true,
    structuredVisionBootstrap: false,
    downscale: false,
    freeFallback: false,
    localLmStudio: {
      enabled: true,
      baseURL: 'https://remote-lm.example/v1',
      model: 'qwen2.5-vl',
      format: 'lmstudio',
    },
  }
  const { ctx, captured } = mockHarnessCtx({ attachments: true, config0: config })
  const transportCalls = []
  const providerTransport = {
    async fetch(input, init) {
      transportCalls.push({ url: String(input), body: JSON.parse(init.body) })
      return new Response(JSON.stringify({
        output: [{ type: 'message', content: 'transport-ok' }],
        stats: { total_output_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  }
  apply(ctx, Config(config), { providerTransport })

  const original = globalThis.fetch
  let bareFetchCalls = 0
  globalThis.fetch = async () => {
    bareFetchCalls += 1
    throw new Error('bare fetch must not own provider egress')
  }
  try {
    const attachment = {
      attachmentId: 'sha256:64664664664664664664664664664664',
      mediaType: 'image/png',
      name: 'issue-646.png',
    }
    const messages = [{
      role: 'user',
      content: [{ type: 'image', attachment }, { type: 'text', text: 'describe' }],
    }]
    const preStep = captured.on.get('agent/pre-step')
    assert.equal(typeof preStep, 'function')
    await preStep(
      { agent: { session: { id: 'issue-646', events: [] } }, messages, turn: 1 },
      async () => ({ messages }),
    )
  } finally {
    globalThis.fetch = original
  }

  assert.equal(bareFetchCalls, 0)
  assert.equal(transportCalls.length, 1)
  assert.equal(transportCalls[0].url, 'https://remote-lm.example/api/v1/chat')
  assert.equal(transportCalls[0].body.model, 'qwen2.5-vl')
})
