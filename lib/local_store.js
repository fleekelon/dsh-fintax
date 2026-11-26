import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class LocalStoreError extends Error {
  constructor(code) {
    super({
      LOCAL_DATA_CORRUPT: '本地数据文件损坏，请先备份并修复原文件。',
      LOCAL_DATA_UNAVAILABLE: '本地数据读写失败，请检查目录权限及文件状态。',
      LOCAL_DATA_BUSY: '本地数据正在更新，请稍后重试。',
    }[code])
    this.code = code
  }
}

export function readLocalJson(path) {
  let content
  try {
    content = readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return undefined
    throw new LocalStoreError('LOCAL_DATA_UNAVAILABLE')
  }
  try {
    return JSON.parse(content)
  } catch {
    throw new LocalStoreError('LOCAL_DATA_CORRUPT')
  }
}

const DEFAULT_STALE_LOCK_MS = 30_000
const SLEEP_ARR = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(SLEEP_ARR, 0, 0, ms)
}

function tryAcquireLock(lock, staleMs, retries, retryDelayMs) {
  let staleRecovered = false
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      try {
        writeFileSync(fd, `${process.pid}:${Date.now()}\n`, 'utf8')
      } catch { /* ignore metadata write errors */ }
      return fd
    } catch (err) {
      if (err.code !== 'EEXIST') throw new LocalStoreError('LOCAL_DATA_UNAVAILABLE')
      if (!staleRecovered) {
        try {
          const st = statSync(lock)
          if (Date.now() - st.mtimeMs >= staleMs) {
            rmSync(lock, { force: true })
            staleRecovered = true
            attempt--
            continue
          }
        } catch (statErr) {
          if (statErr.code === 'ENOENT') {
            staleRecovered = true
            attempt--
            continue
          }
        }
      }
      if (attempt < retries) sleepSync(retryDelayMs)
    }
  }
  throw new LocalStoreError('LOCAL_DATA_BUSY')
}

export function withLocalWriteLock(path, operation, {
  checkWritable = true,
  staleMs = DEFAULT_STALE_LOCK_MS,
  retries = 2,
  retryDelayMs = 15,
} = {}) {
  const lock = `${path}.lock`
  let fd
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  } catch {
    throw new LocalStoreError('LOCAL_DATA_UNAVAILABLE')
  }
  fd = tryAcquireLock(lock, staleMs, retries, retryDelayMs)
  try {
    if (checkWritable) {
      try {
        if ((statSync(path).mode & 0o222) === 0) throw new LocalStoreError('LOCAL_DATA_UNAVAILABLE')
      } catch (err) {
        if (err.code !== 'ENOENT') throw new LocalStoreError('LOCAL_DATA_UNAVAILABLE')
      }
    }
    return operation()
  } finally {
    closeSync(fd)
    rmSync(lock, { force: true })
  }
}

export function writeLocalJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`
  let fd
  let created = false
  try {
    fd = openSync(tmp, 'wx', 0o600)
    created = true
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8')
    closeSync(fd)
    fd = undefined
    renameSync(tmp, path)
  } catch {
    throw new LocalStoreError('LOCAL_DATA_UNAVAILABLE')
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (created) rmSync(tmp, { force: true })
  }
}
