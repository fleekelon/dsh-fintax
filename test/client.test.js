import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { calculateCrossborder } from '../lib/calc_crossborder.js'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const demoButton = '用示例看一张核对单'
const htmlButton = '导出老板版 HTML 核对单'
const flush = () => new Promise((resolve) => setImmediate(resolve))
const response = (data, status = 200) => new Response(JSON.stringify(data), { status })

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function* tree(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* tree(child)
  } else if (node?.props) {
    yield node
    yield* tree(node.children)
  }
}

function byText(node, type, text) {
  return [...tree(node)].find((el) => el.type === type && el.children.includes(text))
}

// Exercise component callbacks through the normal Host slots, independent of a browser installation.
function workbench(fetch, clipboard = async () => {}) {
  let mounted
  let reads = 0
  let lateWrites = 0
  const styles = new Map()
  const document = {
    baseURI: 'https://localhost/',
    getElementById: (id) => styles.get(id),
    head: { appendChild: (style) => styles.set(style.id, style) },
    createElement: () => ({ dataset: {}, remove() { styles.delete(this.id) } }),
  }
  class FileReader {
    readAsDataURL(file) {
      reads++
      this.result = `data:text/csv;base64,${file.content || 'YWJj'}`
      queueMicrotask(() => { this.onload(); this.onloadend() })
    }
    abort() { this.onabort(); this.onloadend() }
  }

  function cell(initialize) {
    const index = mounted.index++
    return mounted.cells[index] ??= initialize()
  }
  const same = (left, right) => left?.length === right?.length && right.every((value, i) => Object.is(left[i], value))
  function useMemo(create, deps) {
    const item = cell(() => ({}))
    if (!same(item.deps, deps)) Object.assign(item, { deps, value: create() })
    return item.value
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useRef: (current) => cell(() => ({ current })),
    useMemo,
    useCallback: (fn, deps) => useMemo(() => fn, deps),
    useState(initial) {
      const fiber = mounted
      const item = cell(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [item.value, (next) => {
        if (fiber.closed) lateWrites++
        item.value = typeof next === 'function' ? next(item.value) : next
      }]
    },
    useEffect(fn, deps) {
      const item = cell(() => ({}))
      if (same(item.deps, deps)) return
      item.deps = deps
      mounted.effects.push(() => {
        item.undo?.()
        item.undo = fn()
      })
    },
  }
  const slots = new Map()
  const window = {
    __ModuleLoader__: { load: (module) => module.factory(() => React).apply({
      locale: { bind: () => (key) => key, register() {}, getLocale: () => ({ active: 'zh' }) },
      effect: (fn) => fn(),
      slots: { inject: (_, fn) => fn(), register: (meta, render) => slots.set(meta.name, render) },
    }) },
  }
  runInNewContext(source, { window, document, navigator: { clipboard: { writeText: clipboard } }, FileReader, fetch, AbortController, URL, setTimeout, clearTimeout, console })
  const fibers = []
  function unmount(fiber) {
    if (fiber.closed) return
    for (const item of fiber.cells) item.undo?.()
    fiber.closed = true
  }
  function mount(render) {
    const fiber = { cells: [], effects: [] }
    fibers.push(fiber)
    function renderFiber() {
      const parent = mounted
      mounted = fiber
      fiber.index = 0
      try {
        const result = render()
        for (const effect of fiber.effects.splice(0)) effect()
        return result
      } finally {
        mounted = parent
      }
    }
    renderFiber.unmount = () => unmount(fiber)
    return renderFiber
  }
  const panel = slots.get('main')().children[0]
  const renderRoot = mount(() => panel.type(panel.props))
  function tab(name) {
    return mount(() => {
      const component = [...tree(renderRoot())].find((el) => el.type.name === name)
      return component.type(component.props)
    })
  }
  return {
    renderRoot,
    radar: tab('StatementRadarTab'),
    calc: tab('CalculatorTab'),
    settings: mount(() => { const panel = slots.get('settings.section')(); return panel.type(panel.props) }),
    counts: () => ({ reads, lateWrites, styles: styles.size }),
    unmount: () => fibers.forEach(unmount),
  }
}

function apiFallback(path) {
  if (path.endsWith('/history')) return response({ history: [] })
  if (path.endsWith('/status')) return response({ version: '0.8.3' })
  throw new Error(`Unexpected mock route ${path}`)
}

function batchResult({ currency = 'CNY', count = 1, consolidated } = {}) {
  return { summaries: [{ platform: 'Stripe', role: 'sales', period: '2026-11', currency, rawRowCount: count,
    anomalies: Array.from({ length: count }, (_, index) => ({
      severity: 'P0', category: '拒付', refId: `private-reference-${index}`, amount: '101.95', detail: `private-counterparty-${index}`,
    })),
  }], consolidated, elapsedMs: 1 }
}

function importFiles(radar, files) {
  const input = [...tree(radar())].find((el) => el.type === 'input' && el.props.type === 'file')
  input.props.onChange({ target: { files, value: '' } })
}

test('client drops a stale demo after newer import failure and locks exports', async (t) => {
  const oldDemo = deferred()
  let demos = 0
  const ui = workbench((path, init) => {
    if (!path.endsWith('/parse')) return apiFallback(path)
    const body = JSON.parse(init.body)
    if (!body.demo) return response({ error: '无法识别文件表头' }, 400)
    return ++demos === 1 ? response(batchResult()) : oldDemo.promise
  })
  t.after(() => ui.unmount())
  await byText(ui.radar(), 'button', demoButton).props.onClick()
  assert.equal(byText(ui.radar(), 'button', htmlButton).props.disabled, false)
  const stale = byText(ui.radar(), 'button', demoButton).props.onClick()
  importFiles(ui.radar, [{ name: 'ordinary.csv', size: 3 }])
  await flush()
  oldDemo.resolve(response(batchResult()))
  await stale
  const current = ui.radar()
  assert.ok(byText(current, 'span', '无法识别文件表头'))
  assert.equal(byText(current, 'button', htmlButton).props.disabled, true)
  assert.equal(byText(current, 'button', '归档'), undefined)
  assert.equal([...tree(current)].some((el) => el.props.className === 'ftx-risk-row'), false)
})

test('client rejects over-limit selections before encoding and pages even large anomaly lists', async (t) => {
  const copied = []
  const ui = workbench((path) => path.endsWith('/parse') ? response(batchResult({ count: 50000 })) : apiFallback(path), (text) => { copied.push(text) })
  t.after(() => ui.unmount())
  importFiles(ui.radar, Array.from({ length: 25 }, (_, n) => ({ name: `file-${n}.csv`, size: 1 })))
  importFiles(ui.radar, [{ name: 'too-large.csv', size: 21 * 1024 * 1024 }])
  assert.equal(ui.counts().reads, 0)
  await byText(ui.radar(), 'button', demoButton).props.onClick()
  const rows = () => [...tree(ui.radar())].filter((el) => el.props.className === 'ftx-risk-row')
  assert.equal(rows().length, 12)
  byText(ui.radar(), 'button', '下一页').props.onClick()
  assert.equal(rows().length, 12)
  assert.equal(rows()[0].props.title, 'private-counterparty-12')
  await byText(rows()[0], 'button', '查 IMA SOP').props.onClick()
  assert.match(copied[0], /Stripe.*拒付/)
  assert.doesNotMatch(copied[0], /private-|101\.95/)
})

test('client identifies a conflicting worksheet without displaying untrusted diagnostic values', async (t) => {
  const coverage = { complete: false, files: [
    { fileIndex: 1, status: 'partial', diagnostics: [{
      sheetIndex: 2, entryIndex: 3, code: 'STATEMENT_CANDIDATE_CONFLICT',
      candidates: ['Stripe', 'Payoneer', 'private-counterparty'],
      candidateRows: [{ row: 4, fields: ['private-cell'] }],
    }] },
  ] }
  const ui = workbench((path) => path.endsWith('/parse') ? response({ ...batchResult(), coverage }) : apiFallback(path))
  t.after(() => ui.unmount())
  await byText(ui.radar(), 'button', demoButton).props.onClick()
  const page = ui.radar()
  const component = [...tree(page)].find((el) => el.type.name === 'CoverageDetails')
  const list = component.type(component.props)
  assert.ok(byText(list, 'li', '第 1 份账单 / ZIP 条目 3 / 工作表 2 · 候选格式冲突（Stripe、Payoneer） · 待核行 4'))
  assert.doesNotMatch(JSON.stringify(list), /private/)
  assert.equal(byText(page, 'button', htmlButton).props.disabled, true)
})

test('client starts with blank FX, explicitly confirms the rate and requests reports on demand', async (t) => {
  const requests = []
  const ui = workbench((path, init) => {
    if (!path.endsWith('/parse')) return apiFallback(path)
    const body = JSON.parse(init.body)
    requests.push(body)
    if (body.reportFormat !== 'data') return response({})
    const consolidated = body.fxConfirmed
      ? { ready: true, totals: { grossCny: 100, netSalesCny: 100, feesCny: 0 } }
      : { ready: false, missingCurrencies: ['NZD'] }
    return response({ ...batchResult({ currency: 'NZD', consolidated }), fxConfirmationNeeded: !body.fxConfirmed })
  })
  t.after(() => ui.unmount())
  importFiles(ui.radar, [{ name: 'nz.csv', size: 1 }])
  await flush()
  assert.equal(requests[0].reportFormat, 'data')
  assert.deepEqual(requests[0].fxRates, {})
  assert.equal(requests[0].fxConfirmed, false)
  const editFx = byText(ui.radar(), 'label', 'NZD 折人民币汇率').children[1]
  assert.equal(editFx.props.value, '')
  editFx.props.onChange({ target: { value: '4.12345' } })
  assert.equal(byText(ui.radar(), 'button', htmlButton).props.disabled, true)
  await byText(ui.radar(), 'button', '确认汇率并复算').props.onClick()
  assert.equal(requests[1].fxRates.NZD, '4.12345')
  assert.equal(requests[1].fxConfirmed, true)
  await byText(ui.radar(), 'button', htmlButton).props.onClick()
  assert.equal(requests[2].reportFormat, 'html')
  assert.equal(requests[2].fxRates.NZD, '4.12345')
})

test('style ownership is shared and late clipboard completion cannot write after unmount', async () => {
  const clipboard = deferred()
  const ui = workbench(apiFallback, () => clipboard.promise)
  const radar = [...tree(ui.renderRoot())].find((el) => el.type.name === 'StatementRadarTab')
  ui.settings()
  assert.equal(ui.counts().styles, 1)
  ui.settings.unmount()
  assert.equal(ui.counts().styles, 1)
  const writing = radar.props.onCopyText('row', 'safe topic')
  ui.unmount()
  clipboard.resolve()
  await writing
  await flush()
  assert.deepEqual(ui.counts(), { reads: 0, lateWrites: 0, styles: 0 })
})

test('switching entity and calculator scenario drops old request completions', async (t) => {
  const oldHistory = deferred()
  const oldCalculation = deferred()
  const entities = [{ name: 'Alpha', count: 1 }, { name: 'Beta', count: 2 }]
  const history = (count) => response({ history: [], rolling12m: { snapshotCount: count, totalNetSalesCny: 6000000, thresholdApplicable: true, entities } })
  const requests = []
  const ui = workbench((path) => {
    requests.push(path)
    if (path.endsWith('/history')) return history(3)
    if (path.endsWith('entity=Alpha')) return oldHistory.promise
    if (path.endsWith('entity=Beta')) return history(2)
    if (path.endsWith('/calc')) return oldCalculation.promise
    return apiFallback(path)
  })
  t.after(() => ui.unmount())
  const entity = () => [...tree(ui.radar())].find((el) => el.type === 'select' && el.props.title?.includes('公司主体'))
  ui.radar()
  await flush()
  assert.equal([...tree(ui.radar())].some((el) => el.type.name === 'DialGauge'), false)
  entity().props.onChange({ target: { value: 'Alpha' } })
  entity().props.onChange({ target: { value: 'Beta' } })
  ui.radar()
  await flush()
  oldHistory.resolve(history(1))
  await flush()
  assert.ok(byText(ui.radar(), 'span', '滚动监控（2 份归档）'))
  assert.equal(requests.filter((path) => path.endsWith('entity=Beta')).length, 1)

  const pending = byText(ui.calc(), 'button', '立即代码精算（0 Token）').props.onClick()
  const nextScene = byText(ui.calc(), 'span', '500 万一般纳税人临界拐点')
  const nav = [...tree(ui.calc())].find((el) => el.props.className === 'ftx-nav-btn' && el.children[0].children[0] === nextScene.children[0])
  nav.props.onClick()
  oldCalculation.resolve(response({ result: { summaryLine: '过期试算结果' } }))
  await pending
  assert.equal(byText(ui.calc(), 'div', '过期试算结果'), undefined)
})

test('clearing stored FX preserves a newer draft while the settings write is pending', async (t) => {
  const settings = deferred()
  let writes = 0
  const ui = workbench((path) => {
    if (path.endsWith('/settings')) {
      writes++
      return settings.promise
    }
    if (path.endsWith('/status')) return response({ customFxRates: { USD: 7.5 } })
    return apiFallback(path)
  })
  t.after(() => ui.unmount())
  ui.radar()
  await flush()
  byText(ui.radar(), 'button', '汇率与申报额 ▼').props.onClick()
  const usd = () => byText(ui.radar(), 'label', 'USD 折人民币汇率').children[1]
  assert.equal(usd().props.value, '7.5')
  const reset = byText(ui.radar(), 'button', '清除保存的汇率').props.onClick()
  assert.equal(byText(ui.radar(), 'button', '保存为默认汇率').props.disabled, true)
  usd().props.onChange({ target: { value: '7.1234' } })
  settings.resolve(response({ customFxRates: {} }))
  await reset
  assert.equal(writes, 1)
  assert.equal(usd().props.value, '7.1234')
})

test('archive replacement requires choosing an exact snapshot and retries only its current revision', async (t) => {
  const writes = []
  const candidates = [
    { id: 'first', revision: 'revision-1', month: '2026-11', label: '原档' },
    { id: 'second', revision: 'revision-2', month: '2026-11', label: '补充档' },
  ]
  const ui = workbench((path, init) => {
    if (path.endsWith('/parse')) {
      const consolidated = { ready: true, totals: { grossCny: 100, netSalesCny: 100, feesCny: 0 } }
      return response({ ...batchResult({ consolidated }), archiveToken: 'test-token', archiveMonth: '2026-11' })
    }
    if (!path.endsWith('/history') || init.method !== 'POST') return apiFallback(path)
    const body = JSON.parse(init.body)
    writes.push(body)
    if (body.conflictMode === 'check') return response({ conflict: true, candidates }, 409)
    if (body.expectedRevision === 'revision-2') {
      candidates[1] = { ...candidates[1], revision: 'revision-3' }
      return response({ conflict: true, candidates }, 409)
    }
    return response({ deduplicated: true })
  })
  t.after(() => ui.unmount())
  importFiles(ui.radar, [{ name: 'ordinary.csv', size: 1 }])
  await flush()
  await byText(ui.radar(), 'button', '归档').props.onClick()
  const replace = () => byText(ui.radar(), 'button', '覆盖替换原档')
  const choose = () => [...tree(ui.radar())].find((el) => el.props['aria-label'] === '选择要覆盖的归档')
  assert.equal(replace().props.disabled, true)
  choose().props.onChange({ target: { value: 'second' } })
  await replace().props.onClick()
  assert.equal(writes[1].expectedRevision, 'revision-2')
  assert.equal(replace().props.disabled, true)
  choose().props.onChange({ target: { value: 'second' } })
  await replace().props.onClick()
  assert.equal(writes[2].targetId, 'second')
  assert.equal(writes[2].expectedRevision, 'revision-3')
  assert.equal(writes[2].archiveToken, 'test-token')
  assert.equal(byText(ui.radar(), 'button', '归档').props.disabled, true)
})


// ── v0.9.0 Track E regression suite (modular build, 14 calcs, Stage 3, cache export, annual, IMA drawer, DSH 0.2.3 & i18n) ──

function workbenchEx(fetch, {
  clipboard = async () => {},
  lang = 'zh',
  dockMode = '0.2.3', // '0.2.3' | '0.2.2-throw' | '0.2.2-has-false'
} = {}) {
  let mounted
  let activeLang = lang
  let langListener = null
  const styles = new Map()
  const document = {
    baseURI: 'https://localhost/',
    documentElement: { lang },
    getElementById: (id) => styles.get(id),
    head: { appendChild: (style) => styles.set(style.id, style) },
    body: { appendChild() {}, removeChild() {} },
    createElement: () => ({ dataset: {}, click() {}, remove() { styles.delete(this.id) } }),
  }
  class FileReader {
    readAsDataURL(file) {
      this.result = `data:text/csv;base64,${file.content || 'YWJj'}`
      queueMicrotask(() => { this.onload(); this.onloadend() })
    }
    readAsText(file) {
      this.result = String(file.textContent ?? '')
      queueMicrotask(() => { this.onload(); this.onloadend() })
    }
    abort() { this.onabort(); this.onloadend() }
  }
  function cell(initialize) {
    const index = mounted.index++
    return mounted.cells[index] ??= initialize()
  }
  const same = (left, right) => left?.length === right?.length && right.every((value, i) => Object.is(left[i], value))
  function useMemo(create, deps) {
    const item = cell(() => ({}))
    if (!same(item.deps, deps)) Object.assign(item, { deps, value: create() })
    return item.value
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useRef: (current) => cell(() => ({ current })),
    useMemo,
    useCallback: (fn, deps) => useMemo(() => fn, deps),
    useState(initial) {
      const item = cell(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [item.value, (next) => { item.value = typeof next === 'function' ? next(item.value) : next }]
    },
    useEffect(fn, deps) {
      const item = cell(() => ({}))
      if (same(item.deps, deps)) return
      item.deps = deps
      mounted.effects.push(() => { item.undo?.(); item.undo = fn() })
    },
  }
  const slots = new Map()
  const ctxSlots = {
    ...(dockMode === '0.2.2-has-false' ? { has: (name) => name !== 'conversation.input.dock' } : {}),
    inject: (name, fn) => {
      if (dockMode === '0.2.2-throw' && name === 'conversation.input.dock') {
        throw new Error('Unknown slot conversation.input.dock on DSH 0.2.2')
      }
      return fn()
    },
    register: (meta, render) => { slots.set(meta.name, render); return () => slots.delete(meta.name) },
  }
  const window = {
    __ModuleLoader__: {
      load: (module) => module.factory(() => React).apply({
        locale: {
          bind: () => (key) => key,
          register() {},
          getLocale: () => ({ active: activeLang }),
          onLanguageChange: (cb) => { langListener = cb; return () => { langListener = null } },
        },
        effect: (fn) => fn(),
        slots: ctxSlots,
      }),
    },
  }
  runInNewContext(source, { window, document, navigator: { clipboard: { writeText: clipboard } }, FileReader, fetch, AbortController, URL, Blob, setTimeout, clearTimeout, console })
  const fibers = []
  function unmount(fiber) {
    if (fiber.closed) return
    for (const item of fiber.cells) item.undo?.()
    fiber.closed = true
  }
  function mount(render) {
    const fiber = { cells: [], effects: [] }
    fibers.push(fiber)
    function renderFiber() {
      const parent = mounted
      mounted = fiber
      fiber.index = 0
      try {
        const result = render()
        for (const effect of fiber.effects.splice(0)) effect()
        return result
      } finally {
        mounted = parent
      }
    }
    renderFiber.unmount = () => unmount(fiber)
    return renderFiber
  }
  const panel = slots.get('main')().children[0]
  const renderRoot = mount(() => panel.type(panel.props))
  function childComp(name) {
    return mount(() => {
      const component = [...tree(renderRoot())].find((el) => el.type?.name === name)
      return component ? component.type(component.props) : null
    })
  }
  return {
    slots,
    styles,
    renderRoot,
    radar: childComp('StatementRadarTab'),
    calc: childComp('CalculatorTab'),
    annual: childComp('AnnualArchiveTab'),
    drawer: childComp('ImaQuickDrawer'),
    settings: childComp('SettingsTab'),
    setHostLang(next) { activeLang = next; langListener?.(next) },
    unmount: () => fibers.forEach(unmount),
  }
}

test('build-client.mjs --check passes deterministically and bundle preserves dark theme & container queries', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/build-client.mjs', import.meta.url))
  const out = execFileSync(process.execPath, [scriptPath, '--check'], { encoding: 'utf8' })
  assert.match(out, /\[build-client\] OK:/)
  assert.match(source, /AUTO-GENERATED FILE/)
  assert.match(source, /body\[data-ds-dark-theme\] \.ftx-root/)
  assert.match(source, /@container ftx/)
  assert.doesNotMatch(source, /CTPAT-certified|--profile default/)
})

test('demo:v9 renders Stage 3 5-key panel isolated from candidate matches and cache export falls back on 404', async (t) => {
  const calls = []
  let exportAttempt = 0
  const ui = workbenchEx((path, init) => {
    calls.push({ path, body: init?.body ? JSON.parse(init.body) : null })
    if (path.endsWith('/history')) return response({ history: [] })
    if (path.endsWith('/status')) return response({ version: '0.9.0', supportedChannels: 17, calcEngineCount: 14 })
    if (path.endsWith('/parse/export')) {
      exportAttempt++
      if (exportAttempt === 1) return response({ ok: true, format: 'html', filename: 'cached.html', content: '<html>ok</html>', fromCache: true })
      return response({ ok: false, error: 'CACHE_EXPIRED', message: '缓存已过期' }, 404)
    }
    if (path.endsWith('/parse')) {
      const body = JSON.parse(init.body)
      if (body.reportFormat === 'html') return response({ reportHtml: '<html>fallback</html>' })
      return response({
        ...batchResult({
          consolidated: {
            ready: true,
            totals: { grossCny: 420000, netSalesCny: 400000, feesCny: 50000, refundCny: 10000, subsidyCny: 0, selfRemitTaxCny: 0, reserveCny: 0, payoutCny: 340000, payoutEvidenceCount: 2 },
            fundChain: {
              hasSalesStatements: true, hasSalesEvidence: true, salesSheetCount: 2, walletCount: 3,
              stage1PlatformPayoutCny: 340000, stage2WalletInboundCny: 340000, stage1to2Status: 'matched', stage1to2GapCny: 0,
              stage3CorporateRepatriatedCny: 289200, stage3PersonalWithdrawCny: 14460, stage3UnverifiedWithdrawCny: 0, directSpendCny: 0, walletFeesCny: 1800,
              corporateRepatriationRatePct: 85.06,
              stage3: {
                stage3Status: 'partial', stage2CorporateExpectedCny: 289200, stage3MatchedCny: 180780,
                bankFeeCny: 120, fxGapOrInTransitCny: 108300, inTransitUnmatchedCny: 108300, fxSpreadCny: -50,
                matchedMatches: [{ walletPlatform: 'LianLian', bank: 'CMB', bankLabel: '招商银行', period: '2026-11', currency: 'CNY', accountSuffix: '8821', expectedAmount: 108600, receivedAmount: 108600, bankFee: 0, fxDiff: 0 }],
                stage3CandidateMatches: [{ walletPlatform: 'PingPong', bank: 'CMB', bankLabel: '招商银行', period: '2026-11', currency: 'CNY', expectedAmount: 72200, receivedAmount: 72150, diffAmount: -50, matchBasis: '参考级待确认：缺精确参考号' }],
                alerts: ['【P2-关注 · 参考级候选匹配】检出 1 组参考级候选回单'],
                stats: { matchedCount: 1, candidateCount: 1, totalReceipts: 2 },
              },
            },
          },
        }),
        cacheToken: 'a'.repeat(32),
      })
    }
    return response({})
  })
  t.after(() => ui.unmount())
  const v9Btn = byText(ui.radar(), 'button', '体验 v0.9 完整三段资金链（含银行回单）')
  assert.ok(v9Btn)
  await v9Btn.props.onClick()
  const parseCall = calls.find((c) => c.path.endsWith('/parse'))
  assert.equal(parseCall.body.demo, 'v9')
  const view = ui.radar()
  const txt = JSON.stringify(view)
  assert.match(txt, /法定 5 键已核销实收 CNY/)
  assert.match(txt, /参考级待确认回单（不计入法定 5 键已核销/)
  assert.ok([...tree(view)].some((el) => el.props['data-testid'] === 'stage3-candidates'))
  // First HTML export hits /parse/export with cacheToken
  await byText(view, 'button', htmlButton).props.onClick()
  const cachedCall = calls.find((c) => c.path.endsWith('/parse/export'))
  assert.equal(cachedCall.body.cacheToken, 'a'.repeat(32))
  assert.equal(cachedCall.body.format, 'html')
  // Second HTML export gets 404 CACHE_EXPIRED and seamlessly falls back to /parse with reportFormat: 'html'
  await byText(ui.radar(), 'button', htmlButton).props.onClick()
  const fallbackParse = calls.filter((c) => c.path.endsWith('/parse')).at(-1)
  assert.equal(fallbackParse.body.reportFormat, 'html')
})

test('Stage 3 panel stays pending without bank receipts and hides empty Stage 3 detail box', async (t) => {
  const ui = workbenchEx((path) => {
    if (path.endsWith('/history')) return response({ history: [] })
    if (path.endsWith('/status')) return response({ version: '0.9.0' })
    if (path.endsWith('/parse')) {
      return response(batchResult({
        consolidated: {
          ready: true,
          totals: { grossCny: 200000, netSalesCny: 190000, feesCny: 20000, refundCny: 10000, subsidyCny: 0, selfRemitTaxCny: 0, reserveCny: 0, payoutCny: 160000, payoutEvidenceCount: 1 },
          fundChain: {
            hasSalesStatements: true, hasSalesEvidence: true, salesSheetCount: 1, walletCount: 1,
            bankReceiptCount: 0, bankReceivedCny: null, stage3VerificationStatus: 'pending_bank_receipt',
            stage1PlatformPayoutCny: 160000, stage2WalletInboundCny: 160000, stage1to2Status: 'matched', stage1to2GapCny: 0,
            stage3CorporateRepatriatedCny: 120000, stage3PersonalWithdrawCny: 0, stage3UnverifiedWithdrawCny: 0, directSpendCny: 0, walletFeesCny: 500,
            corporateRepatriationRatePct: 75,
            stage3: {
              stage3Status: 'pending_bank_receipt', stage2CorporateExpectedCny: 120000, stage3MatchedCny: 0,
              bankFeeCny: 0, fxGapOrInTransitCny: 120000, inTransitUnmatchedCny: 120000, fxSpreadCny: 0,
              matchedMatches: [], stage3CandidateMatches: [], alerts: [],
              stats: { matchedCount: 0, candidateCount: 0, totalReceipts: 0 },
            },
          },
        },
      }))
    }
    return response({})
  })
  t.after(() => ui.unmount())
  await byText(ui.radar(), 'button', demoButton).props.onClick()
  const view = ui.radar()
  const txt = JSON.stringify(view)
  assert.match(txt, /银行实收 待核回单/)
  assert.doesNotMatch(txt, /法定 5 键银行实收 ¥0/)
  assert.equal([...tree(view)].some((el) => el.props.className === 'ftx-stage3-panel'), false)
})

test('calculator registers all 14 engines and aligns 1:1 with real lib/calc_crossborder.js payloads', async (t) => {
  const calcRequests = []
  const ui = workbenchEx((path, init) => {
    if (path.endsWith('/history')) return response({ history: [] })
    if (path.endsWith('/status')) return response({ version: '0.9.0' })
    if (path.endsWith('/calc')) {
      const body = JSON.parse(init.body)
      calcRequests.push(body)
      const params = body.scenario === 'us_t86_vs_9810_ddp'
        ? { ...body.params, ieepaPaidUsd: 10000, tariffProgram: 'IEEPA', entryPeriodStart: '2025-03-01', entryPeriodEnd: '2026-01-31', aceAchBound: false }
        : body.params
      return response({ result: calculateCrossborder(body.scenario, params) })
    }
    return response({})
  })
  t.after(() => ui.unmount())
  const navBtns = [...tree(ui.calc())].filter((el) => el.props.className?.includes('ftx-nav-btn'))
  assert.equal(navBtns.length, 14)

  // 1) eu_low_value_parcel against real calculateCrossborder output
  const euBtn = navBtns.find((el) => JSON.stringify(el).includes('欧盟低值包裹'))
  assert.ok(euBtn)
  euBtn.props.onClick()
  await byText(ui.calc(), 'button', '立即代码精算（0 Token）').props.onClick()
  assert.equal(calcRequests[0].scenario, 'eu_low_value_parcel')
  const euRendered = JSON.stringify(ui.calc())
  assert.doesNotMatch(euRendered, /€—/)
  assert.match(euRendered, /同篮拆包 €-?\d/)
  assert.match(euRendered, /单税则SKU €\d/)
  assert.match(euRendered, /海外仓盈亏平衡履约线 €\d/)
  assert.match(euRendered, /含税抽佣保毛利反推最低价/)

  // 2) us_t86_vs_9810_ddp against real calculateCrossborder output (incl. achHoldAlert)
  const usBtn = navBtns.find((el) => JSON.stringify(el).includes('美线 Type 11 vs 9810 DDP'))
  assert.ok(usBtn)
  assert.ok(navBtns.some((el) => JSON.stringify(el).includes('50 万 FBA 有票+无票混合采购拆单')))
  usBtn.props.onClick()
  await byText(ui.calc(), 'button', '立即代码精算（0 Token）').props.onClick()
  assert.equal(calcRequests[1].scenario, 'us_t86_vs_9810_ddp')
  const usRendered = JSON.stringify(ui.calc())
  assert.doesNotMatch(usRendered, /\$—/)
  assert.match(usRendered, /单件关税 \$\d/)
  assert.match(usRendered, /单件利差 \$/)
  assert.match(usRendered, /2027-01-05.*CTPAT-validated/)
  assert.match(usRendered, /P0: ACE ACH Hold/)
  assert.match(usRendered, /就地查 IMA 出处/)
})

test('annual tab loads Q1-Q4 & 3-jurisdiction cards, handles 409 reassign force confirm, and exports/imports backup', async (t) => {
  const reassignPayloads = []
  const backupPosts = []
  const annualExports = []
  const sampleHistory = [
    { id: '11111111-1111-4111-8111-111111111111', revision: '22222222-2222-4222-8222-222222222222', month: '2026-11', entityName: '待认领', entityLabel: '待认领', ownershipStatus: 'unclaimed', storeScope: 'Amazon', netSalesCny: 250000 },
  ]
  const sampleSummary = {
    year: 2026, deadlineDate: '2027-01-31', scopeLabel: '多主体拆表参考',
    availableEntities: [{ entityKey: 'unclaimed', entityLabel: '待认领', ownershipStatus: 'unclaimed', snapshotCount: 1 }],
    crossEntityMixed: true, mixingProtectionWarning: '【跨主体混算保护 · 不可直接合并申报】',
    unclaimedWarning: '【存在待认领归档】', missingMonthsCount: 11, missingMonthsNote: '2026 年已覆盖 1/12 个月，缺失 11 个月账单',
    monthlySeries: Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, status: i === 10 ? 'recorded' : 'missing', snapshotCount: i === 10 ? 1 : 0, netSalesCny: i === 10 ? 250000 : 0 })),
    quarters: [
      { quarter: 'Q1', label: 'Q1 (01–03月)', grossCny: 0, netSalesCny: 0, payoutCny: 0, stage2WalletInboundCny: null, stage3BankReceivedCny: null, p0Count: 0, missingMonths: ['2026-01', '2026-02', '2026-03'] },
      { quarter: 'Q2', label: 'Q2 (04–06月)', grossCny: 0, netSalesCny: 0, payoutCny: 0, stage2WalletInboundCny: null, stage3BankReceivedCny: null, p0Count: 0, missingMonths: ['2026-04', '2026-05', '2026-06'] },
      { quarter: 'Q3', label: 'Q3 (07–09月)', grossCny: 0, netSalesCny: 0, payoutCny: 0, stage2WalletInboundCny: null, stage3BankReceivedCny: null, p0Count: 0, missingMonths: ['2026-07', '2026-08', '2026-09'] },
      { quarter: 'Q4', label: 'Q4 (10–12月)', grossCny: 260000, netSalesCny: 250000, payoutCny: 210000, stage2WalletInboundCny: 210000, stage3BankReceivedCny: 180000, p0Count: 0, missingMonths: ['2026-10', '2026-12'] },
    ],
    annual: { referenceOnly: true, grossCny: 260000, netSalesCny: 250000, payoutCny: 210000, stage2WalletInboundCny: 210000, stage3BankReceivedCny: 180000, p0Count: 0, missingMonthCount: 11 },
    threeJurisdictions: {
      deadline: '2027-01-31',
      cards: [
        { id: 'china_810', jurisdiction: 'CN', title: '中国 · 国务院 810 号令', deadline: '2027-01-31', policyRef: '国务院令第 810 号', status: 'danger', summary: 'Q4 缺月', checklist: ['核对四层口径'] },
        { id: 'eu_dac7', jurisdiction: 'EU', title: '欧盟 · DAC7 平台报送', deadline: '2027-01-31', policyRef: 'EU DAC7', status: 'warn', summary: '检查 €2,000 / 30 笔', checklist: ['下载 DAC7 回执'] },
        { id: 'us_1099k', jurisdiction: 'US', title: '美国 · IRS 1099-K 双门槛', deadline: '2027-01-31', policyRef: 'IRC §6050W ($20,000 & 200)', status: 'warn', summary: 'OBBBA $20,000 & 200 笔', checklist: ['核对 W-8BEN-E'] },
      ],
    },
  }
  const ui = workbenchEx((path, init) => {
    if (path.endsWith('/status')) return response({ version: '0.9.0' })
    if (path.includes('/history/annual')) {
      if (path.includes('format=html') || path.includes('format=md')) {
        annualExports.push(path)
        return response({ ok: true, format: 'html', filename: 'annual-2026.html', content: '<html>annual</html>', summary: sampleSummary })
      }
      return response({ ok: true, summary: sampleSummary })
    }
    if (path.endsWith('/history/reassign')) {
      const body = JSON.parse(init.body)
      reassignPayloads.push(body)
      if (!body.force) return response({ conflict: true, reason: 'source_key_collision', conflicts: [{ id: 'other' }] }, 409)
      return response({ ok: true, conflict: false, overwritten: true })
    }
    if (path.endsWith('/history/backup') && (!init?.method || init.method === 'GET')) {
      return response({ ok: true, filename: 'dsh-fintax-history-backup-20261127.json', backup: { schemaVersion: 'dsh-fintax-backup-v1', recordCount: 1, records: sampleHistory, checksum: 'b'.repeat(64) } })
    }
    if (path.endsWith('/history/backup') && init?.method === 'POST') {
      const body = JSON.parse(init.body)
      backupPosts.push(body)
      return response({ ok: true, imported: 1, skipped: 0, overwritten: 0, totalInStore: 2 })
    }
    if (path.endsWith('/history')) return response({ history: sampleHistory })
    return response({})
  })
  t.after(() => ui.unmount())
  // Switch to Annual tab
  byText(ui.renderRoot(), 'button', '年度汇算与归档').props.onClick()
  ui.annual()
  await flush()
  const annualView = ui.annual()
  const serialized = JSON.stringify(annualView)
  assert.match(serialized, /跨主体混算保护/)
  assert.match(serialized, /2027-01-31 全球三地报送自检卡/)
  assert.match(serialized, /中国 · 国务院 810 号令/)
  assert.match(serialized, /欧盟 · DAC7/)
  assert.match(serialized, /IRS 1099-K/)
  // Export annual HTML
  await byText(annualView, 'button', '导出年度老板版 HTML').props.onClick()
  assert.equal(annualExports.length, 1)
  // Reassign unclaimed snapshot with 409 conflict -> explicit force: true confirmation
  byText(ui.annual(), 'button', '认领 / 重分配').props.onClick()
  const entityInput = [...tree(ui.annual())].find((el) => el.type === 'input' && el.props.placeholder === '目标法人/公司主体名称')
  entityInput.props.onChange({ target: { value: '深圳星海跨境科技有限公司' } })
  await byText(ui.annual(), 'button', '提交认领 / 重分配').props.onClick()
  assert.equal(reassignPayloads[0].force, false)
  const forceBtn = byText(ui.annual(), 'button', '确认强制覆盖 (force)')
  assert.ok(forceBtn)
  await forceBtn.props.onClick()
  assert.equal(reassignPayloads[1].force, true)
  // Export & import backup JSON
  await byText(ui.annual(), 'button', '一键导出备份 (.json)').props.onClick()
  const modeSelect = [...tree(ui.annual())].find((el) => el.props['aria-label'] === '备份导入模式')
  modeSelect.props.onChange({ target: { value: 'merge_overwrite' } })
  const importInput = [...tree(ui.annual())].find((el) => el.props['aria-label'] === '选择备份文件')
  await importInput.props.onChange({ target: { files: [{ text: async () => JSON.stringify({ schemaVersion: 'dsh-fintax-backup-v1', recordCount: 1, records: [], checksum: 'c'.repeat(64) }) }], value: '' } })
  await flush()
  assert.equal(backupPosts[0].mode, 'merge_overwrite')
  assert.equal(backupPosts[0].verifyChecksum, true)
})

test('IMA quick drawer enforces <=160 char snippet moat, strips HTML without double-escaping, and surfaces backend messages', async (t) => {
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML\s*=/)
  const imaCalls = []
  let mode = 'hits' // 'hits' | 'no-kb' | 'unconfigured'
  const xssSnippet = `<script>alert("xss")</script><b>$20,000 & 200 笔 (<=€150) "IOSS"</b> ${'欧盟2欧低值包裹退货不退处理费政策原文摘录'.repeat(12)}`
  const ui = workbenchEx((path, init) => {
    if (path.endsWith('/history')) return response({ history: [] })
    if (path.endsWith('/status')) return response({ version: '0.9.0', configured: mode !== 'unconfigured' })
    if (path.endsWith('/parse')) return response(batchResult({ count: 1 }))
    if (path.endsWith('/ima-quick')) {
      const body = JSON.parse(init.body)
      imaCalls.push(body)
      if (mode === 'unconfigured') return response({ ok: true, configured: false, hits: [], message: '请先在设置页配置 IMA Client ID 与 API Key' })
      if (mode === 'no-kb') return response({ ok: true, configured: true, hits: [], message: '尚未绑定默认财税知识库，请在设置页选择默认库后重试。' })
      return response({
        ok: true, configured: true, query: body.query, usedFallback: false, fallbackTerms: [],
        hits: [{ title: '<b>欧盟低值包裹 & 1099-K 规则</b>', folderPath: '/EU/2026', snippet: xssSnippet }],
        disclaimer: '仅展示 ≤160 字只读摘要',
      })
    }
    return response({})
  })
  t.after(() => ui.unmount())
  await byText(ui.radar(), 'button', demoButton).props.onClick()
  const row = [...tree(ui.radar())].find((el) => el.props.className === 'ftx-risk-row')
  byText(row, 'button', '就地查 IMA 出处').props.onClick()
  ui.drawer()
  await flush()
  assert.equal(imaCalls[0].query, 'Stripe 拒付')
  assert.doesNotMatch(imaCalls[0].query, /private-|101\.95/)
  const drawerTree = ui.drawer()
  const snippetEl = [...tree(drawerTree)].find((el) => el.props.className === 'ftx-drawer-snippet')
  assert.ok(snippetEl)
  const renderedSnippet = String(snippetEl.children[0])
  assert.doesNotMatch(renderedSnippet, /<script>|<b>|alert\("xss"\)/)
  assert.doesNotMatch(renderedSnippet, /&amp;|&quot;|&lt;/)
  assert.match(renderedSnippet, /\$20,000 & 200 笔 \(<=€150\) "IOSS"/)
  assert.ok(renderedSnippet.endsWith('…'))
  assert.equal(renderedSnippet.length <= 160, true)

  // Configured but unbound default KB displays backend guidance message
  mode = 'no-kb'
  await byText(drawerTree, 'button', '检索出处').props.onClick()
  await flush()
  assert.match(JSON.stringify(ui.drawer()), /尚未绑定默认财税知识库/)

  // Unconfigured mode shows Settings guidance button
  mode = 'unconfigured'
  await byText(ui.drawer(), 'button', '检索出处').props.onClick()
  await flush()
  assert.ok(byText(ui.drawer(), 'button', '前往设置页配置 IMA'))
})

test('DSH 0.2.2/0.2.3 conversation.input.dock degrades safely, dsh-market probe is passive, and live zh/en switch updates UI', async (t) => {
  // 1) DSH 0.2.2 host throwing on unknown slot does not crash mount
  const ui22Throw = workbenchEx((path) => {
    if (path.endsWith('/history')) return response({ history: [] })
    if (path.endsWith('/status')) return response({ version: '0.9.0' })
    return response({})
  }, { dockMode: '0.2.2-throw' })
  t.after(() => ui22Throw.unmount())
  assert.equal(ui22Throw.slots.has('main'), true)
  assert.equal(ui22Throw.slots.has('conversation.input.dock'), false)

  // 2) DSH 0.2.2 host with slots.has('conversation.input.dock') === false skips registration cleanly
  const ui22Has = workbenchEx((path) => {
    if (path.endsWith('/history')) return response({ history: [] })
    if (path.endsWith('/status')) return response({ version: '0.9.0' })
    return response({})
  }, { dockMode: '0.2.2-has-false' })
  t.after(() => ui22Has.unmount())
  assert.equal(ui22Has.slots.has('conversation.input.dock'), false)

  // 3) DSH 0.2.3 registers dock slot, probes dsh-market Update API v1 passively, and reacts to host language switch
  const inserted = []
  const ui23 = workbenchEx((path) => {
    if (path.endsWith('/history')) return response({ history: [] })
    if (path.endsWith('/status')) return response({ version: '0.9.0', capabilities: { dshMarketUpdateV1: true } })
    if (path.endsWith('/dsh-market/api/v1/capabilities')) return response({ plugins: [{ id: 'dsh-fintax', latestVersion: '0.9.5' }] })
    return response({})
  }, { dockMode: '0.2.3', lang: 'zh' })
  t.after(() => ui23.unmount())
  assert.equal(ui23.slots.has('conversation.input.dock'), true)
  const dockEl = ui23.slots.get('conversation.input.dock')({ insertText: (txt) => inserted.push(txt) })
  const dockBtn = dockEl.type(dockEl.props)
  dockBtn.props.onClick()
  assert.equal(inserted.length, 1)

  ui23.renderRoot()
  await flush()
  ui23.renderRoot()
  await flush()
  const zhRoot = JSON.stringify(ui23.renderRoot())
  assert.match(zhRoot, /发现新版本 v0\.9\.5/)
  assert.match(zhRoot, /14 大确定性算税/)

  // Dynamic zh -> en host language switch
  ui23.setHostLang('en')
  const enRoot = JSON.stringify(ui23.renderRoot())
  assert.match(enRoot, /14 Tax Calculators/)
  assert.match(enRoot, /Annual & Archives/)
  assert.match(enRoot, /Update available v0\.9\.5/)
})


test('Round-2 client regressions: tab re-activation refreshes history, tariffProgram defaults blank, EU math-infeasible never shows EUR 0, and IMA strips <br/> & //domain + safe UTF-16 slice', async (t) => {
  let historyFetchCount = 0
  const calcBodies = []
  let calcMode = 'us_default'
  const existingClaimed = [
    ...Array.from({ length: 24 }, (_, idx) => ({
      id: `111111${String(idx + 1).padStart(2, '0')}-1111-4111-8111-111111111111`,
      revision: `222222${String(idx + 1).padStart(2, '0')}-2222-4222-8222-222222222222`,
      month: `2026-${String((idx % 12) + 1).padStart(2, '0')}`,
      entityKey: '深圳同名科技-uscc91440300',
      entityLabel: '深圳同名科技',
      entityName: '深圳同名科技',
      ownershipStatus: 'claimed',
      shopKey: `s${idx + 1}`,
      shopLabel: `店${idx + 1}`,
      storeScope: `店${idx + 1}`,
      netSalesCny: 100000,
    })),
    { id: '99999999-1111-4111-8111-111111111111', revision: '88888888-2222-4222-8222-222222222222', month: '2026-01', entityName: '待认领', entityLabel: '待认领', ownershipStatus: 'unclaimed', shopKey: 'uncl_jan', shopLabel: '一月老待认领店', storeScope: '一月老待认领店', netSalesCny: 50000 },
  ]
  const emojiSnippet = `${'欧'.repeat(158)}🔋尾部被截断<br/>换行//cdn.leak.example.com/secret.pdf`
  const ui = workbenchEx((path, init) => {
    if (path.endsWith('/history') && (!init?.method || init.method === 'GET')) {
      historyFetchCount++
      return response({ history: existingClaimed })
    }
    if (path.endsWith('/history/annual')) return response({ ok: true, summary: { year: 2026, deadlineDate: '2027-01-31', scopeLabel: '全部', availableEntities: [], quarters: [], threeJurisdictions: { cards: [] } } })
    if (path.endsWith('/status')) return response({ version: '0.9.0', configured: true })
    if (path.endsWith('/parse')) {
      return response({
        ...batchResult({ consolidated: { ready: true, totals: { grossCny: 1000, netSalesCny: 1000, feesCny: 0 } } }),
        archiveToken: 'tok-1', archiveMonth: '2026-11',
      })
    }
    if (path.endsWith('/history') && init?.method === 'POST') {
      return response({ conflict: true, code: 'REVISION_CONFLICT', conflictType: 'revision_conflict', candidates: existingClaimed }, 409)
    }
    if (path.endsWith('/calc')) {
      const body = JSON.parse(init.body)
      calcBodies.push(body)
      if (calcMode === 'eu_infeasible') {
        return response({
          result: {
            scenario: '欧盟低值包裹', scenarioCode: 'eu_low_value_parcel', currency: 'EUR', sellingPriceEur: 35.7,
            euCustomsLevyTotalEur: 10, netProfitEur: 1.67, returnSunkHandlingFeeEur: 0.32,
            breakdown: {
              revenueAndTax: { sellingPriceEur: 35.7 },
              planComparison: { mixedDirect: { netProfitEur: 1.67 }, splitParcelByHsDirect: { netProfitEur: -2.33 }, singleHsDirect: { netProfitEur: 6.67 } },
              reversePricing: {
                mixedDirect: {
                  feasible: false, mathFeasible: false, feasibleUnderLowValueRegime: false, exceeds150Threshold: false,
                  infeasibleReason: 'exceeds_theoretical_margin_cap', maxTheoreticalMarginRate: 0.6902,
                  minSellingPriceEur: null, minSellingPriceCeilEur: null, unconstrainedMinSellingPriceEur: null,
                },
              },
            },
          },
        })
      }
      return response({ result: calculateCrossborder('us_t86_vs_9810_ddp', body.params) })
    }
    if (path.endsWith('/ima-quick')) {
      return response({
        ok: true, configured: true, query: '欧盟',
        hits: [{ title: `标题${'A'.repeat(77)}🔋<br/>//evil.example.org/a`, folderPath: '/EU/2026', snippet: emojiSnippet }],
        disclaimer: '仅展示 ≤160 字只读摘要',
      })
    }
    return response({})
  })
  t.after(() => ui.unmount())

  // 1) Initial Tab 1 load -> switch to Tab 3 -> switch back to Tab 1 triggers automatic refreshHistory
  ui.radar()
  await flush()
  const initialCount = historyFetchCount
  byText(ui.renderRoot(), 'button', '年度汇算与归档').props.onClick()
  ui.annual()
  ui.radar()
  await flush()
  assert.match(JSON.stringify(ui.annual()), /一月老待认领店/, '>20 份归档时第 25 条年初待认领快照绝不可被截断隐藏')
  const afterAnnualCount = historyFetchCount
  byText(ui.renderRoot(), 'button', '账单离线排雷').props.onClick()
  ui.radar()
  await flush()
  assert.ok(historyFetchCount > afterAnnualCount && afterAnnualCount >= initialCount)

  // 2) Same-name claimed entity guard in Tab 1 blocks silent merge until entityKey selected, and 409 REVISION_CONFLICT shows distinct text
  importFiles(ui.radar, [{ name: 'a.csv', size: 1 }])
  await flush()
  const entInput = [...tree(ui.radar())].find((el) => el.type === 'input' && el.props.placeholder === '公司主体(防串账)')
  entInput.props.onChange({ target: { value: '深圳同名科技' } })
  assert.ok([...tree(ui.radar())].some((el) => el.props['data-testid'] === 'entity-key-guard'))
  await byText(ui.radar(), 'button', '归档').props.onClick()
  assert.match(JSON.stringify(ui.radar()), /复用已有主体编码或填写统一社会信用代码/)
  byText(ui.radar(), 'button', '复用 [深圳同名科技-uscc91440300]').props.onClick()
  await byText(ui.radar(), 'button', '归档').props.onClick()
  assert.match(JSON.stringify(ui.radar()), /REVISION_CONFLICT/)
  assert.ok(byText(ui.radar(), 'button', '刷新归档列表'))

  // 3) us_t86_vs_9810_ddp defaults tariffProgram to '' (never sends 'IEEPA' unchosen)
  const navBtns = [...tree(ui.calc())].filter((el) => el.props.className?.includes('ftx-nav-btn'))
  navBtns.find((el) => JSON.stringify(el).includes('美线 Type 11 vs 9810 DDP')).props.onClick()
  await byText(ui.calc(), 'button', '立即代码精算（0 Token）').props.onClick()
  assert.equal(calcBodies[0].params.tariffProgram, undefined)

  // 4) eu_low_value_parcel math-infeasible target margin renders '目标净利率不可达', never '€0（超 €150）'
  calcMode = 'eu_infeasible'
  navBtns.find((el) => JSON.stringify(el).includes('欧盟低值包裹')).props.onClick()
  await byText(ui.calc(), 'button', '立即代码精算（0 Token）').props.onClick()
  const euTxt = JSON.stringify(ui.calc())
  assert.match(euTxt, /同篮拆包 €-2\.33/)
  assert.match(euTxt, /单税则SKU €6\.67/)
  assert.match(euTxt, /目标净利率不可达/)
  assert.doesNotMatch(euTxt, /€0（超 €150）/)

  // 5) IMA drawer strips <br/> & //domain.tld while preserving /EU/2026 and UTF-16 well-formedness
  const row = [...tree(ui.radar())].find((el) => el.props.className === 'ftx-risk-row')
  byText(row, 'button', '就地查 IMA 出处').props.onClick()
  ui.drawer()
  await flush()
  const dTree = ui.drawer()
  const snip = String([...tree(dTree)].find((el) => el.props.className === 'ftx-drawer-snippet').children[0])
  assert.equal(snip.isWellFormed(), true)
  assert.doesNotMatch(snip, /<br\/>|leak\.example\.com/)
  assert.match(JSON.stringify(dTree), /\/EU\/2026/)
  assert.doesNotMatch(JSON.stringify(dTree), /evil\.example\.org/)
})
