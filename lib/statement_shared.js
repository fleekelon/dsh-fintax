// dsh-fintax 共享底层原语模块（零本地模块依赖，彻底消除顶层循环依赖 TDZ）。
// 仅依赖 Node.js 内置 node:crypto，供 statement.js / platforms_v8.js / platforms_v9.js / bank_receipt.js / report.js 共享。

import { createHmac, randomBytes } from 'node:crypto'

// 金额在原币汇总和折算中保留八位小数，只有展示时才量化到分。
export const AMOUNT_SCALE = 100000000n
export const CENT_STEP = AMOUNT_SCALE / 100n

export const PERSONAL_ACCOUNT_RE =
  /\bpersonal\b|private\s*(?:bank|account)|\bindividual\b|自然人|个人(?:账户|银行|储蓄|私户|卡|结算户)?|法人(?:私户|个人|卡)|私户|私卡|对私|储蓄卡/i

export const CORPORATE_ENTITY_RE =
  /co\.?\s*,?\s*ltd|\blimited\b|\bltd\b|\binc\b|\bllc\b|\bcorp(?:oration)?\b|corporate|business\s*account|\bpte\.?\b|\bgmbh\b|\bs\.?a\.?r\.?l\.?\b|\bb\.?v\.?\b|\bplc\b|pty\.?\s*ltd|sdn\.?\s*bhd|有限公司|有限责任公司|股份公司|[A-Za-z\u4e00-\u9fa5]{1,30}公司(?=$|[\s,，;；(（])|合伙企业|个体工商户|商行|经营部|工作室|贸易行|实业|集团|对公|公户|公司基本户|对公一般户|基本存款账户/i

export const COMMERCIAL_SPEND_RE =
  /\bsupplier\b|\bvendor\b|\bfactory\b|物流|供应商|采购款|广告|缴税|vat\s*payment|tax\s*payment|card\s*purchase|facebook|meta\s*ads|google\s*ads|yunexpress|freight|头程|海外仓|虚拟卡消费/i

const CURRENCY_CODES = new Set(
  ('AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNH CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG').split(' '),
)

const CURRENCY_ALIASES = new Map([
  ['RMB', 'CNY'], ['人民币', 'CNY'], ['¥', 'CNY'], ['￥', 'CNY'],
  ['美元', 'USD'], ['美金', 'USD'], ['US$', 'USD'], ['欧元', 'EUR'], ['€', 'EUR'],
  ['英镑', 'GBP'], ['£', 'GBP'], ['港币', 'HKD'], ['港元', 'HKD'], ['HK$', 'HKD'],
  ['日元', 'JPY'], ['澳元', 'AUD'], ['加元', 'CAD'], ['新加坡元', 'SGD'], ['新币', 'SGD'],
  ['林吉特', 'MYR'], ['马币', 'MYR'], ['泰铢', 'THB'], ['越南盾', 'VND'], ['印尼盾', 'IDR'],
])

export function normalizeCurrencyCode(raw) {
  const code = String(raw ?? '').trim().toUpperCase()
  return CURRENCY_ALIASES.get(code) ?? (CURRENCY_CODES.has(code) ? code : 'UNKNOWN')
}

const AMOUNT_PREFIX = /^(?<currency>[A-Za-z]{3}|(?:HK|US|CA|AU|NZ|SG)?\$|[€£¥￥])\s*/i
const AMOUNT_SUFFIX = /\s*(?<currency>[A-Za-z]{3}|(?:HK|US|CA|AU|NZ|SG)?\$|[€£¥￥])$/i
const AMOUNT_CURRENCY_SYMBOL = /^(?:(?:HK|US|CA|AU|NZ|SG)?\$|[€£¥￥])$/i

/** 有值、缺失和非法输入分别返回，支持美式、欧式、德式多级千位、法式窄/不换行空格及货币内外层会计括号。 */
export function parseAmountCell(raw) {
  if (raw === null || raw === undefined) return { state: 'missing' }
  if (typeof raw === 'bigint') return { state: 'value', value: raw }
  if (typeof raw === 'number' && !Number.isFinite(raw)) return { state: 'invalid' }
  let text = String(raw).trim()
  if (/^(?:-{0,2}|[\u2212\u2013\u2014\uff0d]{1,2}|N\/A|null|none|nan)$/i.test(text)) return { state: 'missing' }
  if (text.length > 96) return { state: 'invalid' }

  // 归一 Unicode 减号/破折号/全角负号为标准 ASCII '-'
  text = text.replace(/[\u2212\u2013\u2014\uff0d]/g, '-')

  let accounting = false
  if (text.startsWith('(') && text.endsWith(')')) {
    accounting = true
    text = text.slice(1, -1).trim()
  }
  let negative = accounting
  let signed = false
  if (/^[+-]/.test(text)) {
    signed = true
    negative ||= text[0] === '-'
    text = text.slice(1).trimStart()
  }
  const currencyMatch = AMOUNT_PREFIX.exec(text) || AMOUNT_SUFFIX.exec(text)
  if (currencyMatch) {
    const code = currencyMatch.groups.currency
    if (!AMOUNT_CURRENCY_SYMBOL.test(code) && normalizeCurrencyCode(code) === 'UNKNOWN') return { state: 'invalid' }
    text = currencyMatch.index === 0 ? text.slice(currencyMatch[0].length) : text.slice(0, currencyMatch.index)
    text = text.trim()
  }
  if (!accounting && text.startsWith('(') && text.endsWith(')')) {
    accounting = true
    negative = true
    text = text.slice(1, -1).trim()
  }
  if (!signed && /^[+-]/.test(text)) {
    negative ||= text[0] === '-'
    text = text.slice(1).trimStart()
  }
  // 逗号、小数点与法式/欧式空格（\u202f 窄不换行空格、\u00a0 不换行空格、ASCII 空格）只在合法三位分组或小数位置去除/替换。
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) text = text.replace(/,/g, '')
  else if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(text)) text = text.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(text)) text = text.replace(/\./g, '')
  else if (/^\d{1,3}(?:[\u00a0\u202f ]\d{3})+(?:,\d+)?$/.test(text)) text = text.replace(/[\u00a0\u202f ]/g, '').replace(',', '.')
  else if (/^\d{1,3}(?:[\u00a0\u202f ]\d{3})+\.\d+$/.test(text)) text = text.replace(/[\u00a0\u202f ]/g, '')
  else if (/^\d*,\d+$/.test(text)) text = text.replace(',', '.')

  const match = /^(\d*)(?:\.(\d+))?(?:[Ee]([+-]?\d{1,3}))?$/.exec(text)
  if (!match || !(match[1] || match[2])) return { state: 'invalid' }
  const fraction = match[2] || ''
  const digits = match[1] + fraction
  const exponent = Number(match[3] || 0)
  if (Math.abs(exponent) > 80 || digits.length > 60 || digits.length - fraction.length + exponent > 40) {
    return { state: 'invalid' }
  }
  const shift = 8 + exponent - fraction.length
  let value = BigInt(digits)
  if (shift >= 0) value *= 10n ** BigInt(shift)
  else {
    const divisor = 10n ** BigInt(-shift)
    value = (value + divisor / 2n) / divisor
  }
  return { state: 'value', value: negative ? -value : value }
}

export function parseAmount(raw) {
  return parseAmountCell(raw).value ?? 0n
}

export const absBig = (v) => (v < 0n ? -v : v)

export function mulScaledBig(a, b) {
  const prod = a * b
  const neg = prod < 0n
  const abs = neg ? -prod : prod
  const res = (abs + AMOUNT_SCALE / 2n) / AMOUNT_SCALE
  return neg ? -res : res
}

/** ROUND_HALF_UP 量化到 0.01（返回对齐到 CENT_STEP 的 BigInt）。 */
export function q2(val) {
  const neg = val < 0n
  const a = neg ? -val : val
  const q = (a + CENT_STEP / 2n) / CENT_STEP
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

export const cell = (row, idx) => (idx == null || idx >= row.length ? '' : String(row[idx] ?? '').trim())

export function normHeader(text) {
  if (text == null) return ''
  return String(text)
    .trim()
    .replace(/^\ufeff/, '')
    .toLowerCase()
    .replace(/[\s_\-/\\（）()[\]【】:：.]+/g, ' ')
    .trim()
}

export function findHeaderRow(rows, aliasGroups, minMatched = 3, maxScanRows = 45, exactOnly = false) {
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
        if (normCells[cIdx] && !usedCols.has(cIdx) && aliases.includes(normCells[cIdx])) {
          colMap[canon] = cIdx
          usedCols.add(cIdx)
          break
        }
      }
    }
    const fuzzyPairs = []
    for (const [canon, aliases] of Object.entries(normAliases)) {
      if (exactOnly || canon in colMap) continue
      for (let cIdx = 0; cIdx < normCells.length; cIdx++) {
        if (!normCells[cIdx] || usedCols.has(cIdx)) continue
        let maxLen = 0
        for (const al of aliases) {
          if (al.length >= 5 && normCells[cIdx].includes(al) && al.length > maxLen) maxLen = al.length
        }
        if (maxLen > 0) fuzzyPairs.push([maxLen, canon, cIdx])
      }
    }
    fuzzyPairs.sort((a, b) => b[0] - a[0])
    for (const [, canon, cIdx] of fuzzyPairs) {
      if (!(canon in colMap) && !usedCols.has(cIdx)) {
        colMap[canon] = cIdx
        usedCols.add(cIdx)
      }
    }
    if (Object.keys(colMap).length >= minMatched && Object.keys(colMap).length > Object.keys(bestMap).length) {
      bestIdx = rIdx
      bestMap = colMap
    }
  }
  return bestIdx === null ? null : [bestIdx, bestMap]
}

export function detectDeductionSign(dataRows, colMap, grossKeys, deductionKeys, netKey) {
  let neg = 0
  let pos = 0
  for (const r of dataRows) {
    let hasGross = false
    for (const gk of grossKeys) {
      if (gk in colMap && parseAmount(cell(r, colMap[gk])) > 0n) { hasGross = true; break }
    }
    if (!hasGross) continue
    for (const dk of deductionKeys) {
      if (!(dk in colMap)) continue
      const v = parseAmount(cell(r, colMap[dk]))
      if (v < 0n) neg++
      else if (v > 0n) pos++
    }
  }
  if (neg === 0 && pos === 0 && netKey && netKey in colMap) {
    // 仅含冲回/退款行（无正销售额行）时，先按净额方程拟合确定符号约定，再辅以净额方向判断。
    let negFit = 0
    let posFit = 0
    for (const r of dataRows) {
      if (cell(r, colMap[netKey]) === '') continue
      const netVal = parseAmount(cell(r, colMap[netKey]))
      let gSum = 0n
      for (const gk of grossKeys) {
        if (gk in colMap) gSum += parseAmount(cell(r, colMap[gk]))
      }
      let dSum = 0n
      for (const dk of deductionKeys) {
        if (dk in colMap) dSum += parseAmount(cell(r, colMap[dk]))
      }
      if (dSum !== 0n) {
        const errPos = absBig(q2(netVal - (gSum - dSum)))
        const errNeg = absBig(q2(netVal - (gSum + dSum)))
        if (errNeg < CENT_STEP && errPos >= CENT_STEP) negFit++
        else if (errPos < CENT_STEP && errNeg >= CENT_STEP) posFit++
      }
      if (netVal < 0n) {
        for (const dk of deductionKeys) {
          if (!(dk in colMap)) continue
          const v = parseAmount(cell(r, colMap[dk]))
          if (v < 0n) neg++
          else if (v > 0n) pos++
        }
      } else if (netVal > 0n && gSum === 0n) {
        for (const dk of deductionKeys) {
          if (!(dk in colMap)) continue
          const v = parseAmount(cell(r, colMap[dk]))
          if (v > 0n) neg++
          else if (v < 0n) pos++
        }
      }
    }
    if (negFit !== posFit) return negFit > posFit ? -1n : 1n
  }
  return neg > pos ? -1n : 1n
}

// ── Excel 日期序列号还原（1900 制拒绝虚构 1900-02-29 即序号 60；1904 制上界严格 < 2957004） ──
const ISO_DATE_STRICT_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/

export function excelSerialToIsoDate(raw, date1904 = false) {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null
  if (typeof raw === 'string' && !raw.trim()) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  const minSerial = date1904 ? 0 : 1
  const maxSerialExclusive = date1904 ? 2_957_004 : 2_958_466
  if (n < minSerial || n >= maxSerialExclusive) return null
  const wholeDays = Math.floor(n)
  // Excel 1900 日期系统将序号 60 虚构为 1900-02-29（1900 非闰年），必须拦截避免静默映射为 1900-02-28。
  if (!date1904 && wholeDays === 60) return null
  const epochMs = date1904
    ? Date.UTC(1904, 0, 1) + wholeDays * 86_400_000
    : (wholeDays < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)) + wholeDays * 86_400_000
  const d = new Date(epochMs)
  if (Number.isNaN(d.getTime())) return null
  const year = d.getUTCFullYear()
  if (year < 1900 || year > 9999) return null
  const iso = d.toISOString().slice(0, 10)
  return ISO_DATE_STRICT_RE.test(iso) ? iso : null
}

// ── 日期与账期识别（支持欧洲站点/语种 DD/MM/YYYY 及歧义斜杠日期拦截） ──
const MONTHS = {
  // EN
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  // FR
  janv: '01', fev: '02', 'fév': '02', fevr: '02', 'févr': '02', mars: '03', avr: '04', mai: '05',
  juin: '06', juil: '07', aout: '08', 'août': '08', sept: '09', 'déc': '12',
  // IT
  gen: '01', mag: '05', giu: '06', lug: '07', ago: '08', set: '09', ott: '10', dic: '12',
  // ES / PT
  ene: '01', abr: '04', out: '10',
  // DE / AT
  'jän': '01', jaen: '01', 'mär': '03', maerz: '03', okt: '10', dez: '12',
}

export const DMY_SITES = new Set([
  'FR', 'IT', 'ES', 'DE', 'UK', 'GB', 'NL', 'BE', 'IE', 'PL', 'SE', 'EU',
  'AU', 'SG', 'AE', 'SA', 'TR', 'BR', 'IN', 'MX', 'MY', 'TH', 'VN', 'PH', 'ID',
])
export const MDY_SITES = new Set(['US'])

export function inferDateOrderFromSite(site) {
  const code = String(site ?? '').trim().toUpperCase()
  if (DMY_SITES.has(code)) return 'DMY'
  if (MDY_SITES.has(code)) return 'MDY'
  return null
}

function validatedMonth(year, month, day = '1') {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null
  return year + '-' + String(m).padStart(2, '0')
}

function lookupMonthToken(token) {
  const clean = String(token ?? '').toLowerCase().replace(/\.$/, '')
  if (MONTHS[clean]) return MONTHS[clean]
  const p3 = clean.slice(0, 3)
  if (MONTHS[p3]) return MONTHS[p3]
  const p4 = clean.slice(0, 4)
  return MONTHS[p4] || null
}

export function isAmbiguousSlashDate(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/)
  if (!m) return false
  const first = Number(m[1])
  const second = Number(m[2])
  return first >= 1 && first <= 12 && second >= 1 && second <= 12 && first !== second
}

export function transactionMonth(raw, strictOrOptions = true) {
  const opts = typeof strictOrOptions === 'object' && strictOrOptions !== null
    ? strictOrOptions
    : { strict: Boolean(strictOrOptions), dateOrder: null }
  const strict = opts.strict !== false
  const dateOrder = opts.dateOrder === 'DMY' || opts.dateOrder === 'MDY' ? opts.dateOrder : null

  const text = String(raw ?? '').trim()
  let m = text.match(/^(20\d{2})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?=$|[\sT])/)
  if (m) return validatedMonth(m[1], m[2], m[3])
  m = text.match(/^([A-Za-z\u00C0-\u017F]{3,12})\.?[\s,.-]+(\d{1,2})(?:[\s,.-]+(?:de|del))?[\s,.-]+(20\d{2})\b/i)
  if (m) {
    const mo = lookupMonthToken(m[1])
    if (mo) return validatedMonth(m[3], mo, m[2])
  }
  m = text.match(/^(\d{1,2})(?:[\s,.-]+(?:de|del))?[\s,.-]+([A-Za-z\u00C0-\u017F]{3,12})\.?(?:[\s,.-]+(?:de|del))?[\s,.-]+(20\d{2})\b/i)
  if (m) {
    const mo = lookupMonthToken(m[2])
    if (mo) return validatedMonth(m[3], mo, m[1])
  }
  // 欧式点分日期 DD.MM.YYYY（如 DE/FR/IT/PL）
  m = text.match(/^(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/)
  if (m) {
    const first = Number(m[1])
    const second = Number(m[2])
    if (second <= 12) return validatedMonth(m[3], second, first)
    return null
  }
  // 斜杠日期 DD/MM/YYYY 或 MM/DD/YYYY
  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/)
  if (m) {
    const first = Number(m[1])
    const second = Number(m[2])
    if (first > 12) return validatedMonth(m[3], second, first)
    if (second > 12) return validatedMonth(m[3], first, second)
    if (first === second) return validatedMonth(m[3], first, second)
    // first <= 12 && second <= 12 && first !== second（歧义日期）
    if (dateOrder === 'DMY') return validatedMonth(m[3], second, first)
    if (dateOrder === 'MDY') return validatedMonth(m[3], first, second)
    if (strict) return null
    return validatedMonth(m[3], first, second)
  }
  return null
}

function inferBatchSlashDateOrder(dates, explicitOrder) {
  if (explicitOrder === 'DMY' || explicitOrder === 'MDY') return explicitOrder
  let sawDmy = false
  let sawMdy = false
  for (const raw of dates || []) {
    const m = String(raw ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/)
    if (!m) continue
    const first = Number(m[1])
    const second = Number(m[2])
    if (first > 12 && second <= 12) sawDmy = true
    else if (second > 12 && first <= 12) sawMdy = true
  }
  if (sawDmy && !sawMdy) return 'DMY'
  if (sawMdy && !sawDmy) return 'MDY'
  return null
}

export function hasAmbiguousSlashDates(dates, dateOrder = null) {
  const effectiveOrder = inferBatchSlashDateOrder(dates, dateOrder)
  if (effectiveOrder) return false
  return (dates || []).some((d) => isAmbiguousSlashDate(d))
}

export function isInvalidCalendarDate(raw, dateOrder = null) {
  const text = String(raw ?? '').trim()
  if (!text) return false
  if (text === 'INVALID_EXCEL_1900_02_29') return true
  const looksNumericDate =
    /^(?:20\d{2})[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?=$|[\sT])/.test(text) ||
    /^\d{1,2}[/.]\d{1,2}[/.](?:20\d{2})\b/.test(text)
  let looksWordDate = false
  let m = text.match(/^([A-Za-z\u00C0-\u017F]{3,12})\.?[\s,.-]+(\d{1,2})(?:[\s,.-]+(?:de|del))?[\s,.-]+(20\d{2})\b/i)
  if (m && lookupMonthToken(m[1])) looksWordDate = true
  m = text.match(/^(\d{1,2})(?:[\s,.-]+(?:de|del))?[\s,.-]+([A-Za-z\u00C0-\u017F]{3,12})\.?(?:[\s,.-]+(?:de|del))?[\s,.-]+(20\d{2})\b/i)
  if (m && lookupMonthToken(m[2])) looksWordDate = true
  if (!looksNumericDate && !looksWordDate) return false
  return transactionMonth(text, { strict: false, dateOrder }) === null
}

export function findInvalidCalendarDates(dates, dateOrder = null) {
  const effectiveOrder = inferBatchSlashDateOrder(dates, dateOrder)
  const bad = []
  for (const d of dates || []) {
    if (isInvalidCalendarDate(d, effectiveOrder)) bad.push(String(d).trim())
  }
  return bad
}

export function inferPeriod(dates, fallback = '待确认期间', options = {}) {
  const opts = typeof fallback === 'object' && fallback !== null ? fallback : options
  const fb = typeof fallback === 'string' ? fallback : (opts.fallback || '待确认期间')
  const effectiveOrder = inferBatchSlashDateOrder(dates, opts?.dateOrder || null)
  const list = dates || []
  const periods = new Set()
  let ambiguousCount = 0
  for (const date of list) {
    if (!effectiveOrder && isAmbiguousSlashDate(date)) {
      ambiguousCount++
      continue
    }
    const p = transactionMonth(date, { strict: true, dateOrder: effectiveOrder })
    if (p) periods.add(p)
  }
  if (periods.size > 1) return '跨期（待核）'
  // 未知站点下只要存在无法确认日/月顺序的歧义斜杠日期（即使与确定 ISO 日期混排），一律暂挂待核禁止静默归入单月！
  if (ambiguousCount > 0) return fb
  return periods.values().next().value ?? fb
}

export function appendDateValidationAnomalies(summary, dates, dateOrder = null, refPrefix = 'DATE') {
  if (!summary || !Array.isArray(summary.anomalies)) return
  if (hasAmbiguousSlashDates(dates, dateOrder)) {
    const hasAmbig = summary.anomalies.some((a) => String(a.category || '').includes('日/月歧义'))
    if (!hasAmbig) {
      summary.anomalies.push({
        severity: 'P1-高危',
        category: '账单日期存在日/月歧义（待核）',
        refId: `${refPrefix}-AMBIG`,
        amount: '0.00',
        detail: '未确认站点/语种且检测到 DD/MM 与 MM/DD 无法区分的斜杠日期，严禁将歧义行静默并入单月，账期已暂挂待核。',
      })
    }
  }
  const badDates = findInvalidCalendarDates(dates, dateOrder)
  if (badDates.length > 0) {
    const hasBad = summary.anomalies.some((a) => String(a.category || '').includes('日历日期'))
    if (!hasBad) {
      summary.anomalies.push({
        severity: 'P1-高危',
        category: '账单存在无效或不存在的日历日期',
        refId: `${refPrefix}-INVALID`,
        amount: '0.00',
        detail: `检出 ${badDates.length} 条非法日历日期（如 ${badDates[0]}），请核对原始导出日期格式。`,
      })
    }
  }
}

// ── 实体 / 账号 / 参考号脱敏标准化工具（单一事实源） ──
export function normalizeEntityName(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/[（(][^）)]*(?:对公|基本户|一般户|专户|结算户|人民币户|外币户|基本存款账户|corporate|business)[^）)]*[）)]/gi, '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[.,，。;；]+$/g, '')
    .trim()
  if (!text || text.length > 200) return ''
  return text.toLowerCase()
}

function stripAccountTrailingNote(raw) {
  const text = String(raw ?? '').trim()
  if (!text || text.length > 128) return ''
  const stripped = text.replace(/\s*(?:[（(][^）)]*[）)]\s*)+$/, '').trim()
  return /\d{3}/.test(stripped) ? stripped : text
}

export function extractAccountSuffix(raw) {
  const text = stripAccountTrailingNote(raw)
  if (!text) return null
  const m = text.match(/(\d{4})\D*$/)
  return m ? m[1] : null
}

export function extractAccountPrefix(raw) {
  const text = stripAccountTrailingNote(raw)
  if (!text) return null
  const hasMask = /[*xX●•]/.test(text)
  if (/尾号/.test(text) && !hasMask) return null
  const head = hasMask ? text.split(/[*xX●•]/)[0] : text
  const compactHead = head.replace(/[\s-]+/g, '').toUpperCase()
  if (hasMask) {
    if (/^\d{3,32}$/.test(compactHead)) return compactHead
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{0,28}$/.test(compactHead)) return compactHead
    return null
  }
  if (/^\d{6,32}$/.test(compactHead)) return compactHead
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/.test(compactHead)) return compactHead
  return null
}

export function extractFullBankAccountDigits(raw) {
  const text = stripAccountTrailingNote(raw)
  if (!text) return null
  if (/[*xX●•尾号]/.test(text)) return null
  const compact = text.replace(/[\s-]+/g, '').toUpperCase()
  if (/^\d{8,32}$/.test(compact)) return compact
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/.test(compact)) return compact
  return null
}

const STD_BANK_INSTITUTION_RULES = [
  ['CMB', /招商银行|招行|\bcmb\b|china\s*merchants\s*bank/i],
  ['BOC', /中国银行|中行|\bboc\b|bank\s*of\s*china/i],
  ['ICBC', /工商银行|工行|\bicbc\b|industrial\s*and\s*commercial\s*bank/i],
  ['CCB', /建设银行|建行|\bccb\b|china\s*construction\s*bank/i],
  ['ABC', /农业银行|农行|\babc\b|agricultural\s*bank/i],
  ['BOCOM', /交通银行|交行|\bbocom\b|bank\s*of\s*communications/i],
  ['PINGAN', /平安银行|\bpab\b|ping\s*an\s*bank/i],
  ['CIB', /兴业银行|\bcib\b|industrial\s*bank/i],
  ['SPDB', /浦发银行|浦东发展银行|\bspdb\b/i],
  ['CITIC', /中信银行|\bcitic\b/i],
  ['CEB', /光大银行|\bceb\b|everbright\s*bank/i],
  ['CMBC', /民生银行|\bcmbc\b|minsheng\s*bank/i],
  ['GDB', /广发银行|\bgdb\b|\bcgb\b/i],
  ['HXB', /华夏银行|\bhxb\b|huaxia\s*bank/i],
  ['PSBC', /邮政储蓄银行|邮储银行|\bpsbc\b/i],
]

export function normalizeBankInstitutionCode(raw) {
  const s = String(raw ?? '').trim()
  if (!s || /^generic_bank$/i.test(s) || s === '国内对公银行' || s === '国内银行') return null
  const upper = s.toUpperCase()
  for (const [code, re] of STD_BANK_INSTITUTION_RULES) {
    if (upper === code || re.test(s)) return code
  }
  return null
}

export function normalizeReferenceToken(raw) {
  const text = String(raw ?? '').trim().toUpperCase()
  if (!text || text.length < 3 || text.length > 128) return ''
  return text
}

// ── 资金链凭证 HMAC 哈希与汇总工厂 ──
const evidenceSecret = randomBytes(32)
const EVIDENCE_ALIASES = {
  entity: ['legal entity id', 'entity id', 'merchant legal entity id', '主体编号', '法人实体编号'],
  account: ['settlement account id', 'destination account id', 'wallet account id', 'wallet id', 'account id', '资金账户编号', '收款账户编号', '结汇账户编号'],
  reference: ['platform payout id', 'platform payout reference', 'payout id', 'payout reference', '结算凭证编号', '平台放款编号', '放款编号'],
  source_platform: ['source platform', 'origin platform', 'payment platform', '来源平台', '打款平台'],
}
const PLATFORM_CODES = new Map([
  ['amazon', 'Amazon'], ['stripe', 'Stripe'], ['shopify', 'Shopify'], ['tiktok', 'TikTok Shop'],
  ['tiktok shop', 'TikTok Shop'], ['temu', 'Temu'], ['aliexpress', 'AliExpress'],
  ['shopee', 'Shopee'], ['paypal', 'PayPal'], ['速卖通', 'AliExpress'], ['虾皮', 'Shopee'],
  ['shein', 'SHEIN'], ['希音', 'SHEIN'], ['walmart', 'Walmart'], ['沃尔玛', 'Walmart'],
  ['lazada', 'Lazada'], ['来赞达', 'Lazada'],
])

export function evidenceKey(raw) {
  if (!raw || raw.length > 256) return null
  return createHmac('sha256', evidenceSecret).update(raw).digest('hex')
}

export function reportedCurrency(rows, column) {
  const currencies = new Set(rows.map((row) => normalizeCurrencyCode(cell(row, column))))
  return currencies.size === 1 ? currencies.values().next().value : 'UNKNOWN'
}

export function evidenceColumns(header) {
  return findHeaderRow([header], EVIDENCE_ALIASES, 1, 1, true)?.[1] ?? {}
}

export function pickFundEvidence(row, columns, sourcePlatform, date, amount, fallbackReference = '', dateOrder = null) {
  return {
    period: transactionMonth(date, { strict: true, dateOrder }),
    amount,
    sourcePlatform: PLATFORM_CODES.get(String(sourcePlatform || cell(row, columns.source_platform)).toLowerCase()) ?? null,
    entityKey: evidenceKey(cell(row, columns.entity)),
    accountKey: evidenceKey(cell(row, columns.account)),
    referenceKey: evidenceKey(cell(row, columns.reference) || fallbackReference),
  }
}

export function addPayoutEvidence(summary, row, columns, date, amount, fallbackReference = '', dateOrder = null) {
  summary.actualPayout += amount
  summary.payoutEvidenceCount++
  summary.payoutEvidence.push(pickFundEvidence(row, columns, summary.platform, date, amount, fallbackReference, dateOrder))
}

export function makeEmptySummary({ period, platform, site, currency, formatLabel, fileName }) {
  return {
    role: 'sales_platform',
    period,
    platform,
    site,
    currency: normalizeCurrencyCode(currency),
    formatLabel,
    fileName,
    rawRowCount: 0,
    orderCount: 0,
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
    payoutEvidence: [],
    payoutEvidenceCount: 0,
    facilitatorTaxStripped: 0n,
    uncapturedVoidExcluded: 0n,
    freeSampleCount: 0,
    horizontalDiffTotal: 0n,
    anomalies: [],
  }
}

export function finalizeSummary(s) {
  s.totalFees = s.platformCommission + s.affiliateCommission + s.logisticsWarehousing + s.inPlatformAds + s.gatewayDisputeFee
  // Local references avoid carrying transaction IDs into API or report outputs.
  for (const [index, anomaly] of s.anomalies.entries()) anomaly.refId = '待核-' + (index + 1)
  if (s.role === 'settlement_wallet' || s.role === 'bank_receipt') {
    s.orderCount = 0
    s.taxReportingGrossRef = 0n
    s.taxReportingGrossRefSource = s.role === 'bank_receipt' ? 'bank_receipt_excluded' : 'settlement_wallet_excluded'
    s.theoreticalPayout = 0n
    s.statementPayoutDiff = 0n
    s.statementPayoutDiffFormula = s.role === 'bank_receipt' ? '国内对公银行回单（参与 Stage 3 实收核销）' : '结汇通道（参与三段资金链核对）'
    return s
  }
  s.orderCount = Number.isInteger(s.orderCount) && s.orderCount >= 0 ? s.orderCount : 0
  const netRev = s.grossSales - s.sellerDiscount + s.platformSubsidy - s.customerRefund
  s.taxReportingGrossRef = s.grossSales - s.sellerDiscount
  s.taxReportingGrossRefSource = 'statement_reference'
  s.theoreticalPayout = netRev - s.totalFees + s.selfRemitTaxNet - s.reserveNetChange
  s.statementPayoutDiff = s.actualPayout - s.theoreticalPayout
  s.statementPayoutDiffFormula = '实际放款 − 理论放款'
  return s
}
