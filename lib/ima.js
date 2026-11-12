// IMA OpenAPI 只读客户端 + 本地安全凭证与默认知识库配置管理。
// 凭证解析优先级：环境变量 (IMA_CLIENT_ID / IMA_API_KEY) → ~/.config/ima/ 本地文件。
// 凭证仅作为 HTTP 头发送到官方 https://ima.qq.com，绝不回传前端明文、不写日志。

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE_URL = 'https://ima.qq.com'
const TIMEOUT_MS = 30_000

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
  if (envClientId && envApiKey) {
    return { clientId: envClientId, apiKey: envApiKey, source: 'env' }
  }
  const fileClientId = readFileSafe(join(dir, 'client_id'))
  const fileApiKey = readFileSafe(join(dir, 'api_key'))
  if (fileClientId && fileApiKey) {
    return { clientId: fileClientId, apiKey: fileApiKey, source: 'file' }
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
  return {
    defaultKbId: envDefaultKb || String(fileCfg.defaultKbId || '').trim(),
    defaultKbName: envDefaultKb
      ? String(fileCfg.defaultKbName || '环境变量指定知识库').trim()
      : String(fileCfg.defaultKbName || '').trim(),
    defaultKbSource: envDefaultKb ? 'env' : fileCfg.defaultKbId ? 'file' : 'none',
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
}

/** 清除本地文件中的 IMA 凭证（不影响进程外部注入的环境变量）。 */
export function clearCredentials() {
  const dir = getImaConfigDir()
  for (const name of ['client_id', 'api_key']) {
    const p = join(dir, name)
    if (existsSync(p)) rmSync(p, { force: true })
  }
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
  '未配置 IMA 凭证，知识库检索工具暂不可用（7 场景确定性税额与对账试算工具仍可正常离线使用）。',
  '配置方法（二选一，推荐方式一）：',
  '1. 【图形界面免命令行】打开 DSH 桌面端「设置 → 财税工作台」，直接粘贴 IMA Client ID 与 API Key 保存并勾选默认知识库；',
  '2. 【手动配置】前往 https://ima.qq.com/agent-interface 获取凭证，写入 ~/.config/ima/client_id 与 ~/.config/ima/api_key，或设置环境变量 IMA_CLIENT_ID / IMA_API_KEY。',
  '凭证仅作为请求头发送到官方 ima.qq.com，插件对知识库严格只读。',
].join('\n')

/**
 * 调用 IMA OpenAPI（POST + JSON）。成功返回 data；失败抛出带 msg 的错误。
 * @param {string} apiPath 例如 openapi/wiki/v1/search_knowledge
 * @param {object} body 请求体
 */
export async function imaCall(apiPath, body) {
  const creds = loadCredentials()
  if (!creds) throw new Error(CREDENTIALS_HELP)

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
    throw new Error(`IMA 接口网络请求失败（${apiPath}）：${err.message}。请检查网络后重试。`)
  }

  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`IMA 接口返回非 JSON 响应（HTTP ${res.status}），请稍后重试。`)
  }
  if (json.code !== 0) {
    throw new Error(`IMA 接口业务错误（${apiPath}，code=${json.code}）：${json.msg || '未知错误'}`)
  }
  return json.data ?? {}
}
