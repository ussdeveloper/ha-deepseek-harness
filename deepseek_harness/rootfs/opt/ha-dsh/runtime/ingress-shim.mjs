/**
 * Ingress shim: the only listener the Supervisor can reach (port 8099).
 *
 * Home Assistant authenticates the browser and forwards every request with an
 * `X-Ingress-Path` header. DSH itself serves origin-root URLs only and enforces
 * a Host/Origin browser-trust fence, so the shim:
 *
 *   - accepts connections only from the Supervisor network / loopback;
 *   - strips the ingress prefix before proxying to DSH on loopback;
 *   - normalises `Host` to the trusted `dsh.local` authority and drops `Origin`
 *     (DSH rejects a mismatched Origin; Home Assistant already authenticated);
 *   - injects the per-process launch token on the first document request so the
 *     browser can obtain DSH's session cookie;
 *   - scopes DSH cookies to the ingress path (`Set-Cookie: Path=…`), which Home
 *     Assistant's proxy does not do for us;
 *   - forwards WebSocket upgrades (the agent streams over `/api/remote.mux`).
 *
 * Plain Node built-ins only.
 *
 * @module ingress-shim
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const WEB_HOST = '127.0.0.1'
const WEB_PORT = Number.parseInt(process.env.DSH_WEB_PORT ?? '3080', 10)
const INGRESS_PORT = Number.parseInt(process.env.DSH_INGRESS_PORT ?? '8099', 10)
const BIND = process.env.DSH_INGRESS_BIND ?? '0.0.0.0'
const TOKEN_FILE = process.env.DSH_TOKEN_FILE ?? '/data/runtime/dsh-token'
const TRUSTED_AUTHORITY = 'dsh.local'

/** Networks allowed to talk to the ingress port (Supervisor + loopback). */
const ALLOWED = [
  /^127\./,
  /^::1$/,
  /^::ffff:127\./,
  /^172\.30\.32\./,
  /^172\.30\.33\./,
  ...(process.env.DSH_INGRESS_ALLOW_CIDR ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => new RegExp(`^${entry.replaceAll('.', '\\.').replace('*', '\\d+')}$`)),
]

/** @param {string|undefined} address @returns {boolean} */
export function peerAllowed(address) {
  if (address === undefined) return false
  return ALLOWED.some((pattern) => pattern.test(address))
}

/**
 * Strip the ingress prefix from a browser path.
 * @param {string} url path with optional query string
 * @param {string|undefined} ingressPath `X-Ingress-Path` header value
 * @returns {{ path: string, prefix: string }}
 */
export function stripIngressPrefix(url, ingressPath) {
  const [rawPath, ...rest] = url.split('?')
  const query = rest.length === 0 ? '' : `?${rest.join('?')}`
  const prefix = (ingressPath ?? '').replace(/\/+$/, '')
  if (prefix !== '' && (rawPath === prefix || rawPath.startsWith(`${prefix}/`))) {
    const path = rawPath.slice(prefix.length) || '/'
    return { path: `${path}${query}`, prefix: `${prefix}/` }
  }
  const match = /^\/api\/hassio_ingress\/[^/]+/.exec(rawPath)
  if (match !== null) {
    const path = rawPath.slice(match[0].length) || '/'
    return { path: `${path}${query}`, prefix: `${match[0]}/` }
  }
  return { path: `${rawPath === '' ? '/' : rawPath}${query}`, prefix: '/' }
}

/**
 * Rewrite a Set-Cookie header so DSH's cookie is scoped to the ingress path.
 * @param {string} cookie
 * @param {string} prefix ingress root ending with `/`
 * @param {boolean} secure
 * @returns {string}
 */
export function rewriteSetCookie(cookie, prefix, secure) {
  let value = cookie.replace(/;\s*path=\/?(?=;|$)/i, `; Path=${prefix}`)
  if (!/;\s*path=/i.test(value)) value += `; Path=${prefix}`
  if (secure && !/;\s*secure(?:;|$)/i.test(value)) value += '; Secure'
  if (!/;\s*samesite=/i.test(value)) value += '; SameSite=Strict'
  return value
}

/**
 * Whether a request is the single document that needs the launch token.
 * Assets, `/api/*`, `/connect` and WebSocket upgrades are plain forwards.
 * @param {string} method @param {string} path stripped path (may carry a query)
 */
export function isDocumentRequest(method, path) {
  if (method !== 'GET' && method !== 'HEAD') return false
  return path.split('?')[0] === '/'
}

/** @param {string|undefined} cookieHeader */
function hasAuthCookie(cookieHeader) {
  return typeof cookieHeader === 'string' && /(?:^|;\s*)(?:dsh[-_])?(?:auth|session|cookie)/i.test(cookieHeader)
}

let tokenCache = { value: undefined, readAt: 0 }

/** Read the launch token written by the entrypoint; cached for a second. */
async function launchToken() {
  if (Date.now() - tokenCache.readAt < 1_000) return tokenCache.value
  tokenCache.readAt = Date.now()
  try {
    const value = (await readFile(TOKEN_FILE, 'utf8')).trim()
    tokenCache.value = value === '' ? undefined : value
  } catch {
    tokenCache.value = undefined
  }
  return tokenCache.value
}

/**
 * Prepare upstream headers for the DSH server.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {{ keepUpgrade?: boolean }} [options]
 */
export function upstreamHeaders(headers, options = {}) {
  /** @type {Record<string, string|string[]>} */
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (lower === 'host' || lower === 'origin' || lower === 'referer') continue
    if (lower === 'x-ingress-path') continue
    if (!options.keepUpgrade && (lower === 'connection' || lower === 'upgrade')) continue
    out[lower] = value
  }
  out.host = TRUSTED_AUTHORITY
  return out
}

/**
 * Restore the plugin-bundle URL through Home Assistant's proxies.
 *
 * DSH advertises bundles as `plugins/??<ids>/client.js&rev=…`: the first `?`
 * starts the query and the second is part of the exact resource key the module
 * registry matches. Home Assistant Core parses that query into a parameter
 * (`?@…` with an empty value) and re-encodes it, so the add-on receives
 * `/plugins/?%3F%40…=&rev=…` and DSH answers 404. Rebuild the exact key.
 *
 * @param {string} path stripped request path (with query string)
 * @returns {string} path DSH matches, or the input unchanged
 */
export function normalizePluginBundleUrl(path) {
  const queryIndex = path.indexOf('?')
  if (queryIndex === -1) return path
  const pathname = path.slice(0, queryIndex)
  if (pathname !== '/plugins/') return path
  const search = path.slice(queryIndex)
  if (!/^\?%3F/i.test(search)) return path
  try {
    let decoded = decodeURIComponent(search.slice(1))
    if (!decoded.startsWith('?')) return path
    // aiohttp serialises the empty value of the `?ids` key as `…=&rev`, while
    // the advertised key has no `=`.
    decoded = decoded.replace(/=&/g, '&').replace(/=$/, '')
    return `${pathname}?${decoded}`
  } catch {
    return path
  }
}

/**
 * Proxy one HTTP request to the DSH web server.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function proxyRequest(req, res) {
  const rawUrl = req.url ?? '/'
  const headerPrefix = (req.headers['x-ingress-path'] ?? '').replace(/\/+$/, '')
  const rawPath = rawUrl.split('?')[0]
  // The panel URL always ends with "/": a bare prefix is redirected relatively,
  // because Home Assistant's proxy does not follow redirects for us.
  if (headerPrefix !== '' && rawPath === headerPrefix) {
    res.writeHead(308, { location: `${headerPrefix}/` })
    res.end()
    return
  }

  const { path, prefix } = stripIngressPrefix(rawUrl, headerPrefix)
  let target = normalizePluginBundleUrl(path)

  // Temporary diagnostics: `curl -H 'x-dsh-debug: 1'` returns the exact URL
  // this shim received after Home Assistant's proxies.
  if (req.headers['x-dsh-debug'] === '1') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        url: rawUrl,
        ingress_path: req.headers['x-ingress-path'] ?? null,
        prefix,
        path,
        target,
        host: req.headers.host ?? null,
        origin: req.headers.origin ?? null,
      }),
    )
    return
  }

  if (
    isDocumentRequest(req.method ?? 'GET', target) &&
    !/[?&]token=/.test(target) &&
    !hasAuthCookie(req.headers.cookie)
  ) {
    // Wait briefly for DSH to print its launch token on a cold start.
    const deadline = Date.now() + 2_500
    let token = await launchToken()
    while (token === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      token = await launchToken()
    }
    if (token !== undefined) {
      target += `${target.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    }
  }

  const secure = req.headers['x-forwarded-proto'] === 'https'
  const upstream = httpRequest(
    {
      host: WEB_HOST,
      port: WEB_PORT,
      method: req.method,
      path: target,
      headers: upstreamHeaders(req.headers),
    },
    (upstreamRes) => {
      /** @type {import('node:http').IncomingHttpHeaders} */
      const headers = { ...upstreamRes.headers }
      const cookies = upstreamRes.headers['set-cookie']
      if (cookies !== undefined) {
        headers['set-cookie'] = cookies.map((cookie) => rewriteSetCookie(cookie, prefix, secure))
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headers)
      upstreamRes.pipe(res)
    },
  )

  upstream.on('error', (error) => {
    process.stderr.write(`${new Date().toISOString()} [shim] upstream error: ${error.message}\n`)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('DeepSeek Harness is starting; retry in a moment.')
  })

  req.pipe(upstream)
}

/**
 * Proxy a WebSocket upgrade.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 */
function proxyUpgrade(req, socket, head) {
  const { path } = stripIngressPrefix(req.url ?? '/', req.headers['x-ingress-path'])
  const headers = upstreamHeaders(req.headers, { keepUpgrade: true })
  const lines = [`GET ${path} HTTP/1.1`]
  for (const [key, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`)
  }
  const upstream = netConnect(WEB_PORT, WEB_HOST, () => {
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', (error) => {
    process.stderr.write(`${new Date().toISOString()} [shim] websocket upstream error: ${error.message}\n`)
    socket.destroy()
  })
  socket.on('error', () => upstream.destroy())
}

/** Start the ingress listener. */
export function startShim() {
  const server = createServer((req, res) => {
    if (!peerAllowed(req.socket.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }
    void proxyRequest(req, res)
  })

  server.on('upgrade', (req, socket, head) => {
    if (!peerAllowed(req.socket.remoteAddress)) {
      socket.destroy()
      return
    }
    proxyUpgrade(req, socket, head)
  })

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    void error
  })

  server.listen(INGRESS_PORT, BIND, () => {
    process.stdout.write(
      `${new Date().toISOString()} [shim] listening on ${BIND}:${INGRESS_PORT} -> http://${WEB_HOST}:${WEB_PORT}\n`,
    )
  })

  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  return server
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startShim()
}
