import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { admitRequest, createFintaxApiHandler } from '../index.js'
import { computeRolling12m, deleteSnapshot, loadHistory, saveSnapshot } from '../lib/history.js'
import { saveFintaxSettings } from '../lib/ima.js'

function useTestProfile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fintax-isolated-'))
  const previous = process.env.FINTAX_CONFIG_DIR
  process.env.FINTAX_CONFIG_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.FINTAX_CONFIG_DIR
    else process.env.FINTAX_CONFIG_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function handler() {
  return createFintaxApiHandler({ getConnection: () => ({ admit: () => ({ peer: {} }) }) })
}

function respond(handle, req) {
  const result = {}
  return handle(req, {
    writeHead(status, headers) { Object.assign(result, { status, headers }) },
    end(text) { result.data = JSON.parse(text) },
  }).then(() => result)
}

function request(handle, method, path, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method, url: '/api/fintax' + path })
  return respond(handle, req)
}

function salesFile(currency = 'USD', month = '2026-11') {
  const csv = [
    'Created,ID,Type,Description,Currency,Amount,Fee,Net',
    month + '-03,ch_fixture,charge,Sale,' + currency + ',100,0,100',
  ].join('\n')
  return { name: 'sales.csv', dataBase64: Buffer.from(csv).toString('base64') }
}

test('现代准入只接受明确 peer 或合法拒绝，旧版拒绝码单独兼容', () => {
  for (const admission of [undefined, null, {}, { peer: null }, { rejection: 200 }, [], Promise.resolve({ peer: {} })]) {
    assert.equal(admitRequest({}, { admit: () => admission, requestRejection: () => undefined }), 503)
  }
  assert.equal(admitRequest({}, { admit: () => ({ peer: {} }) }), undefined)
  assert.equal(admitRequest({}, { admit: () => ({ rejection: 403 }) }), 403)
  assert.equal(admitRequest({}, { requestRejection: () => undefined }), undefined)
  assert.equal(admitRequest({}, { requestRejection: () => 401 }), 401)
})

test('流式读取超过上限先返回 413，未销毁请求；中断后的正文不尝试保存', async () => {
  const handle = handler()
  class Request extends EventEmitter {
    method = 'POST'
    url = '/api/fintax/settings'
    destroy() { assert.fail('413 must be sent before closing the response') }
  }
  const req = new Request()
  const pending = respond(handle, req)
  req.emit('data', Buffer.alloc(32_769))
  req.emit('end')
  const r = await pending
  assert.equal(r.status, 413)
  assert.equal(r.headers.connection, 'close')
  assert.equal(r.data.code, 'REQUEST_TOO_LARGE')
  const abort = new Request()
  const aborted = respond(handle, abort)
  abort.emit('aborted')
  assert.equal((await aborted).data.code, 'REQUEST_INTERRUPTED')
})

test('缺失或未确认的汇率、跨月及漏页均无法提交归档', async (t) => {
  useTestProfile(t)
  const handle = handler()
  const parse = (files, options = {}) => request(handle, 'POST', '/parse', { reportFormat: 'data', files, ...options })
  const save = (body) => request(handle, 'POST', '/history', { month: '2026-11', ...body })
  for (const fxRates of [null, 'null', []]) {
    const result = await parse([salesFile()], { fxRates })
    assert.equal(result.status, 400)
    assert.equal(result.data.code, 'INVALID_FX_MAP')
  }
  const invalidUpload = await parse([{ name: 'sales.csv', dataBase64: '%%%%' }])
  assert.equal(invalidUpload.data.code, 'INVALID_FILE_DATA')
  assert.equal((await parse(Array(25).fill(salesFile()))).status, 413)
  const unconfirmed = await parse([salesFile()], { fxRates: { USD: 7.2 } })
  assert.equal(unconfirmed.data.consolidated.ready, true)
  assert.equal(unconfirmed.data.fxConfirmationNeeded, true)
  assert.equal(unconfirmed.data.archiveToken, undefined)
  assert.equal((await save({ grossCny: 720 })).data.code, 'ARCHIVE_EVIDENCE_REQUIRED')
  const missing = await parse([salesFile()], { fxConfirmed: true })
  assert.equal(missing.data.consolidated.ready, false)
  assert.equal(missing.data.archiveToken, undefined)
  const first = await parse([salesFile()], { fxRates: { USD: 7.2 }, fxConfirmed: true })
  assert.equal(first.data.archiveMonth, '2026-11')
  assert.ok(first.data.archiveToken)
  assert.equal((await save({ month: '2026-12', archiveToken: first.data.archiveToken })).data.code, 'ARCHIVE_PERIOD_MISMATCH')
  const saved = await save({ archiveToken: first.data.archiveToken, grossCny: 1 })
  assert.equal(saved.data.entry.grossCny, 720)
  assert.equal((await save({ archiveToken: first.data.archiveToken })).data.code, 'ARCHIVE_EVIDENCE_REQUIRED')

  const unknown = { name: 'unknown.csv', dataBase64: Buffer.from('Day,Note,Count\n2026-11-01,private@example.test,1').toString('base64') }
  const partial = await parse([salesFile('CNY'), unknown])
  assert.equal(partial.status, 200)
  assert.deepEqual(partial.data.coverage.files.map(({ status }) => status), ['parsed', 'rejected'])
  assert.equal(partial.data.consolidated.coverageComplete, false)
  assert.equal(partial.data.archiveToken, undefined)
  assert.doesNotMatch(JSON.stringify(partial.data), /private@example/)
  const mixed = await parse([salesFile('CNY'), salesFile('CNY', '2026-10')])
  assert.equal(mixed.data.archiveToken, undefined)
})

test('账期、冲突方式、UUID 及替换版本均严格校验，未知删除不重写', (t) => {
  const dir = useTestProfile(t)
  const path = join(dir, 'fintax_history.json')
  const basic = { month: '2026-11', grossCny: 10, entityName: 'Example Trading', storeScope: 'North' }
  for (const month of ['2026-1', '2026-13', 'text 2026-11', '2026/11', undefined]) {
    assert.throws(() => saveSnapshot({ ...basic, month }), { code: 'INVALID_MONTH' })
  }
  assert.throws(() => saveSnapshot({ ...basic, conflictMode: null }), { code: 'INVALID_CONFLICT_MODE' })
  assert.throws(() => saveSnapshot({ ...basic, conflictMode: 'replace' }), { code: 'INVALID_REPLACE_TARGET' })
  assert.throws(() => saveSnapshot({ ...basic, zeroSalesConfirmed: 'false' }), { code: 'INVALID_ZERO_CONFIRMATION' })
  const original = saveSnapshot(basic).entry
  assert.equal(original.entityName, 'Example Trading')
  const appended = saveSnapshot({ ...basic, conflictMode: 'append' }).entry
  assert.equal(saveSnapshot(basic).candidates.length, 2)
  const replace = { ...basic, conflictMode: 'replace', targetId: original.id, expectedRevision: original.revision, grossCny: 20 }
  const changed = saveSnapshot(replace)
  assert.equal(changed.entry.id, original.id)
  assert.notEqual(changed.entry.revision, original.revision)
  assert.equal(changed.history.find(({ id }) => id === appended.id).grossCny, 10)
  assert.equal(saveSnapshot(replace).conflict, true)
  assert.throws(() => deleteSnapshot('legacy_1'), { code: 'INVALID_SNAPSHOT_ID' })
  const contents = readFileSync(path, 'utf8')
  assert.equal(deleteSnapshot('10bfc9c4-6383-4939-b49b-3226c3b7012d').deleted, false)
  assert.equal(readFileSync(path, 'utf8'), contents)
})

test('旧档白名单迁移、防重复 ID 与多店完整滚动窗口', (t) => {
  const dir = useTestProfile(t)
  const path = join(dir, 'fintax_history.json')
  const legacy = { id: 'legacy_1', month: '2026-10', grossCny: 100, platforms: ['Amazon', 'private@example.test'], rawRows: ['private@example.test'] }
  writeFileSync(path, JSON.stringify({ entries: [legacy] }))
  const migrated = loadHistory()[0]
  assert.deepEqual(migrated.platforms, ['Amazon'])
  assert.equal(migrated.rawRows, undefined)
  assert.equal(migrated.ownershipStatus, 'unclaimed')
  assert.equal(loadHistory()[0].id, migrated.id)

  for (let store = 1; store <= 11; store++) {
    for (let month = 1; month <= 12; month++) {
      saveSnapshot({
        month: '2026-' + String(month).padStart(2, '0'),
        entityName: store <= 5 ? '公司甲' : '公司乙', storeScope: '店铺' + store,
        grossCny: 47_000,
      })
    }
  }
  const history = loadHistory()
  assert.equal(history.length, 133)
  assert.doesNotMatch(readFileSync(path, 'utf8'), /private@example|rawRows/)
  const all = computeRolling12m(history)
  assert.ok(all.totalNetSalesCny > 5_000_000)
  assert.equal(all.thresholdApplicable, false)
  assert.equal(all.threshold5mLevel, null)
  assert.equal(all.cliff75mAlert, null)
  assert.equal(computeRolling12m(history, { entityName: '公司甲' }).threshold5mLevel, 'safe')

  const duplicate = JSON.stringify({ entries: [legacy, legacy] })
  writeFileSync(path, duplicate)
  assert.throws(() => saveSnapshot({ month: '2026-11', grossCny: 100 }), { code: 'LOCAL_DATA_CORRUPT' })
  assert.equal(readFileSync(path, 'utf8'), duplicate)
})

test('损坏本地设置保留原件，锁竞争和写入失败不会留下暂存文件', (t) => {
  const dir = useTestProfile(t)
  const path = join(dir, 'fintax_config.json')
  const original = '{"customFxRates":'
  writeFileSync(path, original)
  assert.throws(() => saveFintaxSettings({ customFxRates: { USD: 7.21 } }), { code: 'LOCAL_DATA_CORRUPT' })
  assert.equal(readFileSync(path, 'utf8'), original)
  assert.deepEqual(readdirSync(dir), ['fintax_config.json'])
  writeFileSync(path + '.lock', '')
  assert.throws(() => saveFintaxSettings({ customFxRates: { USD: 7.23 } }), { code: 'LOCAL_DATA_BUSY' })
})
