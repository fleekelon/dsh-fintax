// 跨境电商平台原始结算账单确定性初筛体检与异常雷达（纯 Node.js 零第三方依赖）。
// 支持平台：
//   1. Amazon Seller Central（Date Range Reports CSV 多语种表头自动跳行 / All Statements Flat File V2 TSV）
//   2. TikTok Shop Seller Center（Statements / Order details CSV 或多工作表 XLSX）
//   3. Stripe / 独立站网关（balance_transactions CSV / XLSX，支持多币种自动拆表）
//
// 算术精度：全部采用 BigInt 定点数（1e-4 内部精度 + ROUND_HALF_UP 精确到 0.01 分），零浮点误差。
// 商业边界：本模块仅输出单文件账单参考数据、资金桥接与 P0/P1/P2 风险异常雷达；
//           不包含多表联动正式关账母表 (.xlsx)、三方收款池跨期台账或标准借贷会计分录。

import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import {
  AMOUNT_SCALE,
  CENT_STEP,
  absBig,
  addPayoutEvidence,
  appendDateValidationAnomalies,
  cell,
  detectDeductionSign,
  evidenceColumns,
  evidenceKey,
  excelSerialToIsoDate,
  extractAccountPrefix,
  finalizeSummary,
  findHeaderRow,
  findInvalidCalendarDates,
  fmtAmount,
  hasAmbiguousSlashDates,
  inferDateOrderFromSite,
  inferPeriod,
  isInvalidCalendarDate,
  makeEmptySummary,
  normHeader,
  normalizeBankInstitutionCode,
  normalizeCurrencyCode,
  parseAmount,
  parseAmountCell,
  pickFundEvidence,
  q2,
  reportedCurrency,
  toNumber2,
  transactionMonth,
} from './statement_shared.js'
import {
  SHOPIFY_ALIASES, TEMU_ALIASES, getDemoStatementBuffers,
  isShopifyMatch, isTemuMatch, parseShopifySheets, parseTemuSheets,
} from './platforms_extra.js'
import {
  ALIEXPRESS_ALIASES, PAYPAL_ALIASES, SHOPEE_ALIASES,
  isAliExpressMatch, isPayPalMatch, isShopeeMatch, parseAliExpressSheets, parsePayPalSheets, parseShopeeSheets,
} from './platforms_v7.js'
import { AIRWALLEX_ALIASES, PAYONEER_ALIASES, WORLDFIRST_ALIASES, findWalletCandidates, parseWalletSheet } from './platforms_v8.js'
import {
  AMAZON_V9_ROW_TYPE_ALIASES,
  AMAZON_V9_SITE_TO_CURRENCY,
  LAZADA_ALIASES,
  LIANLIAN_ALIASES,
  PINGPONG_ALIASES,
  SHEIN_ALIASES,
  SUNRATE_ALIASES,
  V9_SALES_ADAPTERS,
  WALMART_ALIASES,
  classifyAmazon2027Fee,
  findV9WalletCandidates,
  mergeAmazonV9HeaderAliases,
  parseV9WalletSheet,
  resolveAmazonV9Site,
} from './platforms_v9.js'
import {
  BANK_RECEIPT_ALIASES,
  detectBankReceipt,
  getV9DemoBuffers,
  parseBankReceiptRows,
} from './bank_receipt.js'

export {
  AMOUNT_SCALE,
  CENT_STEP,
  absBig,
  addPayoutEvidence,
  appendDateValidationAnomalies,
  cell,
  detectDeductionSign,
  evidenceColumns,
  evidenceKey,
  excelSerialToIsoDate,
  extractAccountPrefix,
  finalizeSummary,
  findHeaderRow,
  findInvalidCalendarDates,
  fmtAmount,
  hasAmbiguousSlashDates,
  inferDateOrderFromSite,
  inferPeriod,
  isInvalidCalendarDate,
  makeEmptySummary,
  normalizeBankInstitutionCode,
  normalizeCurrencyCode,
  parseAmount,
  parseAmountCell,
  pickFundEvidence,
  q2,
  reportedCurrency,
  toNumber2,
  transactionMonth,
}

const BASE_SITE_TO_CURRENCY = {
  US: 'USD', CA: 'CAD', MX: 'MXN', UK: 'GBP', GB: 'GBP',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', IE: 'EUR', EU: 'EUR',
  JP: 'JPY', AU: 'AUD', SG: 'SGD', CN: 'CNY',
}
const DMY_CURRENCIES = new Set(['EUR', 'GBP', 'PLN', 'SEK', 'CHF', 'DKK', 'NOK', 'CZK', 'HUF', 'RON', 'AUD', 'NZD', 'SGD', 'BRL', 'MXN', 'INR'])
let _siteToCurrencyCache = null
function getSiteToCurrency() {
  if (!_siteToCurrencyCache) {
    _siteToCurrencyCache = { ...BASE_SITE_TO_CURRENCY, ...AMAZON_V9_SITE_TO_CURRENCY }
  }
  return _siteToCurrencyCache
}
const CURRENCY_TO_SITE = {
  USD: 'US', EUR: 'EU', GBP: 'UK', JPY: 'JP', CNY: 'CN', CAD: 'CA', AUD: 'AU', SGD: 'SG',
  SEK: 'SE', PLN: 'PL', TRY: 'TR', AED: 'AE', SAR: 'SA', BRL: 'BR', INR: 'IN',
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

const MAX_EXPANDED_BYTES = 120 * 1024 * 1024
const MAX_INPUT_BYTES = 80 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 512
const MAX_ROWS = 500_000
const MAX_CELLS = 4_000_000
const MAX_COLUMNS = 1024
const MAX_CELL_CHARS = 32_767
const rowNumbers = new WeakMap()

const statementMessages = {
  STATEMENT_UNKNOWN_FORMAT: '无法识别账单表头。请使用官方原始明细导出。',
  STATEMENT_CANDIDATE_CONFLICT: '同一表有多个符合条件的候选格式，需核对平台后重试。',
  STATEMENT_EMPTY: '未读取到账单明细。',
  STATEMENT_AMOUNT_INVALID: '账单金额列存在无效值，请核对源表。',
  STATEMENT_LIMIT: '账单或压缩包超过解析上限，请按账期或店铺拆分。',
  STATEMENT_INVALID_ARCHIVE: 'ZIP 或 XLSX 的压缩目录、条目或工作簿格式无效。',
  STATEMENT_NESTED_ARCHIVE: '压缩包内仅支持账单文件和工作簿。',
  STATEMENT_INVALID_FILE: '账单文件无法读取或文件格式无效。',
}

export class StatementInputError extends Error {
  constructor(code, diagnostics = []) {
    super(statementMessages[code] || statementMessages.STATEMENT_INVALID_FILE)
    this.name = 'StatementInputError'
    this.code = code
    this.diagnostics = diagnostics
  }
}

export function createStatementBudget() {
  return { inputBytes: 0, expandedBytes: 0, entries: 0, rows: 0, cells: 0 }
}

function addBudget(budget, prop, count, limit) {
  budget[prop] += count
  if (budget[prop] > limit) throw new StatementInputError('STATEMENT_LIMIT')
}

function appendRow(rows, row, rowNumber, budget) {
  if (row.length > MAX_COLUMNS || row.some((value) => value.length > MAX_CELL_CHARS)) {
    throw new StatementInputError('STATEMENT_LIMIT')
  }
  if (!row.some((value) => value !== '')) return
  addBudget(budget, 'rows', 1, MAX_ROWS)
  addBudget(budget, 'cells', row.length, MAX_CELLS)
  rowNumbers.set(row, rowNumber)
  rows.push(row)
}

function unzipEntries(buf, budget) {
  const invalid = () => new StatementInputError('STATEMENT_INVALID_ARCHIVE')
  let eocd = -1
  const minPos = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i
      break
    }
  }
  if (eocd < 0 || buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw invalid()
  const totalEntries = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (buf.readUInt16LE(eocd + 8) !== totalEntries || cdOffset + cdSize !== eocd) throw invalid()
  addBudget(budget, 'entries', totalEntries, MAX_ARCHIVE_ENTRIES)

  const definitions = []
  const names = new Set()
  let declaredBytes = 0
  let pos = cdOffset
  for (let idx = 0; idx < totalEntries; idx++) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== 0x02014b50) throw invalid()
    const flags = buf.readUInt16LE(pos + 8)
    const method = buf.readUInt16LE(pos + 10)
    const checksum = buf.readUInt32LE(pos + 16)
    const compSize = buf.readUInt32LE(pos + 20)
    const rawSize = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const nextPos = pos + 46 + nameLen + extraLen + commentLen
    if (!nameLen || nextPos > eocd || flags & ~0x80e || ![0, 8].includes(method) ||
        buf.readUInt16LE(pos + 34) !== 0 || localOffset + 30 > cdOffset) throw invalid()
    const nameBytes = buf.subarray(pos + 46, pos + 46 + nameLen)
    const name = nameBytes.toString('utf8').replace(/\\/g, '/')
    if (!name || name.includes('\0') || names.has(name)) throw invalid()
    names.add(name)
    pos = nextPos

    if (buf.readUInt32LE(localOffset) !== 0x04034b50 || buf.readUInt16LE(localOffset + 8) !== method ||
        buf.readUInt16LE(localOffset + 6) !== flags) throw invalid()
    if (!(flags & 8) && (buf.readUInt32LE(localOffset + 14) !== checksum ||
        buf.readUInt32LE(localOffset + 18) !== compSize || buf.readUInt32LE(localOffset + 22) !== rawSize)) throw invalid()
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const dataStart = localOffset + 30 + localNameLen + buf.readUInt16LE(localOffset + 28)
    const dataEnd = dataStart + compSize
    if (dataEnd > cdOffset || !buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).equals(nameBytes) ||
        (method === 0 && compSize !== rawSize) || (name.endsWith('/') && rawSize !== 0)) throw invalid()
    declaredBytes += rawSize
    definitions.push({ name, method, rawSize, localOffset, dataStart, dataEnd })
  }
  if (pos !== eocd) throw invalid()
  let end = 0
  for (const entry of [...definitions].sort((a, b) => a.localOffset - b.localOffset)) {
    if (entry.localOffset < end) throw invalid()
    end = entry.dataEnd
  }
  if (budget.expandedBytes + declaredBytes > MAX_EXPANDED_BYTES) throw new StatementInputError('STATEMENT_LIMIT')

  const files = new Map()
  for (const { name, method, rawSize, dataStart, dataEnd } of definitions) {
    if (name.endsWith('/')) continue
    const compressed = buf.subarray(dataStart, dataEnd)
    let value = compressed
    if (method === 8) {
      try {
        // 限制生效于解压过程中，大小谎报的条目也无法越过其声明值或剩余预算。
        const maxOutputLength = Math.max(1, Math.min(rawSize, MAX_EXPANDED_BYTES - budget.expandedBytes))
        value = inflateRawSync(compressed, { maxOutputLength })
      } catch {
        throw invalid()
      }
    }
    if (value.length !== rawSize) throw invalid()
    addBudget(budget, 'expandedBytes', value.length, MAX_EXPANDED_BYTES)
    files.set(name, value)
  }
  return files
}

function colLettersToIndex(cellRef) {
  const m = String(cellRef || '').match(/^([A-Za-z]{1,3})\d+$/)
  if (!m) return -1
  let idx = 0
  const letters = m[1].toUpperCase()
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64)
  }
  return idx - 1
}

const BUILTIN_DATE_NUMFMT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
  71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81,
])

function isExcelDateFormatCode(code) {
  if (!code) return false
  const stripped = decodeXmlEntities(code)
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '')
  if (/[#0?%]/.test(stripped) && !/[yd年月日]/i.test(stripped)) return false
  return /(?:y{2,4}|d{1,2}|年|月|日)/i.test(stripped)
}

function parseXlsxDateStyles(files) {
  const dateStyleIndexes = new Set()
  const stylesBuf = files.get('xl/styles.xml')
  if (!stylesBuf) return dateStyleIndexes
  const stylesXml = stylesBuf.toString('utf8')
  const customFmtMap = new Map()
  const numFmtsMatch = stylesXml.match(/<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/)
  if (numFmtsMatch) {
    for (const fm of numFmtsMatch[1].matchAll(/<numFmt\b([^>]*)\/?>/g)) {
      const attrs = fm[1]
      const id = Number(attrs.match(/\bnumFmtId="(\d+)"/)?.[1])
      const code = attrs.match(/\bformatCode="([^"]*)"/)?.[1]
      if (Number.isInteger(id) && code !== undefined) customFmtMap.set(id, code)
    }
  }
  const cellXfsMatch = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)
  if (cellXfsMatch) {
    let idx = 0
    for (const xf of cellXfsMatch[1].matchAll(/<xf\b([^>]*)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
      const attrs = xf[1]
      const numFmtId = Number(attrs.match(/\bnumFmtId="(\d+)"/)?.[1] ?? 0)
      const isDate = BUILTIN_DATE_NUMFMT_IDS.has(numFmtId) || isExcelDateFormatCode(customFmtMap.get(numFmtId))
      if (isDate) dateStyleIndexes.add(idx)
      idx++
    }
  }
  return dateStyleIndexes
}

function readXlsxSheets(files, budget) {
  const sharedStrings = []
  const sstBuf = files.get('xl/sharedStrings.xml')
  if (sstBuf) {
    const sstXml = sstBuf.toString('utf8')
    for (const siMatch of sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      if (sharedStrings.length >= MAX_CELLS) throw new StatementInputError('STATEMENT_LIMIT')
      const value = extractXmlText(siMatch[1])
      if (value.length > MAX_CELL_CHARS) throw new StatementInputError('STATEMENT_LIMIT')
      sharedStrings.push(value)
    }
  }

  // 解析工作表名称与路径映射，同时检查 1904 日期系统与 xl/styles.xml 日期单元格样式
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

  const dateStyleIndexes = parseXlsxDateStyles(files)
  let date1904 = false
  const sheetDefs = []
  const wbBuf = files.get('xl/workbook.xml')
  if (wbBuf) {
    const wbXml = wbBuf.toString('utf8')
    date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/i.test(wbXml)
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
  const usedPaths = new Set()
  for (const def of sheetDefs) {
    if (usedPaths.has(def.path)) throw new StatementInputError('STATEMENT_INVALID_ARCHIVE')
    usedPaths.add(def.path)
    const wsBuf = files.get(def.path)
    if (!wsBuf) {
      out.push([def.name, []])
      continue
    }
    const wsXml = wsBuf.toString('utf8')
    const rows = []
    let rowCounter = 0
    for (const rowMatch of wsXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      rowCounter++
      const rowNumber = Number(rowMatch[1].match(/\br="(\d{1,7})"/)?.[1]) || rowCounter
      const rowXml = rowMatch[2]
      const rowArr = []
      let seqCol = 0
      for (const cMatch of rowXml.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cMatch[1] || ''
        const inner = cMatch[2] || ''
        const ref = attrs.match(/\br="([^"]+)"/)?.[1]
        const colIdx = ref ? colLettersToIndex(ref) : seqCol
        if (colIdx < 0 || colIdx >= MAX_COLUMNS) throw new StatementInputError('STATEMENT_LIMIT')
        seqCol = colIdx + 1
        const cellType = attrs.match(/\bt="([^"]+)"/)?.[1] || ''
        const styleIdxRaw = attrs.match(/\bs="(\d+)"/)?.[1]
        const styleIdx = styleIdxRaw !== undefined ? Number(styleIdxRaw) : -1

        let val = ''
        if (cellType === 'inlineStr') {
          val = extractXmlText(inner)
        } else {
          const vRaw = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1]
          if (vRaw !== undefined) {
            if (cellType === 's') {
              const sIdx = parseInt(vRaw.trim(), 10)
              val = sharedStrings[sIdx] ?? ''
            } else if ((!cellType || cellType === 'n') && styleIdx >= 0 && dateStyleIndexes.has(styleIdx)) {
              const rawTrimmed = vRaw.trim()
              const serialNum = Number(rawTrimmed)
              if (!date1904 && Number.isFinite(serialNum) && Math.floor(serialNum) === 60) {
                val = 'INVALID_EXCEL_1900_02_29'
              } else {
                val = excelSerialToIsoDate(rawTrimmed, date1904) ?? decodeXmlEntities(rawTrimmed)
              }
            } else {
              val = decodeXmlEntities(vRaw.trim())
            }
          }
        }
        while (rowArr.length <= colIdx) rowArr.push('')
        rowArr[colIdx] = String(val).trim()
      }
      appendRow(rows, rowArr, rowNumber, budget)
    }
    out.push([def.name, rows])
  }
  return out
}

// ── RFC-4180 CSV / TSV 多编码读取器（兼容 UTF-8 / UTF-16LE / UTF-16BE / GB18030 / Win-1252） ──
function decodeTextBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), enc: 'utf-8-bom' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), enc: 'utf-16le-bom' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), enc: 'utf-16be-bom' }
  }
  if (buf.length >= 16 && buf.length % 2 === 0) {
    const sampleLen = Math.min(buf.length, 256)
    let oddNulls = 0
    let evenNulls = 0
    for (let i = 0; i < sampleLen; i += 2) {
      if (buf[i] === 0) evenNulls++
      if (buf[i + 1] === 0) oddNulls++
    }
    const pairs = sampleLen / 2
    if (oddNulls / pairs > 0.35 && evenNulls / pairs < 0.05) {
      return { text: new TextDecoder('utf-16le').decode(buf), enc: 'utf-16le' }
    }
    if (evenNulls / pairs > 0.35 && oddNulls / pairs < 0.05) {
      return { text: new TextDecoder('utf-16be').decode(buf), enc: 'utf-16be' }
    }
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

function parseDelimited(text, delimiter, budget) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let recordNumber = 1

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (field.length > MAX_CELL_CHARS || row.length >= MAX_COLUMNS) throw new StatementInputError('STATEMENT_LIMIT')
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
      appendRow(rows, row, recordNumber++, budget)
      row = []
    } else {
      field += ch
    }
  }
  if (inQuotes) throw new StatementInputError('STATEMENT_INVALID_FILE')
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim())
    appendRow(rows, row, recordNumber, budget)
  }
  return rows
}

function detectCsvDelimiter(text, ext) {
  if (ext === '.tsv') return '\t'
  const sample = text.slice(0, 65536)
  const unquotedLines = []
  let line = ''
  let inQuotes = false
  for (let i = 0; i < sample.length && unquotedLines.length < 40; i++) {
    const ch = sample[i]
    if (inQuotes) {
      if (ch === '"') {
        if (sample[i + 1] === '"') i++
        else inQuotes = false
      }
    } else if (ch === '"') {
      inQuotes = true
      line += 'Q'
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && sample[i + 1] === '\n') i++
      if (line.trim().length > 0) unquotedLines.push(line)
      line = ''
    } else {
      line += ch
    }
  }
  if (line.trim().length > 0 && unquotedLines.length < 40) unquotedLines.push(line)

  const scoreDelim = (delim) => {
    const freq = new Map()
    let positiveLines = 0
    let total = 0
    for (const ln of unquotedLines) {
      let c = 0
      for (let i = 0; i < ln.length; i++) {
        if (ln[i] === delim) c++
      }
      if (c > 0) {
        positiveLines++
        total += c
        freq.set(c, (freq.get(c) || 0) + 1)
      }
    }
    let modeVal = 0
    let modeFreq = 0
    for (const [val, f] of freq.entries()) {
      if (f > modeFreq || (f === modeFreq && val > modeVal)) {
        modeFreq = f
        modeVal = val
      }
    }
    const consistency = positiveLines > 0 ? modeFreq / positiveLines : 0
    return { delim, modeVal, modeFreq, positiveLines, consistency, total }
  }

  const candidates = ['\t', ';', ','].map(scoreDelim)
  const structured = candidates
    .filter((c) => c.modeVal >= 2 && c.modeFreq >= 2)
    .sort((a, b) => (b.modeFreq - a.modeFreq) || (b.consistency - a.consistency) || (b.modeVal - a.modeVal))
  if (structured.length > 0) return structured[0].delim

  const [tabs, semis, commas] = candidates
  if (tabs.total > commas.total && tabs.total > semis.total && tabs.total >= 3) return '\t'
  if (semis.total > commas.total && semis.total >= 3) return ';'
  return ','
}

export function readTabularSheetsFromBuffer(buf, fileName, budget = createStatementBudget(), nested = false) {
  if (!Buffer.isBuffer(buf)) throw new StatementInputError('STATEMENT_INVALID_FILE')
  if (!nested) addBudget(budget, 'inputBytes', buf.length, MAX_INPUT_BYTES)
  const ext = extname(fileName).toLowerCase()
  const isPkZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.zip' || isPkZip) {
    const entries = unzipEntries(buf, budget)
    const isOpenXmlWorkbook =
      entries.has('xl/workbook.xml') || [...entries.keys()].some((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
    if (isOpenXmlWorkbook) {
      return { kind: 'sheets', sheets: readXlsxSheets(entries, budget), formatInfo: 'xlsx' }
    }
    if (isPkZip || ext === '.zip') {
      if (nested) throw new StatementInputError('STATEMENT_NESTED_ARCHIVE')
      const subFiles = []
      for (const [entryName, entryBuf] of entries.entries()) {
        const base = basename(entryName)
        if (entryName.includes('__MACOSX/') || base.startsWith('.')) continue
        const subExt = extname(base).toLowerCase()
        if (!['.csv', '.tsv', '.txt', '.xlsx', '.xlsm'].includes(subExt)) continue
        subFiles.push([base, entryBuf])
      }
      if (!subFiles.length) throw new StatementInputError('STATEMENT_EMPTY')
      return { kind: 'zip', entries: subFiles, formatInfo: 'zip' }
    }
    throw new StatementInputError('STATEMENT_INVALID_ARCHIVE')
  }

  const { text, enc } = decodeTextBuffer(buf)
  const delimiter = detectCsvDelimiter(text, ext)

  const rows = parseDelimited(text, delimiter, budget)
  return {
    kind: 'sheets',
    sheets: [[basename(fileName, ext), rows]],
    formatInfo: `${enc} (delim=${delimiter === '\t' ? 'TAB' : delimiter})`,
  }
}

function readStatementFile(filePath, budget) {
  try {
    const st = statSync(filePath)
    if (!st.isFile()) throw new StatementInputError('STATEMENT_INVALID_FILE')
    if (st.size > MAX_INPUT_BYTES - budget.inputBytes) throw new StatementInputError('STATEMENT_LIMIT')
    return readFileSync(filePath)
  } catch (error) {
    if (error instanceof StatementInputError) throw error
    throw new StatementInputError('STATEMENT_INVALID_FILE')
  }
}

export function readTabularSheets(filePath) {
  const budget = createStatementBudget()
  return readTabularSheetsFromBuffer(readStatementFile(filePath, budget), filePath, budget)
}

// ── 1. Amazon 解析器（Date Range CSV + Flat File V2，含 v0.9 FR/IT/ES 表头、9 大新兴站点与 2027 FBA 新费用） ────────
const BASE_AMAZON_DR_ALIASES = {
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

let _amazonDrAliasesCache = null
function getAmazonDrAliases() {
  if (!_amazonDrAliasesCache) _amazonDrAliasesCache = mergeAmazonV9HeaderAliases(BASE_AMAZON_DR_ALIASES)
  return _amazonDrAliasesCache
}

const AMAZON_2027_FAST_RE = /aged|storage|awd|mcd|fuel|surcharge|oversize|over[\s-]*size|extra[\s-]*large|bulky|库龄|仓储|燃油|附加费|超大件|大件|6级|六级/i
let _amazonTypeSetsCache = null
function getAmazonTypeSets() {
  if (!_amazonTypeSetsCache) {
    _amazonTypeSetsCache = {
      transfer: new Set(['transfer', 'disbursement', '转账', 'übertrag', '振込', ...AMAZON_V9_ROW_TYPE_ALIASES.transfer]),
      reserve: new Set(['debt', 'reserve', 'carryover', 'unavailable balance', '预留金额', ...AMAZON_V9_ROW_TYPE_ALIASES.reserve]),
      serviceFee: new Set(['service fee', '服务费', 'servicegebühr', ...AMAZON_V9_ROW_TYPE_ALIASES.service_fee]),
      inventoryFee: new Set(['亚马逊库存费用', '配送服务', 'fba inventory fee', 'fba customer return fee', ...AMAZON_V9_ROW_TYPE_ALIASES.inventory_fee]),
      adjustment: new Set(['adjustment', 'fba inventory reimbursement', 'safe-t reimbursement', '赔偿', '调整', 'liquidations', ...AMAZON_V9_ROW_TYPE_ALIASES.adjustment]),
      refundKeywords: ['refund', '退款', 'erstattung', '返金', ...AMAZON_V9_ROW_TYPE_ALIASES.refund],
      orderKeywords: ['order', '订单', 'bestellung', '注文', ...AMAZON_V9_ROW_TYPE_ALIASES.order],
    }
  }
  return _amazonTypeSetsCache
}

const EU_LOCALIZED_HEADER_RE = /^(?:date heure|data ora|fecha hora|fecha y hora|datum uhrzeit|ventes de produits|ventes produits|vendite|ventas de productos|umsätze|frais de vente|commissioni di vendita|tarifas de venta|verkaufsgebühren|numéro de versement|numero de versement|numero pagamento|id de liquidación)$/i

function inferAmazonDateOrder(site, headerRow = [], explicitSite = site, currency = 'UNKNOWN') {
  const fromExplicitSite = inferDateOrderFromSite(explicitSite)
  if (fromExplicitSite) return fromExplicitSite
  if (Array.isArray(headerRow) && headerRow.some((h) => EU_LOCALIZED_HEADER_RE.test(normHeader(h)))) {
    return 'DMY'
  }
  if (!explicitSite && DMY_CURRENCIES.has(currency)) return 'DMY'
  return null
}

function matchAmazon2027FeeFast(rawType, desc) {
  if (!AMAZON_2027_FAST_RE.test(desc) && !AMAZON_2027_FAST_RE.test(rawType)) return null
  return classifyAmazon2027Fee(rawType, desc)
}

function recordAmazon2027Hit(hits, rule, signedCost) {
  if (!rule) return
  const cur = hits.get(rule.id) || { rule, count: 0, netAmount: 0n, grossActivity: 0n }
  cur.count++
  cur.netAmount += signedCost
  cur.grossActivity += absBig(signedCost)
  hits.set(rule.id, cur)
}

function flushAmazon2027Hits(s, hits) {
  if (!hits.size) return
  s.amazon2027Fees = []
  for (const { rule, count, netAmount, grossActivity } of hits.values()) {
    s.amazon2027Fees.push({
      id: rule.id,
      label: rule.label,
      count,
      amount: fmtAmount(netAmount),
      netAmount: fmtAmount(netAmount),
      activityAmount: fmtAmount(grossActivity),
      effectiveYear: rule.effectiveYear,
    })
    s.anomalies.push({
      severity: rule.severity || 'P2-关注',
      category: rule.label,
      refId: `AMZ-2027-${rule.id}`,
      amount: fmtAmount(netAmount),
      detail: `${rule.note}（共 ${count} 笔，净额 ${fmtAmount(netAmount)} ${s.currency}，活动发生额 ${fmtAmount(grossActivity)} ${s.currency}）`,
    })
  }
}

const AMAZON_V2_ALIASES = {
  settlement_id: ['settlement id', 'settlement-id'],
  settlement_end_date: ['settlement end date', 'settlement-end-date'],
  deposit_date: ['deposit date', 'deposit-date'],
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

function inferAmazonSiteAndCcy(marketplaces, preambleLines) {
  const currencyLine = preambleLines.map((line) => line.match(/^\s*(?:currency|币种|货币)\s*[:：,]?\s*([a-z]{3})\s*$/i)?.[1]).find(Boolean)
  const explicitCurrency = normalizeCurrencyCode(currencyLine)
  const sites = new Set()
  const suffixes = new Map([
    ['com', 'US'], ['com.au', 'AU'], ['com.mx', 'MX'], ['co.jp', 'JP'], ['co.uk', 'UK'],
    ['ca', 'CA'], ['mx', 'MX'], ['de', 'DE'], ['fr', 'EU'], ['it', 'EU'], ['nl', 'EU'],
    ['es', 'EU'], ['eu', 'EU'], ['sg', 'SG'], ['jp', 'JP'], ['cn', 'CN'],
  ])
  const siteToCcy = getSiteToCurrency()
  for (const raw of marketplaces) {
    const v9Site = resolveAmazonV9Site(raw)
    if (v9Site) {
      sites.add(v9Site.site)
      continue
    }
    const name = raw.toLowerCase().replace(/^https?:\/\/|^www\./g, '').replace(/\/$/, '')
    const code = name.toUpperCase()
    if (Object.hasOwn(siteToCcy, code)) sites.add(code)
    else {
      const suffix = name.match(/^amazon(?: marketplace)?\.([a-z.]+)$/)?.[1]
      if (suffix && suffixes.has(suffix)) sites.add(suffixes.get(suffix))
    }
  }
  const currencies = new Set([...sites].map((site) => siteToCcy[site]))
  const currency = explicitCurrency !== 'UNKNOWN' ? explicitCurrency
    : currencies.size === 1 ? currencies.values().next().value : 'UNKNOWN'
  const explicitSite = sites.size === 1 ? sites.values().next().value : null
  const site = explicitSite || CURRENCY_TO_SITE[currency] || 'GLOBAL'
  return { site, explicitSite, currency }
}

/** Flat File V2 documents currency on settlement metadata rows. */
function amazonV2Currency(rows, columns, inferred) {
  if (!('currency' in columns)) return inferred
  const settlements = new Map()
  for (const row of rows) {
    const id = cell(row, columns.settlement_id)
    const raw = cell(row, columns.currency)
    if (!id || !raw) continue
    const code = normalizeCurrencyCode(raw)
    if (code === 'UNKNOWN' || (settlements.has(id) && settlements.get(id) !== code)) return 'UNKNOWN'
    settlements.set(id, code)
  }
  const currencies = new Set()
  for (const row of rows) {
    const id = cell(row, columns.settlement_id)
    const raw = cell(row, columns.currency)
    if (!id && !raw && !cell(row, columns.amount) && !cell(row, columns.total_amount)) continue
    currencies.add(raw ? normalizeCurrencyCode(raw) : settlements.get(id) ?? 'UNKNOWN')
  }
  return currencies.size === 1 ? currencies.values().next().value : 'UNKNOWN'
}

function parseAmazonV2(fileName, rows, hdrIdx, colMap, formatInfo) {
  const fundColumns = evidenceColumns(rows[hdrIdx])
  const dataRows = rows.slice(hdrIdx + 1)
  const dates = dataRows.map((r) => cell(r, colMap.posted_date) || cell(r, colMap.settlement_end_date)).filter(Boolean)
  const mps = dataRows.map((r) => cell(r, colMap.marketplace_name)).filter(Boolean)
  const { site, explicitSite, currency: infCcy } = inferAmazonSiteAndCcy(mps, [])
  const currency = amazonV2Currency(dataRows, colMap, infCcy)
  const dateOrder = inferAmazonDateOrder(site, rows[hdrIdx], explicitSite, currency)
  const s = makeEmptySummary({
    period: inferPeriod(dates, '待确认期间', { dateOrder }),
    platform: 'Amazon',
    site,
    currency,
    formatLabel: `Amazon Flat File V2 (${formatInfo})`,
    fileName,
  })
  if (hasAmbiguousSlashDates(dates, dateOrder)) {
    s.anomalies.push({
      severity: 'P1-高危',
      category: '账单日期存在日/月歧义（待核）',
      refId: 'AMZ-DATE-AMBIG',
      amount: '0.00',
      detail: '未确认站点/语种且检测到 DD/MM 与 MM/DD 无法区分的斜杠日期，账期已暂挂待核。',
    })
  }
  appendDateValidationAnomalies(s, dates, dateOrder, 'AMZ-V2')

  let reimbNet = 0n
  let taxCollectedTotal = 0n
  let withheldTotal = 0n
  const amazon2027Hits = new Map()
  const countedOrderIds = new Set()

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    const txType = cell(r, colMap.transaction_type)
    const amtType = cell(r, colMap.amount_type)
    const amtDesc = cell(r, colMap.amount_description)
    const totRaw = cell(r, colMap.total_amount)
    const amt = parseAmount(cell(r, colMap.amount))
    const orderId = cell(r, colMap.order_id) || `Row-${hdrIdx + 2 + i}`

    if (!txType && !amtType && totRaw !== '') {
      const payout = parseAmountCell(totRaw)
      if (payout.state === 'value') addPayoutEvidence(s, r, fundColumns, cell(r, colMap.deposit_date) || cell(r, colMap.settlement_end_date), payout.value, cell(r, colMap.settlement_id), dateOrder)
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
    if (['tax', 'shippingtax', 'giftwraptax', 'promotiontax'].includes(adl) || (!atl.includes('fee') && adl.endsWith('tax'))) {
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
        detail: `请区分销售补贴与非销售仓储理赔。`,
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
        detail: `请核对争议费并与销售额分列。`,
      })
    }

    if (atl.includes('itemprice')) {
      if (isRefund) s.customerRefund += -amt
      else {
        s.grossSales += amt
        if (amt > 0n && !adl.includes('shipping') && !adl.includes('gift') && !adl.includes('wrap') && !adl.includes('tax')) {
          // 同一订单多 SKU 明细行按原表订单号去重计 1 单，订单号缺失时才按行回退
          const rawOrderId = cell(r, colMap.order_id)
          if (!rawOrderId) s.orderCount++
          else if (!countedOrderIds.has(rawOrderId)) {
            countedOrderIds.add(rawOrderId)
            s.orderCount++
          }
        }
      }
    } else if (atl.includes('promotion')) {
      if (isRefund) s.customerRefund += -amt
      else s.sellerDiscount += -amt
    } else if (matchAmazon2027FeeFast(amtType, amtDesc)) {
      const fee2027 = matchAmazon2027FeeFast(amtType, amtDesc)
      recordAmazon2027Hit(amazon2027Hits, fee2027, -amt)
      s.logisticsWarehousing += -amt
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
  flushAmazon2027Hits(s, amazon2027Hits)

  return [finalizeSummary(s)]
}

function parseAmazonDateRange(fileName, rows, hdrIdx, colMap, formatInfo) {
  const preamble = rows.slice(0, hdrIdx).map((r) => r.join(' '))
  const fundColumns = evidenceColumns(rows[hdrIdx])
  const dataRows = rows.slice(hdrIdx + 1)
  const dates = dataRows.map((r) => cell(r, colMap.date_time)).filter(Boolean)
  const mps = dataRows.map((r) => cell(r, colMap.marketplace)).filter(Boolean)
  const { site, explicitSite, currency } = inferAmazonSiteAndCcy(mps, preamble)
  const dateOrder = inferAmazonDateOrder(site, rows[hdrIdx], explicitSite, currency)
  const typeSets = getAmazonTypeSets()

  const s = makeEmptySummary({
    period: inferPeriod(dates, '待确认期间', { dateOrder }),
    platform: 'Amazon',
    site,
    currency,
    formatLabel: `Amazon Date Range CSV (${formatInfo}，自动跳过表头前说明 ${hdrIdx} 行)`,
    fileName,
  })
  if (hasAmbiguousSlashDates(dates, dateOrder)) {
    s.anomalies.push({
      severity: 'P1-高危',
      category: '账单日期存在日/月歧义（待核）',
      refId: 'AMZ-DATE-AMBIG',
      amount: '0.00',
      detail: '未确认站点/语种且检测到 DD/MM 与 MM/DD 无法区分的斜杠日期，账期已暂挂待核。',
    })
  }
  appendDateValidationAnomalies(s, dates, dateOrder, 'AMZ-DR')

  const compKeys = [
    'product_sales', 'product_sales_tax', 'shipping_credits', 'shipping_credits_tax',
    'gift_wrap_credits', 'giftwrap_credits_tax', 'regulatory_fee', 'tax_on_regulatory_fee',
    'promotional_rebates', 'promotional_rebates_tax', 'marketplace_withheld_tax',
    'selling_fees', 'fba_fees', 'other_transaction_fees', 'other',
  ]
  const presentKeys = compKeys.filter((k) => k in colMap)
  let reimbNet = 0n
  const amazon2027Hits = new Map()

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

    const isTransferRow = typeSets.transfer.has(tl) || dl.includes('to ending balance')
    const isReserveRow =
      typeSets.reserve.has(tl) ||
      ['account level reserve', 'current reserve', 'previous reserve', 'reserve amount', 'unavailable balance', '预留金额', '储备金', 'solde indisponible', 'saldo non disponibile', 'saldo no disponible'].some((w) => dl.includes(w))

    const cv = Object.fromEntries(compKeys.map((k) => [k, k in colMap ? parseAmount(cell(r, colMap[k])) : 0n]))
    if (presentKeys.length > 0 && ((!isTransferRow && !isReserveRow) || 'other' in colMap)) {
      const horizSum = presentKeys.reduce((acc, k) => acc + cv[k], 0n)
      const horizDiff = q2(total - horizSum)
      if (absBig(horizDiff) >= CENT_STEP) {
        s.horizontalDiffTotal += horizDiff
        s.anomalies.push({
          severity: 'P0-阻断',
          category: '行内水平勾稽不守恒',
          refId: orderId,
          amount: fmtAmount(horizDiff),
          detail: `第 ${hdrIdx + 2 + i} 行分项合计 (${fmtAmount(horizSum)}) 与 total 列 (${fmtAmount(total)}) 不等，疑似导出截断或手工改动`,
        })
      }
    }

    if (isTransferRow) {
      if (parseAmountCell(cell(r, colMap.total)).state === 'value') {
        addPayoutEvidence(s, r, fundColumns, cell(r, colMap.date_time), -total, cell(r, colMap.settlement_id), dateOrder)
      }
      continue
    }

    if (isReserveRow) {
      s.reserveNetChange += -total
      continue
    }

    const taxCollected =
      cv.product_sales_tax + cv.shipping_credits_tax + cv.giftwrap_credits_tax + cv.promotional_rebates_tax + cv.tax_on_regulatory_fee
    const withheldTax = cv.marketplace_withheld_tax
    const taxNet = taxCollected + withheldTax
    if (withheldTax !== 0n) s.facilitatorTaxStripped += absBig(withheldTax)
    if (absBig(taxNet) >= CENT_STEP) s.selfRemitTaxNet += taxNet

    const fee2027 = matchAmazon2027FeeFast(rawType, desc)

    if (typeSets.serviceFee.has(tl) || dl.includes('cost of advertising') || dl.includes('广告')) {
      const signedFee = -total + taxNet
      if (fee2027?.bucket === 'logisticsWarehousing') {
        recordAmazon2027Hit(amazon2027Hits, fee2027, signedFee)
        s.logisticsWarehousing += signedFee
      } else if (dl.includes('advertising') || dl.includes('广告') || dl.includes('sponsored')) {
        s.inPlatformAds += signedFee
      } else {
        s.platformCommission += signedFee
      }
      continue
    }

    if (
      tl.includes('inventory fee') ||
      tl.includes('shipping services') ||
      typeSets.inventoryFee.has(tl)
    ) {
      const signedFee = -total + taxNet
      if (fee2027) recordAmazon2027Hit(amazon2027Hits, fee2027, signedFee)
      s.logisticsWarehousing += signedFee
      continue
    }

    if (
      typeSets.adjustment.has(tl) ||
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
        detail: `请区分销售补贴与非销售理赔。`,
      })
      continue
    }

    const isClaimOrCb = ['chargeback', 'a-to-z', 'guarantee claim', '索赔', '拒付', 'retrocharge'].some((k) => tl.includes(k))
    const isRefund = isClaimOrCb || typeSets.refundKeywords.some((k) => tl.includes(k))
    const isOrder = typeSets.orderKeywords.some((k) => tl.includes(k))

    if (!isOrder && !isRefund) {
      const netExTax = total - taxNet
      if (fee2027) {
        recordAmazon2027Hit(amazon2027Hits, fee2027, -netExTax)
        s.logisticsWarehousing += -netExTax
        continue
      }
      s.anomalies.push({
        severity: 'P1-高危',
        category: '未识别交易类型',
        refId: orderId,
        amount: fmtAmount(total),
        detail: `发现非常规交易类型，请在原账单中核对。`,
      })
      if (netExTax < 0n) s.platformCommission += -netExTax
      else reimbNet += netExTax
      continue
    }

    if (fee2027) {
      const trackedSigned = cv.fba_fees !== 0n ? -cv.fba_fees : cv.other_transaction_fees !== 0n ? -cv.other_transaction_fees : -total
      recordAmazon2027Hit(amazon2027Hits, fee2027, trackedSigned)
    }

    if (isClaimOrCb) {
      s.anomalies.push({
        severity: 'P1-高危',
        category: 'A-to-z索赔/拒付/Retrocharge',
        refId: orderId,
        amount: fmtAmount(total),
        detail: `请核查货物退回状态与拒付争议裁决。`,
      })
    }

    const grossItems = cv.product_sales + cv.shipping_credits + cv.gift_wrap_credits
    const promo = cv.promotional_rebates
    const sellFee = cv.selling_fees + cv.regulatory_fee
    const fbaFee = cv.fba_fees
    const otherTxFee = cv.other_transaction_fees
    const otherCol = cv.other

    if (isOrder) {
      if (grossItems > 0n) s.orderCount++
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
  flushAmazon2027Hits(s, amazon2027Hits)

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
  customer_shipping: ['customer shipping fee', 'buyer paid shipping fee', 'customer paid shipping fee', 'customer paid shipping fee before discounts', '买家支付运费', '买家实付运费'],
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
  payout_date: ['payout date', 'payment date', '打款日期', '放款日期'],
}

function parseTikTokSheets(fileName, sheets, formatInfo) {
  let detailSheet = null
  const payoutSheets = []

  for (const [sName, rows] of sheets) {
    const dm = tiktokDetailHeader(rows)
    if (dm) {
      if (!detailSheet || Object.keys(dm[1]).length > Object.keys(detailSheet[3]).length) {
        detailSheet = [sName, rows, dm[0], dm[1]]
        continue
      }
    }
    const pm = tiktokPayoutHeader(rows)
    if (pm) {
      payoutSheets.push([sName, rows, pm[0], pm[1]])
    }
  }
  if (!detailSheet) return null

  const [, rows, hdrIdx, colMap] = detailSheet
  const fundColumns = evidenceColumns(rows[hdrIdx])
  const dataRows = rows.slice(hdrIdx + 1)
  const dates = dataRows.map((r) => cell(r, colMap.statement_date)).filter(Boolean)
  const regions = dataRows.map((r) => cell(r, colMap.region).toUpperCase()).filter(Boolean)
  const siteToCcy = getSiteToCurrency()
  const explicitSite = regions.find((region) => Object.hasOwn(siteToCcy, region) || inferDateOrderFromSite(region)) || null
  const site = explicitSite || 'GLOBAL'
  const currency = reportedCurrency(dataRows, colMap.currency)
  const dateOrder = inferDateOrderFromSite(explicitSite) || (DMY_CURRENCIES.has(currency) ? 'DMY' : null)

  const s = makeEmptySummary({
    period: inferPeriod(dates, '待确认期间', { dateOrder }),
    platform: 'TikTok Shop',
    site,
    currency,
    formatLabel: `TikTok Shop (${formatInfo})`,
    fileName,
  })
  appendDateValidationAnomalies(s, dates, dateOrder, 'TTS')

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
        detail: `检测到全托管供货与自运营/半托管零售订单混同，纳税义务与对手方截然不同，严禁混报！`,
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
      const payout = parseAmountCell(cell(r, colMap.payout_amount) || cell(r, colMap.settlement_amount))
      if (payout.state === 'value') addPayoutEvidence(s, r, fundColumns, cell(r, colMap.statement_date), payout.value, undefined, dateOrder)
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
      addPayoutEvidence(s, r, fundColumns, cell(r, colMap.statement_date), payAmt, undefined, dateOrder)
    }

    const isSampleRow =
      tl.includes('sample') ||
      rl.includes('sample') ||
      tl.includes('寄样') ||
      rl.includes('寄样') ||
      (gross > 0n && absBig(gross + sDisc) === 0n && (shipFee !== 0n || rl.includes('free')))
    if (isSampleRow) {
      s.freeSampleCount++
      s.anomalies.push({
        severity: 'P2-关注',
        category: '达人免费寄样 (Free Sample)',
        refId: orderId,
        amount: fmtAmount(shipFee !== 0n ? shipFee : gross),
        detail: `识别到达人免费寄样出库，需核查无偿转让视同应税交易边界并留存推广合作证据`,
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
        detail: `请单独核对拒付争议费。`,
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
      if (!isRefundRow && !isSampleRow && gAdd > 0n) s.orderCount++
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
          detail: `第 ${hdrIdx + 2 + i} 行分项合计 (${fmtAmount(expected)}) 与应结算列 (${fmtAmount(settleAmt)}) 差额 ${fmtAmount(hDiff)}`,
        })
      }
    }
  }

  if (subsidyAccum >= 0n) s.platformSubsidy += subsidyAccum
  else s.sellerDiscount += -subsidyAccum

  const payoutDetailIds = new Set(dataRows.map((row) => cell(row, colMap.statement_id).toLowerCase()).filter(Boolean))
  for (const [, pRows, pHdr, pMap] of payoutSheets) {
    const payoutColumns = evidenceColumns(pRows[pHdr])
    for (const pr of pRows.slice(pHdr + 1)) {
      const sid = cell(pr, pMap.statement_id).toLowerCase()
      if (['total', '合计', '总计'].includes(sid)) continue
      if (!payoutDetailIds.has(sid)) continue
      const rHeld = parseAmount(cell(pr, pMap.reserve_held))
      const rRel = parseAmount(cell(pr, pMap.reserve_released))
      const pOut = parseAmountCell(cell(pr, pMap.payout_amount))
      if (!hasInlineReserve && (rHeld !== 0n || rRel !== 0n)) {
        s.reserveNetChange += absBig(rHeld) - absBig(rRel)
      }
      if (!hasInlinePayout && pOut.state === 'value') {
        addPayoutEvidence(s, pr, payoutColumns, cell(pr, pMap.payout_date), pOut.value, undefined, dateOrder)
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
  created: ['date', 'created', 'created utc', 'created date', 'available on', '入账时间', '创建时间', '交易日期'],
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

function stripeStrength(rows, hdrIdx, columns) {
  if (!('created' in columns && 'currency' in columns && 'tx_type' in columns &&
        'amount' in columns && 'fee' in columns && 'net' in columns)) return 0
  const sample = rows.slice(hdrIdx + 1, hdrIdx + 26)
  if (sample.some((row) => /^(?:txn_|ch_|py_|po_|re_|du_|iss_)/i.test(cell(row, columns.tx_id)))) return 3
  if (sample.some((row) => /^(?:charge|stripe_fee|payment_refund|reserve_transaction|refund|dispute)$/i.test(cell(row, columns.tx_type)))) return 2
  return sample.some((row) => /^(?:payout|payment|payout_failure|payout_cancel|payout_reversal)$/i.test(cell(row, columns.tx_type))) ? 1 : 0
}

function parseStripeRows(fileName, rows, hdrIdx, colMap, formatInfo) {
  const fundColumns = evidenceColumns(rows[hdrIdx])
  const dataRows = rows.slice(hdrIdx + 1)
  const byCcy = new Map()
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    const ccy = normalizeCurrencyCode(cell(r, colMap.currency))
    if (!byCcy.has(ccy)) byCcy.set(ccy, [])
    byCcy.get(ccy).push([hdrIdx + 2 + i, r])
  }

  const explicitUsHint = /(?:^|[._\s-])US(?:$|[._\s-])/i.test(fileName)
  const out = []
  for (const [ccy, indexedRows] of byCcy.entries()) {
    const dates = indexedRows.map(([, r]) => cell(r, colMap.created)).filter(Boolean)
    const site = CURRENCY_TO_SITE[ccy] || 'GLOBAL'
    const dateOrder = DMY_CURRENCIES.has(ccy) ? 'DMY' : (ccy === 'USD' && explicitUsHint ? 'MDY' : null)
    const s = makeEmptySummary({
      period: inferPeriod(dates, '待确认期间', { dateOrder }),
      platform: 'Stripe',
      site,
      currency: ccy,
      formatLabel: `Stripe Balance (${formatInfo})`,
      fileName,
    })
    appendDateValidationAnomalies(s, dates, dateOrder, 'STR')

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

      const isPayoutOrTransfer = ['payout', 'transfer', 'payout_failure', 'payout_cancel', 'payout_reversal', '提现', '打款'].includes(tl) && !tl.includes('connect')
      const isPayoutReversal = ['payout_failure', 'payout_cancel', 'payout_reversal'].includes(tl)
      if (isPayoutReversal && amt > 0n && parseAmountCell(cell(r, colMap.amount)).state === 'value') {
        addPayoutEvidence(s, r, fundColumns, cell(r, colMap.created), -absBig(amt), cell(r, colMap.tx_id), dateOrder)
      }
      const isChargeRow = ['charge', 'payment', '收款', '支付成功'].includes(tl)
      const isInvalidChargeFlag = isChargeRow && ['false', 'no', '0', '未捕获'].includes(capturedFlag)
      if (
        ['uncaptured', 'authorized', 'requires_capture', 'failed', 'canceled', 'cancelled', 'voided', 'test'].includes(status) ||
        isInvalidChargeFlag ||
        ['uncaptured', 'void', 'failed'].includes(tl) || isPayoutReversal
      ) {
        if (isPayoutOrTransfer) {
          s.anomalies.push({
            severity: 'P1-高危',
            category: '网关提现/打款失败或取消',
            refId: txId,
            amount: fmtAmount(amt),
            detail: `提现未成功，请核对银行账户退汇流水。`,
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
          if (parseAmountCell(cell(r, colMap.amount)).state === 'value') {
            addPayoutEvidence(s, r, fundColumns, cell(r, colMap.created), -amt, cell(r, colMap.tx_id), dateOrder)
          }
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
          detail: `检测到从网关余额直接扣付海外广告费：须还原收支两条线全额确认销售收入，严禁坐支冲抵收入！`,
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
        if (amt > 0n) s.orderCount++
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
            detail: `本金变动 ${fmtAmount(amt)}，不可退争议处理费 ${fmtAmount(feeDeduction)}（争议费应计财务费用，勿冲减收入）`,
          })
        }
        continue
      }

      s.anomalies.push({
        severity: 'P1-高危',
        category: '未识别网关流水类型',
        refId: txId,
        amount: fmtAmount(net),
        detail: `未知网关类型，请在原账单中核对。`,
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

function hasColumns(columns, ...keys) {
  return keys.every((key) => key in columns)
}

function tiktokDetailHeader(rows) {
  const match = findHeaderRow(rows, TIKTOK_DETAIL_ALIASES, 5)
  if (!match) return null
  const [, map] = match
  return hasColumns(map, 'tx_type', 'currency') &&
    ('order_id' in map || 'statement_id' in map) &&
    ('gross_sales' in map || 'affiliate_commission' in map) &&
    ('settlement_amount' in map || 'statement_date' in map) ? match : null
}

function tiktokPayoutHeader(rows) {
  const match = findHeaderRow(rows, TIKTOK_SUMMARY_ALIASES, 3, 45, true)
  return match && hasColumns(match[1], 'statement_id', 'payout_amount') ? match : null
}

let _salesAdaptersCache = null
function getSalesAdapters() {
  if (!_salesAdaptersCache) {
    _salesAdaptersCache = [
      {
        platform: 'Amazon', aliases: AMAZON_V2_ALIASES, minimum: 6,
        match: (_rows, _header, map) => hasColumns(map, 'amount_type', 'settlement_id', 'amount', 'transaction_type'),
        parse: (fileName, [, rows], [header, map], format) => parseAmazonV2(fileName, rows, header, map, format),
      },
      {
        platform: 'Amazon', aliases: getAmazonDrAliases(), minimum: 6,
        match: (_rows, _header, map) => hasColumns(map, 'date_time', 'total', 'type') &&
          ('product_sales' in map || 'fba_fees' in map),
        parse: (fileName, [, rows], [header, map], format) => parseAmazonDateRange(fileName, rows, header, map, format),
      },
      {
        platform: 'TikTok Shop', detect: tiktokDetailHeader,
        parse: (fileName, sheet, _found, format, supplemental) => parseTikTokSheets(fileName, [sheet, ...supplemental], format),
      },
      { platform: 'AliExpress', aliases: ALIEXPRESS_ALIASES, minimum: 4, check: isAliExpressMatch, parseSheets: parseAliExpressSheets },
      { platform: 'Temu', aliases: TEMU_ALIASES, minimum: 4, check: isTemuMatch, parseSheets: parseTemuSheets },
      { platform: 'Shopee', aliases: SHOPEE_ALIASES, minimum: 4, check: isShopeeMatch, parseSheets: parseShopeeSheets },
      { platform: 'PayPal', aliases: PAYPAL_ALIASES, minimum: 5, check: isPayPalMatch, parseSheets: parsePayPalSheets },
      { platform: 'Shopify', aliases: SHOPIFY_ALIASES, minimum: 4, check: isShopifyMatch, parseSheets: parseShopifySheets },
      {
        platform: 'Stripe', aliases: STRIPE_ALIASES, minimum: 6,
        strength: stripeStrength,
        parse: (fileName, [, rows], [header, map], format) => parseStripeRows(fileName, rows, header, map, format),
      },
      ...V9_SALES_ADAPTERS.map((adapter) => ({
        platform: adapter.platform,
        aliases: adapter.aliases,
        minimum: adapter.minimum,
        passFileName: true,
        check: adapter.check,
        parseSheets: adapter.parseSheets,
      })),
    ]
  }
  return _salesAdaptersCache
}
const HINT_NAMES = new Map([
  ['amazon', 'Amazon'], ['tiktok', 'TikTok Shop'], ['temu', 'Temu'], ['aliexpress', 'AliExpress'], ['ae', 'AliExpress'],
  ['shopee', 'Shopee'], ['paypal', 'PayPal'], ['shopify', 'Shopify'], ['stripe', 'Stripe'],
  ['shein', 'SHEIN'], ['walmart', 'Walmart'], ['lazada', 'Lazada'],
  ['worldfirst', 'WorldFirst'], ['wf', 'WorldFirst'], ['payoneer', 'Payoneer'], ['airwallex', 'Airwallex'], ['awx', 'Airwallex'],
  ['lianlian', 'LianLian'], ['ll', 'LianLian'], ['pingpong', 'PingPong'], ['ppg', 'PingPong'], ['sunrate', 'SUNRATE'], ['sr', 'SUNRATE'],
  ['bank_receipt', 'BankReceipt'], ['bank', 'BankReceipt'], ['cmb', 'BankReceipt'], ['boc', 'BankReceipt'],
  ['icbc', 'BankReceipt'], ['ccb', 'BankReceipt'], ['abc', 'BankReceipt'], ['bocom', 'BankReceipt'],
])
const WALLET_NAMES = new Set(['WorldFirst', 'Payoneer', 'Airwallex'])
const V9_WALLET_NAMES = new Set(['LianLian', 'PingPong', 'SUNRATE'])

function normalizeBankReceiptSummary(parsedBank) {
  const s = {
    ...makeEmptySummary({
      period: parsedBank.period || '待确认期间',
      platform: parsedBank.bankLabel || '国内对公银行',
      site: 'CN',
      currency: parsedBank.currency === 'MULTI' ? 'CNY' : (parsedBank.currency === 'UNKNOWN' ? 'UNKNOWN' : (parsedBank.currency || 'CNY')),
      formatLabel: parsedBank.formatLabel,
      fileName: parsedBank.fileName,
    }),
    ...parsedBank,
    role: 'bank_receipt',
    platform: parsedBank.bankLabel || '国内对公银行',
    site: 'CN',
    currency: parsedBank.currency || 'CNY',
  }
  return finalizeSummary(s)
}

function identifySheet(rows, hint, fileName = '') {
  const candidates = []
  for (const adapter of getSalesAdapters()) {
    if (hint && hint !== adapter.platform) continue
    const found = adapter.detect ? adapter.detect(rows) : findHeaderRow(rows, adapter.aliases, adapter.minimum)
    if (!found) continue
    const [header, map] = found
    if (adapter.match && !adapter.match(rows, header, map)) continue
    if (adapter.check && !adapter.check(adapter.passFileName ? fileName : '', rows, header, map)) continue
    const score = adapter.strength ? adapter.strength(rows, header, map) : 4
    if (score) candidates.push({ platform: adapter.platform, adapter, found, score })
  }
  const v8Wallets = (!hint || WALLET_NAMES.has(hint))
    ? findWalletCandidates(rows, hint, fileName).map((wc) => ({ ...wc, isV8Wallet: true }))
    : []
  const v9Wallets = (!hint || V9_WALLET_NAMES.has(hint))
    ? findV9WalletCandidates(rows, hint && V9_WALLET_NAMES.has(hint) ? hint : null, fileName).map((wc) => ({ ...wc, isV9Wallet: true }))
    : []

  // 防抢占与显式冲突拦截：
  // 1) 已有高置信 v0.8 钱包通道（score >= 2）时，直接剔除低分匿名/通用 v9 候选（score <= 2）；
  // 2) 若同时命中高置信 v0.8（score >= 2）与显式品牌 v9（score >= 3），说明通道特征明确冲突，强制拉平分数回报 STATEMENT_CANDIDATE_CONFLICT！
  const maxV8Score = v8Wallets.length ? Math.max(...v8Wallets.map((c) => c.score)) : 0
  const filteredV9 = maxV8Score >= 2 ? v9Wallets.filter((c) => c.score >= 3) : v9Wallets
  const maxV9Score = filteredV9.length ? Math.max(...filteredV9.map((c) => c.score)) : 0
  if (maxV8Score >= 2 && maxV9Score >= 3) {
    const conflictScore = Math.max(maxV8Score, maxV9Score)
    for (const c of v8Wallets) {
      if (c.score === maxV8Score) candidates.push({ ...c, score: conflictScore })
    }
    for (const c of filteredV9) {
      if (c.score === maxV9Score) candidates.push({ ...c, score: conflictScore })
    }
  } else {
    candidates.push(...v8Wallets, ...filteredV9)
  }

  if (!hint || hint === 'BankReceipt') {
    let bankDet = detectBankReceipt(null, fileName, rows)
    if (!bankDet && hint === 'BankReceipt') {
      const manualMatch = findHeaderRow(rows, BANK_RECEIPT_ALIASES, 3, 45, false)
      if (manualMatch) {
        bankDet = {
          detected: true, role: 'bank_receipt', bank: 'GENERIC_BANK', bankLabel: '国内对公银行',
          headerIndex: manualMatch[0], columns: manualMatch[1], score: 4, confidence: 'medium',
        }
      }
    }
    if (bankDet?.detected) {
      candidates.push({ platform: bankDet.bankLabel, role: 'bank_receipt', bankReceipt: bankDet, score: bankDet.score })
    }
  }
  if (!candidates.length) return []
  const highestScore = Math.max(...candidates.map((candidate) => candidate.score))
  return candidates.filter((candidate) => candidate.score === highestScore)
}

let _safeHeadersCache = null
function getSafeHeaders() {
  if (_safeHeadersCache) return _safeHeadersCache
  const map = new Map()
  const salesAdapters = getSalesAdapters()
  const v9Names = new Set(V9_SALES_ADAPTERS.map((adapter) => adapter.platform))
  for (const aliases of [
    ...salesAdapters.filter((adapter) => !v9Names.has(adapter.platform)).map((adapter) => adapter.aliases).filter(Boolean),
    TIKTOK_DETAIL_ALIASES, TIKTOK_SUMMARY_ALIASES, WORLDFIRST_ALIASES, PAYONEER_ALIASES, AIRWALLEX_ALIASES,
  ]) {
    for (const [field, names] of Object.entries(aliases)) {
      for (const name of names) map.set(normHeader(name), field)
    }
  }
  for (const aliases of [
    ...V9_SALES_ADAPTERS.map((adapter) => adapter.aliases).filter(Boolean),
    LIANLIAN_ALIASES, PINGPONG_ALIASES, SUNRATE_ALIASES, BANK_RECEIPT_ALIASES,
  ]) {
    for (const [field, names] of Object.entries(aliases)) {
      for (const name of names) {
        const normalized = normHeader(name)
        if (!map.has(normalized)) map.set(normalized, field)
      }
    }
  }
  _safeHeadersCache = map
  return map
}

function sheetDiagnostic(rows, sheetIndex, code, candidates = []) {
  const safeHeaders = getSafeHeaders()
  const candidateRows = []
  for (const [index, row] of rows.slice(0, 12).entries()) {
    const fields = [...new Set(row.map((value) => safeHeaders.get(normHeader(value))).filter(Boolean))].slice(0, 16)
    if (fields.length) candidateRows.push({ row: rowNumbers.get(row) ?? index + 1, fields })
    if (candidateRows.length === 3) break
  }
  const diagnostic = { code, sheetIndex }
  if (candidateRows.length) diagnostic.candidateRows = candidateRows
  if (candidates.length) diagnostic.candidates = candidates
  return diagnostic
}

const AMOUNT_FIELDS = new Set(('total total_amount amount product_sales product_sales_tax shipping_credits shipping_credits_tax gift_wrap_credits giftwrap_credits_tax regulatory_fee tax_on_regulatory_fee promotional_rebates promotional_rebates_tax marketplace_withheld_tax selling_fees fba_fees other_transaction_fees other gross_sales customer_shipping seller_discount seller_shipping_discount platform_discount platform_shipping_subsidy refund_subtotal seller_discount_refund platform_discount_refund refund_shipping commission_fee transaction_fee chargeback_fee affiliate_commission affiliate_partner_commission shipping_fee ads_fee tax_collected tax_withheld adjustment_amount reserve_amount payout_amount settlement_amount reserve_held reserve_released fee net gross_before_discount retail_gross supply_settlement shipping_income platform_subsidy refund_amount logistics_fee penalty_fee withheld_tax reserve_change net_settlement subtotal shipping discount tax gross sales_tax order_gross affiliate_fee self_tax net_amount released_amount product_price buyer_shipping shopee_subsidy shipping_rebate service_fee actual_shipping supply_amount fulfillment_fee deduction_fee total_payable wfs_fee vat_in_amount wht_amount').split(' '))

function invalidAmountRows(rows, header, columns) {
  const moneyColumns = Object.entries(columns).filter(([name]) => AMOUNT_FIELDS.has(name))
  const invalid = []
  for (let index = header + 1; index < rows.length && invalid.length < 3; index++) {
    const row = rows[index]
    const fields = moneyColumns.filter(([, col]) => parseAmountCell(cell(row, col)).state === 'invalid').map(([name]) => name)
    if (fields.length) invalid.push({ row: rowNumbers.get(row) ?? index + 1, fields })
  }
  return invalid
}

function parseLoadedSheets(fileName, sheets, formatInfo, platformHint = 'auto') {
  const hintCode = String(platformHint || 'auto').toLowerCase()
  const hint = HINT_NAMES.get(hintCode)
  if (hintCode !== 'auto' && !hint) throw new StatementInputError('STATEMENT_UNKNOWN_FORMAT')
  const results = []
  const diagnostics = []
  const identified = sheets.map((sheet) => identifySheet(sheet[1], hint, fileName))
  const supplemental = new Map()
  // A TikTok companion page is attached only by a matching official statement ID.
  const tiktokIds = sheets.map(([, rows], i) => {
    const [candidate] = identified[i]
    if (identified[i].length !== 1 || candidate.platform !== 'TikTok Shop') return null
    const [header, map] = candidate.found
    return new Set(rows.slice(header + 1).map((row) => cell(row, map.statement_id).toLowerCase()).filter(Boolean))
  })
  for (const [i, sheet] of sheets.entries()) {
    if (identified[i].length || (hint && hint !== 'TikTok Shop')) continue
    const [, rows] = sheet
    const match = tiktokPayoutHeader(rows)
    if (!match) continue
    const [header, columns] = match
    const refs = rows.slice(header + 1).map((row) => cell(row, columns.statement_id).toLowerCase())
      .filter((id) => id && !['total', '合计', '总计'].includes(id))
    const owners = tiktokIds.map((ids, index) => ids && refs.length && refs.every((id) => ids.has(id)) ? index : -1).filter((index) => index >= 0)
    if (owners.length === 1) supplemental.set(i, owners[0])
  }
  for (const [i, sheet] of sheets.entries()) {
    if (supplemental.has(i)) continue
    const [, rows] = sheet
    const candidates = identified[i]
    if (candidates.length !== 1) {
      const code = candidates.length > 1 ? 'STATEMENT_CANDIDATE_CONFLICT' : rows.length ? 'STATEMENT_UNKNOWN_FORMAT' : 'STATEMENT_EMPTY'
      diagnostics.push(sheetDiagnostic(rows, i + 1, code, [...new Set(candidates.map((candidate) => candidate.platform))]))
      continue
    }
    const [candidate] = candidates
    let parsed
    if (candidate.adapter) {
      const invalid = invalidAmountRows(rows, ...candidate.found)
      if (invalid.length) diagnostics.push({ code: 'STATEMENT_AMOUNT_INVALID', sheetIndex: i + 1, candidateRows: invalid })
    }
    if (candidate.bankReceipt) {
      const bankParsed = parseBankReceiptRows(rows, {
        fileName, formatInfo,
        headerIndex: candidate.bankReceipt.headerIndex,
        columns: candidate.bankReceipt.columns,
        bank: candidate.bankReceipt.bank,
        bankLabel: candidate.bankReceipt.bankLabel,
      })
      parsed = bankParsed.rawRowCount > 0 || bankParsed.anomalies.length > 0 ? [normalizeBankReceiptSummary(bankParsed)] : []
    } else if (candidate.adapter?.parse) {
      const companionSheets = candidate.platform === 'TikTok Shop' ? sheets.filter((_, j) => supplemental.get(j) === i) : []
      parsed = candidate.adapter.parse(fileName, sheet, candidate.found, formatInfo, companionSheets)
    } else if (candidate.adapter?.parseSheets) {
      parsed = candidate.adapter.parseSheets(fileName, [sheet], formatInfo, candidate.found)
    } else if (candidate.isV9Wallet) {
      parsed = parseV9WalletSheet(fileName, rows, formatInfo, candidate)
      if (parsed.some((summary) => summary.walletMetrics?.invalidAmountCount)) {
        diagnostics.push({ code: 'STATEMENT_AMOUNT_INVALID', sheetIndex: i + 1 })
      }
    } else {
      parsed = parseWalletSheet(fileName, rows, formatInfo, candidate)
      if (parsed.some((summary) => summary.walletMetrics.invalidAmountCount)) {
        diagnostics.push({ code: 'STATEMENT_AMOUNT_INVALID', sheetIndex: i + 1 })
      }
    }
    if (parsed?.length) results.push(...parsed)
    else {
      diagnostics.push(sheetDiagnostic(rows, i + 1, 'STATEMENT_EMPTY'))
      for (const [j, owner] of supplemental) {
        if (owner === i) diagnostics.push(sheetDiagnostic(sheets[j][1], j + 1, 'STATEMENT_EMPTY'))
      }
    }
  }
  if (!results.length) {
    const conflict = diagnostics.some((diagnostic) => diagnostic.code === 'STATEMENT_CANDIDATE_CONFLICT')
    const anyRows = sheets.some(([, rows]) => rows.length)
    throw new StatementInputError(conflict ? 'STATEMENT_CANDIDATE_CONFLICT' : anyRows ? 'STATEMENT_UNKNOWN_FORMAT' : 'STATEMENT_EMPTY', diagnostics)
  }
  if (diagnostics.length) results[0].parseDiagnostics = diagnostics
  return results
}

export function parseStatementBuffer(buf, fileName, platformHint = 'auto', budget = createStatementBudget()) {
  const loaded = readTabularSheetsFromBuffer(buf, fileName, budget)
  const safeFileName = basename(fileName)
  if (loaded.kind !== 'zip') return parseLoadedSheets(safeFileName, loaded.sheets, loaded.formatInfo, platformHint)

  const combined = []
  const diagnostics = []
  for (const [index, [subName, subBuf]] of loaded.entries.entries()) {
    try {
      const subLoaded = readTabularSheetsFromBuffer(subBuf, subName, budget, true)
      const summaries = parseLoadedSheets(safeFileName, subLoaded.sheets, 'zip->' + subLoaded.formatInfo, platformHint)
      for (const summary of summaries) {
        if (summary.parseDiagnostics) {
          diagnostics.push(...summary.parseDiagnostics.map((diagnostic) => ({ ...diagnostic, entryIndex: index + 1 })))
          delete summary.parseDiagnostics
        }
      }
      combined.push(...summaries)
    } catch (error) {
      if (!(error instanceof StatementInputError) || error.code === 'STATEMENT_LIMIT') throw error
      const entryDiagnostics = error.diagnostics.length ? error.diagnostics : [{ code: error.code }]
      diagnostics.push(...entryDiagnostics.map((diagnostic) => ({ ...diagnostic, entryIndex: index + 1 })))
    }
  }
  if (!combined.length) throw new StatementInputError('STATEMENT_UNKNOWN_FORMAT', diagnostics)
  if (diagnostics.length) combined[0].parseDiagnostics = diagnostics
  return combined
}

/** Accept local statement paths or in-process synthetic demos. */
export function parsePlatformStatement(filePathOrPaths, platformHint = 'auto') {
  const list = Array.isArray(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths]
  const cleanList = list.map((value) => String(value ?? '').trim()).filter(Boolean)
  if (!cleanList.length) throw new StatementInputError('STATEMENT_EMPTY')
  if (cleanList.length > 24) throw new StatementInputError('STATEMENT_LIMIT')
  const budget = createStatementBudget()
  const summaries = []
  for (const file of cleanList) {
    if (/^demo(?::|$)/i.test(file)) {
      let samples
      try {
        samples = /^demo:v9$/i.test(file) ? getV9DemoBuffers() : getDemoStatementBuffers(file)
      } catch {
        throw new StatementInputError('STATEMENT_UNKNOWN_FORMAT')
      }
      for (const [name, buffer] of samples) summaries.push(...parseStatementBuffer(buffer, name, platformHint, budget))
      continue
    }
    summaries.push(...parseStatementBuffer(readStatementFile(file, budget), file, platformHint, budget))
  }
  return summaries
}
