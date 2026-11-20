// dsh-fintax：财税工作台插件入口（Host 半身）。
// 纯 ESM、零运行时依赖：
//   1. 向 ctx.tools 注册 6 个工具（4 个 IMA 知识库只读工具 + 1 个 11 通道账单与结汇链离线初筛体检雷达 fintax_parse_statement + 1 个 10 场景确定性算税与对账引擎 fintax_calc）；
//   2. 向 ctx.skills 注册 4 个随包财税合规技能；
//   3. 当宿主挂载 webServer 时，提供经会话准入校验的 /api/fintax/* 设置接口（配合 client.js 图形化设置页，绝不回传密钥明文）。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import {
  imaCall,
  ImaServiceError,
  readImaTextDownload,
  searchImaKnowledge,
  loadCredentials,
  loadFintaxSettings,
  saveCredentials,
  clearCredentials,
  saveFintaxSettings,
  getPublicStatus,
  CREDENTIALS_HELP,
} from './lib/ima.js'
import { calculate, platformTaxReconcile } from './lib/calc.js'
import { StatementInputError, fmtAmount } from './lib/statement.js'
import {
  buildConsolidatedReconcile,
  exportDiagnosticReport,
  normalizeFxMap,
  renderRollingTrendReportHtml,
  serializeSummary,
} from './lib/report.js'
import { computeRolling12m, deleteSnapshot, HistoryInputError, loadHistory, saveSnapshot } from './lib/history.js'
import { LocalStoreError } from './lib/local_store.js'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version

export const name = 'fintax'
export const inject = ['tools', 'skills']

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/** 工具执行兜底：把错误变成模型可读的可操作提示，而不是让调用崩掉。 */
async function guarded(fn) {
  try {
    return await fn()
  } catch (err) {
    const known = err instanceof StatementInputError || err instanceof ImaServiceError ||
      err instanceof LocalStoreError || err instanceof PublicRequestError
    if (err instanceof StatementInputError && err.diagnostics?.length) {
      return `[错误] ${err.code} ${err.message}\n${JSON.stringify(err.diagnostics)}`
    }
    if (['REPORT_ALREADY_EXISTS', 'REPORT_FORMAT_UNSUPPORTED', 'REPORT_WRITE_FAILED'].includes(err?.code)) {
      return `[错误] ${err.code} ${err.message}`
    }
    if (err?.code === 'INVALID_FX_MAP') return '[错误] INVALID_FX_MAP 汇率须为有效的币种映射对象。'
    return known ? `[错误] ${err.code} ${err.message}` : '[错误] 操作失败，请核对输入参数、文件格式和本机权限。'
  }
}

const isRejection = (value) => Number.isInteger(value) && value >= 400 && value <= 599

/**
 * 宿主连接准入校验（对齐 DSH connection 服务，防止未授权访问或跨站伪造）：
 * - 现代宿主提供 connection.admit(req) -> { peer } | { rejection }
 * - 旧版提供 connection.requestRejection(req) -> number | undefined
 * - 若 connection 服务缺失或异常，默认按 503 拒绝（fail-closed）。
 */
export function admitRequest(req, connection) {
  if (!connection) return 503
  try {
    if (typeof connection.admit === 'function') {
      const res = connection.admit(req)
      if (!res || typeof res !== 'object' || Array.isArray(res)) return 503
      if (Object.hasOwn(res, 'rejection')) return isRejection(res.rejection) ? res.rejection : 503
      return Object.hasOwn(res, 'peer') && res.peer !== null && typeof res.peer === 'object' ? undefined : 503
    }
    if (typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      return rejection === undefined || isRejection(rejection) ? rejection : 503
    }
    return 503
  } catch {
    return 503
  }
}

class PublicRequestError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

function bodyTooLarge() {
  return new PublicRequestError(413, 'REQUEST_TOO_LARGE', '请求体过大，请减少文件数量或拆分上传。')
}

/** 超限后停止累积，先返回 413，再由 HTTP 响应关闭连接。 */
function readJsonBody(req, maxBytes = 32_768) {
  const length = req.headers?.['content-length']
  if (/^\d+$/.test(length ?? '') && Number(length) > maxBytes) {
    req.resume()
    return Promise.reject(bodyTooLarge())
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let completed = false
    const fail = (error) => {
      if (completed) return
      completed = true
      chunks.length = 0
      reject(error)
    }
    req.on('data', (chunk) => {
      if (completed) return
      total += Buffer.byteLength(chunk)
      if (total > maxBytes) {
        fail(bodyTooLarge())
        return
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.once('end', () => {
      if (completed) return
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        const body = raw ? JSON.parse(raw) : {}
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError()
        completed = true
        resolve(body)
      } catch {
        fail(new PublicRequestError(400, 'INVALID_JSON_BODY', '请求体须为合法的 JSON 对象。'))
      }
    })
    const interrupted = () => fail(new PublicRequestError(400, 'REQUEST_INTERRUPTED', '请求读取中断，请重试。'))
    req.once('aborted', interrupted)
    req.once('error', interrupted)
    req.once('close', interrupted)
  })
}

const UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_PARSE_WORKERS = 2
const MAX_ARCHIVE_TOKENS = 64
const ARCHIVE_TTL_MS = 30 * 60 * 1000
const FORMATS = new Set(['all', 'data', 'html', 'md', 'csv'])
const DEMOS = new Set(['all', 'v7', 'v8', 'full', 'wallets', 'amazon', 'tiktok', 'temu', 'aliexpress', 'shopee', 'shopify', 'paypal', 'stripe', 'worldfirst', 'payoneer', 'airwallex'])
let activeParses = 0

function prepareParseRequest(body) {
  const reportFormat = body.reportFormat === undefined ? 'all' : body.reportFormat
  if (!FORMATS.has(reportFormat)) throw new PublicRequestError(400, 'INVALID_REPORT_FORMAT', '报告格式无效。')
  const platform = String(body.platform ?? 'auto').trim().toLowerCase() || 'auto'
  if (platform !== 'auto' && (!DEMOS.has(platform) || ['all', 'v7', 'v8', 'full', 'wallets'].includes(platform))) {
    throw new PublicRequestError(400, 'INVALID_STATEMENT_PLATFORM', '账单通道无效。')
  }
  const demo = typeof body.demo === 'string' ? body.demo.trim().toLowerCase().replace(/^demo:/, '') : ''
  if (body.demo != null && (typeof body.demo !== 'string' || !DEMOS.has(demo) || body.files?.length)) {
    throw new PublicRequestError(400, 'INVALID_DEMO', '请选择有效的示例，或单独上传账单。')
  }
  let files = []
  if (!demo) {
    if (!Array.isArray(body.files) || !body.files.length) throw new PublicRequestError(400, 'FILES_REQUIRED', '请上传至少一份账单文件。')
    if (body.files.length > 24) throw new PublicRequestError(413, 'FILE_COUNT_LIMIT', '单次最多解析 24 份账单文件，请分批上传。')
    let decodedBytes = 0
    files = body.files.map((file) => {
      const name = typeof file?.name === 'string' ? file.name.trim() : ''
      const dataBase64 = file?.dataBase64
      if (name.length > 255 || !name || /[/\\:\p{Cc}\p{Cf}]/u.test(name) || !/\.(csv|tsv|txt|xlsx|zip)$/i.test(name)) {
        throw new PublicRequestError(400, 'INVALID_FILE_NAME', '账单文件名或扩展名无效。')
      }
      if (typeof dataBase64 !== 'string' || !dataBase64.length || dataBase64.length % 4 !== 0 ||
          /[^A-Za-z0-9+/=]/.test(dataBase64) || !/^[^=]+={0,2}$/.test(dataBase64) ||
          (dataBase64.endsWith('==') && !/[AQgw]==$/.test(dataBase64)) ||
          (dataBase64.endsWith('=') && !dataBase64.endsWith('==') && !/[AEIMQUYcgkosw048]=$/.test(dataBase64))) {
        throw new PublicRequestError(400, 'INVALID_FILE_DATA', '账单文件内容编码无效。')
      }
      decodedBytes += dataBase64.length / 4 * 3 - (dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0)
      if (decodedBytes > UPLOAD_BYTES) throw new PublicRequestError(413, 'FILE_BYTES_LIMIT', '账单文件合计最多 20 MiB，请拆分上传。')
      return { name, dataBase64 }
    })
  }
  if (body.fxConfirmed !== undefined && typeof body.fxConfirmed !== 'boolean') {
    throw new PublicRequestError(400, 'INVALID_FX_CONFIRMATION', '汇率确认须为布尔值。')
  }
  return {
    demo, files, platform, reportFormat, includeResourceAppendix: body.includeResourceAppendix === true,
    options: { fxRateToCny: body.fxRateToCny, fxRates: normalizeFxMap(body.fxRates), declaredVatSalesCny: body.declaredVatSalesCny },
  }
}

function parseInWorker(input, res) {
  if (activeParses >= MAX_PARSE_WORKERS) {
    throw new PublicRequestError(503, 'PARSE_BUSY', '账单正在处理中，请稍后重试。')
  }
  const worker = new Worker(new URL('./lib/parse_worker.js', import.meta.url), {
    workerData: input,
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 384 },
  })
  activeParses++
  worker.once('exit', () => { activeParses-- })
  return new Promise((resolve, reject) => {
    const failed = () => reject(new PublicRequestError(503, 'PARSE_INTERRUPTED', '账单处理超时或中断，请拆分账单后重试。'))
    const cancel = () => {
      void worker.terminate()
      failed()
    }
    const timeout = setTimeout(cancel, 30_000)
    const finish = () => {
      clearTimeout(timeout)
      res?.removeListener?.('close', cancel)
    }
    res?.once?.('close', cancel)
    worker.once('message', (value) => { finish(); resolve(value) })
    worker.once('error', () => { finish(); failed() })
    worker.once('exit', () => { finish(); failed() })
  })
}

function buildArchiveKpis(payload, declaredVatSalesCny) {
  const c = payload.consolidated
  const summaries = payload.summaries
  const counts = { P0: 0, P1: 0, P2: 0 }
  for (const summary of summaries) {
    for (const anomaly of summary.anomalies) {
      const severity = anomaly.severity.slice(0, 2)
      if (Object.hasOwn(counts, severity)) counts[severity]++
    }
  }
  return {
    platforms: [...new Set(summaries.map((item) => item.platform))],
    sheetCount: summaries.length,
    rowCount: summaries.reduce((total, item) => total + item.rawRowCount, 0),
    grossCny: c.totals.grossCny,
    refundCny: c.totals.refundCny,
    netSalesCny: c.totals.netSalesCny,
    feesCny: c.totals.feesCny,
    payoutCny: c.totals.payoutCny,
    p0Count: counts.P0,
    p1Count: counts.P1,
    p2Count: counts.P2,
    declaredVatSalesCny,
  }
}

function getArchiveMonth(summaries = []) {
  const months = new Set(summaries.map((item) => item.period))
  const [month] = months
  return months.size === 1 && /^(?:201[5-9]|20[2-9][0-9])-(?:0[1-9]|1[0-2])$/.test(month) ? month : undefined
}

/** 创建设置页后端路由处理器（导出以便单元测试直接验证准入与脱敏逻辑）。 */
export function createFintaxApiHandler({ getConnection }) {
  const archiveTokens = new Map()
  return async function handleFintaxApi(req, res) {
    const send = (status, payload) => {
      if (res.destroyed || res.writableEnded) return
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...(status === 413 ? { connection: 'close' } : {}),
      })
      res.end(body)
    }

    let rejection = 503
    try {
      rejection = admitRequest(req, typeof getConnection === 'function' ? getConnection() : undefined)
    } catch { /* Host services can be unavailable during initialization. */ }
    if (rejection !== undefined) {
      return send(rejection, {
        error: rejection === 401 ? '未登录或会话无效' : rejection === 503 ? '宿主连接准入服务未就绪' : '拒绝访问',
      })
    }

    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const marker = '/api/fintax'
      const idx = url.pathname.indexOf(marker)
      const subPath = (idx >= 0 ? url.pathname.slice(idx + marker.length) : url.pathname).replace(/\/+$/, '') || '/'
      const method = String(req.method ?? 'GET').toUpperCase()
      if (subPath === '/status' && method === 'GET') {
        return send(200, { ok: true, version: PKG_VERSION, ...getPublicStatus() })
      }

      if (subPath === '/credentials' && method === 'POST') {
        const body = await readJsonBody(req)
        const cid = typeof body?.clientId === 'string' ? body.clientId.trim() : ''
        const key = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!cid && !key) {
          return send(400, { error: '请至少填写 Client ID 或 API Key 后再保存' })
        }
        saveCredentials({ clientId: cid, apiKey: key })
        return send(200, { ok: true, ...getPublicStatus() })
      }

      if (subPath === '/credentials' && method === 'DELETE') {
        clearCredentials()
        return send(200, { ok: true, ...getPublicStatus() })
      }

      if (subPath === '/settings' && method === 'POST') {
        const body = await readJsonBody(req)
        const patch = {}
        if (body && Object.prototype.hasOwnProperty.call(body, 'defaultKbId')) patch.defaultKbId = body.defaultKbId ?? ''
        if (body && Object.prototype.hasOwnProperty.call(body, 'defaultKbName')) patch.defaultKbName = body.defaultKbName ?? ''
        if (body && Object.prototype.hasOwnProperty.call(body, 'customFxRates')) patch.customFxRates = body.customFxRates
        saveFintaxSettings(patch)
        return send(200, { ok: true, ...getPublicStatus() })
      }

      if (subPath === '/kbs' && method === 'GET') {
        if (!loadCredentials()) {
          return send(400, { error: '尚未配置完整的 IMA Client ID 与 API Key，请先保存凭证' })
        }
        const data = await imaCall(
          'openapi/wiki/v1/search_knowledge_base',
          {
            query: url.searchParams.get('query') ?? '',
            cursor: '',
            limit: 50,
          },
          { noCache: url.searchParams.get('refresh') === '1' },
        )
        const list = data.info_list ?? data.knowledge_base_list ?? data.list ?? []
        const kbs = Array.isArray(list)
          ? list.map((kb) => ({
              id: String(kb.kb_id ?? kb.id ?? ''),
              name: String(kb.kb_name ?? kb.name ?? '未命名知识库'),
              count: kb.content_count != null ? String(kb.content_count) : '',
              description: String(kb.description ?? ''),
            }))
          : []
        return send(200, { ok: true, kbs })
      }

      if (subPath === '/calc' && method === 'POST') {
        const body = await readJsonBody(req, 65_536)
        const scenario = String(body?.scenario ?? '').trim()
        if (!scenario) return send(400, { error: 'scenario（算税场景标识）不能为空' })
        try {
          const result = calculate(scenario, body?.params || {})
          return send(200, { ok: true, result })
        } catch (calcErr) {
          return send(400, { code: 'INVALID_CALC_INPUT', error: '试算参数校验失败，请核对场景和各项输入。' })
        }
      }

      if (subPath === '/parse' && method === 'POST') {
        const body = await readJsonBody(req, 28 * 1024 * 1024)
        const input = prepareParseRequest(body)
        const payload = await parseInWorker(input, res)
        if (payload.error) return send(400, payload)
        const fxConfirmationNeeded = Boolean(payload.summaries?.some((summary) => summary.currency !== 'CNY') && !body.fxConfirmed)
        const archiveMonth = getArchiveMonth(payload.summaries)
        let archiveBlockReason
        let archiveToken
        if (input.demo) archiveBlockReason = '示例仅供预览。'
        else if (!payload.coverage.complete) archiveBlockReason = '请核对未解析账单或工作表后重新导入。'
        else if (!payload.consolidated.ready || fxConfirmationNeeded) archiveBlockReason = '请核对账单币种并确认所用汇率。'
        else if (payload.summaries && !archiveMonth) archiveBlockReason = '请按可识别的单一账期分别导入归档。'
        else if (payload.summaries) {
          const now = Date.now()
          for (const [token, entry] of archiveTokens) {
            if (entry.expiresAt <= now) archiveTokens.delete(token)
          }
          if (archiveTokens.size >= MAX_ARCHIVE_TOKENS) archiveTokens.delete(archiveTokens.keys().next().value)
          archiveToken = randomUUID()
          archiveTokens.set(archiveToken, { expiresAt: now + ARCHIVE_TTL_MS, month: archiveMonth, kpis: buildArchiveKpis(payload, input.options.declaredVatSalesCny) })
        }
        return send(200, { ok: true, version: PKG_VERSION, ...payload, fxConfirmationNeeded, archiveToken, archiveMonth, archiveBlockReason })
      }

      if (subPath === '/history' && method === 'GET') {
        const entityName = (url.searchParams.get('entity') ?? '').trim()
        const history = loadHistory()
        return send(200, { ok: true, history, rolling12m: computeRolling12m(history, { entityName }) })
      }

      if (subPath === '/history/report' && method === 'GET') {
        const entityName = (url.searchParams.get('entity') ?? '').trim()
        const history = loadHistory()
        const rolling12m = computeRolling12m(history, { entityName })
        const reportHtml = renderRollingTrendReportHtml({ history, rolling12m, version: PKG_VERSION })
        return send(200, { ok: true, version: PKG_VERSION, reportHtml })
      }

      if (subPath === '/history' && method === 'POST') {
        const body = await readJsonBody(req, 65_536)
        const evidence = archiveTokens.get(body.archiveToken)
        if (!evidence || evidence.expiresAt <= Date.now()) {
          return send(400, { code: 'ARCHIVE_EVIDENCE_REQUIRED', error: '请重新核对完整账单并确认所用汇率，再提交归档。' })
        }
        if (body.month !== evidence.month) {
          return send(400, { code: 'ARCHIVE_PERIOD_MISMATCH', error: '归档账期须与已核对账单账期一致。' })
        }
        const saved = saveSnapshot({ ...body, ...evidence.kpis })
        if (saved.conflict) {
          return send(409, {
            ok: false, code: 'ARCHIVE_CONFLICT',
            error: '同主体同店铺同账期的归档已存在或已改变，请确认目标快照后重试。',
            ...saved,
          })
        }
        archiveTokens.delete(body.archiveToken)
        const filterEntity = typeof body.filterEntity === 'string' ? body.filterEntity.trim() : ''
        const rolling12m = filterEntity ? computeRolling12m(saved.history, { entityName: filterEntity }) : saved.rolling12m
        return send(200, { ok: true, ...saved, rolling12m })
      }

      if ((subPath === '/history' || subPath.startsWith('/history/')) && method === 'DELETE') {
        const id = subPath.startsWith('/history/')
          ? subPath.slice('/history/'.length)
          : (url.searchParams.get('id') ?? '')
        const entityName = (url.searchParams.get('entity') ?? '').trim()
        const resDel = deleteSnapshot(id)
        const rolling12m = entityName ? computeRolling12m(resDel.history, { entityName }) : resDel.rolling12m
        return send(200, { ok: true, ...resDel, rolling12m })
      }

      return send(404, { code: 'UNKNOWN_ROUTE', error: '接口不存在。' })
    } catch (err) {
      if (err instanceof PublicRequestError) return send(err.statusCode, { code: err.code, error: err.message })
      if (err instanceof HistoryInputError) return send(400, { code: err.code, error: err.message })
      if (err?.code === 'INVALID_FX_MAP') return send(400, { code: err.code, error: '汇率须为有效的币种映射对象。' })
      if (err instanceof LocalStoreError) return send(err.code === 'LOCAL_DATA_BUSY' ? 409 : 500, { code: err.code, error: err.message })
      if (err instanceof ImaServiceError) {
        return send(err.code === 'INVALID_SETTINGS' ? 400 : 502, { code: err.code, error: err.message })
      }
      return send(500, { code: 'INTERNAL_ERROR', error: '处理请求失败，请稍后重试。' })
    }
  }
}

export function apply(ctx) {
  console.log(`[fintax] 财税工作台 v${PKG_VERSION} 加载中…`)

  // ── 工具 1：列出我的 IMA 知识库 ─────────────────────────────
  ctx.tools.register({
    name: 'ima_list_kbs',
    description:
      '列出当前用户配置的 IMA 知识库（id、名称、条数、是否已设为默认优先库）。若用户已在「设置 → 财税工作台」绑定默认知识库，可直接调用 ima_search / ima_browse 而无需每次先调本工具。',
    parameters: {
      query: { type: 'string', description: '按名称过滤知识库；留空返回全部。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        if (!loadCredentials()) return CREDENTIALS_HELP
        const pref = loadFintaxSettings()
        const data = await imaCall('openapi/wiki/v1/search_knowledge_base', {
          query: args?.query ?? '',
          cursor: '',
          limit: 30,
        })
        const list = data.info_list ?? data.knowledge_base_list ?? data.list ?? []
        if (!Array.isArray(list) || list.length === 0) {
          return '未找到知识库。'
        }
        const lines = list.map((kb) => {
          const id = kb.kb_id ?? kb.id
          const kbName = kb.kb_name ?? kb.name
          const isDefault = pref.defaultKbId && id === pref.defaultKbId
          const extra = [kb.content_count ? `${kb.content_count} 条内容` : '', kb.base_type ?? ''].filter(Boolean).join('，')
          return `${isDefault ? '★ [默认优先库] ' : '- '}id: ${id} | 名称: ${kbName}${extra ? ` | ${extra}` : ''}${kb.description ? ` | 描述: ${kb.description}` : ''}`
        })
        const defaultBanner = pref.defaultKbId
          ? `当前已绑定默认优先财税知识库：${pref.defaultKbName || pref.defaultKbId} (${pref.defaultKbId})；后续调用 ima_search / ima_browse 可省略 knowledge_base_id。\n`
          : ''
        return `${defaultBanner}找到 ${list.length} 个知识库：\n${lines.join('\n')}${data.is_end === false ? `\n（还有更多，next_cursor: ${data.next_cursor}）` : ''}`
      })
    },
  })

  // ── 工具 2：在指定（或默认）知识库内搜索 ────────────────────
  ctx.tools.register({
    name: 'ima_search',
    description:
      '在 IMA 知识库内搜索政策原文与底稿条目，返回 media_id、标题和命中摘要。首屏长问题少于 2 条时自动尝试最多 3 组财税短词。绑定默认知识库后可省略 knowledge_base_id。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '可传用户原始问题，也可传明确的关键词，例如“退运”或“9810”。',
      },
      knowledge_base_id: {
        type: 'string',
        description: '知识库 ID；若已在「设置 → 财税工作台」绑定默认知识库可留空，否则先用 ima_list_kbs 获取。',
      },
      cursor: { type: 'string', description: '分页游标，首次留空。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const kbId = String(args?.knowledge_base_id ?? '').trim() || String(loadFintaxSettings().defaultKbId ?? '').trim()
        if (!kbId) {
          throw new PublicRequestError(400, 'IMA_KB_REQUIRED', '请指定知识库 ID，或在财税工作台绑定默认库。')
        }
        if (!args?.query || !String(args.query).trim()) {
          throw new PublicRequestError(400, 'IMA_QUERY_REQUIRED', '请填写搜索关键词，或用 ima_browse 浏览目录。')
        }
        if (!loadCredentials()) return CREDENTIALS_HELP
        const data = await searchImaKnowledge({
          query: String(args.query).trim(),
          knowledge_base_id: kbId,
          cursor: args.cursor ?? '',
        })
        const list = data.info_list ?? []
        const fallback = data.fallback?.queries.length
          ? `短词补查：${data.fallback.queries.join('、')}${data.fallback.failed ? `（${data.fallback.failed} 组查询失败）` : ''}。`
          : ''
        if (!Array.isArray(list) || list.length === 0) {
          return [`知识库 ${kbId} 中未搜到「${args.query}」。`, fallback, '可换更短的同义词重试，或用 ima_browse 浏览目录。'].filter(Boolean).join('\n')
        }
        const items = list.map((it) => {
          const isFolder = it.media_type === 99 || String(it.media_id ?? '').startsWith('folder_')
          return {
            media_id: it.media_id,
            title: it.title,
            media_type: it.media_type,
            kind: isFolder ? 'folder（请将 media_id 作为 folder_id 传给 ima_browse 展开目录，勿调 ima_read）' : 'item（可用 ima_read 读取）',
            highlight: it.highlight_content ?? '',
          }
        })
        return [
          `[库 ${kbId}] 命中 ${items.length} 条（query: ${args.query}）：`,
          ...(fallback ? [fallback] : []),
          JSON.stringify(items, null, 2),
          data.is_end === false && data.next_cursor ? `原查询还有更多结果，next_cursor: ${data.next_cursor}` : '原查询已到末尾。',
          '若命中文件夹（kind 为 folder），请将 media_id 作为 folder_id 传给 ima_browse 展开；引用文档前请用 ima_read 读取原文并核对文号。',
        ].join('\n')
      })
    },
  })

  // ── 工具 3：浏览知识库内容目录 ─────────────────────────────
  ctx.tools.register({
    name: 'ima_browse',
    description:
      '浏览 IMA 知识库的内容目录（标题 + media_id，支持传入 folder_id 展开子文件夹）。若用户已绑定默认知识库，knowledge_base_id 可省略。',
    parameters: {
      knowledge_base_id: {
        type: 'string',
        description: '知识库 ID；若已在「设置 → 财税工作台」绑定默认知识库可留空，否则先用 ima_list_kbs 获取。',
      },
      cursor: { type: 'string', description: '分页游标，首次留空。' },
      folder_id: { type: 'string', description: '可选，浏览指定文件夹（传入 folder_ 开头的 media_id）；留空浏览根目录。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const kbId = String(args?.knowledge_base_id ?? '').trim() || String(loadFintaxSettings().defaultKbId ?? '').trim()
        if (!kbId) {
          throw new PublicRequestError(400, 'IMA_KB_REQUIRED', '请指定知识库 ID，或在财税工作台绑定默认库。')
        }
        if (!loadCredentials()) return CREDENTIALS_HELP
        const body = { knowledge_base_id: kbId, cursor: args?.cursor ?? '', limit: 50 }
        if (args?.folder_id) body.folder_id = String(args.folder_id).trim()
        const data = await imaCall('openapi/wiki/v1/get_knowledge_list', body)
        const list = data.knowledge_list ?? data.info_list ?? []
        if (!Array.isArray(list) || list.length === 0) return `知识库 ${kbId} 该目录下暂无内容。`
        const lines = list.map((it) => {
          const isFolder = it.media_type === 99 || String(it.media_id ?? '').startsWith('folder_')
          const tag = isFolder
            ? '📁 文件夹（请将 media_id 作为 folder_id 传给 ima_browse 展开）'
            : `📄 文档${it.media_type != null ? ` (media_type=${it.media_type})` : ''}（传 media_id 给 ima_read 读取）`
          return `- ${it.title} | media_id: ${it.media_id} | ${tag}`
        })
        return [
          `[库 ${kbId}] 共列出 ${lines.length} 条：`,
          ...lines,
          data.is_end === false ? `（还有更多，next_cursor: ${data.next_cursor}）` : '（已到末尾）',
        ].join('\n')
      })
    },
  })

  // ── 工具 4：读取知识条目原文 ────────────────────────────────
  ctx.tools.register({
    name: 'ima_read',
    description:
      '按 media_id 读取 IMA 的 Markdown、纯文本或笔记。folder_ 开头的文件夹请用 ima_browse 展开。',
    parameters: {
      media_id: { type: 'string', required: true, description: '知识条目 media_id（来自 ima_browse 或 ima_search 结果中的非文件夹条目）。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const mediaId = String(args?.media_id ?? '').trim()
        if (!mediaId) {
          throw new PublicRequestError(400, 'IMA_MEDIA_REQUIRED', '请从 ima_browse 或 ima_search 结果中获取 media_id。')
        }
        if (mediaId.startsWith('folder_')) {
          return `media_id "${mediaId}" 是文件夹，不能用 ima_read 读取。请调用 ima_browse 并传入 folder_id="${mediaId}" 展开查看该文件夹内的文档。`
        }
        if (!loadCredentials()) return CREDENTIALS_HELP
        const data = await imaCall('openapi/wiki/v1/get_media_info', { media_id: mediaId })
        if (data.media_type === 99) {
          return `media_id "${mediaId}" 是文件夹（media_type=99），请调用 ima_browse 并传入 folder_id="${mediaId}" 展开查看内部文档。`
        }

        if (data.media_type === 11 && data.notebook_ext_info?.notebook_id) {
          try {
            const noteData = await imaCall('openapi/note/v1/get_doc_content', {
              note_id: data.notebook_ext_info.notebook_id,
              target_content_format: 0,
            })
            if (noteData?.content) {
              const text = String(noteData.content)
              return [
                `media_id: ${mediaId}（IMA 笔记原文）：`,
                text.slice(0, 8000),
                text.length > 8000 ? `\n…（原文共 ${text.length} 字，已截断前 8000 字）` : '',
                '引用时请注明资料标题与出处，只引用原文中真实出现的政策文号。',
              ].filter(Boolean).join('\n')
            }
          } catch {
            // Preserve the limited metadata projection below when a note cannot be read.
          }
        }

        if ((data.media_type === 7 || data.media_type === 13) && data.url_info?.url) {
          try {
            const text = await readImaTextDownload(data.url_info.url)
            return [
              `media_id: ${mediaId}（Markdown/文本原文）：`,
              text.slice(0, 8000),
              text.length > 8000 ? `\n…（原文共 ${text.length} 字，已截断前 8000 字）` : '',
              '引用时请注明资料标题与出处，只引用原文中真实出现的政策文号。',
            ].filter(Boolean).join('\n')
          } catch {
            // Download failures must never expose server-provided URLs or headers.
          }
        }

        const mediaInfo = {
          title: typeof data.title === 'string' ? data.title.slice(0, 250) : '',
          media_type: Number.isSafeInteger(data.media_type) ? data.media_type : null,
        }
        if ([1, 3, 4, 5].includes(data.media_type)) {
          return [
            `media_id: ${mediaId} 的文件信息（二进制文档）：`,
            JSON.stringify(mediaInfo, null, 2),
            '注意：该条目为 PDF/Word/PPT/Excel 二进制文件，请勿直接用网页抓取工具读取 URL（会产生二进制乱码撑爆上下文）；请优先读取同目录下的 Markdown (.md) 指南文档，或将该文件说明告知用户。',
          ].join('\n')
        }

        return [
          `media_id: ${mediaId} 的条目信息：`,
          JSON.stringify(mediaInfo, null, 2),
          '请在 IMA 内打开条目核对原文。',
        ].join('\n')
      })
    },
  })

  // ── 工具 5：10 场景确定性税额与差额对账引擎 ──────────────────
  ctx.tools.register({
    name: 'fintax_calc',
    description:
      '确定性财税试算与对账引擎（免配 IMA 亦可离线运行，严禁 LLM 心算替代），支持 10 大场景：' +
      'platform_tax_reconcile 对照平台报送、财务会计、增值税与出口、企业所得税四个口径，并独立核对资金放款；' +
      'export_invoice_breakeven 供应商开票加点「拿专票退税 vs 合规无票免税」毛利临界点与所得税联动测算；' +
      'export_rebate 外贸企业出口免退税（孰低规则+征退税率差转成本）；' +
      'export_rebate_manufacturer 生产企业出口“免、抵、退”税五步法测算（含免抵税额计征附加税预警）；' +
      'cbec_assessed_cit 综试区零售出口4%核定应税所得率及小型微利企业条件试算；' +
      'cbec_return_duty_exempt 2026年第16号公告跨境电商出口退运专项资格与条件测算（2026–2027申报，1210按出区离境起算）；' +
      'vat_taxpayer_threshold 500万一般纳税人强制认定临界与进项专票抵扣拐点测算；' +
      'annual_bonus_iit 年终奖单独计税个税（含多发一元临界点陷阱检测）；' +
      'cross_border_import 跨境电商零售进口综合税（限额内70%口径+超限预警）；' +
      'vat 增值税价税分离。',
    parameters: {
      scenario: {
        type: 'string',
        required: true,
        description:
          'platform_tax_reconcile | export_invoice_breakeven | export_rebate | export_rebate_manufacturer | cbec_assessed_cit | cbec_return_duty_exempt | vat_taxpayer_threshold | annual_bonus_iit | cross_border_import | vat',
      },
      params: {
        type: 'object',
        required: true,
        description:
          'platform_tax_reconcile: {reportedGrossRevenue, reportedGrossSource="platform"|"statement_reference", refunds=0, accountingRevenue?, declaredVatSales?, citTaxableIncome?, marketplaceWithheldTax=0, withheldTaxIncludedInGross=true, cutoffAndFxDiff=0, platformFees=0, subsidies=0, subsidiesIncludedInGross=false, selfRemitTaxNet=0, reserveChange=0, actualPayout?, principalRole="principal"}，实际报送总额已含补贴时设 subsidiesIncludedInGross=true；' +
          'export_invoice_breakeven: {barePurchaseAmount, supplierMarkupRate, vatRate=0.13, rebateRate=vatRate, exportRevenue?, otherDeductibleExpenses=0, invoicedCitRate=0.05, noInvoiceRevenueCitRate=0.002}；' +
          'export_rebate: {purchaseAmount, vatRate=0.13, rebateRate=vatRate}；' +
          'export_rebate_manufacturer: {exportFobCny, totalInputVat, vatRate=0.13, rebateRate=vatRate, dutyFreeMaterialsCny=0, domesticOutputVat=0, priorCreditCarryover=0}；' +
          'cbec_assessed_cit: {revenue, assessedQualificationConfirmed?, taxableIncomeRate=0.04, citRate=0.25, taxYear?, annualTaxableIncome?, annualAverageEmployees?, annualAverageAssets?, nonRestrictedIndustry?, smallLowProfit?}，revenue 填同一主体同一纳税年度收入；' +
          'cbec_return_duty_exempt: {customsCode, exportValueCny, exportDate, returnDate, departureDate?, zoneExitDate?, returnedOutsideZone?, returnReason="unsold"|"customer_return"|"other", tariffRate=0.10, importVatRate=0.13, consumptionTaxRate=0, inOriginalCondition, isFood, refundedExportTax, exportRefundRepaid?, hasTaxCertificate}，日期 YYYY-MM-DD，1210 需填出区离境日期和是否退回境内区外；' +
          'vat_taxpayer_threshold: {rolling12mTaxableSales, projectedAnnualGrossSales?, deductibleCostRatio=0.65, inputVatRate=0.13, generalOutputRate=0.13, smallScaleRate=0.01, hasExportRebateDemand=true, taxPeriod?="month"|"quarter", periodTaxableSales?, periodWaivedSales=0}，月/季起征点需同时填计税期间和不含税销售额；' +
          'annual_bonus_iit: {bonus}；' +
          'cross_border_import: {price, vatRate=0.13, consumptionTaxRate=0, discount=0.7, singleLimit=5000, annualLimit=26000, annualUsed=0}；' +
          'vat: {amount, rate=0.13, inclusive=true}。比例/税率均传 0~1 小数。',
      },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const rawParams = args?.params && typeof args.params === 'object' ? args.params : (args ?? {})
        const r = calculate(args?.scenario, rawParams)
        const lines = [`【${r.scenario}】`, ...r.steps.map((s) => `· ${s}`)]

        if (r.summaryLine) {
          lines.push(`核心结论：${r.summaryLine}`)
        } else {
          const amount = r.taxPayable ?? r.taxAmount ?? r.taxRefund
          const effRate = r.effectiveRate ?? r.effectiveRateOnRevenue
          const overLimitNote = r.withinLimit === false ? '（注意：本单已超限，不适用限额内优惠口径，此数字仅作限额内算术对照）' : ''
          lines.push(
            `结果：${r.taxRefund != null ? '应退税额' : '应纳税额'} ${amount} 元${effRate ? `（实际税负率 ${effRate}）` : ''}${r.afterTax != null ? `，税后 ${r.afterTax} 元` : ''}${overLimitNote}`,
          )
        }

        if (r.withinLimit === false) lines.push('⚠ 超限：见下方警告。')
        if (r.warnings?.length) lines.push(...r.warnings.map((w) => `⚠ ${w}`))
        if (r.policyRefs?.length) {
          lines.push('政策依据（引用前请核对现行有效性）：')
          lines.push(...r.policyRefs.map((p) => `· ${p.ref}：${p.note}`))
        }
        lines.push('声明：本结果基于传入参数与默认政策口径的确定性算术试算，政策参数须经权威来源核对；正式申报以主管税务机关口径为准。')
        return lines.join('\n')
      })
    },
  })

  // ── 工具 6：跨境平台与结汇通道原始账单本地初筛体检与三段资金链核对 (v0.8 升级 11 通道) ──
  ctx.tools.register({
    name: 'fintax_parse_statement',
    description:
      '本地离线解析跨境电商 8 大销售平台（Amazon、TikTok Shop、Temu、速卖通 AliExpress、Shopee、Shopify、PayPal、Stripe）及 3 大第三方结汇通道（万里汇 WorldFirst、派安盈 Payoneer、空中云汇 Airwallex）原始账单（支持 .csv/.tsv/.txt/.xlsx/.zip 及 UTF-16，也可试用 demo:all / demo:v7 / demo:v8 / demo:wallets / demo:full）。自动执行「平台放款→结汇入账→钱包转出至疑似企业户（待补银行回单）」三段资金交叉核对（绝不重复计税）、多币种初筛与 P0/P1/P2 异常雷达，支持导出 HTML/Markdown 诊断书或异常 CSV。',
    parameters: {
      file_path: {
        type: 'string',
        description: '本机账单文件路径（支持 .csv / .tsv / .txt / .xlsx / .zip，或传 demo:all / demo:v7 / demo:v8 / demo:wallets / demo:full / demo:worldfirst / demo:payoneer / demo:airwallex 免文件体验）。与 file_paths 二选一即可。',
      },
      file_paths: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：多份月度/多站点及第三方结汇流水路径数组（同时传入销售平台账单与结汇流水将自动激活三段资金交叉核对）。',
      },
      platform: {
        type: 'string',
        description: 'auto（默认自动识别表头）| amazon | tiktok | temu | aliexpress | shopee | shopify | paypal | stripe | worldfirst | payoneer | airwallex',
      },
      fx_rate_to_cny: {
        type: 'number',
        description: '可选：单币种折合人民币汇率（如 USD 传 7.18）。多币种账单请改用 fx_rates。',
      },
      fx_rates: {
        type: 'object',
        description: '可选：多币种汇率映射（如 {"USD": 7.18, "EUR": 7.82, "MYR": 1.62, "SGD": 5.36}），用于多站点/多币种合并折算总对账。',
      },
      declared_vat_sales_cny: {
        type: 'number',
        description: '可选：企业当期或全年累计实际已申报增值税/出口销售额（人民币，元）；自动执行合并申报缺口与“回款净额报税”诊断。',
      },
      export_report_path: {
        type: 'string',
        description: '可选：导出本地报告路径（传 "auto" 自动生成可打印 .html 汇报单，"auto.md" 生成 Markdown，"auto.csv" 生成全量异常排雷 CSV，或指定具体路径）。',
      },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const inputPaths = []
        if (args?.file_path && String(args.file_path).trim()) inputPaths.push(String(args.file_path).trim())
        if (Array.isArray(args?.file_paths)) {
          for (const p of args.file_paths) {
            if (p && String(p).trim()) inputPaths.push(String(p).trim())
          }
        }
        if (!inputPaths.length) throw new PublicRequestError(400, 'FILES_REQUIRED', '请提供账单文件路径。')
        const parsed = await parseInWorker({ inputPaths, platform: args?.platform || 'auto' })
        if (parsed.error) {
          const detail = parsed.diagnostics?.length ? '\n' + JSON.stringify(parsed.diagnostics) : ''
          throw new PublicRequestError(400, parsed.code, parsed.error + detail)
        }
        const summaries = parsed.localSummaries
        const consolidated = buildConsolidatedReconcile(summaries, {
          fxRateToCny: args?.fx_rate_to_cny,
          fxRates: args?.fx_rates,
          declaredVatSalesCny: args?.declared_vat_sales_cny,
        })

        const blocks = []
        const yuan = (n) => n == null ? '待核' : `¥${n.toFixed(2)}`
        const amountOrPending = (n) => typeof n === 'bigint' ? fmtAmount(n) : '待核'
        for (const [index, s] of summaries.entries()) {
          const publicSummary = serializeSummary({ ...s, fileName: '' })
          const ccy = publicSummary.currency
          const p0 = publicSummary.anomalies.filter((a) => a.severity.startsWith('P0'))
          const p1 = publicSummary.anomalies.filter((a) => a.severity.startsWith('P1'))
          const p2 = publicSummary.anomalies.filter((a) => a.severity.startsWith('P2'))

          const lines = s.role === 'settlement_wallet' && s.walletMetrics
            ? [
                `【第三方结汇通道资金排雷报告｜${s.platform} · ${ccy}】`,
                `· 账单 ${index + 1} · ${publicSummary.formatLabel}`,
                `· 识别期间：${publicSummary.period} | 有效明细行数：${s.rawRowCount} 行（口径声明：结汇通道不重复计入销售报送总额）`,
                `── 一、结汇通道资金流向拆解（单位：${ccy}，精确到 0.01）──`,
                `· ① 电商平台/收单网关回款入账：${fmtAmount(s.walletMetrics.platformInbound)}`,
                `· ② 非标准平台/其他入账（请核实来源防漏报）：${fmtAmount(s.walletMetrics.otherInbound)}`,
                `· ③ 结汇提现至企业账户（待核银行回单）：${fmtAmount(s.walletMetrics.fxWithdrawToCorporate)}`,
                `· ④ 提现至个人私户/法人私卡（P0 优先核查）：${fmtAmount(s.walletMetrics.fxWithdrawToPersonal)}`,
                `· ⑤ 收款户性质待核提现（未计入企业户转出占比，P1）：${fmtAmount(s.walletMetrics.unverifiedWithdraw || 0n)}`,
                `· ⑥ 钱包余额境外坐支（供应商/物流/广告/卡消费，P1 高危）：${fmtAmount(s.walletMetrics.directSpend)}`,
                `· ⑦ 提现/汇兑/账户手续费：${fmtAmount(s.walletMetrics.walletFees)}`,
                `· ⑧ 已自动剥离同户换汇/多币种互转：${fmtAmount(s.walletMetrics.internalFxStripped)}（${s.walletMetrics.internalFxCount} 笔，本币净变动 ${fmtAmount(s.walletMetrics.internalFxNet || 0n)}）`,
                `· ⑨ 期间净流：${publicSummary.walletMetrics.signedNetFlow ?? '待核'} ｜ 期初余额：${amountOrPending(s.walletMetrics.openingBalance)} ｜ 期末余额：${amountOrPending(s.walletMetrics.closingBalance)} ｜ 银行实收：待补回单`,
              ]
            : [
                `【跨境原始账单初筛体检报告｜${s.platform} · ${ccy}】`,
                `· 账单 ${index + 1} · ${publicSummary.formatLabel}`,
                `· 识别期间：${publicSummary.period} | 有效明细行数：${s.rawRowCount} 行`,
                `── 一、原币报送参考与结算项目（单位：${ccy}，精确到 0.01）──`,
                `· ① 商品含运费原价总额：${fmtAmount(s.grossSales)}`,
                `· ② 减：商家承担促销折扣：${fmtAmount(s.sellerDiscount)}`,
                `· ★ 账单推算报送参考毛额（①−②）：${fmtAmount(s.taxReportingGrossRef)}；正式报送总额请核对实际报送单及补贴归属。`,
                `· ③ 加：平台出资补贴 / 库存赔付：${fmtAmount(s.platformSubsidy)}`,
                `· ④ 减：客户退款本金：${fmtAmount(s.customerRefund)}`,
                `· ⑤~⑨ 平台与履约费用合计（主要责任人须单独列支成本费用，严禁直接冲减收入）：${fmtAmount(s.totalFees)}`,
                `    ├─ 平台佣金及交易手续费：${fmtAmount(s.platformCommission)}`,
                `    ├─ 联盟达人佣金（Affiliate/TAP）：${fmtAmount(s.affiliateCommission)}`,
                `    ├─ FBA / 仓储及尾程物流费：${fmtAmount(s.logisticsWarehousing)}`,
                `    ├─ 站内广告 / 网关直付广告费：${fmtAmount(s.inPlatformAds)}`,
                `    └─ 支付网关 / 拒付争议及履约罚款：${fmtAmount(s.gatewayDisputeFee)}`,
                `· 已自动剥离（商城代扣代缴流转税，不计入收入）：${fmtAmount(s.facilitatorTaxStripped)}`,
                `· ⑩ 非代扣待卖家自申报流转税净流入（应计其他应付款，勿混入收入）：${fmtAmount(s.selfRemitTaxNet)}`,
                `· ⑪ 冻结准备金/保证金净变动（+新增冻结 / -释放前期）：${fmtAmount(s.reserveNetChange)}`,
                `── 二、资金桥接与账单内部勾稽 ──`,
                `· 行内水平守恒校验：差额 ${fmtAmount(s.horizontalDiffTotal)} ${ccy}（${s.horizontalDiffTotal === 0n ? '✔ 全部明细行水平守恒通过' : '❌ 存在行内不守恒阻断项，见下方异常雷达'}）`,
                publicSummary.payoutEvidenceCount > 0
                  ? `· 理论应放款净额：${fmtAmount(s.theoreticalPayout)} ${ccy} | 账单内提取实际打款（Payout）：${fmtAmount(s.actualPayout)} ${ccy} | 放款差额（实际 − 理论，正为多放、负为少放）：${fmtAmount(s.statementPayoutDiff)} ${ccy}`
                  : `· 理论应放款净额：${fmtAmount(s.theoreticalPayout)} ${ccy} ｜ 实际放款及差额待补凭证。`,
              ]

          if (publicSummary.payoutEvidenceCount > 0 && s.statementPayoutDiff !== 0n && s.horizontalDiffTotal === 0n) {
            lines.push(
              `  （注：行内水平守恒已通过；放款差额 ${fmtAmount(s.statementPayoutDiff)} ${ccy} 通常源于自然月截取导致的期初/期末待打款留存余额变动或独立结算周期跨月打款。）`,
            )
          }
          if (s.uncapturedVoidExcluded > 0n) {
            lines.push(`· 已自动过滤未捕获预授权/未结清废单金额：${fmtAmount(s.uncapturedVoidExcluded)} ${ccy}`)
          }

          if (summaries.length === 1 && consolidated?.ready) {
            const rec = consolidated.reconcile
            lines.push(`── 三、人民币折算与申报比对诊断（按汇率 ${consolidated.breakdown[0].fx} 试算）──`)
            lines.push(...rec.steps.map((st) => `· ${st}`))
            if (rec.warnings.length) lines.push(...rec.warnings.map((w) => `⚠ ${w}`))
            if (consolidated.cliffAlert) lines.push(consolidated.cliffAlert)
            if (p0.length > 0) {
              lines.push(
                '⚠ 阻断级混表提示：上述折算毛收入仍包含尚未剥离的 P0 级异常记录（如全托管供货结算单），在按自营零售申报前请先剔除对应结算额！',
              )
            }
          }

          lines.push(`── 异常交易雷达扫描结果（P0阻断 ${p0.length} 项 | P1高危 ${p1.length} 项 | P2关注 ${p2.length} 项）──`)
          if (s.anomalies.length === 0) {
            lines.push('✔ 未检出异常交易记录。')
          } else {
            const ordered = [...p0, ...p1, ...p2]
            for (const a of ordered.slice(0, 18)) {
              lines.push(`· [${a.severity}] ${a.category}（本地定位 ${a.refId}，金额 ${a.amount} ${ccy}）：${a.detail}`)
            }
            if (ordered.length > 18) {
              lines.push(`· …其余 ${ordered.length - 18} 条同类异常已折叠汇总。`)
            }
          }

          lines.push(
            '── 合规与关账边界说明 ──',
            '· 如检出 P0/P1 异常（如全托管混表、网关余额坐支海外广告、非代扣待申报流转税、回款净额漏报），若已配置 IMA 知识库可调用 ima_search 检索对应实操 SOP 与政策原文。',
            '· 本工具提供原始账单离线初筛体检与异常排雷；企业正式关账仍须结合多店铺主体映射、央行基准汇率、第三方收款机构期初期末资金池、海关报关离境跨期台账及标准借贷会计分录完成完整底稿复核。',
          )
          blocks.push(lines.join('\n'))
        }

        if (summaries.length > 1 && consolidated) {
          if (consolidated.ready) {
            const hasSales = summaries.some((s) => s.role !== 'settlement_wallet')
            const cLines = [
              `【多表/多币种合并人民币总对账 & 年终红线核验（共合并 ${summaries.length} 张结算单）】`,
              ...consolidated.breakdown.map((b, index) =>
                b.role === 'settlement_wallet'
                  ? `· 结汇通道 [账单 ${index + 1}]：平台入账折合 ¥${(b.walletInboundCny || 0).toFixed(2)} ｜ 转出企业户(待核回单)折合 ¥${(b.corporateWithdrawCny || 0).toFixed(2)}（汇率 ${b.fx}，不重复计入销售报送额）`
                  : `· 分表折算 [账单 ${index + 1}]：原币报送毛额 ${b.grossOrig} ${b.currency} × 汇率 ${b.fx} = ${b.grossCny.toFixed(2)} 元`,
              ),
              ...consolidated.reconcile.steps.map((st) => `· ${st}`),
              ...consolidated.reconcile.warnings.map((w) => `⚠ ${w}`),
              ...(hasSales
                ? [`· 4% 核定收入等值初筛：当前合并报送参考净额为 7,500 万元等值的 ${consolidated.cliffRatioPct}%。年度应纳税所得额须按主体另行核定。`]
                : []),
            ]
            if (consolidated.fundChain) {
              const fc = consolidated.fundChain
              const s1Txt = yuan(fc.stage1PlatformPayoutCny)
              const gapTxt = yuan(fc.stage1to2GapCny)
              const rateTxt = fc.corporateRepatriationRatePct !== null ? `${fc.corporateRepatriationRatePct}%` : '待核'
              cLines.push(
                `── 三段资金链路交叉核对（平台放款 → 结汇通道 → 钱包转出至企业户[待核银行回单]）──`,
                `· ① 销售平台实际放款：${s1Txt} ｜ ② 结汇通道平台入账：¥${fc.stage2WalletInboundCny.toFixed(2)}${fc.stage2OtherInboundCny > 0 ? `（+其他入账 ¥${fc.stage2OtherInboundCny.toFixed(2)}）` : ''} ｜ 一/二段差额：${gapTxt}`,
                `· ③ 钱包转出至企业户(待核银行回单)：¥${fc.stage3CorporateRepatriatedCny.toFixed(2)}（企业户转出占比 ${rateTxt}）｜ 私户提现(P0)：¥${fc.stage3PersonalWithdrawCny.toFixed(2)} ｜ 待核提现(P1)：¥${(fc.stage3UnverifiedWithdrawCny || 0).toFixed(2)} ｜ 境外坐支(P1)：¥${fc.directSpendCny.toFixed(2)} ｜ 期末余额：${yuan(fc.closingBalanceCny)} ｜ 银行实收：待补回单`,
                ...(fc.stage3StatusNote ? [`· 口径提示：${fc.stage3StatusNote}`] : []),
                ...fc.alerts.map((a) => `· ${a}`),
              )
            }
            if (consolidated.cliffAlert) cLines.push(consolidated.cliffAlert)
            if (consolidated.p0Count > 0) {
              cLines.push(
                '⚠ 阻断级混表提示：合并毛收入中含 P0 级异常记录（如全托管供货结算），按境外自营零售申报前请先剥离对应供货额！',
              )
            }
            blocks.push(cLines.join('\n'))
          } else {
            blocks.push(
              `【多币种合并折算提示】检测到多币种账单，尚缺币种 [${consolidated.missingCurrencies.join(', ')}] 的人民币汇率；请传入 fx_rates（如 {"USD": 7.18, "EUR": 7.82}）即可一键完成合并人民币总对账。`,
            )
          }
        }

        if (consolidated.coverageComplete === false) {
          const diagnostics = summaries.flatMap((summary) => summary.parseDiagnostics ?? [])
          blocks.push(`【部分账单待核】${JSON.stringify(diagnostics)}`)
        }
        if (summaries.length === 1 && !consolidated.ready) {
          blocks.push('【人民币折算待核】请核对币种及对应汇率。')
        }

        if (args?.export_report_path) {
          const savedPath = exportDiagnosticReport({
            summaries,
            consolidated,
            exportPath: args.export_report_path,
            firstInputPath: inputPaths[0],
            version: PKG_VERSION,
          })
          if (savedPath) {
            blocks.push('已在本机生成核对报告。')
          }
        }

        return blocks.join('\n\n========================================\n\n')
      })
    },
  })

  // ── 随包技能注册 ─────────────────────────────────────────────
  const skillsDir = join(PKG_DIR, 'skills')
  let entries = []
  try {
    entries = readdirSync(skillsDir)
  } catch {
    ctx.logger?.warn?.('[fintax] skills 目录缺失，跳过技能注册')
  }
  for (const entry of entries) {
    const dir = join(skillsDir, entry)
    const file = join(dir, 'SKILL.md')
    try {
      if (!statSync(dir).isDirectory()) continue
      const raw = readFileSync(file, 'utf8')
      const parsed = parseSkillMd(raw)
      if (!parsed) {
        ctx.logger?.warn?.(`[fintax] 无法解析 ${file}，跳过`)
        continue
      }
      ctx.skills.register({
        name: parsed.name,
        description: parsed.description,
        content: parsed.body,
        path: file,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: dir },
      })
    } catch (err) {
      ctx.logger?.warn?.(`[fintax] 注册技能 ${entry} 失败：${err.message}`)
    }
  }

  // ── 桌面端图形化设置接口（仅当宿主存在 webServer 时挂载，CLI 模式自动优雅跳过） ──
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      const apiHandler = createFintaxApiHandler({
        getConnection: () => scoped.get?.('connection') ?? ctx.get?.('connection'),
      })
      scoped.effect(
        () => scoped.webServer.register({ kind: 'prefix', path: '/api/fintax', handler: apiHandler }),
        'fintax: settings api routes',
      )
      ctx.logger?.info?.('[fintax] 设置页接口已挂载于 /api/fintax')
    })
  }

  console.log(`[fintax] 财税工作台 v${PKG_VERSION} 已加载：6 个工具（11 通道账单与结汇链离线体检雷达 + 10 大确定性算税场景 + 12 个月滚年归档）+ 4 个技能`)
}

/** 极简 frontmatter 解析：只取 name / description（单行值），其余交给正文。 */
function parseSkillMd(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return null
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim()
  }
  if (!meta.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name)) return null
  return { name: meta.name, description: meta.description ?? '', body: m[2].trim() }
}
