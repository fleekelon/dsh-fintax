// 算税引擎公共参数校验与舍入内核（供 lib/calc.js 与 lib/calc_extra.js 共享）。

export class CalcInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CalcInputError'
    this.code = 'INVALID_CALC_INPUT'
  }
}

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100

/** 解析必填数字参数：拒绝 null / undefined / 空字符串 / 布尔值 / 对象 / NaN。 */
export function reqNum(raw, errMsg, { allowZero = true } = {}) {
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
  return n
}

/** 解析可选非负数字参数：undefined / null / 空字符串时回退到 fallback；其余非法值抛错。 */
export function optNum(raw, fallback, name) {
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
  return n
}

/** 解析可选带符号数字参数（允许正负调节项，如跨期调增/调减、准备金释放、负应纳税所得额）。 */
export function optSignedNum(raw, fallback, name) {
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
  return n
}

export function optIsoDate(raw, name) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const date = String(raw).trim()
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new CalcInputError(`${name} 必须是有效日期（YYYY-MM-DD）`)
  }
  return parsed
}

export function optBoolean(value, name) {
  if (value === undefined || value === null || value === '') return null
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new CalcInputError(`${name} 必须为 true 或 false`)
}
