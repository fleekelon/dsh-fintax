// API transport, request deduplication hook, file encoders, and passive dsh-market Update API v1 probe.

export function useLatestRequest() {
  const state = useRef({ version: 0, controller: null })
  const invalidate = useCallback(() => {
    state.current.version++
    state.current.controller?.abort()
    state.current.controller = null
  }, [])
  useEffect(() => invalidate, [invalidate])
  const start = useCallback(() => {
    invalidate()
    const version = state.current.version
    const controller = new AbortController()
    state.current.controller = controller
    return {
      signal: controller.signal,
      isCurrent: () => state.current.version === version,
    }
  }, [invalidate])
  return [start, invalidate]
}

export const API_BASE = (() => {
  try { return new URL('api/fintax', document.baseURI).pathname } catch { return '/api/fintax' }
})()

// 仅保存在客户端工作台闭包内存中的 128-bit 会话随机标识与服务端 HMAC 会话断言（严禁写入 localStorage / Cookie）
const CLIENT_SESSION_ID = (() => {
  try {
    const bytes = new Uint8Array(16)
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(bytes)
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch { /* fallback for non-WebCrypto VM test sandboxes */ }
  let hex = ''
  for (let i = 0; i < 4; i++) {
    const chunk = ((Math.random() * 0xffffffff) >>> 0) ^ (((Date.now() + i * 0x9e3779b9) & 0xffffffff) >>> 0)
    hex += (chunk >>> 0).toString(16).padStart(8, '0')
  }
  return hex
})()
let sessionAssertion = ''

export async function callApi(path, options = {}) {
  const { timeout = 25000, signal, ...rest } = options
  const ctrl = new AbortController()
  const abort = () => ctrl.abort()
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: {
        'content-type': 'application/json',
        'x-fintax-client-session': CLIENT_SESSION_ID,
        ...(sessionAssertion ? { 'x-fintax-session-assertion': sessionAssertion } : {}),
        ...(rest.headers || {}),
      },
      redirect: 'error',
      signal: ctrl.signal,
    })
    try {
      const nextAssertion = res?.headers?.get?.('x-fintax-session-assertion')
      if (typeof nextAssertion === 'string' && nextAssertion.trim()) {
        sessionAssertion = nextAssertion.trim()
      }
    } catch { /* ignore mock Response without headers */ }
    const txt = await res.text()
    let json = {}
    try { json = txt ? JSON.parse(txt) : {} } catch { throw new Error(`服务响应格式无效（HTTP ${res.status}）`) }
    if (!res.ok) {
      const apiErr = new Error(json?.message || json?.error || `HTTP ${res.status}`)
      apiErr.status = res.status
      apiErr.data = json
      throw apiErr
    }
    return json
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

export function fileToBase64(file, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const reader = new FileReader()
    const abort = () => reader.abort()
    signal.addEventListener('abort', abort, { once: true })
    reader.onloadend = () => signal.removeEventListener('abort', abort)
    reader.onload = () => {
      const raw = String(reader.result || '')
      const idx = raw.indexOf(',')
      resolve(idx >= 0 ? raw.slice(idx + 1) : raw)
    }
    reader.onabort = () => reject(signal.reason || new Error('读取已取消'))
    reader.onerror = () => reject(new Error('读取账单文件失败'))
    reader.readAsDataURL(file)
  })
}

export function readTextFile(file, signal) {
  return new Promise((resolve, reject) => {
    if (typeof file?.text === 'function') {
      file.text().then(resolve, reject)
      return
    }
    if (signal?.aborted) {
      reject(signal.reason || new Error('读取已取消'))
      return
    }
    const reader = new FileReader()
    const abort = () => reader.abort()
    signal?.addEventListener('abort', abort, { once: true })
    reader.onloadend = () => signal?.removeEventListener('abort', abort)
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onabort = () => reject(signal?.reason || new Error('读取已取消'))
    reader.onerror = () => reject(new Error('读取备份文件失败'))
    if (typeof reader.readAsText === 'function') reader.readAsText(file)
    else reader.readAsDataURL(file)
  })
}

export function numericFxRates(draft) {
  const rates = {}
  for (const [currency, value] of Object.entries(draft || {})) {
    const raw = String(value).trim()
    const amount = Number(raw)
    if (raw && Number.isFinite(amount) && amount > 0) rates[currency] = raw
  }
  return rates
}

export function money(value) {
  return value == null ? '待核' : `¥${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

export function downloadText(content, filename, mime) {
  if (typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function' || typeof document === 'undefined') return
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body?.appendChild?.(a)
  a.click?.()
  document.body?.removeChild?.(a)
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}

const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * Passive, read-only probe against dsh-market Update API v1.
 * Validates explicit protocol fields (capabilities object, non-empty version/apiVersion, or catalog list)
 * so an empty `{}` or non-market JSON response is never misclassified as supported/up-to-date.
 */
export async function probeMarketUpdate(currentVersion, signal) {
  const ctrl = new AbortController()
  const abort = () => ctrl.abort()
  if (signal?.aborted) return null
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), 3500)
  try {
    let url = '/dsh-market/api/v1/capabilities'
    try { url = new URL('/dsh-market/api/v1/capabilities', document.baseURI).pathname } catch { /* fallback */ }
    const res = await fetch(url, { method: 'GET', redirect: 'error', signal: ctrl.signal })
    if (!res.ok) return null
    const data = await res.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const hasCapabilitiesObj = Boolean(data.capabilities && typeof data.capabilities === 'object' && !Array.isArray(data.capabilities))
    const hasProtocolVersion = (typeof data.version === 'string' && data.version.trim().length > 0) ||
      (typeof data.apiVersion === 'string' && data.apiVersion.trim().length > 0)
    const hasCatalog = Array.isArray(data.plugins) || Array.isArray(data.updates) ||
      Boolean(data.packages && typeof data.packages === 'object' && !Array.isArray(data.packages))
    if (!hasCapabilitiesObj && !hasProtocolVersion && !hasCatalog) return null
    const plugins = Array.isArray(data.plugins) ? data.plugins : Array.isArray(data.updates) ? data.updates : []
    const match = plugins.find((p) => p?.id === 'dsh-fintax' || p?.name === 'dsh-fintax') || data.packages?.['dsh-fintax'] || null
    const rawLatest = match?.latestVersion || match?.version || (typeof data.latestVersion === 'string' ? data.latestVersion : null)
    const latestVersion = typeof rawLatest === 'string' && SEMVER_RE.test(rawLatest.trim()) ? rawLatest.trim().replace(/^v/i, '') : null
    const hasUpdate = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0)
    return {
      supported: true,
      latestVersion,
      versionChecked: Boolean(latestVersion),
      hasUpdate,
      notes: typeof match?.summary === 'string' ? match.summary : (typeof match?.releaseNotes === 'string' ? match.releaseNotes : ''),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
