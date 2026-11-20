// IMA OpenAPI 只读客户端 + 本地安全凭证与默认知识库配置管理。
// 凭证解析优先级：环境变量 (IMA_CLIENT_ID / IMA_API_KEY) → ~/.config/ima/ 本地文件。
// 凭证仅作为 HTTP 头发送到官方 https://ima.qq.com，绝不回传前端明文、不写日志。

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LocalStoreError, readLocalJson, withLocalWriteLock, writeLocalJson } from './local_store.js'

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
const inFlight = new Map()
const activeCalls = new Map()
const MAX_ACTIVE_CALLS = 8
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_RETRY_WAIT_MS = 5000

export class ImaServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

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

/** 清洗用户自定义汇率映射表（白名单 3 位币种代码 + 严格数字类型 + 有限正数，上限 32 币种）。 */
export function sanitizeCustomFxRates(raw, { strict = false } = {}) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) throw new ImaServiceError('INVALID_SETTINGS', 'customFxRates 须为币种汇率对象或 null。')
    return {}
  }
  const clean = {}
  for (const [k, v] of Object.entries(raw)) {
    const code = String(k || '').trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code) || code === 'CNY' || code === 'RMB') continue
    if (typeof v !== 'number' && typeof v !== 'string') continue
    if (typeof v === 'string' && v.trim() === '') continue
    const num = Number(v)
    if (!Number.isFinite(num) || num <= 0 || num >= 100000) continue
    const rounded = Math.round(num * 1_000_000) / 1_000_000
    if (rounded <= 0) continue
    if (!(code in clean) && Object.keys(clean).length >= 32) break
    clean[code] = rounded
  }
  return clean
}

function readRawFintaxConfigFile(dir) {
  const parsed = readLocalJson(join(dir, 'fintax_config.json'))
  if (parsed === undefined) return {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LocalStoreError('LOCAL_DATA_CORRUPT')
  return parsed
}

/** 读取用户配置的默认优先知识库与自定义汇率（环境变量优先于 fintax_config.json）。 */
export function loadFintaxSettings() {
  const dir = getImaConfigDir()
  const fileCfg = readRawFintaxConfigFile(dir)
  const envDefaultKb = (process.env.IMA_DEFAULT_KB_ID || '').trim()
  const fileKbId = String(fileCfg.defaultKbId || '').trim()
  const fileKbName = String(fileCfg.defaultKbName || '').trim()
  const customFxRates = sanitizeCustomFxRates(fileCfg.customFxRates)
  return {
    defaultKbId: envDefaultKb || fileKbId,
    defaultKbName: envDefaultKb
      ? String(process.env.IMA_DEFAULT_KB_NAME || (fileKbId === envDefaultKb && fileKbName ? fileKbName : '环境变量指定知识库')).trim()
      : fileKbName,
    defaultKbSource: envDefaultKb ? 'env' : fileKbId ? 'file' : 'none',
    customFxRates,
  }
}

/** 保存非敏感偏好（仅局部合并磁盘原始文件，绝不因环境变量覆盖而误清磁盘 defaultKbId；原子写入 0o600）。 */
export function saveFintaxSettings(patch = {}) {
  const dir = getImaConfigDir()
  const target = join(dir, 'fintax_config.json')
  return withLocalWriteLock(target, () => {
    const disk = readRawFintaxConfigFile(dir)
    const next = {
      defaultKbId: String(patch.defaultKbId ?? disk.defaultKbId ?? '').trim(),
      defaultKbName: String(patch.defaultKbName ?? disk.defaultKbName ?? '').trim(),
      customFxRates: patch.customFxRates === undefined
        ? sanitizeCustomFxRates(disk.customFxRates)
        : sanitizeCustomFxRates(patch.customFxRates, { strict: true }),
    }
    writeLocalJson(target, next)
    return loadFintaxSettings()
  })
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
    customFxRates: settings.customFxRates,
  }
}

export const CREDENTIALS_HELP = [
  '未配置 IMA 凭证，知识库检索工具暂不可用（11 通道离线账单与结汇链排雷、10 场景确定性算税工具仍可正常离线使用）。',
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
const API_PATHS = new Set([
  ...CACHEABLE_PATHS,
  'openapi/wiki/v1/get_media_info',
  'openapi/note/v1/get_doc_content',
])

async function readBoundedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new ImaServiceError('IMA_RESPONSE_LIMIT', 'IMA 响应超过大小限制。')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, size).toString('utf8')
  } finally {
    reader.releaseLock()
  }
}

export function isAllowedImaDownload(url) {
  const host = url.hostname.toLowerCase()
  const allowedHost = host === 'ima.qq.com' || host.endsWith('.ima.qq.com') ||
    /^[a-z0-9-]+\.cos\.[a-z0-9-]+\.myqcloud\.com$/.test(host)
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && allowedHost
}

/** Download text links returned by IMA, validating each redirect before making a request. */
export async function readImaTextDownload(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ImaServiceError('IMA_DOWNLOAD_HOST', 'IMA 下载地址不在允许范围内。')
  }
  const signal = AbortSignal.timeout(15_000)
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isAllowedImaDownload(url)) throw new ImaServiceError('IMA_DOWNLOAD_HOST', 'IMA 下载地址不在允许范围内。')
    const response = await fetch(url.href, { redirect: 'manual', signal })
    if (response.ok) return readBoundedText(response)
    await response.body?.cancel().catch(() => {})
    const location = response.headers.get('location')
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) break
    url = new URL(location, url)
  }
  throw new ImaServiceError('IMA_DOWNLOAD_UNAVAILABLE', 'IMA 文本下载失败。')
}

export async function imaCall(apiPath, body, opts = {}) {
  if (!API_PATHS.has(apiPath)) throw new ImaServiceError('INVALID_IMA_ENDPOINT', 'IMA 接口不受支持。')
  const creds = loadCredentials()
  if (!creds) throw new ImaServiceError('IMA_CREDENTIALS_REQUIRED', CREDENTIALS_HELP)

  const requestBody = JSON.stringify(body ?? {})
  const credentialKey = createHash('sha256').update(JSON.stringify([creds.clientId, creds.apiKey])).digest('hex')
  const requestKey = JSON.stringify([credentialKey, apiPath, requestBody])
  const useCache = !opts.noCache && CACHEABLE_PATHS.has(apiPath)
  const ttlMs = typeof opts.cacheTtlMs === 'number' && opts.cacheTtlMs > 0 ? opts.cacheTtlMs : DEFAULT_CACHE_TTL_MS

  if (useCache) {
    const cached = cacheGet(requestKey)
    if (cached !== undefined) return cached
  }
  let pending = inFlight.get(requestKey)
  if (!pending) {
    const active = activeCalls.get(credentialKey) ?? 0
    if (active >= MAX_ACTIVE_CALLS) throw new ImaServiceError('IMA_BUSY', 'IMA 并发请求已达上限，请稍后重试。')
    activeCalls.set(credentialKey, active + 1)
    pending = sendImaRequest(apiPath, requestBody, creds, opts).finally(() => {
      inFlight.delete(requestKey)
      const remaining = activeCalls.get(credentialKey) - 1
      if (remaining) activeCalls.set(credentialKey, remaining)
      else activeCalls.delete(credentialKey)
    })
    inFlight.set(requestKey, pending)
  }
  const data = await pending
  if (useCache) cacheSet(requestKey, data, ttlMs)
  return data
}

function retryAfterMs(response) {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return 0
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isNaN(ms) ? 0 : Math.max(0, ms)
}

async function sendImaRequest(apiPath, requestBody, creds, opts) {
  const retries = Number.isInteger(opts.retries) && opts.retries >= 0 ? Math.min(2, opts.retries) : 2
  const retryBaseMs = typeof opts.retryBaseMs === 'number' && opts.retryBaseMs >= 0
    ? Math.min(MAX_RETRY_WAIT_MS, opts.retryBaseMs)
    : 400
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  let waitMs = 0
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (waitMs) await sleep(waitMs)
    waitMs = Math.min(MAX_RETRY_WAIT_MS, retryBaseMs * 2 ** attempt)
    let res
    try {
      res = await fetch(`${BASE_URL}/${apiPath}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'ima-openapi-clientid': creds.clientId,
          'ima-openapi-apikey': creds.apiKey,
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal,
      })
    } catch {
      if (attempt < retries && !signal.aborted) continue
      throw new ImaServiceError('IMA_NETWORK', 'IMA 接口请求失败，请检查网络后重试。')
    }

    if (!res.ok) {
      const retryAfter = retryAfterMs(res)
      await res.body?.cancel().catch(() => {})
      if ((res.status === 429 || res.status >= 500) && attempt < retries && retryAfter <= MAX_RETRY_WAIT_MS) {
        waitMs = Math.max(waitMs, retryAfter)
        continue
      }
      throw new ImaServiceError('IMA_HTTP', `IMA 接口暂不可用（HTTP ${res.status}）。`)
    }

    const text = await readBoundedText(res)
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new ImaServiceError('IMA_INVALID_RESPONSE', 'IMA 接口响应格式无效。')
    }
    if (!json || json.code !== 0) {
      const code = Number.isSafeInteger(json?.code) ? json.code : 'unknown'
      throw new ImaServiceError('IMA_BUSINESS_ERROR', `IMA 接口业务错误（code=${code}）。`)
    }
    return json.data ?? {}
  }
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
  // V2.3 新增专题与高频政策短词锚点（顺序置于存量核心词之后，确保 25 题基线零回归）
  ['欧盟低值包裹', /(?<!\d)(?:2|两|二)\s*欧|处理费|低值包裹/],
  ['T86', /\bT86\b|小额豁免|(?:800|八百)\s*(?:美[元金]|\$)/i],
  ['全托管', /全托管|半托管|\bTemu\b|\bSHEIN\b/i],
  ['独立站', /独立站|\bShopify\b|支付网关/i],
  ['数字产品', /数字产品|\bSaaS\b|短剧|App\s*Store|Stripe\s*Tax/i],
  ['加计扣除', /加计扣除|研发费用|高新资质/],
  ['海关稽查', /海关稽查|特许权使用费|归类预裁定/],
  ['买单', /买单|无票采购/],
  ['退税率调整', /29号|退税率.{0,6}(?:调整|取消|下调)/],
  ['缺票', /缺票|无票支出/],
  ['离岸豁免', /离岸豁免|\bODI\b|37号文/i],
  ['新加坡', /新加坡|\bCFC\b/i],
  ['美国本土店', /美国本土|5472|\bNexus\b|\bLLC\b|C_Corp/i],
  ['东南亚', /东南亚|\bShopee\b|\bLazada\b|越南|印尼/i],
  ['拉美', /拉美|巴西|墨西哥|\bRFC\b/i],
  ['中东', /中东|沙特|阿联酋/],
  ['日本站', /日本|\bJCT\b|\bACP\b/i],
  ['韩国站', /韩国|\bCoupang\b/i],
  ['英国PVA', /\bPVA\b|\bC79\b|欧盟4200|\bCP42\b/i],
  ['注销', /注销|尽调|历史账税切割/],
  ['EPR', /\bEPR\b|\bCBAM\b|\bWEEE\b|碳关税/i],
  ['广告代投', /\bMCN\b|TikTok公会|广告代投/i],
  ['ERP', /\bERP\b|领星|积加|金蝶|用友/i],
  ['质保金', /\bWayfair\b|质保金|无代价抵偿|3100/i],
  ['二手翻新', /二手|翻新|\bRenewed\b|以旧换新/i],
  ['年末关账', /年末关账|跨年未发货|股东借款/],
  ['海外众筹', /众筹|\bKickstarter\b|\bIndiegogo\b/i],
  ['测评', /测评|\bVine\b|站外返现/i],
  ['股权激励', /股权激励|持股平台|股份支付/],
  ['即征即退', /即征即退|嵌入式软件|技术先进型/],
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
  ['美国关税', /美国.{0,8}关税|301.{0,4}关税|美线清关/],
  ['香港', /香港/],
  ['核准回执', /核准回执|事前鉴定|核定鉴定/],
]

function knowledgeSearchTerms(query) {
  const text = String(query ?? '').normalize('NFKC').trim()
  const entities = [...new Set((text.match(/\b(?:0110|9610|9710|9810|1210|1039|IOSS|VAT|T86|JCT|ODI|RFC|PVA|C79|EPR|CBAM|ERP|MCN)\b/gi) ?? [])
    .map((term) => term.toUpperCase()))]
  if (!/\p{Script=Han}/u.test(text) || (!entities.length && text.length < 10 && !/[?？]|怎么|如何|什么|咋|吗/.test(text))) return []
  const terms = [
    ...FIN_TAX_TERMS.filter(([, match]) => match.test(text)).map(([term]) => term),
    ...entities,
    ...GENERAL_TAX_TERMS.filter(([, match]) => match.test(text)).map(([term]) => term),
  ]
  const selected = [...new Set(terms)].filter((term) => term.toLowerCase() !== text.toLowerCase()).slice(0, 3)
  if (entities.length && !selected.some((term) => entities.includes(term))) selected[2] = entities[0]
  return selected
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
    imaCall(KNOWLEDGE_SEARCH_PATH, { ...body, query, cursor: '' }, { ...opts, retries: 0 }),
  ))
  const pages = replies.filter((reply) => reply.status === 'fulfilled').map((reply) => reply.value)
  return {
    ...original,
    info_list: mergeKnowledgeMatches([original, ...pages]),
    fallback: { queries, failed: replies.length - pages.length },
  }
}
