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
const DEFAULT_SESSION_FILE = process.env.DSH_DEFAULT_SESSION_FILE ?? '/data/runtime/default-session.json'
const ADDON_LOG_FILE = process.env.DSH_ADDON_LOG_FILE ?? '/data/dsh-home/addon.log'

/** Strip credentials from log text before it is served over ingress. */
function redactLog(text) {
  return text
    .replace(/[?&]token=[^\s&"']+/g, '?token=[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
}

/** Serve the add-on log tail for diagnostics (authenticated by HA ingress). */
async function serveLogs(res) {
  try {
    const text = redactLog(await readFile(ADDON_LOG_FILE, 'utf8'))
    const lines = text.split('\n')
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(lines.slice(-160).join('\n'))
  } catch (error) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`no add-on log yet: ${error?.message ?? error}\n`)
  }
}

/**
 * Inject the saved first-run session into the browser before the app boots.
 *
 * DSH persists the active session selection in `localStorage` under
 * `dsh.sessions.current`. The first-run session is opened once per browser even
 * if a selection already exists (marked in `dsh.first-run-session`), so an
 * existing browser profile still lands on the analysis; later user choices are
 * never overridden.
 * @param {string} html
 * @param {string} sessionId
 * @returns {string}
 */
export function injectDefaultSession(html, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return html
  const value = JSON.stringify(sessionId)
  const script = `<script>(function(){try{var key="dsh.sessions.current",seen="dsh.first-run-session",id=${value};if(localStorage.getItem(seen)!==id){localStorage.setItem(key,JSON.stringify({sessionId:id}));localStorage.setItem(seen,id)}}catch(error){}})()</script>`
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
}

let defaultSessionCache = { value: undefined, readAt: 0 }

/** Read the first-run session id written by `first-run.mjs`; cached for a second. */
async function defaultSessionId() {
  if (Date.now() - defaultSessionCache.readAt < 1_000) return defaultSessionCache.value
  defaultSessionCache.readAt = Date.now()
  try {
    const parsed = JSON.parse(await readFile(DEFAULT_SESSION_FILE, 'utf8'))
    defaultSessionCache.value = typeof parsed?.sessionId === 'string' ? parsed.sessionId : undefined
  } catch {
    defaultSessionCache.value = undefined
  }
  return defaultSessionCache.value
}

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
  // Home Assistant keeps the bare `??` form but serialises the empty value of
  // the `?<ids>` parameter as `…client.js=&rev=…`; DSH's key has no `=`.
  if (search.startsWith('??')) {
    return `${pathname}${search.replace(/=&/g, '&').replace(/=$/, '')}`
  }
  // Some proxy versions percent-encode the leading `?` of the same parameter.
  if (!/^\?%3F/i.test(search)) return path
  try {
    let decoded = decodeURIComponent(search.slice(1))
    if (!decoded.startsWith('?')) return path
    decoded = decoded.replace(/=&/g, '&').replace(/=$/, '')
    return `${pathname}?${decoded}`
  } catch {
    return path
  }
}

/**
 * A small self-refreshing page shown while DSH is still starting or its launch
 * token is not available yet. It replaces DSH's raw
 * "authentication required; reopen the URL printed by dsh web" page, which is
 * confusing inside the Home Assistant panel.
 * @param {import('node:http').ServerResponse} res
 */
function sendStartingPage(res) {
  const body = [
    '<!doctype html><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>DeepSeek Harness starting…</title>',
    '<style>body{font:15px/1.5 system-ui,sans-serif;background:#0b1220;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}',
    'main{max-width:32rem;padding:2rem;text-align:center}.muted{color:#94a3b8}</style>',
    '<main><h1>DeepSeek Harness is starting…</h1>',
    '<p class="muted">The agent is preparing its first-run system recognition. This page refreshes automatically.</p></main>',
    '<script>setTimeout(function(){location.reload()},2500)</script>',
  ].join('')
  res.writeHead(503, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'retry-after': '2',
  })
  res.end(body)
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

  // Authenticated diagnostics: the Supervisor API serves add-on logs as
  // text/plain, which the Home Assistant WebSocket bridge cannot return, so the
  // shim exposes the log tail through the same ingress-authenticated origin.
  if (target.split('?')[0] === '/__logs') {
    await serveLogs(res)
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
    } else {
      sendStartingPage(res)
      return
    }
  }

  const secure = req.headers['x-forwarded-proto'] === 'https'
  const documentRequest = isDocumentRequest(req.method ?? 'GET', target)
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

      const contentType = String(upstreamRes.headers['content-type'] ?? '')
      if (documentRequest && [401, 403].includes(upstreamRes.statusCode ?? 0)) {
        // A stale or missing DSH session cookie: show the retry page instead of
        // DSH's raw "authentication required" document.
        upstreamRes.resume()
        sendStartingPage(res)
        return
      }
      if (documentRequest && (upstreamRes.statusCode ?? 0) === 200 && contentType.includes('text/html')) {
        // The document is small; buffer it so the default-session script can be
        // injected and the content length corrected.
        const chunks = []
        upstreamRes.on('data', (chunk) => chunks.push(chunk))
        upstreamRes.on('end', () => {
          void (async () => {
            const sessionId = await defaultSessionId()
            let body = Buffer.concat(chunks).toString('utf8')
            if (sessionId !== undefined) body = injectDefaultSession(body, sessionId)
            const encoded = Buffer.from(body, 'utf8')
            delete headers['content-length']
            headers['content-length'] = String(encoded.byteLength)
            res.writeHead(upstreamRes.statusCode ?? 200, headers)
            res.end(encoded)
          })()
        })
        return
      }

      res.writeHead(upstreamRes.statusCode ?? 502, headers)
      upstreamRes.pipe(res)
    },
  )

  upstream.on('error', (error) => {
    process.stderr.write(`${new Date().toISOString()} [shim] upstream error: ${error.message}\n`)
    if (documentRequest) {
      if (!res.headersSent) sendStartingPage(res)
      return
    }
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
