/**
 * ClaWHub API 客户端
 *
 * 封装 clawhub.ai 公开 API（search/install/update），无需登录 token。
 * Phase 2 再添加需要 token 的 publish/whoami。
 */

import * as https from 'node:https'
import * as http from 'node:http'
import { readStoredToken } from './auth.js'

export const DEFAULT_REGISTRY = process.env['CLAWHUB_REGISTRY']?.trim() || 'https://lightmake.site'
const REQUEST_TIMEOUT_MS = 15_000

/** 优先使用显式传入的 token，否则读取本地存储的 token */
async function resolveToken(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit
  return (await readStoredToken()) ?? undefined
}

// ============================================================
// 响应类型
// ============================================================

export interface SearchResult {
  score: number
  slug: string
  displayName?: string
  summary?: string | null
  version?: string | null
  updatedAt?: number
}

export interface SkillMeta {
  skill: {
    slug: string
    displayName: string
    summary?: string | null
    createdAt: number
    updatedAt: number
  } | null
  latestVersion: {
    version: string
    createdAt: number
    changelog: string
  } | null
  moderation?: {
    isSuspicious: boolean
    isMalwareBlocked: boolean
  } | null
}

export interface ResolveResult {
  match: { version: string } | null
  latestVersion: { version: string } | null
}

export interface WhoamiResult {
  handle: string | null
  displayName: string | null
  image: string | null
}

export interface PublishResult {
  slug: string
  version: string
  createdAt?: number
}

// ============================================================
// HTTP 工具
// ============================================================

async function fetchJson<T>(url: string, token?: string): Promise<T> {
  const parsed = new URL(url)
  const mod = parsed.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const req = mod.request(
      { hostname: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname + parsed.search, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(body) as T)
          } catch {
            reject(new Error(`Invalid JSON response: ${body.slice(0, 100)}`))
          }
        })
        res.on('error', reject)
      }
    )
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Request timed out'))
    })
    req.on('error', reject)
    req.end()
  })
}

async function fetchBinary(url: string, token?: string): Promise<Buffer> {
  const parsed = new URL(url)
  const mod = parsed.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const req = mod.request(
      { hostname: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname + parsed.search, method: 'GET', headers },
      (res) => {
        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const location = res.headers['location']
          if (!location) { reject(new Error('Redirect without Location header')); return }
          fetchBinary(location, token).then(resolve, reject)
          res.resume()
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(new Error(`HTTP ${res.statusCode} downloading zip`))
            return
          }
          resolve(Buffer.concat(chunks))
        })
        res.on('error', reject)
      }
    )
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Request timed out'))
    })
    req.on('error', reject)
    req.end()
  })
}

async function postMultipartPublish<T>(
  url: string,
  payload: Record<string, unknown>,
  files: Array<{ name: string; data: Uint8Array }>,
  token?: string,
): Promise<T> {
  const boundary = `----SemaClawBoundary${Date.now().toString(16)}`
  const parts: Buffer[] = []

  // payload field — JSON string
  const payloadJson = JSON.stringify(payload)
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${payloadJson}\r\n`,
  ))

  // files fields — one entry per file
  for (const file of files) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ))
    parts.push(Buffer.from(file.data))
    parts.push(Buffer.from('\r\n'))
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`))

  const body = Buffer.concat(parts)
  const parsed = new URL(url)
  const mod = parsed.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
      'Accept': 'application/json',
    }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const req = mod.request(
      { hostname: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname + parsed.search, method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(responseBody) as T)
          } catch {
            reject(new Error(`Invalid JSON response: ${responseBody.slice(0, 100)}`))
          }
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Request timed out'))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function registryUrl(path: string, registry: string): string {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  const rel = path.startsWith('/') ? path.slice(1) : path
  return `${base}${rel}`
}

// ============================================================
// 公开 API
// ============================================================

export async function searchSkills(
  query: string,
  options: { registry?: string; limit?: number; token?: string } = {},
): Promise<SearchResult[]> {
  const registry = options.registry ?? DEFAULT_REGISTRY
  const token = await resolveToken(options.token)
  const url = new URL(registryUrl('/api/v1/search', registry))
  url.searchParams.set('q', query)
  if (options.limit) url.searchParams.set('limit', String(options.limit))

  const res = await fetchJson<{ results: Array<{
    score: number; slug?: string; displayName?: string
    summary?: string | null; version?: string | null; updatedAt?: number
  }> }>(url.toString(), token)

  return res.results.map(r => ({
    score: r.score,
    slug: r.slug ?? '',
    displayName: r.displayName,
    summary: r.summary ?? null,
    version: r.version ?? null,
    updatedAt: r.updatedAt,
  }))
}

export async function getSkillMeta(
  slug: string,
  options: { registry?: string; token?: string } = {},
): Promise<SkillMeta> {
  const registry = options.registry ?? DEFAULT_REGISTRY
  const token = await resolveToken(options.token)
  const url = registryUrl(`/api/v1/skills/${encodeURIComponent(slug)}`, registry)
  return fetchJson<SkillMeta>(url, token)
}

export async function downloadSkillZip(
  slug: string,
  version: string,
  options: { registry?: string; token?: string } = {},
): Promise<Buffer> {
  const registry = options.registry ?? DEFAULT_REGISTRY
  const token = await resolveToken(options.token)
  const url = new URL(registryUrl('/api/v1/download', registry))
  url.searchParams.set('slug', slug)
  url.searchParams.set('version', version)
  return fetchBinary(url.toString(), token)
}

export async function resolveSkillVersion(
  slug: string,
  fingerprint: string,
  options: { registry?: string; token?: string } = {},
): Promise<ResolveResult> {
  const registry = options.registry ?? DEFAULT_REGISTRY
  const token = await resolveToken(options.token)
  const url = new URL(registryUrl('/api/v1/resolve', registry))
  url.searchParams.set('slug', slug)
  url.searchParams.set('hash', fingerprint)
  return fetchJson<ResolveResult>(url.toString(), token)
}

export async function whoami(
  options: { registry?: string; token?: string } = {},
): Promise<WhoamiResult> {
  const registry = options.registry ?? DEFAULT_REGISTRY
  const token = await resolveToken(options.token)
  if (!token) throw new Error('Not logged in. Run: semaclaw clawhub login')
  const url = registryUrl('/api/v1/whoami', registry)
  const res = await fetchJson<{ user: WhoamiResult }>(url, token)
  return res.user
}

export async function publishSkill(
  options: {
    slug: string
    displayName: string
    version: string
    changelog: string
    tags: string[]
    files: Array<{ name: string; data: Uint8Array }>
    registry?: string
    token?: string
  },
): Promise<PublishResult> {
  const registry = options.registry ?? DEFAULT_REGISTRY
  const token = await resolveToken(options.token)
  if (!token) throw new Error('Not logged in. Run: semaclaw clawhub login')

  const url = registryUrl('/api/v1/skills', registry)
  const payload = {
    slug: options.slug,
    displayName: options.displayName,
    version: options.version,
    changelog: options.changelog,
    tags: options.tags,
  }

  const res = await postMultipartPublish<{ skill: PublishResult }>(
    url,
    payload,
    options.files,
    token,
  )
  return res.skill
}
