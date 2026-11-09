// IMA OpenAPI 只读客户端（知识库列表 / 搜索 / 原文信息）。
// 凭证解析顺序与 ima-skill 一致：环境变量 → ~/.config/ima/ 文件。
// 凭证仅作为 HTTP 头发送到官方 https://ima.qq.com，不落日志、不写文件。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE_URL = 'https://ima.qq.com'
const TIMEOUT_MS = 30_000

function readFileSafe(p) {
  try {
    return readFileSync(p, 'utf8').trim()
  } catch {
    return ''
  }
}

export function loadCredentials() {
  const clientId =
    process.env.IMA_CLIENT_ID ||
    process.env.IMA_OPENAPI_CLIENTID ||
    readFileSafe(join(homedir(), '.config/ima/client_id'))
  const apiKey =
    process.env.IMA_API_KEY ||
    process.env.IMA_OPENAPI_APIKEY ||
    readFileSafe(join(homedir(), '.config/ima/api_key'))
  if (!clientId || !apiKey) return null
  return { clientId, apiKey }
}

export const CREDENTIALS_HELP = [
  '未配置 IMA 凭证，知识库工具暂不可用（税额试算工具不受影响）。',
  '配置方法：',
  '1. 打开 https://ima.qq.com/agent-interface 获取 Client ID 和 API Key；',
  '2. 写入 ~/.config/ima/client_id 与 ~/.config/ima/api_key 两个文件，',
  '   或设置环境变量 IMA_CLIENT_ID 与 IMA_API_KEY。',
  '配置后重启会话即可使用。凭证只发送到 ima.qq.com 官方接口。',
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