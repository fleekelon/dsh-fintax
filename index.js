// dsh-fintax v0.4.0：财税工作台插件入口（Host 半身）。
// 纯 ESM、零运行时依赖：
//   1. 向 ctx.tools 注册 6 个工具（4 个 IMA 知识库只读工具 + 1 个原始结算账单离线初筛体检雷达 fintax_parse_statement + 1 个 7 场景确定性算税与对账引擎 fintax_calc）；
//   2. 向 ctx.skills 注册 4 个随包财税合规技能；
//   3. 当宿主挂载 webServer 时，提供经会话准入校验的 /api/fintax/* 设置接口（配合 client.js 图形化设置页，绝不回传密钥明文）。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  imaCall,
  loadCredentials,
  loadFintaxSettings,
  saveCredentials,
  clearCredentials,
  saveFintaxSettings,
  getPublicStatus,
  CREDENTIALS_HELP,
} from './lib/ima.js'
import { calculate, platformTaxReconcile } from './lib/calc.js'
import { parsePlatformStatement, fmtAmount, toNumber2 } from './lib/statement.js'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))

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
    return `[错误] ${err.message}`
  }
}

/**
 * 宿主连接准入校验（对齐 DSH connection 服务，防止未授权访问或跨站伪造）：
 * - DSH >= 0.1.7 提供 connection.admit(req) -> { rejection?: number }
 * - 旧版提供 connection.requestRejection(req) -> number | undefined
 * - 若 connection 服务缺失或异常，默认按 503 拒绝（fail-closed）。
 */
export function admitRequest(req, connection) {
  if (!connection) return 503
  try {
    if (typeof connection.admit === 'function') {
      const res = connection.admit(req)
      return res && typeof res === 'object' ? res.rejection : undefined
    }
    if (typeof connection.requestRejection === 'function') {
      return connection.requestRejection(req)
    }
    return 503
  } catch {
    return 503
  }
}

/** 读取小体积 JSON 请求体（上限 32 KiB）。 */
function readJsonBody(req, maxBytes = 32_768) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('请求体不是合法的 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 创建设置页后端路由处理器（导出以便单元测试直接验证准入与脱敏逻辑）。 */
export function createFintaxApiHandler({ getConnection }) {
  return async function handleFintaxApi(req, res) {
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
    }

    const rejection = admitRequest(req, typeof getConnection === 'function' ? getConnection() : undefined)
    if (rejection !== undefined) {
      return send(rejection, {
        error: rejection === 401 ? '未登录或会话无效' : rejection === 503 ? '宿主连接准入服务未就绪' : '拒绝访问',
      })
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const marker = '/api/fintax'
    const idx = url.pathname.indexOf(marker)
    const subPath = (idx >= 0 ? url.pathname.slice(idx + marker.length) : url.pathname).replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    try {
      if (subPath === '/status' && method === 'GET') {
        return send(200, { ok: true, version: '0.4.0', ...getPublicStatus() })
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
        saveFintaxSettings({
          defaultKbId: body?.defaultKbId ?? '',
          defaultKbName: body?.defaultKbName ?? '',
        })
        return send(200, { ok: true, ...getPublicStatus() })
      }

      if (subPath === '/kbs' && method === 'GET') {
        if (!loadCredentials()) {
          return send(400, { error: '尚未配置完整的 IMA Client ID 与 API Key，请先在上方保存凭证' })
        }
        const data = await imaCall('openapi/wiki/v1/search_knowledge_base', {
          query: url.searchParams.get('query') ?? '',
          cursor: '',
          limit: 50,
        })
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

      return send(404, { error: `未知接口：${method} ${subPath}` })
    } catch (err) {
      return send(500, { error: err?.message || '内部错误' })
    }
  }
}

export function apply(ctx) {
  console.log('[fintax] 财税工作台 v0.4.0 加载中…')

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
          return `未找到知识库。原始返回：${JSON.stringify(data).slice(0, 2000)}`
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
      '在 IMA 知识库内搜索政策原文与底稿条目，返回 media_id、标题和命中摘要。若用户已在设置页绑定默认知识库，knowledge_base_id 可省略。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '搜索关键词。IMA 搜索对多词组合敏感：优先用短单一关键词（如“报送”“退运”“9810”），空结果时换词重试。',
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
        const kbId = String(args?.knowledge_base_id || loadFintaxSettings().defaultKbId || '').trim()
        if (!kbId) {
          throw new Error('未指定 knowledge_base_id 且尚未绑定默认知识库（请先调用 ima_list_kbs 获取 ID，或在「设置 → 财税工作台」绑定默认库）')
        }
        if (!args?.query || !String(args.query).trim()) {
          throw new Error('query（搜索关键词）不能为空；若想直接浏览目录请改用 ima_browse')
        }
        if (!loadCredentials()) return CREDENTIALS_HELP
        const data = await imaCall('openapi/wiki/v1/search_knowledge', {
          query: String(args.query).trim(),
          knowledge_base_id: kbId,
          cursor: args.cursor ?? '',
        })
        const list = data.info_list ?? []
        if (!Array.isArray(list) || list.length === 0) {
          return `知识库 ${kbId} 中未搜到「${args.query}」。可换更短的同义词重试，或用 ima_browse 浏览目录。`
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
          JSON.stringify(items, null, 2),
          data.is_end === false ? `还有更多结果，next_cursor: ${data.next_cursor}` : '已到末尾。',
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
        const kbId = String(args?.knowledge_base_id || loadFintaxSettings().defaultKbId || '').trim()
        if (!kbId) {
          throw new Error('未指定 knowledge_base_id 且尚未绑定默认知识库（请先调用 ima_list_kbs 获取 ID，或在「设置 → 财税工作台」绑定默认库）')
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
      '按 media_id 读取 IMA 知识条目原文（Markdown/纯文本/笔记直接返回正文内容，网页返回访问 URL）。folder_ 开头的文件夹请用 ima_browse 展开。',
    parameters: {
      media_id: { type: 'string', required: true, description: '知识条目 media_id（来自 ima_browse 或 ima_search 结果中的非文件夹条目）。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const mediaId = String(args?.media_id ?? '').trim()
        if (!mediaId) {
          throw new Error('media_id 不能为空（请先从 ima_browse 或 ima_search 结果中获取）')
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
            // 失败时回退展示原始 media_info
          }
        }

        if ((data.media_type === 7 || data.media_type === 13) && data.url_info?.url) {
          try {
            const res = await fetch(data.url_info.url, {
              headers: data.url_info.headers ?? {},
              signal: AbortSignal.timeout(15_000),
            })
            if (res.ok) {
              const text = await res.text()
              return [
                `media_id: ${mediaId}（Markdown/文本原文）：`,
                text.slice(0, 8000),
                text.length > 8000 ? `\n…（原文共 ${text.length} 字，已截断前 8000 字）` : '',
                '引用时请注明资料标题与出处，只引用原文中真实出现的政策文号。',
              ].filter(Boolean).join('\n')
            }
          } catch {
            // 直拉失败回退展示 url_info
          }
        }

        if ([1, 3, 4, 5].includes(data.media_type)) {
          return [
            `media_id: ${mediaId} 的文件信息（media_type=${data.media_type}，二进制文档）：`,
            JSON.stringify(data, null, 2).slice(0, 4000),
            '注意：该条目为 PDF/Word/PPT/Excel 二进制文件，请勿直接用网页抓取工具读取 URL（会产生二进制乱码撑爆上下文）；请优先读取同目录下的 Markdown (.md) 指南文档，或将该文件说明告知用户。',
          ].join('\n')
        }

        return [
          `media_id: ${mediaId} 的原文信息：`,
          JSON.stringify(data, null, 2).slice(0, 8000),
          '若返回 url_info.url（网页链接），可用网页抓取工具读取原文；引用时注明标题与出处，不得编造文号。',
        ].join('\n')
      })
    },
  })

  // ── 工具 5：7 场景确定性税额与差额对账引擎 ──────────────────
  ctx.tools.register({
    name: 'fintax_calc',
    description:
      '确定性财税试算与对账引擎（免配 IMA 亦可离线运行，严禁 LLM 心算替代），支持 7 大场景：' +
      'platform_tax_reconcile 平台涉税报送 vs 结算放款 vs 纳税申报四层口径差额桥接核对（含净额法误报佣金冲收入自动排雷）；' +
      'export_invoice_breakeven 供应商开票加点「拿专票退税 vs 合规无票免税」毛利临界点与所得税联动测算；' +
      'export_rebate 外贸企业出口免退税（孰低规则+征退税率差转成本）；' +
      'cbec_assessed_cit 综试区零售出口4%核定征收企业所得税（含300万/7500万小微悬崖预警）；' +
      'annual_bonus_iit 年终奖单独计税个税（含多发一元临界点陷阱检测）；' +
      'cross_border_import 跨境电商零售进口综合税（限额内70%口径+超限预警）；' +
      'vat 增值税价税分离。',
    parameters: {
      scenario: {
        type: 'string',
        required: true,
        description:
          'platform_tax_reconcile | export_invoice_breakeven | export_rebate | cbec_assessed_cit | annual_bonus_iit | cross_border_import | vat',
      },
      params: {
        type: 'object',
        required: true,
        description:
          'platform_tax_reconcile: {reportedGrossRevenue, refunds=0, marketplaceWithheldTax=0, cutoffAndFxDiff=0, platformFees=0, subsidies=0, reserveChange=0, actualPayout?, declaredVatSales?, principalRole="principal"}；' +
          'export_invoice_breakeven: {barePurchaseAmount, supplierMarkupRate, vatRate=0.13, rebateRate=vatRate, exportRevenue?, otherDeductibleExpenses=0, invoicedCitRate=0.05, noInvoiceRevenueCitRate=0.002}；' +
          'export_rebate: {purchaseAmount, vatRate=0.13, rebateRate=vatRate}；' +
          'cbec_assessed_cit: {revenue, taxableIncomeRate=0.04, citRate=0.25, smallLowProfit=false}；' +
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

  // ── 工具 6：跨境平台原始结算账单本地初筛体检与异常雷达 ──────────
  ctx.tools.register({
    name: 'fintax_parse_statement',
    description:
      '本地离线解析跨境电商官方导出的原始结算账单（支持 Amazon Date Range CSV / Flat File V2、TikTok Shop Statements XLSX/CSV、Stripe 独立站余额流水 CSV/XLSX）。采用 BigInt 定点运算精确到分（免装 Python/LibreOffice，原始订单明细不外传），输出四层口径初筛汇总、行内水平守恒校验与 P0/P1/P2 异常交易雷达；可选传入汇率与已申报额直接联动四层口径差额诊断。',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: '本机账单文件路径（支持 .csv / .tsv / .txt / .xlsx）。',
      },
      platform: {
        type: 'string',
        description: 'auto（默认自动识别表头）| amazon | tiktok | stripe',
      },
      fx_rate_to_cny: {
        type: 'number',
        description: '可选：1 原币折合人民币汇率（如 USD 传 7.12）；原币已为 RMB 时默认按 1.0 处理。传入后自动折算人民币四层口径。',
      },
      declared_vat_sales_cny: {
        type: 'number',
        description: '可选：企业当期实际已申报增值税/出口销售额（人民币，元）；配合 fx_rate_to_cny 自动执行申报缺口与“回款净额报税”排雷诊断。',
      },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const fp = String(args?.file_path ?? '').trim()
        if (!fp) throw new Error('file_path（本地账单文件路径）不能为空')
        const summaries = parsePlatformStatement(fp, args?.platform || 'auto')
        const blocks = []

        for (const s of summaries) {
          const ccy = s.currency
          const p0 = s.anomalies.filter((a) => a.severity.startsWith('P0'))
          const p1 = s.anomalies.filter((a) => a.severity.startsWith('P1'))
          const p2 = s.anomalies.filter((a) => a.severity.startsWith('P2'))

          const lines = [
            `【跨境原始账单四层口径初筛体检报告｜${s.platform} · ${s.site} · ${ccy}】`,
            `· 文件与格式：${s.fileName} — ${s.formatLabel}`,
            `· 识别期间：${s.period} | 有效明细行数：${s.rawRowCount} 行`,
            `── 一、原币四层口径精确拆解（单位：${ccy}，精确到 0.01）──`,
            `· ① 商品含运费原价总额：${fmtAmount(s.grossSales)}`,
            `· ② 减：商家承担促销折扣：${fmtAmount(s.sellerDiscount)}`,
            `· ★ 平台涉税报送参考收入总额（①−②，未扣佣金与退款）：${fmtAmount(s.taxReportingGrossRef)}`,
            `· ③ 加：平台出资补贴 / 库存赔付：${fmtAmount(s.platformSubsidy)}`,
            `· ④ 减：客户退款本金：${fmtAmount(s.customerRefund)}`,
            `· ⑤~⑨ 平台与履约费用合计（主要责任人须单独列支成本费用，严禁直接冲减收入）：${fmtAmount(s.totalFees)}`,
            `    ├─ 平台佣金及交易手续费：${fmtAmount(s.platformCommission)}`,
            `    ├─ 联盟达人佣金（Affiliate/TAP）：${fmtAmount(s.affiliateCommission)}`,
            `    ├─ FBA / 仓储及尾程物流费：${fmtAmount(s.logisticsWarehousing)}`,
            `    ├─ 站内广告 / 网关直付广告费：${fmtAmount(s.inPlatformAds)}`,
            `    └─ 支付网关及拒付争议处理费：${fmtAmount(s.gatewayDisputeFee)}`,
            `· 已自动剥离（商城代扣代缴流转税，不计入收入）：${fmtAmount(s.facilitatorTaxStripped)}`,
            `· ⑩ 非代扣待卖家自申报流转税净流入（应计其他应付款，勿混入收入）：${fmtAmount(s.selfRemitTaxNet)}`,
            `· ⑪ 冻结准备金/保证金净变动（+新增冻结 / -释放前期）：${fmtAmount(s.reserveNetChange)}`,
            `── 二、账单内部勾稽核验 ──`,
            `· 行内水平守恒校验：差额 ${fmtAmount(s.horizontalDiffTotal)} ${ccy}（${s.horizontalDiffTotal === 0n ? '✔ 全部明细行水平守恒通过' : '❌ 存在行内不守恒阻断项，见下方异常雷达'}）`,
            `· 理论应放款净额：${fmtAmount(s.theoreticalPayout)} ${ccy} | 账单内提取实际打款（Payout）：${fmtAmount(s.actualPayout)} ${ccy} | 账单内放款差额：${fmtAmount(s.statementPayoutDiff)} ${ccy}`,
          ]

          if (s.statementPayoutDiff !== 0n && s.horizontalDiffTotal === 0n) {
            lines.push(
              `  （注：行内水平守恒已通过；放款差额 ${fmtAmount(s.statementPayoutDiff)} ${ccy} 通常源于自然月截取导致的期初/期末待打款留存余额变动或独立结算周期跨月打款。）`,
            )
          }
          if (s.uncapturedVoidExcluded > 0n) {
            lines.push(`· 已自动过滤未捕获预授权/取消废单金额：${fmtAmount(s.uncapturedVoidExcluded)} ${ccy}`)
          }

          // 可选联动：按汇率折算人民币并接入 platformTaxReconcile
          const rawFx = args?.fx_rate_to_cny ?? (ccy === 'RMB' ? 1 : null)
          if (rawFx !== null && rawFx !== undefined && String(rawFx).trim() !== '' && summaries.length === 1) {
            const fx = Number(rawFx)
            if (Number.isFinite(fx) && fx > 0) {
              const rec = platformTaxReconcile({
                reportedGrossRevenue: Math.round(toNumber2(s.taxReportingGrossRef) * fx * 100) / 100,
                refunds: Math.round(toNumber2(s.customerRefund) * fx * 100) / 100,
                marketplaceWithheldTax: 0, // taxReportingGrossRef 已按不含代扣税的商品原价减商家折扣口径提取
                platformFees: Math.round(toNumber2(s.totalFees) * fx * 100) / 100,
                subsidies: Math.round(toNumber2(s.platformSubsidy) * fx * 100) / 100,
                reserveChange: Math.round(toNumber2(s.reserveNetChange) * fx * 100) / 100,
                actualPayout: s.actualPayout > 0n ? Math.round(toNumber2(s.actualPayout) * fx * 100) / 100 : undefined,
                declaredVatSales: args?.declared_vat_sales_cny,
              })
              lines.push(`── 三、人民币折算与申报比对诊断（按汇率 ${fx} 试算）──`)
              lines.push(...rec.steps.map((st) => `· ${st}`))
              if (rec.warnings.length) lines.push(...rec.warnings.map((w) => `⚠ ${w}`))
            }
          }

          // 异常雷达展示（限制每级展示条数防止大账单撑爆上下文）
          lines.push(`── 异常交易雷达扫描结果（P0阻断 ${p0.length} 项 | P1高危 ${p1.length} 项 | P2关注 ${p2.length} 项）──`)
          if (s.anomalies.length === 0) {
            lines.push('✔ 未检出异常交易记录。')
          } else {
            const ordered = [...p0, ...p1, ...p2]
            for (const a of ordered.slice(0, 18)) {
              lines.push(`· [${a.severity}] ${a.category}（单号 ${a.refId}，金额 ${a.amount} ${ccy}）：${a.detail}`)
            }
            if (ordered.length > 18) {
              lines.push(`· …其余 ${ordered.length - 18} 条同类异常已折叠汇总。`)
            }
          }

          lines.push(
            '── 合规与关账边界说明 ──',
            '· 如检出 P0/P1 异常（如全托管混表、网关余额坐支海外广告、非代扣待申报流转税、回款净额漏报），若已配置 IMA 知识库可调用 ima_search 检索对应实操 SOP 与政策原文。',
            '· 本工具提供单店原始账单初筛体检与异常排雷；企业月末正式关账仍须结合多店铺主体映射、央行基准汇率、第三方收款机构期初期末资金池、海关报关离境跨期台账及标准借贷会计分录完成完整底稿复核。',
          )
          blocks.push(lines.join('\n'))
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

  console.log('[fintax] 财税工作台 v0.4.0 已加载：6 个工具（含原始账单离线体检雷达 + 7 大确定性场景）+ 4 个技能')
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
