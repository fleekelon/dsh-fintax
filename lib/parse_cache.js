// dsh-fintax v0.9.0 纯内存短生命周期解析结果缓存（严禁写盘）。
// 供 Phase 2 导出 HTML/MD/CSV 复用解析产物，避免前端重复上传最高 20 MiB 的 Base64 账单。
// 安全隔离：通过不透明 128-bit 随机 cacheToken 严格绑定宿主已鉴别的独占会话身份 scopeKey，防跨会话误读；
// 严禁退回全局公共默认作用域（缺失有效 scopeKey 时拒绝写入与读取，安全回退由前端重传）；
// 内置 TTL 过期自动淘汰、条目数上限 LRU 驱逐与基于 JS 结构估算的软内存预算（estimated soft budget，非 V8 堆或进程 RSS 硬上限）。

import { randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_RE = /^[0-9a-f]{32}$/
const DEFAULT_MAX_ENTRIES = 8
const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024

function normalizeScopeKey(scope) {
  if (typeof scope !== 'string') return null
  const trimmed = scope.trim().slice(0, 256)
  return trimmed ? trimmed : null
}

function safeScopeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8')
  const bufB = Buffer.from(String(b), 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * 递归估算解析产物占用字节数（安全支持 BigInt、Buffer/TypedArray 与防循环引用）。
 * 注意：该值为用于 LRU/容量淘汰的软内存预算估算（estimated soft budget），不等同于 V8 堆内存或进程 RSS 物理上限。
 */
export function estimateValueBytes(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return 4
  if (depth > 32) return 32
  const type = typeof value
  if (type === 'boolean') return 4
  if (type === 'number') return 8
  if (type === 'bigint') return Math.max(16, String(value).length + 8)
  if (type === 'string') return Buffer.byteLength(value, 'utf8') + 16
  if (type !== 'object') return 16
  if (seen.has(value)) return 8
  seen.add(value)
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength + 16
  if (value instanceof ArrayBuffer) return value.byteLength + 16
  if (value instanceof Date) return 24
  if (Array.isArray(value)) {
    let total = 32
    for (let i = 0; i < value.length; i++) total += estimateValueBytes(value[i], seen, depth + 1)
    return total
  }
  if (value instanceof Map) {
    let total = 48
    for (const [k, v] of value.entries()) {
      total += estimateValueBytes(k, seen, depth + 1) + estimateValueBytes(v, seen, depth + 1)
    }
    return total
  }
  if (value instanceof Set) {
    let total = 48
    for (const item of value.values()) total += estimateValueBytes(item, seen, depth + 1)
    return total
  }
  let total = 48
  for (const key of Object.keys(value)) {
    total += Buffer.byteLength(key, 'utf8') + 16 + estimateValueBytes(value[key], seen, depth + 1)
  }
  return total
}

function sanitizeMeta(rawMeta) {
  if (typeof rawMeta === 'string') return { scopeKey: normalizeScopeKey(rawMeta) }
  if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) return { scopeKey: null }
  const out = {}
  for (const key of Object.keys(rawMeta)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    out[key] = rawMeta[key]
  }
  out.scopeKey = normalizeScopeKey(rawMeta.scopeKey ?? rawMeta.sessionId ?? rawMeta.workspaceKey)
  return out
}

export function createParseCache({
  maxEntries = DEFAULT_MAX_ENTRIES,
  ttlMs = DEFAULT_TTL_MS,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  now = () => Date.now(),
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('maxEntries 须为大于等于 1 的整数。')
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError('ttlMs 须为正数。')
  }
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new RangeError('maxTotalBytes 须为正数。')
  }
  if (typeof now !== 'function') {
    throw new TypeError('now 须为返回毫秒时间戳的函数。')
  }

  const store = new Map()
  let totalBytes = 0
  let hits = 0
  let misses = 0
  let puts = 0
  let evictedExpired = 0
  let evictedLru = 0
  let evictedBytes = 0
  let rejectedOversize = 0
  let scopeMismatches = 0

  function removeKey(token, reason = null) {
    const entry = store.get(token)
    if (!entry) return false
    store.delete(token)
    totalBytes = Math.max(0, totalBytes - entry.sizeBytes)
    if (reason === 'expired') evictedExpired++
    else if (reason === 'lru') evictedLru++
    else if (reason === 'bytes') evictedBytes++
    return true
  }

  function pruneExpired(currentTime = now()) {
    let removed = 0
    for (const [token, entry] of store.entries()) {
      if (entry.expiresAt <= currentTime) {
        removeKey(token, 'expired')
        removed++
      }
    }
    return removed
  }

  function put(result, rawMeta = {}) {
    const currentTime = now()
    pruneExpired(currentTime)

    const meta = sanitizeMeta(rawMeta)
    if (!meta.scopeKey) {
      return {
        cached: false,
        cacheToken: null,
        scopeKey: null,
        createdAt: currentTime,
        expiresAt: 0,
        sizeBytes: 0,
        maxTotalBytes,
        budgetKind: 'estimated_soft_budget',
        reason: 'UNSCOPED_SESSION',
      }
    }
    const explicitBytes = Number.isSafeInteger(meta.byteSize) && meta.byteSize > 0 ? meta.byteSize : null
    const sizeBytes = explicitBytes ?? (estimateValueBytes(result) + estimateValueBytes(meta))

    if (sizeBytes > maxTotalBytes) {
      rejectedOversize++
      return {
        cached: false,
        cacheToken: null,
        scopeKey: meta.scopeKey,
        createdAt: currentTime,
        expiresAt: 0,
        sizeBytes,
        maxTotalBytes,
        budgetKind: 'estimated_soft_budget',
        reason: 'ENTRY_TOO_LARGE',
      }
    }

    const entryTtlMs = Number.isFinite(meta.ttlMs) && meta.ttlMs > 0 ? Math.min(meta.ttlMs, ttlMs) : ttlMs

    while (store.size >= maxEntries && store.size > 0) {
      const oldestToken = store.keys().next().value
      removeKey(oldestToken, 'lru')
    }
    while (totalBytes + sizeBytes > maxTotalBytes && store.size > 0) {
      const oldestToken = store.keys().next().value
      removeKey(oldestToken, 'bytes')
    }

    let cacheToken = randomBytes(16).toString('hex')
    while (store.has(cacheToken)) cacheToken = randomBytes(16).toString('hex')

    const expiresAt = currentTime + entryTtlMs
    store.set(cacheToken, {
      result,
      meta,
      scopeKey: meta.scopeKey,
      createdAt: currentTime,
      lastAccessedAt: currentTime,
      expiresAt,
      sizeBytes,
    })
    totalBytes += sizeBytes
    puts++

    return {
      cached: true,
      cacheToken,
      scopeKey: meta.scopeKey,
      createdAt: currentTime,
      expiresAt,
      sizeBytes,
    }
  }

  function get(token, scopeKey) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      misses++
      return null
    }
    const entry = store.get(token)
    if (!entry) {
      misses++
      return null
    }
    const currentTime = now()
    if (entry.expiresAt <= currentTime) {
      removeKey(token, 'expired')
      misses++
      return null
    }
    const requestedScope = normalizeScopeKey(scopeKey)
    if (!requestedScope || !safeScopeEqual(entry.scopeKey, requestedScope)) {
      scopeMismatches++
      misses++
      return null
    }
    // LRU 刷新：移至 Map 尾部作为最近访问项
    store.delete(token)
    entry.lastAccessedAt = currentTime
    store.set(token, entry)
    hits++
    return {
      result: entry.result,
      meta: entry.meta,
      scopeKey: entry.scopeKey,
      createdAt: entry.createdAt,
      lastAccessedAt: entry.lastAccessedAt,
      expiresAt: entry.expiresAt,
      sizeBytes: entry.sizeBytes,
    }
  }

  function del(token, scopeKey) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false
    const entry = store.get(token)
    if (!entry) return false
    const requestedScope = normalizeScopeKey(scopeKey)
    if (!requestedScope || !safeScopeEqual(entry.scopeKey, requestedScope)) {
      scopeMismatches++
      return false
    }
    return removeKey(token)
  }

  function stats() {
    pruneExpired(now())
    return {
      entries: store.size,
      maxEntries,
      totalBytes,
      maxTotalBytes,
      budgetKind: 'estimated_soft_budget',
      ttlMs,
      hits,
      misses,
      puts,
      evictedExpired,
      evictedLru,
      evictedBytes,
      rejectedOversize,
      scopeMismatches,
    }
  }

  function clear() {
    store.clear()
    totalBytes = 0
  }

  return {
    put,
    get,
    delete: del,
    stats,
    clear,
    prune: () => pruneExpired(now()),
  }
}
