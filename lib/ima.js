// IMA OpenAPI 只读客户端 + 本地安全凭证与默认知识库配置管理。
// 凭证解析优先级：环境变量 (IMA_CLIENT_ID / IMA_API_KEY) → ~/.config/ima/ 本地文件。
// 凭证仅作为 HTTP 头发送到官方 https://ima.qq.com，绝不回传前端明文、不写日志。

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE_URL = 'https://ima.qq.com'
const KNOWLEDGE_SEARCH_PATH = 'openapi/wiki/v1/search_knowledge'
const TIMEOUT_MS = 30_000
const DEFAULT_CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 48
const CACHEABLE_PATHS = new Set([
  'openapi/wiki/v1/search_knowledge_base',
  'openapi/wiki/v1/get_knowledge_list',
  KNOWLEDGE_SEARCH_PATH,
])

const _cache = new Map()

/** 清空 IMA 只读内存缓存（切换凭证、强制刷新或测试隔离时调用）。 */
export function clearImaCache() {
  _cache.clear()
}

function cacheGet(key) {
  const hit = _cache.get(key)
  if (!hit) return undefined
  if (Date.now() > hit.expiresAt) {
    _cache.delete(key)
    return undefined
  }
  return hit.data
}

function cacheSet(key, data, ttlMs) {
  if (_cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = _cache.keys().next().value
    if (oldest !== undefined) _cache.delete(oldest)
  }
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function getImaConfigDir() {
  return process.env.FINTAX_CONFIG_DIR || join(homedir(), '.config', 'ima')
}

function readFileSafe(p) {
  try {
    return readFileSync(p, 'utf8').trim()
  } catch {
    return ''
  }
}

export function loadCredentials() {
  const dir = getImaConfigDir()
  const envClientId = (process.env.IMA_CLIENT_ID || process.env.IMA_OPENAPI_CLIENTID || '').trim()
  const envApiKey = (process.env.IMA_API_KEY || process.env.IMA_OPENAPI_APIKEY || '').trim()
  const fileClientId = readFileSafe(join(dir, 'client_id'))
  const fileApiKey = readFileSafe(join(dir, 'api_key'))
  const clientId = envClientId || fileClientId
  const apiKey = envApiKey || fileApiKey
  if (clientId && apiKey) {
    const source = envClientId && envApiKey ? 'env' : (envClientId || envApiKey) ? 'mixed' : 'file'
    return { clientId, apiKey, source }
  }
  return null
}

/** 读取用户配置的默认优先知识库（环境变量优先于 fintax_config.json）。 */
export function loadFintaxSettings() {
  const dir = getImaConfigDir()
  let fileCfg = {}
  const raw = readFileSafe(join(dir, 'fintax_config.json'))
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') fileCfg = parsed
    } catch {
      // 忽略损坏的本地非敏感偏好文件
    }
  }
  const envDefaultKb = (process.env.IMA_DEFAULT_KB_ID || '').trim()
  const fileKbId = String(fileCfg.defaultKbId || '').trim()
  const fileKbName = String(fileCfg.defaultKbName || '').trim()
  return {
    defaultKbId: envDefaultKb || fileKbId,
    defaultKbName: envDefaultKb
      ? String(process.env.IMA_DEFAULT_KB_NAME || (fileKbId === envDefaultKb && fileKbName ? fileKbName : '环境变量指定知识库')).trim()
      : fileKbName,
    defaultKbSource: envDefaultKb ? 'env' : fileKbId ? 'file' : 'none',
  }
}

/** 保存非敏感偏好（如默认知识库 ID 与名称）。 */
export function saveFintaxSettings(patch = {}) {
  const dir = getImaConfigDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const current = loadFintaxSettings()
  const next = {
    defaultKbId: patch.defaultKbId !== undefined ? String(patch.defaultKbId ?? '').trim() : (current.defaultKbSource === 'env' ? '' : current.defaultKbId),
    defaultKbName: patch.defaultKbName !== undefined ? String(patch.defaultKbName ?? '').trim() : current.defaultKbName,
  }
  const target = join(dir, 'fintax_config.json')
  writeFileSync(target, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  return loadFintaxSettings()
}

/**
 * 保存本地 IMA 凭证到 ~/.config/ima/（0o600 权限）。
 * 传入空字符串的字段保持原文件不变，避免前端未改密码框时误清空。
 */
export function saveCredentials({ clientId, apiKey } = {}) {
  const dir = getImaConfigDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const cid = typeof clientId === 'string' ? clientId.trim() : ''
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (cid) {
    const p = join(dir, 'client_id')
    writeFileSync(p, cid + '\n', { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(p, 0o600) } catch { /* Windows ACL 忽略 POSIX chmod 差异 */ }
  }
  if (key) {
    const p = join(dir, 'api_key')
    writeFileSync(p, key + '\n', { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(p, 0o600) } catch { /* Windows ACL 忽略 POSIX chmod 差异 */ }
  }
  clearImaCache()
}

/** 清除本地文件中的 IMA 凭证（不影响进程外部注入的环境变量）。 */
export function clearCredentials() {
  const dir = getImaConfigDir()
  for (const name of ['client_id', 'api_key']) {
    const p = join(dir, name)
    if (existsSync(p)) rmSync(p, { force: true })
  }
  clearImaCache()
}

/** 返回供前端设置页展示的脱敏状态，绝不包含任何密钥明文。 */
export function getPublicStatus() {
  const dir = getImaConfigDir()
  const envClientId = Boolean((process.env.IMA_CLIENT_ID || process.env.IMA_OPENAPI_CLIENTID || '').trim())
  const envApiKey = Boolean((process.env.IMA_API_KEY || process.env.IMA_OPENAPI_APIKEY || '').trim())
  const fileClientId = Boolean(readFileSafe(join(dir, 'client_id')))
  const fileApiKey = Boolean(readFileSafe(join(dir, 'api_key')))
  const creds = loadCredentials()
  const settings = loadFintaxSettings()
  return {
    configured: Boolean(creds),
    source: creds ? creds.source : 'none',
    clientIdSet: envClientId || fileClientId,
    apiKeySet: envApiKey || fileApiKey,
    envOverride: envClientId && envApiKey,
    defaultKbId: settings.defaultKbId,
    defaultKbName: settings.defaultKbName,
    defaultKbSource: settings.defaultKbSource,
  }
}

export const CREDENTIALS_HELP = [
  '未配置 IMA 凭证，知识库检索工具暂不可用（8 大平台离线账单排雷与 10 场景确定性算税工具仍可正常离线使用）。',
  '配置方法（二选一，推荐方式一）：',
  '1. 【图形界面免命令行】打开 DSH 桌面端「设置 → 财税工作台」，直接粘贴 IMA Client ID 与 API Key 保存并勾选默认知识库；',
  '2. 【手动配置】前往 https://ima.qq.com/agent-interface 获取凭证，写入 ~/.config/ima/client_id 与 ~/.config/ima/api_key，或设置环境变量 IMA_CLIENT_ID / IMA_API_KEY。',
  '凭证仅作为请求头发送到官方 ima.qq.com，插件对知识库严格只读。',
].join('\n')

/**
 * 调用 IMA OpenAPI（POST + JSON）。支持瞬态网络/429/5xx 指数退避重试与 60s 只读目录缓存。
 * @param {string} apiPath 例如 openapi/wiki/v1/search_knowledge
 * @param {object} body 请求体
 * @param {object} [opts] { retries?: number, retryBaseMs?: number, noCache?: boolean, cacheTtlMs?: number }
 */
export async function imaCall(apiPath, body, opts = {}) {
  const creds = loadCredentials()
  if (!creds) throw new Error(CREDENTIALS_HELP)

  const retries = Number.isInteger(opts.retries) && opts.retries >= 0 ? opts.retries : 2
  const retryBaseMs = typeof opts.retryBaseMs === 'number' && opts.retryBaseMs >= 0 ? opts.retryBaseMs : 400
  const useCache = !opts.noCache && CACHEABLE_PATHS.has(apiPath)
  const ttlMs = typeof opts.cacheTtlMs === 'number' && opts.cacheTtlMs > 0 ? opts.cacheTtlMs : DEFAULT_CACHE_TTL_MS
  const cacheKey = useCache ? `${creds.clientId}::${apiPath}::${JSON.stringify(body ?? {})}` : ''

  if (useCache) {
    const cached = cacheGet(cacheKey)
    if (cached !== undefined) return cached
  }

  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0 && retryBaseMs > 0) {
      await sleep(retryBaseMs * (2 ** (attempt - 1)))
    }
    let res
    try {
      res = await fetch(`${BASE_URL}/${apiPath}`, {
        method: 'POST',
        headers: {
          'ima-openapi-clientid': creds.clientId,
          'ima-openapi-apikey': creds.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      lastErr = new Error(`IMA 接口网络请求失败（${apiPath}）：${err.message}。请检查网络后重试。`)
      if (attempt < retries) continue
      throw lastErr
    }

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      lastErr = new Error(`IMA 网关暂不可用（HTTP ${res.status}，${apiPath}），已尝试重试`)
      continue
    }

    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      lastErr = new Error(`IMA 接口返回非 JSON 响应（HTTP ${res.status}），请稍后重试。`)
      if (res.status >= 500 && attempt < retries) continue
      throw lastErr
    }
    if (json.code !== 0) {
      throw new Error(`IMA 接口业务错误（${apiPath}，code=${json.code}）：${json.msg || '未知错误'}`)
    }
    const data = json.data ?? {}
    if (useCache) cacheSet(cacheKey, data, ttlMs)
    return data
  }
  throw lastErr || new Error(`IMA 接口调用失败（${apiPath}）`)
}

// IMA 依赖标题短词匹配。优先提取具体业务动作和条件，再补监管方式、税制及通用主题。
const FIN_TAX_TERMS = [
  ['税务风险提示', /(?:税务|税局|税务局|平台|报送).{0,20}风险提示/],
  ['报送差额', /(?:报送|申报).{0,24}(?:差额|差异|对不上)|(?:差额|差异).{0,16}(?:报送|申报)/],
  ['平台更正', /平台.{0,20}(?:更正|改报)|(?:更正|改报).{0,20}报送/],
  ['四层口径', /四层|(?:GMV|销售额|会计收入).{0,30}(?:桥接|对不上|实收)|(?:回款|到账|实收).{0,40}(?:桥接|销售额)/i],
  ['资金桥接', /资金桥接|(?:回款|实收|到账|打款).{0,40}(?:桥接|销售额)|(?:销售额|GMV).{0,20}(?:桥接|回款|实收|到账)/i],
  ['4%核定', /4\s*%.{0,8}(?:核定|应税所得率)|(?:核定|应税所得率).{0,8}4\s*%/],
  ['小型微利企业', /小型微利|小微企业|小微/],
  ['300万', /(?:300|三百)\s*万/],
  ['无票免税', /无票免税|(?:无票|没有.{0,4}发票|无.{0,4}发票|无进项票).{0,8}免税/],
  ['预退税', /预退税|未售.{0,8}退税|先退税|离境即退/],
  ['个人账户', /个人(?:银行)?账户|个人卡|私人账户/],
  ['3欧元', /(?<!\d)(?:3|三)\s*欧/],
  ['单证备案', /单证备案|备案单证/],
  ['函调', /函调|发函调查/],
  ['借名出海', /借名(?:出海|出口|报关)|(?:朋友|别人|他人|其他公司).{0,12}(?:名义|抬头).{0,8}(?:报关|出口)/],
  ['普通发票', /普通发票|普票/],
  ['扣缴', /扣缴|代扣代缴/],
  ['汇算', /汇算|年度汇缴/],
  ['开账', /开账|建账|新建账套/],
  ['月结', /月结|月底结账|锁表|月度关账/],
  ['退运', /退运|退回国内|复运进境/],
  ['信保', /信保|出口信用保险/],
  ['免抵退', /免抵退|免、抵、退/],
  ['疑点反馈', /疑点.{0,4}反馈|疑点通知/],
]

const GENERAL_TAX_TERMS = [
  ['应税所得率', /应税所得率|4\s*%.{0,8}核定/],
  ['小微', /小微|小型微利/],
  ['平台报送', /平台.{0,10}报送|报送收入|平台收入|平台.{0,6}涉税信息/],
  ['主体', /主体|(?:店铺|收款|报关).{0,10}[A-Z]公司/i],
  ['Amazon', /亚马逊|\bAmazon\b|\bFBA\b/i],
  ['出口发票', /出口发票/],
  ['150欧元', /(?<!\d)(?:150|一百五十)\s*欧/],
  ['出口退税', /出口退税/],
  ['汇兑损益', /汇兑损益|汇率差|汇差/],
  ['第三方收款', /第三方收款|个人(?:银行)?账户|代收款/],
  ['综试区', /综试区|综合试验区/],
  ['骗税', /骗税/],
]

function knowledgeSearchTerms(query) {
  const text = String(query ?? '').normalize('NFKC').trim()
  if (!/\p{Script=Han}/u.test(text) || (text.length < 10 && !/[?？]|怎么|如何|什么|咋|吗/.test(text))) return []
  const entities = text.match(/\b(?:0110|9610|9710|9810|1210|1039|IOSS|VAT)\b/gi) ?? []
  const terms = [
    ...FIN_TAX_TERMS.filter(([, match]) => match.test(text)).map(([term]) => term),
    ...entities.map((term) => term.toUpperCase()),
    ...GENERAL_TAX_TERMS.filter(([, match]) => match.test(text)).map(([term]) => term),
  ]
  return [...new Set(terms)].filter((term) => term.toLowerCase() !== text.toLowerCase()).slice(0, 3)
}

function searchItems(data) {
  return Array.isArray(data.info_list) ? data.info_list : []
}

function mergeKnowledgeMatches(pages) {
  const matches = new Map()
  for (const page of pages) {
    const seen = new Set()
    for (const item of searchItems(page)) {
      if (!item || typeof item !== 'object') continue
      const key = item.media_id || (item.title ? JSON.stringify([item.title, item.parent_folder_id, item.media_type]) : item)
      if (seen.has(key)) continue
      seen.add(key)
      const previous = matches.get(key)
      if (previous) previous.count++
      else matches.set(key, { item, count: 1 })
    }
  }
  // Stable sort preserves the original query and source result order on equal frequency.
  return [...matches.values()].sort((a, b) => b.count - a.count).map(({ item }) => item)
}

/** Search the first page verbatim, then retry sparse natural-language results with short terms. */
export async function searchImaKnowledge(body, opts = {}) {
  const original = await imaCall(KNOWLEDGE_SEARCH_PATH, body, opts)
  // The server cursor belongs to a single query. Do not rerun first-page fallback on subsequent pages.
  if (body.cursor || searchItems(original).length >= 2) return original
  const queries = knowledgeSearchTerms(body.query)
  if (queries.length === 0) return original

  const replies = await Promise.allSettled(queries.map((query) =>
    imaCall(KNOWLEDGE_SEARCH_PATH, { ...body, query, cursor: '' }, opts),
  ))
  const pages = replies.filter((reply) => reply.status === 'fulfilled').map((reply) => reply.value)
  return {
    ...original,
    info_list: mergeKnowledgeMatches([original, ...pages]),
    fallback: { queries, failed: replies.length - pages.length },
  }
}
