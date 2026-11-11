/**
 * Unit tests for the ingress shim helpers (no sockets, no network).
 *
 * Run directly (the Windows sandbox blocks `node --test` child spawns):
 *   node tests/runtime/shim.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

const shim = await import('../../deepseek_harness/rootfs/opt/ha-dsh/runtime/ingress-shim.mjs')

test('peerAllowed accepts Supervisor and loopback only', () => {
  assert.equal(shim.peerAllowed('172.30.32.2'), true)
  assert.equal(shim.peerAllowed('172.30.33.9'), true)
  assert.equal(shim.peerAllowed('127.0.0.1'), true)
  assert.equal(shim.peerAllowed('::1'), true)
  assert.equal(shim.peerAllowed('::ffff:127.0.0.1'), true)
  assert.equal(shim.peerAllowed('192.168.1.20'), false)
  assert.equal(shim.peerAllowed('10.0.0.5'), false)
  assert.equal(shim.peerAllowed(undefined), false)
})

test('stripIngressPrefix removes the header prefix and keeps the query', () => {
  const result = shim.stripIngressPrefix('/api/hassio_ingress/TOK123/assets/app.js?v=1', '/api/hassio_ingress/TOK123/')
  assert.equal(result.path, '/assets/app.js?v=1')
  assert.equal(result.prefix, '/api/hassio_ingress/TOK123/')
})

test('stripIngressPrefix removes a prefix discovered from the header alone', () => {
  const result = shim.stripIngressPrefix('/api/hassio_ingress/TOK/assets/app.js', '/api/hassio_ingress/TOK')
  assert.equal(result.path, '/assets/app.js')
})

test('stripIngressPrefix falls back to the ingress path regex', () => {
  const result = shim.stripIngressPrefix('/api/hassio_ingress/TOK123/api/states?x=1', undefined)
  assert.equal(result.path, '/api/states?x=1')
  assert.equal(result.prefix, '/api/hassio_ingress/TOK123/')
})

test('stripIngressPrefix passes through unprefixed paths', () => {
  const result = shim.stripIngressPrefix('/health', undefined)
  assert.equal(result.path, '/health')
  assert.equal(result.prefix, '/')
})

test('stripIngressPrefix maps the bare root to /', () => {
  const result = shim.stripIngressPrefix('/api/hassio_ingress/TOK123/', '/api/hassio_ingress/TOK123/')
  assert.equal(result.path, '/')
  assert.equal(result.prefix, '/api/hassio_ingress/TOK123/')
})

test('rewriteSetCookie scopes Path to the ingress path', () => {
  assert.equal(
    shim.rewriteSetCookie('dsh-auth=abc; Path=/; HttpOnly; SameSite=Strict', '/api/hassio_ingress/TOK/', false),
    'dsh-auth=abc; Path=/api/hassio_ingress/TOK/; HttpOnly; SameSite=Strict',
  )
})

test('rewriteSetCookie adds Path, Secure and SameSite when missing', () => {
  const rewritten = shim.rewriteSetCookie('dsh-auth=abc; HttpOnly', '/p/', true)
  assert.match(rewritten, /Path=\/p\//)
  assert.match(rewritten, /Secure/)
  assert.match(rewritten, /SameSite=Strict/)
})

test('rewriteSetCookie keeps an explicit non-root path', () => {
  assert.equal(
    shim.rewriteSetCookie('x=1; Path=/keep/', '/p/', false),
    'x=1; Path=/keep/; SameSite=Strict',
  )
})

test('isDocumentRequest matches only the single root document', () => {
  assert.equal(shim.isDocumentRequest('GET', '/'), true)
  assert.equal(shim.isDocumentRequest('HEAD', '/'), true)
  assert.equal(shim.isDocumentRequest('GET', '/?token=abc'), true)
  assert.equal(shim.isDocumentRequest('GET', '/assets/app.js'), false)
  assert.equal(shim.isDocumentRequest('GET', '/api/states'), false)
  assert.equal(shim.isDocumentRequest('POST', '/'), false)
})

test('upstreamHeaders rewrites Host, drops Origin and the ingress path', () => {
  const headers = shim.upstreamHeaders({
    host: 'homeassistant.local:8123',
    origin: 'https://homeassistant.local:8123',
    referer: 'https://homeassistant.local:8123/api/hassio_ingress/TOK/',
    'x-ingress-path': '/api/hassio_ingress/TOK/',
    cookie: 'ingress_session=abc',
    'accept-language': 'en',
  })
  assert.equal(headers.host, 'dsh.local')
  assert.equal(headers.origin, undefined)
  assert.equal(headers.referer, undefined)
  assert.equal(headers['x-ingress-path'], undefined)
  assert.equal(headers.cookie, 'ingress_session=abc')
  assert.equal(headers['accept-language'], 'en')
})

test('upstreamHeaders keeps WebSocket upgrade headers when asked', () => {
  const headers = shim.upstreamHeaders(
    { host: 'ha.local', origin: 'https://ha.local', connection: 'Upgrade', upgrade: 'websocket' },
    { keepUpgrade: true },
  )
  assert.equal(headers.connection, 'Upgrade')
  assert.equal(headers.upgrade, 'websocket')
  assert.equal(headers.origin, undefined)
})

test('normalizePluginBundleUrl restores the double-question bundle key', () => {
  assert.equal(
    shim.normalizePluginBundleUrl(
      '/plugins/?%3F%40deepseek-ai%2Fdsh-client-modules%2Fclient.js=&rev=1b6d0c9f5ce1',
    ),
    '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=1b6d0c9f5ce1',
  )
})

test('normalizePluginBundleUrl restores multi-entry bundle keys', () => {
  assert.equal(
    shim.normalizePluginBundleUrl(
      '/plugins/?%3F%40deepseek-ai%2Fa%2Fclient.js%2C%40deepseek-ai%2Fb%2Fclient.js=&rev=abc',
    ),
    '/plugins/??@deepseek-ai/a/client.js,@deepseek-ai/b/client.js&rev=abc',
  )
})

test('normalizePluginBundleUrl strips the injected empty-value equals sign', () => {
  // Home Assistant keeps the bare `??` form but serialises the empty value of
  // the ids parameter, producing `...client.js=&rev=...`.
  assert.equal(
    shim.normalizePluginBundleUrl('/plugins/??@deepseek-ai/dsh-client-modules/client.js=&rev=da3d2b3bebd0'),
    '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=da3d2b3bebd0',
  )
})

test('normalizePluginBundleUrl leaves other URLs untouched', () => {
  for (const url of [
    '/plugins/',
    '/plugins/@deepseek-ai/dsh-client-modules/client.js?rev=abc',
    '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=abc',
    '/assets/index.js',
    '/',
  ]) {
    assert.equal(shim.normalizePluginBundleUrl(url), url, url)
  }
})
