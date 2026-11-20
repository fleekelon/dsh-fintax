import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

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
