import { parentPort, workerData } from 'node:worker_threads'
import { StatementInputError, createStatementBudget, parsePlatformStatement, parseStatementBuffer } from './statement.js'
import {
  buildConsolidatedReconcile,
  renderAnomaliesCsv,
  renderDiagnosticReportHtml,
  renderDiagnosticReportMd,
  serializeSummary,
} from './report.js'

function parseBatch({ demo, files, platform, options, reportFormat, includeResourceAppendix }) {
  const started = performance.now()
  const summaries = []
  const coverage = { complete: true, files: [] }
  if (demo) {
    summaries.push(...parsePlatformStatement(`demo:${demo}`, platform))
  } else {
    const budget = createStatementBudget()
    for (const [index, file] of files.entries()) {
      const fileIndex = index + 1
      try {
        const parsed = parseStatementBuffer(Buffer.from(file.dataBase64, 'base64'), file.name, platform, budget)
        const diagnostics = parsed.flatMap((item) => item.parseDiagnostics ?? [])
        const status = diagnostics.length ? 'partial' : 'parsed'
        coverage.files.push({ fileIndex, status, diagnostics })
        summaries.push(...parsed)
      } catch (err) {
        if (!(err instanceof StatementInputError)) throw err
        coverage.files.push({ fileIndex, status: 'rejected', code: err.code, diagnostics: err.diagnostics })
      }
    }
    coverage.complete = coverage.files.every((item) => item.status === 'parsed')
  }
  if (summaries.length === 0) return { coverage, code: 'STATEMENT_UNRECOGNIZED', error: '未能解析已上传的账单，请核对格式和候选表头。' }
  const consolidated = buildConsolidatedReconcile(summaries, { ...options, coverageComplete: coverage.complete })
  const payload = { coverage, consolidated }
  if (reportFormat === 'all' || reportFormat === 'data') payload.summaries = summaries.map(serializeSummary)
  const renderOptions = { summaries, consolidated, coverage, includeResourceAppendix }
  if (reportFormat === 'all' || reportFormat === 'html') payload.reportHtml = renderDiagnosticReportHtml(renderOptions)
  if (reportFormat === 'all' || reportFormat === 'md') payload.reportMd = renderDiagnosticReportMd(renderOptions)
  if (reportFormat === 'all' || reportFormat === 'csv') payload.anomaliesCsv = renderAnomaliesCsv(renderOptions)
  payload.elapsedMs = Math.round((performance.now() - started) * 10) / 10
  return payload
}

try {
  const payload = workerData.inputPaths
    ? { localSummaries: parsePlatformStatement(workerData.inputPaths, workerData.platform) }
    : parseBatch(workerData)
  parentPort.postMessage(payload)
} catch (err) {
  if (err instanceof StatementInputError) {
    parentPort.postMessage({ code: err.code, error: err.message, diagnostics: err.diagnostics })
  } else if (err?.code === 'INVALID_FX_MAP') {
    parentPort.postMessage({ code: err.code, error: '汇率须为有效的币种映射对象。' })
  } else {
    parentPort.postMessage({ code: 'STATEMENT_PROCESSING_FAILED', error: '账单处理失败，请检查账单范围和汇率后重试。' })
  }
}
