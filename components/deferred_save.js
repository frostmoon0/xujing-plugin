import { AsyncLocalStorage } from 'node:async_hooks'

const saveContext = new AsyncLocalStorage()
const pending = new Map()
let flushing = false

export function inDeferredSaveContext () {
  return saveContext.getStore() === true
}

export function withDeferredSaveContext (fn) {
  return saveContext.run(true, fn)
}

/** 跨存档事务的检查点必须先落盘，再执行外部账户/背包操作。 */
export function withImmediateSaveContext (fn) {
  return saveContext.run(false, fn)
}

/** 后台推进只登记最新写入；普通玩家操作直接写盘。 */
export function saveOrDefer (key, save) {
  const normalizedKey = String(key)
  if (!inDeferredSaveContext()) {
    const result = save()
    pending.delete(normalizedKey)
    return result
  }
  pending.set(normalizedKey, save)
  return true
}

/** 同步刷新所有待保存项；失败项保留到下一轮重试。 */
export function flushDeferredSaves () {
  if (flushing) return { saved: 0, failed: 0, pending: pending.size }
  flushing = true
  let saved = 0
  let failed = 0
  try {
    for (const [key, save] of [...pending]) {
      try {
        save()
        if (pending.get(key) === save) {
          pending.delete(key)
          saved++
        }
      } catch (err) {
        failed++
      }
    }
  } finally {
    flushing = false
  }
  return { saved, failed, pending: pending.size }
}

export function pendingDeferredSaves () {
  return pending.size
}

/* 正常退出/重启时同步落盘；强制结束进程或断电不在此保证范围内。 */
if (!global.__xujingDeferredSaveExitHook__) {
  global.__xujingDeferredSaveExitHook__ = true
  process.on('beforeExit', () => flushDeferredSaves())
  process.on('exit', () => flushDeferredSaves())
}

export const _test = {
  clear () { pending.clear() },
  pending
}
