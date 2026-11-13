// 跨境电商平台原始结算账单确定性初筛体检与异常雷达（纯 Node.js 零第三方依赖）。
// 支持平台：
//   1. Amazon Seller Central（Date Range Reports CSV 多语种表头自动跳行 / All Statements Flat File V2 TSV）
//   2. TikTok Shop Seller Center（Statements / Order details CSV 或多工作表 XLSX）
//   3. Stripe / 独立站网关（balance_transactions CSV / XLSX，支持多币种自动拆表）
//
// 算术精度：全部采用 BigInt 定点数（1e-4 内部精度 + ROUND_HALF_UP 精确到 0.01 分），零浮点误差。
// 商业边界：本模块仅输出单文件四层口径初筛体检摘要与 P0/P1/P2 风险异常雷达；
//           不包含多表联动正式关账母表 (.xlsx)、三方收款池跨期台账或标准借贷会计分录。

import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { inflateRawSync } from 'node:zlib'

// 内部定点精度：1 单位 = 0.0001（万分之一元），汇总展示时按 ROUND_HALF_UP 量化到 0.01（分）
const SCALE = 10000n
const CENT_STEP = 100n // 100 * 0.0001 = 0.01

const SITE_TO_CURRENCY = {
  US: 'USD', CA: 'CAD', MX: 'MXN', UK: 'GBP', GB: 'GBP',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', EU: 'EUR',
  JP: 'JPY', SG: 'SGD', CN: 'RMB',
}

const CURRENCY_TO_SITE = {
  USD: 'US', EUR: 'EU', GBP: 'UK', JPY: 'JP', RMB: 'CN', CAD: 'CA', AUD: 'AU', SGD: 'SG',
}

/**
 * 将任意金额单元格解析为 SCALE=10000n 的 BigInt 定点数。
 * 兼容：美式 '1,234.56' / '-$45.20'、会计括号 '(1,234.56)'、欧式 '1.234,56' / '-45,20 €'。
 */
export function parseAmount(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return 0n
  if (typeof raw === 'bigint') return raw
  let s = String(raw).trim()
  if (!s || ['-', '--', '—', 'N/A', 'n/a', 'null', 'None', 'nan'].includes(s)) return 0n

  let neg = false
  if (s.startsWith('(') && s.endsWith(')')) {
    neg = true
    s = s.slice(1, -1).trim()
  }
  s = s.replace(/[A-Za-z$€£¥￥\s\u00a0]/g, '')
  if (!s || s === '-' || s === '+') return 0n
  if (s.startsWith('-')) {
    neg = !neg
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }

  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.')
    } else {
      s = s.replace(/,/g, '')
    }
  } else if (s.includes(',')) {
    const parts = s.split(',')
    if (parts.length === 2 && (parts[1].length === 1 || parts[1].length === 2)) {
      s = s.replace(',', '.')
    } else {
      s = s.replace(/,/g, '')
    }
  }

  // 处理科学计数法（如 XLSX 极小数值 0E-8）
  if (/e/i.test(s)) {
    const num = Number(s)
    if (!Number.isFinite(num)) return 0n
    s = num.toFixed(6)
  }

  const m = s.match(/^(\d+)(?:\.(\d+))?$/)
  if (!m) return 0n
  const intPart = BigInt(m[1])
  const fracRaw = (m[2] || '').padEnd(5, '0')
  const frac4 = BigInt(fracRaw.slice(0, 4))
  const fifth = Number(fracRaw[4] || '0')
  let val = intPart * SCALE + frac4 + (fifth >= 5 ? 1n : 0n)
  return neg ? -val : val
}

const absBig = (v) => (v < 0n ? -v : v)

/** ROUND_HALF_UP 量化到 0.01（返回对齐到 CENT_STEP 的 BigInt）。 */
export function q2(val) {
  const neg = val < 0n
  const a = neg ? -val : val
  const q = (a + 50n) / CENT_STEP
  const res = q * CENT_STEP
  return neg ? -res : res
}

/** 格式化定点数为 '1234.56' 字符串。 */
export function fmtAmount(val) {
  const rounded = q2(val)
  const neg = rounded < 0n
  const cents = (neg ? -rounded : rounded) / CENT_STEP
  const intPart = cents / 100n
  const fracPart = String(cents % 100n).padStart(2, '0')
  return `${neg ? '-' : ''}${intPart}.${fracPart}`
}

/** 转为标准 Number（精确到分，供联动传给 platformTaxReconcile）。 */
export function toNumber2(val) {
  return Number(fmtAmount(val))
}

function normHeader(text) {
  if (text == null) return ''
  return String(text)
    .trim()
    .replace(/^\ufeff/, '')
    .toLowerCase()
    .replace(/[\s_\-/\\（）()[\]【】:：.]+/g, ' ')
    .trim()
}

// ── 零依赖轻量 XLSX（ZIP + OpenXML）只读表提取器 ─────────────
function decodeXmlEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** 提取 OpenXML <si> 或 inlineStr 中的文本节点，剔除 <rPh> 注音引导干扰。 */
function extractXmlText(xml) {
  const cleaned = xml.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '')
  const parts = []
  for (const tm of cleaned.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
    parts.push(decodeXmlEntities(tm[1]))
  }
  return parts.join('')
}

function unzipEntries(buf) {
  let eocd = -1
  const minPos = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('无效的 XLSX 文件（未找到 ZIP 目录尾记录）')

  const totalEntries = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const files = new Map()
  let pos = cdOffset

  for (let idx = 0; idx < totalEntries && pos + 46 <= buf.length; idx++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break
    const method = buf.readUInt16LE(pos + 10)
    const compSize = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8')
    pos += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) continue
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const slice = buf.subarray(dataStart, dataStart + compSize)
    if (method === 0) {
      files.set(name, slice)
    } else if (method === 8) {
      files.set(name, inflateRawSync(slice))
    }
  }
  return files
}

function colLettersToIndex(cellRef) {
  const m = String(cellRef || '').match(/^([A-Za-z]+)/)
  if (!m) return -1
  let idx = 0
  const letters = m[1].toUpperCase()
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64)
  }
  return idx - 1
}

function readXlsxSheets(buf) {
  const files = unzipEntries(buf)
  const sharedStrings = []
  const sstBuf = files.get('xl/sharedStrings.xml')
  if (sstBuf) {
    const sstXml = sstBuf.toString('utf8')
    for (const siMatch of sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      sharedStrings.push(extractXmlText(siMatch[1]))
    }
  }

  // 解析工作表名称与路径映射
  const relMap = new Map()
  const relBuf = files.get('xl/_rels/workbook.xml.rels')
  if (relBuf) {
    const relXml = relBuf.toString('utf8')
    for (const rm of relXml.matchAll(/<Relationship\b([^>]+)\/>/g)) {
      const attrs = rm[1]
      const id = attrs.match(/\bId="([^"]+)"/)?.[1]
      const target = attrs.match(/\bTarget="([^"]+)"/)?.[1]
      if (id && target) {
        const clean = target.startsWith('/') ? target.slice(1) : target.startsWith('xl/') ? target : `xl/${target}`
        relMap.set(id, clean)
      }
    }
  }

  const sheetDefs = []
  const wbBuf = files.get('xl/workbook.xml')
  if (wbBuf) {
    const wbXml = wbBuf.toString('utf8')
    for (const sm of wbXml.matchAll(/<sheet\b([^>]+)\/?>/g)) {
      const attrs = sm[1]
      const name = decodeXmlEntities(attrs.match(/\bname="([^"]+)"/)?.[1] || 'Sheet')
      const rid = attrs.match(/\br:id="([^"]+)"/)?.[1]
      const path = (rid && relMap.get(rid)) || `xl/worksheets/sheet${sheetDefs.length + 1}.xml`
      sheetDefs.push({ name, path })
    }
  }
  if (!sheetDefs.length) {
    for (const k of files.keys()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(k)) sheetDefs.push({ name: basename(k, '.xml'), path: k })
    }
  }

  const out = []
  for (const def of sheetDefs) {
    const wsBuf = files.get(def.path)
    if (!wsBuf) continue
    const wsXml = wsBuf.toString('utf8')
    const rows = []
    for (const rowMatch of wsXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const rowXml = rowMatch[1]
      const rowArr = []
      let seqCol = 0
      for (const cMatch of rowXml.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cMatch[1] || ''
        const inner = cMatch[2] || ''
        const ref = attrs.match(/\br="([^"]+)"/)?.[1]
        const colIdx = ref ? colLettersToIndex(ref) : seqCol
        seqCol = colIdx + 1
        const cellType = attrs.match(/\bt="([^"]+)"/)?.[1] || ''

        let val = ''
        if (cellType === 'inlineStr') {
          val = extractXmlText(inner)
        } else {
          const vRaw = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1]
          if (vRaw !== undefined) {
            if (cellType === 's') {
              const sIdx = parseInt(vRaw.trim(), 10)
              val = sharedStrings[sIdx] ?? ''
            } else {
              val = decodeXmlEntities(vRaw.trim())
            }
          }
        }
        while (rowArr.length <= colIdx) rowArr.push('')
        rowArr[colIdx] = String(val).trim()
      }
      if (rowArr.some((c) => c !== '')) rows.push(rowArr)
    }
    if (rows.length) out.push([def.name, rows])
  }
  return out
}

// ── RFC-4180 CSV / TSV 多编码读取器 ──────────────────────────
function decodeTextBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), enc: 'utf-8-bom' }
  }
  for (const enc of ['utf-8', 'gb18030', 'windows-1252']) {
    try {
      const td = new TextDecoder(enc, { fatal: true })
      return { text: td.decode(buf), enc }
    } catch {
      // try next encoding
    }
  }
  return { text: buf.toString('latin1'), enc: 'latin1' }
}

function parseDelimited(text, delimiter) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field.trim())
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field.trim())
      field = ''
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim())
    if (row.some((c) => c !== '')) rows.push(row)
  }
  return rows
}

export function readTabularSheets(filePath) {
  const st = statSync(filePath)
  if (!st.isFile()) throw new Error(`路径不是普通文件：${filePath}`)
  if (st.size > 80 * 1024 * 1024) {
    throw new Error(`账单文件超过 80MB 上限（当前 ${(st.size / 1024 / 1024).toFixed(1)}MB），请按单月或单店铺拆分导出后再解析`)
  }
  const buf = readFileSync(filePath)
  const ext = extname(filePath).toLowerCase()
  if (ext === '.xlsx' || ext === '.xlsm' || (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50)) {
    return { sheets: readXlsxSheets(buf), formatInfo: 'xlsx' }
  }

  const { text, enc } = decodeTextBuffer(buf)
  const sampleLines = text
    .split(/\r?\n/)
    .slice(0, 35)
    .filter((ln) => ln.trim().length > 0)
  const countChar = (ch) => sampleLines.reduce((acc, ln) => acc + (ln.split(ch).length - 1), 0)
  const tabs = countChar('\t')
  const commas = countChar(',')
  const semis = countChar(';')

  let delimiter = ','
  if (ext === '.tsv' || (tabs > commas && tabs > semis && tabs >= 3)) delimiter = '\t'
  else if (semis > commas && semis >= 5) delimiter = ';'

  const rows = parseDelimited(text, delimiter)
  return {
    sheets: [[basename(filePath, ext), rows]],
    formatInfo: `${enc} (delim=${delimiter === '\t' ? 'TAB' : delimiter})`,
  }
}

function findHeaderRow(rows, aliasGroups, minMatched = 3, maxScanRows = 45) {
  const normAliases = Object.fromEntries(
    Object.entries(aliasGroups).map(([canon, list]) => [canon, list.map(normHeader)]),
  )
  let bestIdx = null
  let bestMap = {}
  const limit = Math.min(rows.length, maxScanRows)

  for (let rIdx = 0; rIdx < limit; rIdx++) {
    const normCells = rows[rIdx].map(normHeader)
    const colMap = {}
    const usedCols = new Set()

    for (const [canon, aliases] of Object.entries(normAliases)) {
      for (let cIdx = 0; cIdx < normCells.length; cIdx++) {
        if (normCells[cIdx] && aliases.includes(normCells[cIdx])) {
          colMap[canon] = cIdx
          usedCols.add(cIdx)
          break
        }
      }
    }
    for (const [canon, aliases] of Object.entries(normAliases)) {
      if (canon in colMap) continue
      for (let cIdx = 0; cIdx < normCells.length; cIdx++) {
        if (!normCells[cIdx] || usedCols.has(cIdx)) continue
        if (aliases.some((al) => al.length >= 5 && normCells[cIdx].includes(al))) {
          colMap[canon] = cIdx
          usedCols.add(cIdx)
          break
        }
      }
    }
    if (Object.keys(colMap).length >= minMatched && Object.keys(colMap).length > Object.keys(bestMap).length) {
      bestIdx = rIdx
      bestMap = colMap
    }
  }
  return bestIdx === null ? null : [bestIdx, bestMap]
}

function inferPeriod(dates, fallback = '待确认期间') {
  const counts = new Map()
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }
  const bump = (ym) => counts.set(ym, (counts.get(ym) || 0) + 1)

  for (const raw of dates) {
    if (!raw) continue
    const s = String(raw).trim()
    let m = s.match(/(20\d{2})[-/.](\d{1,2})/)
    if (m) {
      bump(`${m[1]}-${String(Number(m[2])).padStart(2, '0')}`)
      continue
    }
    m = s.match(/([A-Za-z]{3})[a-z]*[\s,.-]+\d{1,2}[\s,.-]+(20\d{2})/)
    if (m && months[m[1].toLowerCase()]) {
      bump(`${m[2]}-${months[m[1].toLowerCase()]}`)
      continue
    }
    m = s.match(/\d{1,2}[\s,.-]+([A-Za-z]{3})[a-z]*[\s,.-]+(20\d{2})/)
    if (m && months[m[1].toLowerCase()]) {
      bump(`${m[2]}-${months[m[1].toLowerCase()]}`)
      continue
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})/)
    if (m) bump(`${m[3]}-${String(Number(m[1])).padStart(2, '0')}`)
  }
  if (!counts.size) return fallback
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

const cell = (row, idx) => (idx == null || idx >= row.length ? '' : String(row[idx] ?? '').trim())

function makeEmptySummary({ period, platform, site, currency, formatLabel, fileName }) {
  return {
    period,
    platform,
    site,
    currency,
    formatLabel,
    fileName,
    rawRowCount: 0,
    grossSales: 0n,
    sellerDiscount: 0n,
    platformSubsidy: 0n,
    customerRefund: 0n,
    platformCommission: 0n,
    affiliateCommission: 0n,
    logisticsWarehousing: 0n,
    inPlatformAds: 0n,
    gatewayDisputeFee: 0n,
    selfRemitTaxNet: 0n,
    reserveNetChange: 0n,
    actualPayout: 0n,
    facilitatorTaxStripped: 0n,
    uncapturedVoidExcluded: 0n,
    freeSampleCount: 0,
    horizontalDiffTotal: 0n,
    anomalies: [],
  }
}

function finalizeSummary(s) {
  const k = [
    'grossSales', 'sellerDiscount', 'platformSubsidy', 'customerRefund',
    'platformCommission', 'affiliateCommission', 'logisticsWarehousing',
    'inPlatformAds', 'gatewayDisputeFee', 'selfRemitTaxNet',
    'reserveNetChange', 'actualPayout', 'facilitatorTaxStripped',
    'uncapturedVoidExcluded', 'horizontalDiffTotal',
  ]
  for (const key of k) s[key] = q2(s[key])
  const netRev = s.grossSales - s.sellerDiscount + s.platformSubsidy - s.customerRefund
  const totalFees =
    s.platformCommission + s.affiliateCommission + s.logisticsWarehousing + s.inPlatformAds + s.gatewayDisputeFee
  s.totalFees = q2(totalFees)
  // 对齐国家税务总局 2025 年第 15 号公告的平台报送收入总额参考口径（商品含运费总额 - 商家自身折扣，不含代扣流转税，不扣佣金与补贴）
  s.taxReportingGrossRef = q2(s.grossSales - s.sellerDiscount)
  s.theoreticalPayout = q2(netRev - totalFees + s.selfRemitTaxNet - s.reserveNetChange)
  s.statementPayoutDiff = q2(s.actualPayout - s.theoreticalPayout)
  return s
}

// ── 1. Amazon 解析器（Date Range CSV + Flat File V2） ────────
const AMAZON_DR_ALIASES = {
  date_time: ['date/time', 'date time', '日期/时间', 'datum/uhrzeit', '日付/時間'],
  settlement_id: ['settlement id', '结算编号', 'abrechnungsnummer', '決済番号'],
  type: ['type', '类型', 'typ', 'トランザクションの種類'],
  order_id: ['order id', '订单编号', 'bestellnummer', '注文番号'],
  description: ['description', '说明', '描述', 'beschreibung', '説明'],
  marketplace: ['marketplace', '商城', '销售渠道', 'マーケットプレイス'],
  product_sales: ['product sales', '商品价格', '产品销售额', 'umsätze', '商品の売上'],
  product_sales_tax: ['product sales tax', '商品税', 'produktumsatzsteuer', '商品の売上税'],
  shipping_credits: ['shipping credits', '运费', '配送信用额', 'gutschrift für versandkosten', '配送料'],
  shipping_credits_tax: ['shipping credits tax', '运费税', 'steuer auf versandgutschrift', '配送料の税金'],
  gift_wrap_credits: ['gift wrap credits', '礼品包装', '礼品包装返点', 'gutschrift für geschenkverpackung', 'ギフト包装手数料'],
  giftwrap_credits_tax: ['giftwrap credits tax', 'gift wrap credits tax', '礼品包装税', 'ギフト包装クレジットの税金'],
  regulatory_fee: ['regulatory fee', '监管费', '监管费用'],
  tax_on_regulatory_fee: ['tax on regulatory fee', '监管费税'],
  promotional_rebates: ['promotional rebates', '促销返点', 'rabatte aus werbeaktionen', 'プロモーション割引'],
  promotional_rebates_tax: ['promotional rebates tax', '促销返点税', 'プロモーション割引の税金'],
  marketplace_withheld_tax: ['marketplace withheld tax', '商城预扣税', '市场预扣税', 'einbehaltene steuer auf marktplatz', 'マーケットプレイス源泉徴収税'],
  selling_fees: ['selling fees', '销售费用', 'verkaufsgebühren', '手数料'],
  fba_fees: ['fba fees', '亚马逊物流基础服务费', 'fba 费用', 'gebühren zu versand durch amazon', 'fba 手数料'],
  other_transaction_fees: ['other transaction fees', '其他交易费用', 'andere transaktionsgebühren', 'トランザクションに関するその他の手数料'],
  other: ['other', '其他', 'andere', 'その他'],
  total: ['total', '总计', 'gesamt', '合計'],
}

const AMAZON_V2_ALIASES = {
  settlement_id: ['settlement id', 'settlement-id'],
  settlement_end_date: ['settlement end date', 'settlement-end-date'],
  total_amount: ['total amount', 'total-amount'],
  currency: ['currency'],
  transaction_type: ['transaction type', 'transaction-type'],
  order_id: ['order id', 'order-id'],
  marketplace_name: ['marketplace name', 'marketplace-name'],
  amount_type: ['amount type', 'amount-type'],
  amount_description: ['amount description', 'amount-description'],
  amount: ['amount'],
  posted_date: ['posted date', 'posted-date', 'posted-date-time'],
}

function inferAmazonSiteAndCcy(mps, preambleLines) {
  const blob = preambleLines.join('\n')
  const mCcy = blob.match(/\b(USD|EUR|GBP|JPY|CAD|AUD|MXN|SGD|RMB|CNY)\b/i)
  let ccy = mCcy ? mCcy[1].toUpperCase() : ''
  if (ccy === 'CNY') ccy = 'RMB'

  const mpCount = new Map()
  for (const mp of mps) {
    if (mp) mpCount.set(mp.toLowerCase(), (mpCount.get(mp.toLowerCase()) || 0) + 1)
  }
  const topMp = mpCount.size ? [...mpCount.entries()].sort((a, b) => b[1] - a[1])[0][0] : ''
  let site = 'US'
  if (topMp.includes('co.uk') || topMp === 'uk') site = 'UK'
  else if (topMp.includes('.de')) site = 'DE'
  else if (['.fr', '.it', '.es', '.nl', '.eu'].some((x) => topMp.includes(x))) site = 'EU'
  else if (topMp.includes('co.jp') || topMp.includes('jp')) site = 'JP'
  else if (topMp.includes('.ca')) site = 'CA'
  else if (topMp.includes('.mx')) site = 'MX'

  return { site, currency: ccy || SITE_TO_CURRENCY[site] || 'USD' }
}

function parseAmazonV2(fileName, rows, hdrIdx, colMap, formatInfo) {
  const dataRows = rows.slice(hdrIdx + 1)
  const dates = dataRows.map((r) => cell(r, colMap.posted_date) || cell(r, colMap.settlement_end_date)).filter(Boolean)
  const mps = dataRows.map((r) => cell(r, colMap.marketplace_name)).filter(Boolean)
  const ccys = dataRows.map((r) => cell(r, colMap.currency).toUpperCase()).filter(Boolean)
  const { site, currency: infCcy } = inferAmazonSiteAndCcy(mps, [])
  const currency = ccys.length ? (ccys[0] === 'CNY' ? 'RMB' : ccys[0]) : infCcy
  const s = makeEmptySummary({
    period: inferPeriod(dates),
    platform: 'Amazon',
    site,
    currency,
    formatLabel: `Amazon Flat File V2 (${formatInfo})`,
    fileName,
  })

  let reimbNet = 0n
  let taxCollectedTotal = 0n
  let withheldTotal = 0n

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    const txType = cell(r, colMap.transaction_type)
    const amtType = cell(r, colMap.amount_type)
    const amtDesc = cell(r, colMap.amount_description)
    const totRaw = cell(r, colMap.total_amount)
    const amt = parseAmount(cell(r, colMap.amount))
    const orderId = cell(r, colMap.order_id) || `Row-${hdrIdx + 2 + i}`

    if (!txType && !amtType && totRaw !== '') {
      s.actualPayout += parseAmount(totRaw)
      continue
    }
    s.rawRowCount++
    const tl = txType.toLowerCase()
    const atl = amtType.toLowerCase()
    const adl = amtDesc.toLowerCase()

    if (atl.includes('previous reserve') || adl.includes('previous reserve') || adl.includes('reserve release')) {
      s.reserveNetChange += -amt
      continue
    }
    if (atl.includes('current reserve') || adl.includes('current reserve') || adl.includes('account level reserve')) {
      s.reserveNetChange += -amt
      continue
    }
    if (atl.replace(/\s+/g, '').includes('withheldtax') || adl.replace(/\s+/g, '').includes('marketplacefacilitator')) {
      withheldTotal += amt
      s.facilitatorTaxStripped += absBig(amt)
      continue
    }
    if (['tax', 'shippingtax', 'giftwraptax', 'promotiontax'].includes(adl) || adl.endsWith('tax')) {
      taxCollectedTotal += amt
      continue
    }
    if (atl.includes('advertising') || adl.includes('advertising')) {
      s.inPlatformAds += -amt
      continue
    }
    if (atl.includes('reimbursement') || tl.includes('reimbursement')) {
      reimbNet += amt
      s.anomalies.push({
        severity: 'P2-关注',
        category: 'FBA库存/履约赔付',
        refId: orderId,
        amount: fmtAmount(amt),
        detail: `${txType || amtType}: ${amtDesc}（需区分销售补贴与非销售仓储理赔）`,
      })
      continue
    }

    const isRefund = ['refund', 'chargeback', 'guarantee', 'a-to-z', 'retrocharge'].some((k) => tl.includes(k))
    if (['chargeback', 'guarantee', 'a-to-z'].some((k) => tl.includes(k))) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'A-to-z索赔/信用卡拒付',
        refId: orderId,
        amount: fmtAmount(amt),
        detail: `${txType} - ${amtDesc}（争议费应计财务费用，勿直接冲减收入）`,
      })
    }

    if (atl.includes('itemprice')) {
      if (isRefund) s.customerRefund += -amt
      else s.grossSales += amt
    } else if (atl.includes('promotion')) {
      if (isRefund) s.customerRefund += -amt
      else s.sellerDiscount += -amt
    } else if (['fba', 'fulfillment', 'storage', 'inbound', 'removal'].some((k) => adl.includes(k))) {
      s.logisticsWarehousing += -amt
    } else if (adl.includes('chargeback') && adl.includes('fee')) {
      s.gatewayDisputeFee += -amt
    } else {
      s.platformCommission += -amt
    }
  }

  const taxNet = taxCollectedTotal + withheldTotal
  if (absBig(taxNet) >= CENT_STEP) {
    s.selfRemitTaxNet += taxNet
    s.anomalies.push({
      severity: 'P1-高危',
      category: '非代扣待自申报境外流转税',
      refId: 'TAX-NET-V2',
      amount: fmtAmount(taxNet),
      detail: '买方税额与商城代扣税未完全抵销（随结算款拨付卖家，须计入其他应付款严禁混入营业收入）',
    })
  }
  if (reimbNet >= 0n) s.platformSubsidy += reimbNet
  else s.logisticsWarehousing += -reimbNet

  return [finalizeSummary(s)]
}

function parseAmazonDateRange(fileName, rows, hdrIdx, colMap, formatInfo) {
  const preamble = rows.slice(0, hdrIdx).map((r) => r.join(' '))
  const dataRows = rows.slice(hdrIdx + 1)
  const dates = dataRows.map((r) => cell(r, colMap.date_time)).filter(Boolean)
  const mps = dataRows.map((r) => cell(r, colMap.marketplace)).filter(Boolean)
  const { site, currency } = inferAmazonSiteAndCcy(mps, preamble)

  const s = makeEmptySummary({
    period: inferPeriod(dates),
    platform: 'Amazon',
    site,
    currency,
    formatLabel: `Amazon Date Range CSV (${formatInfo}，自动跳过表头前说明 ${hdrIdx} 行)`,
    fileName,
  })

  const compKeys = [
    'product_sales', 'product_sales_tax', 'shipping_credits', 'shipping_credits_tax',
    'gift_wrap_credits', 'giftwrap_credits_tax', 'regulatory_fee', 'tax_on_regulatory_fee',
    'promotional_rebates', 'promotional_rebates_tax', 'marketplace_withheld_tax',
    'selling_fees', 'fba_fees', 'other_transaction_fees', 'other',
  ]
  const presentKeys = compKeys.filter((k) => k in colMap)
  let reimbNet = 0n

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    const rawType = cell(r, colMap.type)
    const desc = cell(r, colMap.description)
    const orderId = cell(r, colMap.order_id) || cell(r, colMap.settlement_id) || `Row-${hdrIdx + 2 + i}`
    const total = parseAmount(cell(r, colMap.total))
    if (!rawType && !desc && total === 0n) continue

    s.rawRowCount++
    const tl = rawType.toLowerCase()
    const dl = desc.toLowerCase()

    const cv = Object.fromEntries(compKeys.map((k) => [k, k in colMap ? parseAmount(cell(r, colMap[k])) : 0n]))
    if (presentKeys.length > 0) {
      const horizSum = presentKeys.reduce((acc, k) => acc + cv[k], 0n)
      const horizDiff = q2(total - horizSum)
      if (absBig(horizDiff) >= CENT_STEP) {
        s.horizontalDiffTotal += horizDiff
        s.anomalies.push({
          severity: 'P0-阻断',
          category: '行内水平勾稽不守恒',
          refId: orderId,
          amount: fmtAmount(horizDiff),
          detail: `第 ${hdrIdx + 2 + i} 行 (${rawType}) 分项合计 (${fmtAmount(horizSum)}) 与 total 列 (${fmtAmount(total)}) 不等，疑似导出截断或手工改动`,
        })
      }
    }

    if (['transfer', 'disbursement', '转账', 'übertrag', '振込'].includes(tl) || dl.includes('to ending balance')) {
      s.actualPayout += total < 0n ? -total : total
      continue
    }

    if (
      ['debt', 'reserve', 'carryover', 'unavailable balance', '预留金额'].includes(tl) ||
      ['account level reserve', 'current reserve', 'previous reserve', 'reserve amount', 'unavailable balance', '预留金额', '储备金'].some((w) => dl.includes(w))
    ) {
      s.reserveNetChange += -total
      continue
    }

    const taxCollected =
      cv.product_sales_tax + cv.shipping_credits_tax + cv.giftwrap_credits_tax + cv.promotional_rebates_tax + cv.tax_on_regulatory_fee
    const withheldTax = cv.marketplace_withheld_tax
    const taxNet = taxCollected + withheldTax
    if (withheldTax !== 0n) s.facilitatorTaxStripped += absBig(withheldTax)
    if (absBig(taxNet) >= CENT_STEP) s.selfRemitTaxNet += taxNet

    if (['service fee', '服务费', 'servicegebühr'].includes(tl) || dl.includes('cost of advertising') || dl.includes('广告')) {
      if (dl.includes('advertising') || dl.includes('广告') || dl.includes('sponsored')) {
        s.inPlatformAds += -total + taxNet
      } else {
        s.platformCommission += -total + taxNet
      }
      continue
    }

    if (
      tl.includes('inventory fee') ||
      tl.includes('shipping services') ||
      ['亚马逊库存费用', '配送服务', 'fba inventory fee', 'fba customer return fee'].includes(tl)
    ) {
      s.logisticsWarehousing += -total + taxNet
      continue
    }

    if (
      ['adjustment', 'fba inventory reimbursement', 'safe-t reimbursement', '赔偿', '调整', 'liquidations'].includes(tl) ||
      tl.includes('reimbursement') ||
      dl.includes('reimbursement')
    ) {
      const netAdj = total - taxNet
      reimbNet += netAdj
      s.anomalies.push({
        severity: 'P2-关注',
        category: 'FBA库存赔偿/调账',
        refId: orderId,
        amount: fmtAmount(netAdj),
        detail: `${rawType}: ${desc || '平台库存赔偿/调账'}（需区分销售补贴与非销售理赔）`,
      })
      continue
    }

    const isClaimOrCb = ['chargeback', 'a-to-z', 'guarantee claim', '索赔', '拒付', 'retrocharge'].some((k) => tl.includes(k))
    const isRefund = isClaimOrCb || ['refund', '退款', 'erstattung', '返金'].some((k) => tl.includes(k))
    const isOrder = ['order', '订单', 'bestellung', '注文'].some((k) => tl.includes(k))

    if (!isOrder && !isRefund) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: '未识别交易类型',
        refId: orderId,
        amount: fmtAmount(total),
        detail: `发现非常规交易类型 type='${rawType}', desc='${desc}'`,
      })
      const netExTax = total - taxNet
      if (netExTax < 0n) s.platformCommission += -netExTax
      else reimbNet += netExTax
      continue
    }

    if (isClaimOrCb) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'A-to-z索赔/拒付/Retrocharge',
        refId: orderId,
        amount: fmtAmount(total),
        detail: `${rawType} (${desc}) — 核查货物退回状态与拒付争议裁决`,
      })
    }

    const grossItems = cv.product_sales + cv.shipping_credits + cv.gift_wrap_credits
    const promo = cv.promotional_rebates
    const sellFee = cv.selling_fees + cv.regulatory_fee
    const fbaFee = cv.fba_fees
    const otherTxFee = cv.other_transaction_fees
    const otherCol = cv.other

    if (isOrder) {
      s.grossSales += grossItems
      s.sellerDiscount += -promo
      s.platformCommission += -sellFee
      s.logisticsWarehousing += -fbaFee
      if (dl.includes('advertising') || dl.includes('广告')) s.inPlatformAds += -otherTxFee
      else if (dl.includes('chargeback') || dl.includes('dispute')) s.gatewayDisputeFee += -otherTxFee
      else s.platformCommission += -otherTxFee

      if (otherCol > 0n) reimbNet += otherCol
      else if (otherCol < 0n) s.platformCommission += -otherCol
    } else {
      let refundPrincipal = -(grossItems + promo)
      if (otherCol < 0n && !dl.includes('fee')) refundPrincipal += -otherCol
      else if (otherCol > 0n && dl.includes('restock')) refundPrincipal += -otherCol
      else if (otherCol !== 0n) {
        if (isClaimOrCb) s.gatewayDisputeFee += -otherCol
        else s.platformCommission += -otherCol
      }
      s.customerRefund += refundPrincipal
      s.platformCommission += -sellFee
      s.logisticsWarehousing += -fbaFee
      if (isClaimOrCb && otherTxFee < 0n) s.gatewayDisputeFee += -otherTxFee
      else s.platformCommission += -otherTxFee
    }
  }

  if (reimbNet >= 0n) s.platformSubsidy += reimbNet
  else s.logisticsWarehousing += -reimbNet

  if (absBig(s.selfRemitTaxNet) >= CENT_STEP) {
    s.anomalies.push({
      severity: 'P1-高危',
      category: '非代扣待自申报境外流转税',
      refId: 'AMZ-TAX-SELF',
      amount: fmtAmount(s.selfRemitTaxNet),
      detail: '部分站点买方税未被商城全额代扣（如欧洲未代扣B2B或特殊州税），严禁混入营业收入',
    })
  }

  return [finalizeSummary(s)]
}

// ── 2. TikTok Shop 解析器（Statements / Order details XLSX + CSV） ──
const TIKTOK_DETAIL_ALIASES = {
  statement_id: ['statement id', '账单编号', '结算单号'],
  statement_date: ['statement date', 'settlement date', 'order settled time', '结算日期', '账单日期'],
  tx_type: ['type', 'transaction type', '交易类型', '账单类型', '费用类型'],
  order_id: ['order/adjustment id', 'order adjustment id', 'order id', 'related order id', '订单/调整编号', '关联订单号', '订单编号'],
  shop_mode: ['shop mode', 'business model', '经营模式', '店铺模式', '履约模式'],
  region: ['region', 'marketplace', 'country', '站点', '国家/地区'],
  currency: ['currency', 'settlement currency', '币种', '结算币种'],
  gross_sales: ['gross sales', 'sku subtotal before discount', 'subtotal before discounts', '商品原价', '折扣前商品小计', '商品原价总额'],
  customer_shipping: ['customer shipping fee', 'buyer paid shipping fee', 'customer paid shipping fee before discounts', '买家支付运费', '买家实付运费'],
  seller_discount: ['seller discount', 'seller discounts', 'sku seller discount', 'seller funded discount', '商家折扣', '商家承担折扣', '卖家折扣'],
  seller_shipping_discount: ['seller shipping fee discount', '商家运费折扣', '卖家运费优惠'],
  platform_discount: ['platform discount', 'tiktok shop discount', 'sku platform discount', 'co funded discount platform', '平台补贴', '平台承担折扣', '平台优惠券'],
  platform_shipping_subsidy: ['platform shipping fee subsidy', 'shipping fee subsidy', 'tiktok shop shipping subsidy', '平台运费补贴', '运费补贴'],
  refund_subtotal: ['refund subtotal before seller discounts', 'gross sales refund', 'customer refund', 'refund amount', '退款商品原价', '客户退款', '退款本金'],
  seller_discount_refund: ['seller discount refund', 'refund of seller discounts', '商家折扣退回', '退回商家折扣'],
  platform_discount_refund: ['platform discount refund', 'refund of platform discounts', '平台补贴扣回', '退回平台补贴'],
  refund_shipping: ['refund customer shipping fee', 'customer shipping fee refund', '退还买家运费'],
  commission_fee: ['tiktok shop commission fee', 'referral fee', 'commission fee', '平台佣金', '技术服务费'],
  transaction_fee: ['transaction fee', 'payment processing fee', 'settlement fee', '交易手续费', '结算手续费'],
  chargeback_fee: ['chargeback fee', 'dispute fee', 'payment gateway fee', '拒付手续费', '争议费', '支付通道费'],
  affiliate_commission: ['affiliate commission', 'creator commission', '达人佣金', '联盟达人佣金'],
  affiliate_partner_commission: ['affiliate partner commission', 'tap commission', 'mcn commission', 'affiliate shop ads commission', '团长佣金', '达人合作佣金', '达人广告佣金'],
  shipping_fee: ['shipping fee', 'actual shipping fee', 'fbt fulfillment fee', 'fbt storage fee', 'fbt warehouse service fee', 'return shipping fee', '商家承担运费', '尾程物流费', 'fbt履约费', '物流及仓储扣费'],
  ads_fee: ['shop ads fee', 'gmv max', 'ads payment', 'tapas fee', '站内广告费', '广告扣费'],
  tax_collected: ['sales tax', 'tax collected', 'vat collected', 'customer tax', '代收税费', '买家税费'],
  tax_withheld: ['sales tax withheld', 'tax withheld', 'marketplace facilitator tax', 'vat withheld', '平台代扣税费', '代扣代缴流转税'],
  adjustment_amount: ['adjustment amount', 'other adjustment', '调账金额', '其他调整'],
  reserve_amount: ['reserve amount', 'reserve change', 'earnest money', '储备金变动', '保证金净变动'],
  payout_amount: ['payout amount', 'bank transfer', 'paid amount', '实际放款', '打款金额'],
  settlement_amount: ['total settlement amount', 'settlement amount', 'net amount', 'total amount', '应结算金额', '结算净额'],
  remark: ['remark', 'note', 'adjustment reason', '备注', '说明', '调账原因'],
}

const TIKTOK_SUMMARY_ALIASES = {
  statement_id: ['statement id', '账单编号', '结算单号'],
  reserve_held: ['reserve held', 'reserve hold', '新增冻结储备金', '本期冻结储备金'],
  reserve_released: ['reserve released', 'reserve release', '释放前期储备金', '上期储备金释放'],
  payout_amount: ['payout amount', 'paid amount', '实际打款金额', '实际payout', '放款金额'],
}

function parseTikTokSheets(fileName, sheets, formatInfo) {
  let detailSheet = null
  const payoutSheets = []

  for (const [sName, rows] of sheets) {
    const dm = findHeaderRow(rows, TIKTOK_DETAIL_ALIASES, 5)
    if (dm && ('gross_sales' in dm[1] || 'affiliate_commission' in dm[1])) {
      if (!detailSheet || Object.keys(dm[1]).length > Object.keys(detailSheet[3]).length) {
        detailSheet = [sName, rows, dm[0], dm[1]]
        continue
      }
    }
    const pm = findHeaderRow(rows, TIKTOK_SUMMARY_ALIASES, 3)
    if (pm && 'payout_amount' in pm[1]) {
      payoutSheets.push([sName, rows, pm[0], pm[1]])
    }
  }
  if (!detailSheet) return null

  const [sName, rows, hdrIdx, colMap] = detailSheet
  const dataRows = rows.slice(hdrIdx + 1)
  const dates = dataRows.map((r) => cell(r, colMap.statement_date)).filter(Boolean)
  const ccys = dataRows.map((r) => cell(r, colMap.currency).toUpperCase()).filter(Boolean)
  const regions = dataRows.map((r) => cell(r, colMap.region).toUpperCase()).filter(Boolean)
  const site = regions[0] || 'US'
  const currency = ccys.length ? (ccys[0] === 'CNY' ? 'RMB' : ccys[0]) : (SITE_TO_CURRENCY[site] || 'USD')

  const s = makeEmptySummary({
    period: inferPeriod(dates),
    platform: 'TikTok Shop',
    site,
    currency,
    formatLabel: `TikTok Shop (${sName}, ${formatInfo})`,
    fileName,
  })

  let subsidyAccum = 0n
  let hasInlinePayout = false
  let hasInlineReserve = false

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    const txType = cell(r, colMap.tx_type)
    const tl = txType.toLowerCase()
    const remark = cell(r, colMap.remark)
    const rl = remark.toLowerCase()
    const modeTxt = cell(r, colMap.shop_mode)
    const orderId = cell(r, colMap.order_id) || cell(r, colMap.statement_id) || `Row-${hdrIdx + 2 + i}`

    if (['total', '合计', '总计', 'summary'].includes(tl) || ['total', '合计', '总计'].includes(orderId.toLowerCase())) continue

    if (modeTxt.toLowerCase().includes('fully managed') || modeTxt.includes('全托管') || tl.includes('全托管') || rl.includes('全托管')) {
      s.anomalies.push({
        severity: 'P0-阻断',
        category: '全托管与自运营混表阻断',
        refId: orderId,
        amount: fmtAmount(parseAmount(cell(r, colMap.settlement_amount))),
        detail: `检测到全托管供货记录 (${modeTxt || txType}) 与自运营/半托管零售订单混同，纳税义务与对手方截然不同，严禁混报！`,
      })
    }

    const gross = parseAmount(cell(r, colMap.gross_sales))
    const custShip = parseAmount(cell(r, colMap.customer_shipping))
    const sDisc = parseAmount(cell(r, colMap.seller_discount))
    const sShipDisc = parseAmount(cell(r, colMap.seller_shipping_discount))
    const pDisc = parseAmount(cell(r, colMap.platform_discount))
    const pShipSub = parseAmount(cell(r, colMap.platform_shipping_subsidy))
    const refSub = parseAmount(cell(r, colMap.refund_subtotal))
    const refSDisc = parseAmount(cell(r, colMap.seller_discount_refund))
    const refPDisc = parseAmount(cell(r, colMap.platform_discount_refund))
    const refShip = parseAmount(cell(r, colMap.refund_shipping))
    const comm = parseAmount(cell(r, colMap.commission_fee))
    const txFee = parseAmount(cell(r, colMap.transaction_fee))
    const cbFee = parseAmount(cell(r, colMap.chargeback_fee))
    const affComm = parseAmount(cell(r, colMap.affiliate_commission))
    const affPart = parseAmount(cell(r, colMap.affiliate_partner_commission))
    const shipFee = parseAmount(cell(r, colMap.shipping_fee))
    const adsFee = parseAmount(cell(r, colMap.ads_fee))
    const taxColl = parseAmount(cell(r, colMap.tax_collected))
    const taxWith = parseAmount(cell(r, colMap.tax_withheld))
    const adjAmt = parseAmount(cell(r, colMap.adjustment_amount))
    const resAmt = parseAmount(cell(r, colMap.reserve_amount))
    const payAmt = parseAmount(cell(r, colMap.payout_amount))
    const settleAmt = parseAmount(cell(r, colMap.settlement_amount))

    if (
      !txType &&
      [gross, custShip, sDisc, pDisc, refSub, comm, txFee, cbFee, affComm, affPart, shipFee, adsFee, taxColl, taxWith, adjAmt, resAmt, payAmt, settleAmt].every(
        (v) => v === 0n,
      )
    ) {
      continue
    }

    s.rawRowCount++

    if (['payout', 'withdrawal', 'bank transfer', '打款', '提现', '放款'].includes(tl) || (payAmt !== 0n && gross === 0n && settleAmt === 0n)) {
      hasInlinePayout = true
      s.actualPayout += payAmt !== 0n ? absBig(payAmt) : absBig(settleAmt)
      continue
    }

    if (['reserve', 'earnest', '储备金', '保证金'].some((k) => tl.includes(k))) {
      hasInlineReserve = true
      const rawR = resAmt !== 0n ? resAmt : settleAmt
      s.reserveNetChange += -rawR
      continue
    }

    if (resAmt !== 0n) {
      hasInlineReserve = true
      s.reserveNetChange += -resAmt
    }
    if (payAmt !== 0n) {
      hasInlinePayout = true
      s.actualPayout += absBig(payAmt)
    }

    if (
      tl.includes('sample') ||
      rl.includes('sample') ||
      tl.includes('寄样') ||
      rl.includes('寄样') ||
      (gross > 0n && absBig(gross + sDisc) === 0n && (shipFee !== 0n || rl.includes('free')))
    ) {
      s.freeSampleCount++
      s.anomalies.push({
        severity: 'P2-关注',
        category: '达人免费寄样 (Free Sample)',
        refId: orderId,
        amount: fmtAmount(shipFee !== 0n ? shipFee : gross),
        detail: `识别到达人免费寄样出库 (${txType || remark})，需核查无偿转让视同应税交易边界并留存推广合作证据`,
      })
    }

    if (taxWith !== 0n) s.facilitatorTaxStripped += absBig(taxWith)
    const taxNet = taxColl + taxWith
    if (absBig(taxNet) >= CENT_STEP) s.selfRemitTaxNet += taxNet

    const isRefundRow = ['refund', 'return', 'chargeback', '退款', '退货', '拒付'].some((k) => tl.includes(k))
    if (tl.includes('chargeback') || tl.includes('dispute') || tl.includes('拒付')) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: '拒付/争议扣款 (Chargeback)',
        refId: orderId,
        amount: fmtAmount(settleAmt),
        detail: `${txType}: ${remark}（拒付争议费归入财务费用，不得直接冲减收入）`,
      })
    }

    let rowDeltaS = 0n
    if (isRefundRow && refSub === 0n && gross < 0n) {
      const refPrincipal = -(gross + custShip + sDisc + sShipDisc)
      s.customerRefund += refPrincipal
      rowDeltaS -= refPrincipal
      const subChange = pDisc + pShipSub + refPDisc
      subsidyAccum += subChange
      rowDeltaS += subChange
    } else {
      const gAdd = gross + custShip
      const hAdd = -(sDisc + sShipDisc)
      const subAdd = pDisc + pShipSub + refPDisc
      const jAdd = -(refSub + refShip + refSDisc)
      s.grossSales += gAdd
      s.sellerDiscount += hAdd
      subsidyAccum += subAdd
      s.customerRefund += jAdd
      rowDeltaS += gAdd - hAdd + subAdd - jAdd
    }

    let kAdd = -(comm + txFee)
    let lAdd = -(affComm + affPart)
    let mAdd = -shipFee
    let nAdd = -adsFee
    let oAdd = -cbFee

    if (
      adjAmt !== 0n ||
      (!['order', 'refund', '订单', '退款', ''].includes(tl) &&
        [gross, refSub, comm, affComm, shipFee, adsFee, cbFee].every((v) => v === 0n))
    ) {
      let effAdj = adjAmt !== 0n ? adjAmt : settleAmt - taxNet
      if (['ads', 'gmv max', '广告', '投流'].some((w) => tl.includes(w) || rl.includes(w))) {
        nAdd += -effAdj
      } else if (['affiliate', 'creator', 'mcn', 'tap', '达人', '团长', '坑位'].some((w) => tl.includes(w) || rl.includes(w))) {
        lAdd += -effAdj
      } else if (['shipping', 'logistics', 'fbt', 'warehouse', '运费', '物流', '仓储', '赔付'].some((w) => tl.includes(w) || rl.includes(w))) {
        if (effAdj > 0n && (rl.includes('subsidy') || rl.includes('补贴') || tl.includes('reimbursement') || tl.includes('赔付'))) {
          subsidyAccum += effAdj
          rowDeltaS += effAdj
        } else {
          mAdd += -effAdj
        }
      } else if (['chargeback', 'dispute', '拒付', '争议'].some((w) => tl.includes(w) || rl.includes(w))) {
        oAdd += -effAdj
      } else if (effAdj > 0n) {
        subsidyAccum += effAdj
        rowDeltaS += effAdj
      } else if (effAdj < 0n) {
        kAdd += -effAdj
      }
    }

    s.platformCommission += kAdd
    s.affiliateCommission += lAdd
    s.logisticsWarehousing += mAdd
    s.inPlatformAds += nAdd
    s.gatewayDisputeFee += oAdd
    rowDeltaS -= kAdd + lAdd + mAdd + nAdd + oAdd
    rowDeltaS += taxNet

    if ('settlement_amount' in colMap && cell(r, colMap.settlement_amount) !== '') {
      const expected = q2(rowDeltaS + resAmt)
      const hDiff = q2(settleAmt - expected)
      if (absBig(hDiff) >= CENT_STEP) {
        s.horizontalDiffTotal += hDiff
        s.anomalies.push({
          severity: 'P0-阻断',
          category: '行内水平勾稽差异',
          refId: orderId,
          amount: fmtAmount(hDiff),
          detail: `第 ${hdrIdx + 2 + i} 行 (${txType}) 分项合计 (${fmtAmount(expected)}) 与应结算列 (${fmtAmount(settleAmt)}) 差额 ${fmtAmount(hDiff)}`,
        })
      }
    }
  }

  if (subsidyAccum >= 0n) s.platformSubsidy += subsidyAccum
  else s.sellerDiscount += -subsidyAccum

  for (const [, pRows, pHdr, pMap] of payoutSheets) {
    for (const pr of pRows.slice(pHdr + 1)) {
      const sid = cell(pr, pMap.statement_id).toLowerCase()
      if (['total', '合计', '总计'].includes(sid)) continue
      const rHeld = parseAmount(cell(pr, pMap.reserve_held))
      const rRel = parseAmount(cell(pr, pMap.reserve_released))
      const pOut = parseAmount(cell(pr, pMap.payout_amount))
      if (!hasInlineReserve && (rHeld !== 0n || rRel !== 0n)) {
        s.reserveNetChange += absBig(rHeld) - absBig(rRel)
      }
      if (!hasInlinePayout && pOut !== 0n) {
        s.actualPayout += absBig(pOut)
      }
    }
  }

  if (absBig(s.selfRemitTaxNet) >= CENT_STEP) {
    s.anomalies.push({
      severity: 'P1-高危',
      category: '非代扣待自申报境外流转税',
      refId: 'TTS-TAX-SELF',
      amount: fmtAmount(s.selfRemitTaxNet),
      detail: '检测到未由平台代扣代缴、随结算款拨付给卖家的税款净额，不得计入营业收入',
    })
  }

  return [finalizeSummary(s)]
}

// ── 3. Stripe / 独立站网关解析器（支持多币种自动拆表） ────────
const STRIPE_ALIASES = {
  tx_id: ['id', 'balance transaction id', 'transaction id', 'txn id', '网关流水号', '交易流水号'],
  tx_type: ['type', 'reporting category', 'transaction type', '类型', '交易类别', '交易类型'],
  created: ['created', 'created utc', 'created date', 'available on', '入账时间', '创建时间', '交易日期'],
  currency: ['currency', 'settlement currency', '币种', '结算币种'],
  amount: ['amount', 'gross', 'gross amount', '交易毛额', '毛收款', '金额'],
  fee: ['fee', 'processing fee', 'stripe fee', 'gateway fee', '手续费', '网关手续费', '通道费'],
  net: ['net', 'net amount', '结算净额', '净额'],
  status: ['status', 'payment status', '状态', '交易状态'],
  captured: ['captured', '是否捕获', '已捕获'],
  description: ['description', 'memo', '说明', '摘要', '备注'],
  order_id: ['order id', 'metadata order id', 'payment reference', '独立站订单号', '订单号'],
  gross_before_discount: ['gross before discount', 'subtotal before discount', 'order gross', '折扣前商品总额', '商品原价总额'],
  seller_discount: ['seller discount', 'discount amount', 'coupon discount', '商家折扣', '优惠码折扣'],
  tax_collected: ['tax amount', 'vat amount', 'sales tax', 'tax collected', '代收税费', '待自申报税额'],
}

function isStripeMatch(rows, hdrIdx, colMap) {
  if (!('amount' in colMap && 'fee' in colMap && 'net' in colMap)) return false
  const sampleRows = rows.slice(hdrIdx + 1, hdrIdx + 12)
  const sampleIds = sampleRows.map((r) => cell(r, colMap.tx_id).toLowerCase())
  const sampleTypes = sampleRows.map((r) => cell(r, colMap.tx_type).toLowerCase())
  return (
    sampleIds.some((x) => ['txn_', 'ch_', 'py_', 'po_', 're_', 'du_', 'iss_'].some((p) => x.startsWith(p))) ||
    sampleTypes.some((t) => ['charge', 'payment', 'payout', 'dispute', 'stripe_fee', 'refund', 'payment_refund', 'reserve_transaction'].includes(t))
  )
}

function parseStripeRows(fileName, sName, rows, hdrIdx, colMap, formatInfo) {
  const dataRows = rows.slice(hdrIdx + 1)
  const byCcy = new Map()
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    let ccy = cell(r, colMap.currency).toUpperCase() || 'USD'
    if (ccy === 'CNY') ccy = 'RMB'
    if (!byCcy.has(ccy)) byCcy.set(ccy, [])
    byCcy.get(ccy).push([hdrIdx + 2 + i, r])
  }

  const out = []
  for (const [ccy, indexedRows] of byCcy.entries()) {
    const dates = indexedRows.map(([, r]) => cell(r, colMap.created)).filter(Boolean)
    const site = CURRENCY_TO_SITE[ccy] || 'GLOBAL'
    const s = makeEmptySummary({
      period: inferPeriod(dates),
      platform: 'Stripe独立站',
      site,
      currency: ccy,
      formatLabel: `Stripe Balance (${sName}, ${formatInfo})`,
      fileName,
    })

    let uncapturedCount = 0
    for (const [rowNum, r] of indexedRows) {
      const txId = cell(r, colMap.tx_id) || cell(r, colMap.order_id) || `Row-${rowNum}`
      const txType = cell(r, colMap.tx_type)
      const tl = txType.toLowerCase()
      const status = cell(r, colMap.status).toLowerCase()
      const capturedFlag = cell(r, colMap.captured).toLowerCase()
      const desc = cell(r, colMap.description)
      const dl = desc.toLowerCase()

      const amt = parseAmount(cell(r, colMap.amount))
      const rawFee = parseAmount(cell(r, colMap.fee))
      const net = parseAmount(cell(r, colMap.net))
      if (!txType && amt === 0n && net === 0n) continue

      s.rawRowCount++

      const isPayoutOrTransfer = ['payout', 'transfer', 'payout_failure', '提现', '打款'].includes(tl) && !tl.includes('connect')
      const isInvalidChargeFlag = !isPayoutOrTransfer && ['false', 'no', '0', '未捕获'].includes(capturedFlag)
      if (
        ['uncaptured', 'authorized', 'requires_capture', 'failed', 'canceled', 'cancelled', 'voided', 'test'].includes(status) ||
        isInvalidChargeFlag ||
        ['uncaptured', 'void', 'failed', 'payout_failure'].includes(tl)
      ) {
        if (isPayoutOrTransfer) {
          s.anomalies.push({
            severity: 'P1-高危',
            category: '网关提现/打款失败或取消',
            refId: txId,
            amount: fmtAmount(amt),
            detail: `检测到异常提现记录 (${txType}, status=${status || 'unknown'})，已自动排除出实际打款统计，请核对银行账户退汇流水`,
          })
        } else {
          uncapturedCount++
          s.uncapturedVoidExcluded += absBig(amt)
        }
        continue
      }

      let feeDeduction = rawFee
      if (absBig(net - (amt - rawFee)) <= CENT_STEP) {
        feeDeduction = rawFee
      } else if (absBig(net - (amt + rawFee)) <= CENT_STEP) {
        feeDeduction = -rawFee
      } else {
        const hDiff = q2(net - (amt - rawFee))
        s.horizontalDiffTotal += hDiff
        s.anomalies.push({
          severity: 'P0-阻断',
          category: '行内水平勾稽差异',
          refId: txId,
          amount: fmtAmount(hDiff),
          detail: `第 ${rowNum} 行 Amount (${fmtAmount(amt)}) - Fee (${fmtAmount(rawFee)}) != Net (${fmtAmount(net)})`,
        })
      }

      if (['payout', 'transfer', '提现', '打款'].includes(tl) && !tl.includes('connect')) {
        if (tl === 'payout' || amt < 0n) {
          s.actualPayout += absBig(amt)
          if (feeDeduction !== 0n) s.gatewayDisputeFee += feeDeduction
          continue
        }
      }

      if (
        ['reserve_transaction', 'reserved_funds', 'reserve_hold', 'reserve_release', 'rolling_reserve', '保证金'].includes(tl) ||
        dl.includes('rolling reserve') ||
        dl.includes('reserve hold') ||
        dl.includes('reserve release')
      ) {
        s.reserveNetChange += -net
        continue
      }

      if (
        ['issuing_transaction', 'issuing_authorization', 'direct_ad_spend', '广告直付'].includes(tl) ||
        ['meta ads', 'facebook ads', 'google ads', 'tiktok ads', '直付广告'].some((w) => dl.includes(w))
      ) {
        const adCost = -net
        s.inPlatformAds += adCost
        s.anomalies.push({
          severity: 'P1-高危',
          category: '网关余额/虚拟卡直付海外广告（防坐支预警）',
          refId: txId,
          amount: fmtAmount(adCost),
          detail: `检测到从网关余额直接扣付海外广告费 (${desc || txType})：须还原收支两条线全额确认销售收入，严禁坐支冲抵收入！`,
        })
        continue
      }

      if (['stripe_fee', 'billing_fee', 'radar_fee', 'tax_fee', 'fx_fee', 'network_cost', '网关服务费'].includes(tl)) {
        s.gatewayDisputeFee += -net
        continue
      }

      const taxVal = parseAmount(cell(r, colMap.tax_collected))
      const grossPreDisc = parseAmount(cell(r, colMap.gross_before_discount))
      const sDisc = absBig(parseAmount(cell(r, colMap.seller_discount)))

      if (['charge', 'payment', '收款', '支付成功'].includes(tl)) {
        if (taxVal !== 0n) s.selfRemitTaxNet += taxVal
        const merchCaptured = amt - taxVal
        if (sDisc > 0n) {
          s.grossSales += merchCaptured + sDisc
          s.sellerDiscount += sDisc
        } else if (grossPreDisc > merchCaptured && merchCaptured > 0n) {
          s.grossSales += grossPreDisc
          s.sellerDiscount += grossPreDisc - merchCaptured
        } else {
          s.grossSales += merchCaptured
        }
        s.gatewayDisputeFee += feeDeduction
        continue
      }

      const isDispute = ['dispute', 'chargeback', '拒付', '争议'].some((k) => tl.includes(k) || dl.includes(k))
      if (isDispute || ['refund', 'payment_refund', 'adjustment', '退款'].includes(tl)) {
        const effTaxVal = amt < 0n && taxVal > 0n ? -taxVal : taxVal
        if (effTaxVal !== 0n) s.selfRemitTaxNet += effTaxVal
        s.customerRefund += -(amt - effTaxVal)
        s.gatewayDisputeFee += feeDeduction
        if (isDispute) {
          s.anomalies.push({
            severity: 'P1-高危',
            category: '信用卡拒付争议 (Chargeback/Dispute)',
            refId: txId,
            amount: fmtAmount(net),
            detail: `${txType}: 本金变动 ${fmtAmount(amt)}，不可退争议处理费 ${fmtAmount(feeDeduction)}（争议费应计财务费用，勿冲减收入）`,
          })
        }
        continue
      }

      s.anomalies.push({
        severity: 'P1-高危',
        category: '未识别网关流水类型',
        refId: txId,
        amount: fmtAmount(net),
        detail: `未知网关类型 type='${txType}', desc='${desc}'`,
      })
      if (net < 0n) s.gatewayDisputeFee += -net
      else s.platformSubsidy += net
    }

    if (uncapturedCount > 0) {
      s.anomalies.push({
        severity: 'P2-关注',
        category: '已自动剔除未捕获预授权/失败废单',
        refId: `EXCLUDED-${uncapturedCount}`,
        amount: fmtAmount(s.uncapturedVoidExcluded),
        detail: `共自动剔除 ${uncapturedCount} 笔 Authorized 未捕获/失败/取消订单（总额 ${fmtAmount(s.uncapturedVoidExcluded)}），避免虚增销售收入`,
      })
    }

    if (absBig(s.selfRemitTaxNet) >= CENT_STEP) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: '独立站代收待自申报境外流转税',
        refId: 'STRIPE-TAX-SELF',
        amount: fmtAmount(s.selfRemitTaxNet),
        detail: '独立站无商城代扣机制，结账代收 VAT/Sales Tax 随货款进入网关余额，已单独剥离，切勿计入主营业务收入',
      })
    }

    out.push(finalizeSummary(s))
  }
  return out
}

/**
 * 统一入口：自动识别 Amazon / TikTok Shop / Stripe 原始导出文件并生成确定性初筛体检结果。
 * @param {string} filePath 本地账单文件绝对或相对路径 (.csv / .tsv / .txt / .xlsx)
 * @param {string} [platformHint='auto'] 'auto' | 'amazon' | 'tiktok' | 'stripe'
 */
export function parsePlatformStatement(filePath, platformHint = 'auto') {
  const { sheets, formatInfo } = readTabularSheets(filePath)
  if (!sheets.length) throw new Error('账单文件内容为空，未读取到任何有效数据行')
  const fileName = basename(filePath)
  const hint = String(platformHint || 'auto').toLowerCase()

  if (hint === 'amazon' || hint === 'auto') {
    for (const [, rows] of sheets) {
      const v2 = findHeaderRow(rows, AMAZON_V2_ALIASES, 6)
      if (v2 && 'amount_type' in v2[1] && 'settlement_id' in v2[1]) {
        return parseAmazonV2(fileName, rows, v2[0], v2[1], formatInfo)
      }
    }
    for (const [, rows] of sheets) {
      const dr = findHeaderRow(rows, AMAZON_DR_ALIASES, 6)
      if (dr && ('product_sales' in dr[1] || 'fba_fees' in dr[1]) && 'total' in dr[1]) {
        return parseAmazonDateRange(fileName, rows, dr[0], dr[1], formatInfo)
      }
    }
    if (hint === 'amazon') throw new Error(`未在 ${fileName} 中识别到有效的 Amazon Date Range CSV 或 Flat File V2 表头`)
  }

  if (hint === 'tiktok' || hint === 'auto') {
    const tt = parseTikTokSheets(fileName, sheets, formatInfo)
    if (tt) return tt
    if (hint === 'tiktok') throw new Error(`未在 ${fileName} 中识别到有效的 TikTok Shop Statements / Order details 表头`)
  }

  if (hint === 'stripe' || hint === 'auto') {
    for (const [sName, rows] of sheets) {
      const sm = findHeaderRow(rows, STRIPE_ALIASES, 5)
      if (sm && (hint === 'stripe' || isStripeMatch(rows, sm[0], sm[1]))) {
        return parseStripeRows(fileName, sName, rows, sm[0], sm[1], formatInfo)
      }
    }
    if (hint === 'stripe') throw new Error(`未在 ${fileName} 中识别到有效的 Stripe / 独立站网关余额流水表头`)
  }

  throw new Error(
    `无法自动识别 ${fileName} 的平台表头格式。目前支持官方原样导出的：① Amazon Date Range CSV / Flat File V2；② TikTok Shop Statements (.xlsx/.csv)；③ Stripe 余额流水 (.csv/.xlsx)。请勿删除原始表头行。`,
  )
}
