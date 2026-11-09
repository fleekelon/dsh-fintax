// dsh-fintax：财税工作台插件入口。
// 纯 ESM、零运行时依赖：直接向 ctx.tools / ctx.skills 注册对象，
// 不导入任何 @deepseek-ai 包，宿主版本兼容性风险最小。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { imaCall, loadCredentials, CREDENTIALS_HELP } from './lib/ima.js'
import { calculate } from './lib/calc.js'

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

export function apply(ctx) {
  console.log('[fintax] 财税工作台加载中…')
  // ── 工具 1：列出我的 IMA 知识库 ─────────────────────────────
  ctx.tools.register({
    name: 'ima_list_kbs',
    description:
      '列出当前用户配置的 IMA 知识库（id、名称、描述）。财税政策问答前先用它确定要在哪个知识库检索。需要本机已配置 IMA 凭证。',
    parameters: {
      query: { type: 'string', description: '按名称过滤知识库；留空返回全部。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        if (!loadCredentials()) return CREDENTIALS_HELP
        const data = await imaCall('openapi/wiki/v1/search_knowledge_base', {
          query: args?.query ?? '',
          cursor: '',
          limit: 20,
        })
        const list = data.info_list ?? data.knowledge_base_list ?? data.list ?? []
        if (!Array.isArray(list) || list.length === 0) {
          return `未找到知识库。原始返回：${JSON.stringify(data).slice(0, 2000)}`
        }
        const lines = list.map((kb) => {
          const id = kb.kb_id ?? kb.id
          const name = kb.kb_name ?? kb.name
          const extra = [kb.content_count ? `${kb.content_count} 条内容` : '', kb.base_type ?? ''].filter(Boolean).join('，')
          return `- id: ${id} | 名称: ${name}${extra ? ` | ${extra}` : ''}${kb.description ? ` | 描述: ${kb.description}` : ''}`
        })
        return `找到 ${list.length} 个知识库：\n${lines.join('\n')}${data.is_end === false ? `\n（还有更多，next_cursor: ${data.next_cursor}）` : ''}`
      })
    },
  })

  // ── 工具 2：在指定知识库内搜索 ──────────────────────────────
  ctx.tools.register({
    name: 'ima_search',
    description:
      '在指定 IMA 知识库内搜索知识条目，返回 media_id、标题和命中摘要。用于财税政策问答时检索用户积累的政策原文与解读。需要本机已配置 IMA 凭证。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词。IMA 搜索对多词组合敏感：优先用短单一关键词（如“跨境”“退运”），空结果时换词重试，不要一次堆多个词。' },
      knowledge_base_id: { type: 'string', required: true, description: '知识库 ID（先用 ima_list_kbs 获取）。' },
      cursor: { type: 'string', description: '分页游标，首次留空。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        if (!args?.knowledge_base_id || !String(args.knowledge_base_id).trim()) {
          throw new Error('knowledge_base_id 不能为空（请先调用 ima_list_kbs 获取知识库 ID）')
        }
        if (!args?.query || !String(args.query).trim()) {
          throw new Error('query（搜索关键词）不能为空；若想直接浏览目录请改用 ima_browse')
        }
        if (!loadCredentials()) return CREDENTIALS_HELP
        const data = await imaCall('openapi/wiki/v1/search_knowledge', {
          query: String(args.query).trim(),
          knowledge_base_id: String(args.knowledge_base_id).trim(),
          cursor: args.cursor ?? '',
        })
        const list = data.info_list ?? []
        if (!Array.isArray(list) || list.length === 0) {
          return `知识库 ${args.knowledge_base_id} 中未搜到「${args.query}」。可换关键词重试，或如实告知用户知识库暂无该资料。`
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
          `命中 ${items.length} 条（query: ${args.query}）：`,
          JSON.stringify(items, null, 2),
          data.is_end === false ? `还有更多结果，next_cursor: ${data.next_cursor}` : '已到末尾。',
          '若命中文件夹（kind 为 folder），请将 media_id 作为 folder_id 传给 ima_browse 展开目录；文件条目引用前请用 ima_read 获取原文，核对标题与内容并在回答中注明来源标题。',
        ].join('\n')
      })
    },
  })

  // ── 工具 3：浏览知识库内容列表 ─────────────────────────────
  ctx.tools.register({
    name: 'ima_browse',
    description:
      '浏览指定 IMA 知识库的内容列表（标题+media_id，分页）。小库（几十条以内）优先直接浏览全目录再挑目标，比反复猜关键词搜索更快更省；遇到文件夹可将 media_id 作为 folder_id 传入继续展开，找到文档后用 ima_read 取原文。需要本机已配置 IMA 凭证。',
    parameters: {
      knowledge_base_id: { type: 'string', required: true, description: '知识库 ID（先用 ima_list_kbs 获取）。' },
      cursor: { type: 'string', description: '分页游标，首次留空。' },
      folder_id: { type: 'string', description: '可选，浏览指定文件夹（传入文件夹的 media_id）；留空浏览根目录。' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        if (!args?.knowledge_base_id || !String(args.knowledge_base_id).trim()) {
          throw new Error('knowledge_base_id 不能为空（请先调用 ima_list_kbs 获取知识库 ID）')
        }
        if (!loadCredentials()) return CREDENTIALS_HELP
        const body = { knowledge_base_id: String(args.knowledge_base_id).trim(), cursor: args.cursor ?? '', limit: 50 }
        if (args.folder_id) body.folder_id = String(args.folder_id).trim()
        const data = await imaCall('openapi/wiki/v1/get_knowledge_list', body)
        const list = data.knowledge_list ?? data.info_list ?? []
        if (!Array.isArray(list) || list.length === 0) return `知识库 ${args.knowledge_base_id} 该目录下暂无内容。`
        const lines = list.map((it) => {
          const isFolder = it.media_type === 99 || String(it.media_id ?? '').startsWith('folder_')
          const tag = isFolder
            ? '📁 文件夹（请将 media_id 作为 folder_id 传给 ima_browse 展开）'
            : `📄 文档${it.media_type != null ? ` (media_type=${it.media_type})` : ''}（传 media_id 给 ima_read 读取）`
          return `- ${it.title} | media_id: ${it.media_id} | ${tag}`
        })
        return [
          `共列出 ${lines.length} 条：`,
          ...lines,
          data.is_end === false ? `（还有更多，next_cursor: ${data.next_cursor}）` : '（已到末尾）',
        ].join('\n')
      })
    },
  })

  // ── 工具 4：获取知识条目原文信息 ────────────────────────────
  ctx.tools.register({
    name: 'ima_read',
    description:
      '按 media_id 读取 IMA 知识条目原文（Markdown/纯文本/笔记会直接返回正文内容，网页返回访问 URL）。注意：folder_ 开头的文件夹请用 ima_browse 展开，勿传给本工具。需要本机已配置 IMA 凭证。',
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
          return `media_id "${mediaId}" 是文件夹，不能用 ima_read 读取。请调用 ima_browse 并传入 folder_id="${mediaId}"（同时传 knowledge_base_id）展开查看该文件夹内的文档。`
        }
        if (!loadCredentials()) return CREDENTIALS_HELP
        const data = await imaCall('openapi/wiki/v1/get_media_info', { media_id: mediaId })
        if (data.media_type === 99) {
          return `media_id "${mediaId}" 是文件夹（media_type=99），请调用 ima_browse 并传入 folder_id="${mediaId}" 展开查看内部文档。`
        }

        // 1) IMA 笔记类型（media_type=11）：直接调 get_doc_content 拉取纯文本正文
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
            // 笔记接口无权限或失败时回退展示原始 media_info
          }
        }

        // 2) Markdown / 纯文本（media_type=7 或 13）：直接携带签名 headers 拉取正文返回，省去二次抓取
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
            // 直拉失败时回退展示 url_info
          }
        }

        // 3) 二进制 Office/PDF 文件（media_type=1/3/4/5）：提醒勿用网页抓取工具硬抓二进制乱码
        if ([1, 3, 4, 5].includes(data.media_type)) {
          return [
            `media_id: ${mediaId} 的文件信息（media_type=${data.media_type}，二进制文档）：`,
            JSON.stringify(data, null, 2).slice(0, 4000),
            '注意：该条目为 PDF/Word/PPT/Excel 二进制文件，请勿直接用网页抓取工具读取 URL（会产生二进制乱码撑爆上下文）；请优先读取同目录下的 Markdown (.md) 指南文档，或将该下载信息告知用户。',
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

  // ── 工具 5：确定性税额试算 ──────────────────────────────────
  ctx.tools.register({
    name: 'fintax_calc',
    description:
      '确定性税额试算（不依赖 LLM 算术），5 个场景：cross_border_import 跨境电商零售进口综合税（限额内70%口径+超限预警）；vat 增值税价税分离；annual_bonus_iit 年终奖单独计税个税（含临界点陷阱预警）；export_rebate 外贸企业出口退税免退税（孰低规则+征退税率差转成本）；cbec_assessed_cit 综试区零售出口核定征收企业所得税（4%所得率+小微叠加+9810口径预警）。政策参数可显式覆盖；先用知识库/权威来源核对现行参数。结果附政策文号引证，仅为试算不构成申报依据。',
    parameters: {
      scenario: {
        type: 'string',
        required: true,
        description: 'cross_border_import | vat | annual_bonus_iit | export_rebate | cbec_assessed_cit',
      },
      params: {
        type: 'object',
        required: true,
        description:
          'cross_border_import: {price, vatRate=0.13, consumptionTaxRate=0, discount=0.7, singleLimit=5000, annualLimit=26000, annualUsed=0}；vat: {amount, rate=0.13, inclusive=true}；annual_bonus_iit: {bonus}；export_rebate: {purchaseAmount 专票不含税金额, vatRate=0.13 发票税率, rebateRate 缺省=vatRate 须按商品代码核对}；cbec_assessed_cit: {revenue, taxableIncomeRate=0.04, citRate=0.25, smallLowProfit=false}。税率均传 0~1 小数。',
      },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const rawParams = args?.params && typeof args.params === 'object' ? args.params : (args ?? {})
        const r = calculate(args?.scenario, rawParams)
        const amount = r.taxPayable ?? r.taxAmount ?? r.taxRefund
        const effRate = r.effectiveRate ?? r.effectiveRateOnRevenue
        const overLimitNote = r.withinLimit === false ? '（注意：本单已超限，不适用限额内优惠口径，此数字仅作限额内算术对照）' : ''
        const lines = [
          `【${r.scenario}】`,
          ...r.steps.map((s) => `· ${s}`),
          `结果：${r.taxRefund != null ? '应退税额' : '应纳税额'} ${amount} 元${effRate ? `（实际税负率 ${effRate}）` : ''}${r.afterTax != null ? `，税后 ${r.afterTax} 元` : ''}${overLimitNote}`,
        ]
        if (r.withinLimit === false) lines.push('⚠ 超限：见下方警告。')
        if (r.warnings?.length) lines.push(...r.warnings.map((w) => `⚠ ${w}`))
        if (r.policyRefs?.length) {
          lines.push('政策依据（引用前请核对现行有效性）：')
          lines.push(...r.policyRefs.map((p) => `· ${p.ref}：${p.note}`))
        }
        lines.push('声明：本结果基于传入参数与默认政策口径的算术试算，政策参数须经权威来源核对；正式申报以主管税务机关口径为准。')
        return lines.join('\n')
      })
    },
  })

  // ── 随包技能：skills/*/SKILL.md → ctx.skills.register ───────
  const skillsDir = join(PKG_DIR, 'skills')
  let entries = []
  try {
    entries = readdirSync(skillsDir)
  } catch {
    ctx.logger?.warn?.('[fintax] skills 目录缺失，跳过技能注册')
    return
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
  console.log('[fintax] 财税工作台已加载：5 个工具 + 随包技能')
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