import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { apply } from '../index.js'
import { clearImaCache, imaCall, readImaTextDownload, searchImaKnowledge } from '../lib/ima.js'

const endpoint = 'openapi/wiki/v1/search_knowledge'
const auditQuestionsPath = process.env.FINTAX_IMA_QUESTIONS
const opts = { noCache: true, retries: 0 }

const jsonResponse = (body) => new Response(JSON.stringify(body))
const result = (info_list, paging = {}) => jsonResponse({ code: 0, data: { info_list, ...paging } })
const item = (media_id) => ({ media_id, title: `示例条目 ${media_id}` })
const request = (query, cursor = '') => ({ query, cursor, knowledge_base_id: 'test-kb' })

function mockSearch(t, reply) {
  const saved = [process.env.IMA_CLIENT_ID, process.env.IMA_API_KEY]
  process.env.IMA_CLIENT_ID = 'fake-test-client'
  process.env.IMA_API_KEY = 'fake-test-key'
  clearImaCache()
  t.after(() => {
    clearImaCache()
    for (const [index, key] of ['IMA_CLIENT_ID', 'IMA_API_KEY'].entries()) {
      if (saved[index] === undefined) delete process.env[key]
      else process.env[key] = saved[index]
    }
  })

  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url, `https://ima.qq.com/${endpoint}`)
    assert.equal(init.method, 'POST')
    const body = JSON.parse(init.body)
    assert.equal(body.knowledge_base_id, 'test-kb')
    calls.push(body)
    return reply(body)
  })
  return calls
}

test('IMA：首屏只有一项时并发回退，按各查询命中频次去重排序', { timeout: 5000 }, async (t) => {
  const query = '做９８１０出口时如果货物退回国内，预退税台账怎么处理？'
  const terms = ['预退税', '退运', '9810']
  let allStarted
  const started = new Promise((resolve) => { allStarted = resolve })
  const pending = new Map()
  const listed = [item('stable'), item('overlap'), item('first'), item('last'), item('second')]
  const [stable, overlap, first, last, second] = listed
  const calls = mockSearch(t, ({ query: sent }) => {
    if (sent === query) return result([stable], { is_end: false, next_cursor: 'original-next' })
    return new Promise((resolve) => {
      pending.set(sent, resolve)
      if (pending.size === terms.length) allStarted()
    })
  })

  const search = searchImaKnowledge(request(query), opts)
  await started
  assert.deepEqual(calls.map(({ query, cursor }) => [query, cursor]), [query, ...terms].map((term) => [term, '']))
  pending.get('9810')(result([last, overlap], { is_end: false, next_cursor: 'term-next' }))
  pending.get('退运')(result([overlap, second]))
  pending.get('预退税')(result([first, overlap, overlap]))
  const data = await search
  assert.deepEqual(data.info_list, [overlap, stable, first, second, last])
  assert.deepEqual(data.fallback, { queries: terms, failed: 0 })
  assert.equal(data.is_end, false)
  assert.equal(data.next_cursor, 'original-next')
})

test('IMA：首屏达到两项、已是单短词或正在翻页时直接返回', async (t) => {
  const long = '请问 9610 出口怎样办理无票免税？'
  const calls = mockSearch(t, ({ query, cursor }) => result(query === long && !cursor ? [item('a'), item('b')] : []))
  for (const body of [request(long), request('9610'), request(long, 'original-next')]) {
    const data = await searchImaKnowledge(body, opts)
    assert.equal(data.fallback, undefined)
  }
  assert.deepEqual(calls, [request(long), request('9610'), request(long, 'original-next')])
})

test('IMA：短语保留监管代码，并发刷新合并在途原词和短词', async (t) => {
  const calls = mockSearch(t, async ({ query }) => {
    await new Promise((resolve) => setImmediate(resolve))
    return result(query === '1039' ? [item('1039')] : [])
  })
  for (const query of ['1039预退税', '1039出口的税务风险提示、报送差额以及平台更正']) {
    const before = calls.length
    const [left, right] = await Promise.all([
      searchImaKnowledge(request(query), opts),
      searchImaKnowledge(request(query), opts),
    ])
    assert.deepEqual(left, right)
    assert.deepEqual(left.info_list, [item('1039')])
    assert.ok(left.fallback.queries.includes('1039'))
    assert.deepEqual(calls.slice(before).map(({ query: q }) => q), [query, ...left.fallback.queries])
  }
})

test('IMA：只跟随白名单 HTTPS 下载，跨域重定向在出站前拒绝', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers, undefined)
    calls.push(url)
    if (url.endsWith('/outside')) return new Response(null, { status: 302, headers: { location: 'https://unapproved.example/file' } })
    if (url.endsWith('/inside')) return new Response(null, { status: 302, headers: { location: 'https://bucket.cos.ap-guangzhou.myqcloud.com/text' } })
    return new Response('text fixture')
  })
  await assert.rejects(() => readImaTextDownload('https://unapproved.example/file'), { code: 'IMA_DOWNLOAD_HOST' })
  assert.deepEqual(calls, [])
  await assert.rejects(() => readImaTextDownload('https://ima.qq.com/outside'), { code: 'IMA_DOWNLOAD_HOST' })
  assert.deepEqual(calls, ['https://ima.qq.com/outside'])
  assert.equal(await readImaTextDownload('https://ima.qq.com/inside'), 'text fixture')
  assert.equal(calls.at(-1), 'https://bucket.cos.ap-guangzhou.myqcloud.com/text')
})

test('IMA：短词请求部分失败时保留其他结果，原查询失败则直接报告错误', async (t) => {
  const query = '做 9610 跨境出口，想问出口免抵退和备案单证怎么准备？'
  const denied = () => jsonResponse({ code: 4001, msg: '测试权限错误' })
  const calls = mockSearch(t, ({ query: sent }) => {
    if (sent === '原查询失败' || sent === '免抵退') return denied()
    return result(sent === '单证备案' ? [item('related')] : [])
  })
  const data = await searchImaKnowledge(request(query), opts)
  assert.deepEqual(data.info_list, [item('related')])
  assert.deepEqual(data.fallback, { queries: ['单证备案', '免抵退', '9610'], failed: 1 })
  const failed = request('原查询失败')
  await assert.rejects(() => searchImaKnowledge(failed, opts), /code=4001/)
  assert.deepEqual(calls.slice(-1), [failed])
})

test('IMA：插件注册的 ima_search 工具返回补查条目和短词', async (t) => {
  const tools = new Map()
  apply({ tools: { register: (tool) => tools.set(tool.name, tool) }, skills: { register: () => {} } })
  const calls = mockSearch(t, ({ query }) => result(query === '9810' ? [item('mode')] : []))
  const body = request('9810怎么退税？')
  const output = await tools.get('ima_search').execute(body)
  assert.deepEqual(calls, [body, request('9810')])
  assert.match(output, /命中 1 条/)
  assert.match(output, /短词补查：9810/)
  assert.match(output, /示例条目 mode/)
})

test('IMA：使用外部 25 道真实问句验证离线短词回退', {
  skip: auditQuestionsPath ? false : '设置 FINTAX_IMA_QUESTIONS 指向本地 questions.json 以运行审计题回归',
}, async (t) => {
  const questions = JSON.parse(readFileSync(auditQuestionsPath, 'utf8').replace(/^\uFEFF/, ''))
  assert.equal(questions.length, 25)
  // 业务锚点用于验证拆词，模拟响应不依赖线上库的标题和排序。
  const anchors = [
    '税务风险提示', '报送差额', '平台更正', '四层口径', 'Amazon',
    '月结', '9610', '9710', '预退税', '9810',
    '4%核定', '1210', '0110', '300万', 'IOSS',
    '3欧元', '主体', '个人账户', '扣缴', '函调',
    '借名出海', '汇算', '普通发票', '开账', '四层口径',
  ]
  let anchor
  const calls = mockSearch(t, ({ query }) => result(query === anchor ? [item('fixture')] : []))
  for (const [index, query] of questions.entries()) {
    const body = request(query)
    anchor = anchors[index]
    const before = await imaCall(endpoint, body, opts)
    const start = calls.length
    const after = await searchImaKnowledge(body, opts)
    const queries = calls.slice(start + 1).map(({ query }) => query)
    const label = `口语题第 ${index + 1} 条`
    assert.deepEqual(before.info_list, [], label)
    assert.deepEqual(calls[start], body, label)
    assert.ok(queries.length >= 1 && queries.length <= 3, label)
    assert.equal(new Set(queries).size, queries.length, label)
    assert.ok(queries.every((term) => term.length < query.length), label)
    assert.deepEqual(after.info_list, [item('fixture')], label)
    assert.deepEqual(after.fallback, { queries, failed: 0 }, label)
  }
})

test('IMA：V2.3 新增专题短词回退覆盖 T86、欧盟处理费、全托管与独立站', async (t) => {
  const cases = [
    ['美国800美元T86小额豁免暂停怎么办', 'T86'],
    ['欧盟2欧元处理费实行后低值包裹怎么算', '欧盟低值包裹'],
    ['Temu全托管半托管结算单和退税主体核对', '全托管'],
    ['独立站Shopify和Stripe资金桥接怎么防重复', '独立站'],
    ['2026年末关账跨年未发货收入和股东借款死线', '年末关账'],
  ]
  for (const [query, expectedTerm] of cases) {
    let seen = []
    mockSearch(t, ({ query: sent }) => {
      seen.push(sent)
      return result(sent === expectedTerm ? [item(expectedTerm)] : [])
    })
    const res = await searchImaKnowledge(request(query), opts)
    assert.ok(res.fallback?.queries?.includes(expectedTerm), `expected ${expectedTerm} in ${JSON.stringify(res.fallback?.queries)} for "${query}"`)
    assert.deepEqual(res.info_list, [item(expectedTerm)])
  }
})
