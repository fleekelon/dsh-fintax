// 算税引擎公共参数校验与舍入内核（供 lib/calc.js、lib/calc_extra.js、lib/calc_crossborder.js 共享）。

export const MAX_MONETARY = 1e11 // 单项金额统一上限 1,000 亿，防止 IEEE-754 超安全整数精度失真

export class CalcInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CalcInputError'
    this.code = 'INVALID_CALC_INPUT'
  }
}

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100

/** 解析必填数字参数：拒绝 null / undefined / 空字符串 / 布尔值 / 对象 / NaN / 超上限。 */
export function reqNum(raw, errMsg, { allowZero = true, max = MAX_MONETARY } = {}) {
  if (
    raw === undefined ||
    raw === null ||
    typeof raw === 'boolean' ||
    typeof raw === 'object' ||
    (typeof raw === 'string' && raw.trim() === '')
  ) {
    throw new CalcInputError(errMsg)
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) {
    throw new CalcInputError(errMsg)
  }
  if (n > max) {
    throw new CalcInputError(`${errMsg}（不得超过 ${max}）`)
  }
  return n
}

/** 解析可选非负数字参数：undefined / null / 空字符串时回退到 fallback；其余非法值或超上限抛错。 */
export function optNum(raw, fallback, name, { max = MAX_MONETARY } = {}) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return fallback
  }
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    throw new CalcInputError(`${name} 必须是非负数字`)
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new CalcInputError(`${name} 必须是非负数字`)
  }
  if (n > max) {
    throw new CalcInputError(`${name} 超出合理数值上限（不得超过 ${max}）`)
  }
  return n
}

/** 解析可选带符号数字参数（允许正负调节项，如跨期调增/调减、准备金释放、负应纳税所得额）。 */
export function optSignedNum(raw, fallback, name, { max = MAX_MONETARY } = {}) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return fallback
  }
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    throw new CalcInputError(`${name} 必须是有效数字`)
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new CalcInputError(`${name} 必须是有效数字`)
  }
  if (Math.abs(n) > max) {
    throw new CalcInputError(`${name} 超出合理数值上限（绝对值不得超过 ${max}）`)
  }
  return n
}

export function optIsoDate(raw, name) {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'boolean' || typeof raw === 'object') {
    throw new CalcInputError(`${name} 必须是有效日期（YYYY-MM-DD）`)
  }
  const date = String(raw).trim()
  if (date === '') return null
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new CalcInputError(`${name} 必须是有效日期（YYYY-MM-DD）`)
  }
  return parsed
}

export function optBoolean(value, name) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'object') throw new CalcInputError(`${name} 必须为 true 或 false`)
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const norm = value.trim().toLowerCase()
    if (norm === '') return null
    if (norm === 'true' || norm === '1' || norm === 'yes') return true
    if (norm === 'false' || norm === '0' || norm === 'no') return false
  }
  throw new CalcInputError(`${name} 必须为 true 或 false`)
}

export function boolOrDefault(value, fallback, name) {
  const parsed = optBoolean(value, name)
  return parsed === null ? fallback : parsed
}
