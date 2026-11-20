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

export function withLocalWriteLock(path, operation, { checkWritable = true } = {}) {
  const lock = `${path}.lock`
  let fd
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    fd = openSync(lock, 'wx', 0o600)
  } catch (err) {
    throw new LocalStoreError(err.code === 'EEXIST' ? 'LOCAL_DATA_BUSY' : 'LOCAL_DATA_UNAVAILABLE')
  }
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
