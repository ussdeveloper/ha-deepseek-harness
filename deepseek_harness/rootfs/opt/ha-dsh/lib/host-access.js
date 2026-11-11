/**
 * Host execution: run a shell command with root access to the Home Assistant
 * OS host.
 *
 * Strategy:
 *  1. `nsenter -t 1 …` when the container runs in the host PID namespace
 *     (`host_pid: true` + `full_access: true` + protection mode off).
 *  2. Fallback through the Docker API (`docker_api: true`): start a short-lived
 *     privileged helper container from the add-on's own image, bind-mount the
 *     host root at `/host`, and run `chroot /host /bin/sh -lc <command>`.
 *
 * Both paths are equivalent to root on the host: callers must gate them behind
 * an explicit user confirmation.
 *
 * @module host-access
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

export const DOCKER_SOCKETS = ['/run/docker.sock', '/var/run/docker.sock']

/** @returns {string|undefined} existing Docker socket path */
export function dockerSocket() {
  return DOCKER_SOCKETS.find((candidate) => existsSync(candidate))
}

/**
 * Call the Docker Engine API over its Unix socket.
 * @param {string} socketPath
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ status: number, body: Buffer }>}
 */
export function dockerRequest(socketPath, method, path, body = undefined, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const request = http.request(
      {
        socketPath,
        method,
        path,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }))
      },
    )
    request.on('timeout', () => request.destroy(new Error('docker API timeout')))
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

/** Demultiplex Docker's log stream (8-byte frame headers). */
function demuxLogs(buffer) {
  const chunks = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4)
    const start = offset + 8
    const end = Math.min(buffer.length, start + size)
    chunks.push(buffer.subarray(start, end))
    offset = end
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Find this container's image id through its cgroup entry. */
async function ownImageId(socketPath) {
  try {
    const cgroup = await readFile('/proc/self/cgroup', 'utf8')
    const id = /[0-9a-f]{64}/.exec(cgroup)?.[0]
    if (id === undefined) return undefined
    const inspect = await dockerRequest(socketPath, 'GET', `/containers/${id}/json`)
    if (inspect.status !== 200) return undefined
    const info = JSON.parse(inspect.body.toString('utf8'))
    return typeof info.Image === 'string' ? info.Image : undefined
  } catch {
    return undefined
  }
}

/**
 * Run a command through a temporary privileged container (Docker fallback).
 * @param {string} command
 * @param {number} timeoutMs
 * @returns {Promise<{ exitCode: number|null, stdout: string, stderr: string, via: string }>}
 */
async function dockerHostExec(command, timeoutMs) {
  const socketPath = dockerSocket()
  if (socketPath === undefined) throw new Error('Docker socket is not available (docker_api/protection mode).')
  const image = await ownImageId(socketPath)
  if (image === undefined) throw new Error('Cannot determine the add-on image id through the Docker API.')

  const created = await dockerRequest(
    socketPath,
    'POST',
    '/containers/create',
    {
      Image: image,
      Cmd: ['chroot', '/host', '/bin/sh', '-lc', command],
      Tty: false,
      AttachStdout: false,
      AttachStderr: false,
      HostConfig: {
        Privileged: true,
        PidMode: 'host',
        NetworkMode: 'host',
        Binds: ['/:/host:rw'],
        SecurityOpt: ['apparmor=unconfined'],
        AutoRemove: false,
      },
    },
    30_000,
  )
  if (created.status !== 201) {
    throw new Error(`Docker create failed: HTTP ${created.status}: ${created.body.toString('utf8').slice(0, 500)}`)
  }
  const containerId = JSON.parse(created.body.toString('utf8')).Id
  try {
    const started = await dockerRequest(socketPath, 'POST', `/containers/${containerId}/start`, undefined, 15_000)
    if (started.status !== 204 && started.status !== 304) {
      throw new Error(`Docker start failed: HTTP ${started.status}: ${started.body.toString('utf8').slice(0, 300)}`)
    }
    const waited = await new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        try {
          await dockerRequest(socketPath, 'POST', `/containers/${containerId}/kill`, undefined, 5_000)
        } catch {
          // ignore
        }
        reject(new Error(`host command timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      dockerRequest(socketPath, 'POST', `/containers/${containerId}/wait?condition=not-running`, undefined, timeoutMs + 5_000)
        .then((result) => {
          clearTimeout(timer)
          resolve(result)
        })
        .catch((error) => {
          clearTimeout(timer)
          reject(error)
        })
    })
    const statusCode = JSON.parse(waited.body.toString('utf8')).StatusCode ?? null
    const logResult = await dockerRequest(
      socketPath,
      'GET',
      `/containers/${containerId}/logs?stdout=1&stderr=1&follow=0`,
      undefined,
      15_000,
    )
    const text = demuxLogs(logResult.body)
    return { exitCode: statusCode, stdout: text, stderr: '', via: 'docker privileged chroot' }
  } finally {
    try {
      await dockerRequest(socketPath, 'DELETE', `/containers/${containerId}?force=1`, undefined, 10_000)
    } catch {
      // best effort cleanup
    }
  }
}

/**
 * Run a command in the host namespace, preferring nsenter and falling back to
 * the Docker helper container.
 * @param {string} command
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ exitCode: number|null, stdout: string, stderr: string, via: string }>}
 */
export async function hostExec(command, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const direct = await new Promise((resolve) => {
    let child
    try {
      child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-lc', command], {
        cwd: '/',
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve(undefined)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // A permission failure is worth falling back for; other non-zero exits are
      // real command results.
      if (code !== 0 && /operation not permitted|permission denied|no such file/i.test(stderr)) resolve(undefined)
      else resolve({ exitCode: code, stdout, stderr, via: 'nsenter' })
    })
  })
  if (direct !== undefined) return direct
  return await dockerHostExec(command, timeoutMs)
}
