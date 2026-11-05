import { AsyncLocalStorage } from 'node:async_hooks'

const owners = new AsyncLocalStorage()
const queues = new Map()

/** 同群指令和后台账户结算共用锁；嵌套业务可重入，其他群独立推进。 */
export async function withGameLock (gid, fn) {
  const key = String(gid || 'global')
  const owner = owners.getStore()
  if (owner?.active && owner.key === key) return fn()
  const previous = queues.get(key) || Promise.resolve()
  let release
  const turn = new Promise(resolve => { release = resolve })
  queues.set(key, turn)
  await previous
  const token = { key, active: true }
  try { return await owners.run(token, fn) } finally {
    token.active = false
    if (queues.get(key) === turn) queues.delete(key)
    release()
  }
}
