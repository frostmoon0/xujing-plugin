import test from 'node:test'
import assert from 'node:assert/strict'
import { pushStack, topType, removeType, forceLock, isCurrent, unlock, currentInteract } from '../components/interact.js'

/* 内存 redis 替身: interact.js 函数体内引用全局 redis, 这里直接注入 */
function makeFakeRedis () {
  const store = new Map()
  return {
    store,
    get: async k => store.has(k) ? store.get(k) : null,
    set: async (k, v) => { store.set(k, v) },
    del: async k => { store.delete(k) }
  }
}

/* ---------- 纯函数 ---------- */

test('pushStack: 空栈压入, 栈尾即栈顶', () => {
  const s = pushStack(null, 'street')
  assert.equal(s.length, 1)
  assert.equal(topType(s), 'street')
})

test('pushStack: 同 type 去重并移到栈顶(被埋的同交互重新压栈优先)', () => {
  let s = pushStack([], 'street')
  s = pushStack(s, 'break')        // [street, break]
  s = pushStack(s, 'street')       // street 被埋 → 移到栈顶 → [break, street]
  assert.deepEqual(s.map(x => x.type), ['break', 'street'])
  assert.equal(topType(s), 'street')
})

test('topType: 空/非数组/单元素', () => {
  assert.equal(topType(null), null)
  assert.equal(topType([]), null)
  assert.equal(topType([{ type: 'x' }]), 'x')
  assert.equal(topType([{ type: 'a' }, { type: 'b' }]), 'b')
})

test('removeType: 摘栈顶', () => {
  let s = pushStack([], 'street')
  s = pushStack(s, 'break')        // [street, break]
  s = removeType(s, 'break')       // [street]
  assert.deepEqual(s.map(x => x.type), ['street'])
  assert.equal(topType(s), 'street')
})

test('removeType: 摘被埋条目, 上层不动, 下层仍保持原顺序', () => {
  let s = pushStack([], 'street')
  s = pushStack(s, 'break')        // [street, break]
  s = pushStack(s, 'go')           // [street, break, go]
  s = removeType(s, 'break')       // [street, go]
  assert.deepEqual(s.map(x => x.type), ['street', 'go'])
  assert.equal(topType(s), 'go')
})

test('removeType: 不存在的 type 无副作用', () => {
  const s = pushStack([], 'street')
  const r = removeType(s, 'nope')
  assert.equal(r.length, 1)
  assert.equal(topType(r), 'street')
})

/* ---------- 端到端状态机(内存 redis) ---------- */

test('LIFO: 后发起的交互在栈顶, 被埋的 isCurrent 为 false', async () => {
  const fake = makeFakeRedis()
  global.redis = fake
  const gid = '10002', uid = '20002'
  await forceLock(gid, uid, 'street')
  await forceLock(gid, uid, 'break')            // break 在栈顶
  assert.equal(await isCurrent(gid, uid, 'break'), true)
  assert.equal(await isCurrent(gid, uid, 'street'), false)
  assert.equal((await currentInteract(gid, uid)).type, 'break')
  assert.equal((await currentInteract(gid, uid)).cn, '渡劫')
})

test('unlock: 摘除栈顶后下层交互浮上; 空栈删 key', async () => {
  const fake = makeFakeRedis()
  global.redis = fake
  const gid = '10003', uid = '20003'
  await forceLock(gid, uid, 'street')           // [street]
  await forceLock(gid, uid, 'break')            // [street, break]
  await unlock(gid, uid, 'break')               // → [street]
  assert.equal(await isCurrent(gid, uid, 'street'), true)
  await unlock(gid, uid, 'street')              // → []
  assert.equal(await currentInteract(gid, uid), null)
  assert.equal(fake.store.size, 0)
})

test('unlock: 被埋的交互完成时只摘除自己, 不影响上层', async () => {
  const fake = makeFakeRedis()
  global.redis = fake
  const gid = '10006', uid = '20006'
  await forceLock(gid, uid, 'street')           // [street]
  await forceLock(gid, uid, 'break')            // [street, break]
  await forceLock(gid, uid, 'go')               // [street, break, go]
  await unlock(gid, uid, 'break')               // 埋住的渡劫完成 → [street, go]
  assert.equal(await isCurrent(gid, uid, 'go'), true)
  assert.equal(await isCurrent(gid, uid, 'street'), false)
})

test('forceLock: 被埋的同 type 压栈后移到栈顶(用户重发同指令时打断在前的其它交互)', async () => {
  const fake = makeFakeRedis()
  global.redis = fake
  const gid = '10004', uid = '20004'
  await forceLock(gid, uid, 'street')           // [street]
  await forceLock(gid, uid, 'break')            // [street, break]
  await forceLock(gid, uid, 'street')           // 再逛街 → [break, street]
  assert.equal(await isCurrent(gid, uid, 'street'), true)
  assert.equal(await isCurrent(gid, uid, 'break'), false)
  await unlock(gid, uid, 'street')              // 新逛街完成 → [break]
  assert.equal(await isCurrent(gid, uid, 'break'), true)
})

/* 用户示例2: B→A→答A→C→答C→再答B(每次按"当时栈顶"路由) */
test('LIFO 端到端: B→A→答A→C→答C→答B', async () => {
  const fake = makeFakeRedis()
  global.redis = fake
  const gid = '10001', uid = '20001'

  // B(渡劫)先发起, A(逛街)后发起
  await forceLock(gid, uid, 'break')            // [break]
  await forceLock(gid, uid, 'street')           // [break, street]

  // 回复 1 → 处理 A(栈顶 street)
  assert.equal(await isCurrent(gid, uid, 'street'), true)
  await unlock(gid, uid, 'street')              // → [break]

  // C(跨区)再发起
  await forceLock(gid, uid, 'go')               // [break, go]

  // 回复 2 → 处理 C(栈顶 go)
  assert.equal(await isCurrent(gid, uid, 'go'), true)
  await unlock(gid, uid, 'go')                  // → [break]

  // 回复 3 → 处理 B(栈顶 break)
  assert.equal(await isCurrent(gid, uid, 'break'), true)
  await unlock(gid, uid, 'break')               // → []
  assert.equal(await currentInteract(gid, uid), null)
})

/* 遇宠压栈打断: 逛街中遇宠 → pet 在栈顶 → 处理完弹回逛街 */
test('遇宠压栈打断: pet 栈顶优先, 完成后逛街恢复', async () => {
  const fake = makeFakeRedis()
  global.redis = fake
  const gid = '10005', uid = '20005'
  await forceLock(gid, uid, 'street')           // [street]
  await forceLock(gid, uid, 'pet')              // 遇宠压栈 → [street, pet]
  assert.equal(await isCurrent(gid, uid, 'pet'), true)
  assert.equal(await isCurrent(gid, uid, 'street'), false)
  await unlock(gid, uid, 'pet')                 // 遇宠处理完/过期 → [street]
  assert.equal(await isCurrent(gid, uid, 'street'), true)
})

/* 伏击处置压栈: 打赢伏击压栈 'ambush' → 处置数字归伏击 → 处置完成摘锁弹回下层 */
test('伏击处置压栈: ambush 栈顶优先, 处置完成逛街恢复', async () => {
  const fake = makeFakeRedis()
  global.redis = fake
  const gid = '10008', uid = '20008'
  await forceLock(gid, uid, 'street')           // [street]
  await forceLock(gid, uid, 'ambush')           // 打赢伏击压栈 → [street, ambush]
  assert.equal(await isCurrent(gid, uid, 'ambush'), true)
  assert.equal(await isCurrent(gid, uid, 'street'), false)
  await unlock(gid, uid, 'ambush')              // 处置完成 → [street]
  assert.equal(await isCurrent(gid, uid, 'street'), true)
})

/* 遇宠过期摘锁: 过期后锁被摘, 下层立刻恢复, 不堵栈 */
test('遇宠过期摘锁: unlock 后下层交互立刻可路由', async () => {
  const fake = makeFakeRedis()
  global.redis = fake
  const gid = '10009', uid = '20009'
  await forceLock(gid, uid, 'street')           // [street]
  await forceLock(gid, uid, 'pet')              // 遇宠压栈 → [street, pet]
  await unlock(gid, uid, 'pet')                 // 遇宠过期摘锁 → [street]
  assert.equal(await isCurrent(gid, uid, 'street'), true)
  const cur = await currentInteract(gid, uid)
  assert.equal(cur && cur.type, 'street')
})

/* 孤儿锁自清理: 打赢压栈 ambush 但状态保存失败(won 丢失, 锁残留) → 数字路由时摘除孤儿锁, 下层恢复 */
test('孤儿锁自清理: ambush 状态丢失但锁残留, unlock 后恢复不堵栈', async () => {
  const fake = makeFakeRedis()
  global.redis = fake
  const gid = '10010', uid = '20010'
  await forceLock(gid, uid, 'street')           // [street]
  await forceLock(gid, uid, 'ambush')           // 打赢压栈 → [street, ambush]
  /* 模拟状态保存失败: 没有写 won 状态; 此刻 isCurrent('ambush') 仍为 true(锁残留) */
  assert.equal(await isCurrent(gid, uid, 'ambush'), true)
  /* ambushWonOf 读不到 won → 数字路由到 ambushDisposePickCmd 时摘除孤儿锁 */
  await unlock(gid, uid, 'ambush')              // 摘孤儿锁 → [street]
  assert.equal(await isCurrent(gid, uid, 'street'), true)
  const cur = await currentInteract(gid, uid)
  assert.equal(cur && cur.type, 'street')
})

test('currentInteract: 空栈返回 null, 栈顶类型映射中文名', async () => {
  const fake = makeFakeRedis()
  global.redis = fake
  assert.equal(await currentInteract('10007', '20007'), null)
  await forceLock('10007', '20007', 'dynasty-siege')
  assert.deepEqual(await currentInteract('10007', '20007'), { type: 'dynasty-siege', cn: '王朝攻城' })
})

test('并发压栈保留所有交互，并按发起顺序决定栈顶', async () => {
  const fake = makeFakeRedis()
  global.redis = fake
  const results = await Promise.all(['street', 'pet', 'break'].map(type => forceLock('parallel', '1', type)))
  assert.deepEqual(results.map(r => r.prev), [null, 'street', 'pet'])
  assert.deepEqual(JSON.parse([...fake.store.values()][0]).map(x => x.type), ['street', 'pet', 'break'])
})

test('并发摘除与压栈不丢新交互，也不复活已摘除条目', async () => {
  global.redis = makeFakeRedis()
  await forceLock('parallel', '2', 'street')
  await forceLock('parallel', '2', 'pet')
  await Promise.all([unlock('parallel', '2', 'pet'), forceLock('parallel', '2', 'break'), unlock('parallel', '2', 'street')])
  assert.deepEqual(await currentInteract('parallel', '2'), { type: 'break', cn: '渡劫' })
  await unlock('parallel', '2', 'break')
  assert.equal(await currentInteract('parallel', '2'), null)
})

test('Redis 写入失败后释放队列，不阻塞其它用户和后续交互', async () => {
  const fake = makeFakeRedis()
  let rejectFirst = true
  global.redis = { ...fake, set: async (key, value) => {
    if (key.endsWith(':bad') && rejectFirst) { rejectFirst = false; throw new Error('write failed') }
    return fake.set(key, value)
  } }
  const results = await Promise.allSettled([forceLock('parallel', 'bad', 'street'), forceLock('parallel', 'good', 'pet'), forceLock('parallel', 'bad', 'break')])
  assert.deepEqual(results.map(r => r.status), ['rejected', 'fulfilled', 'fulfilled'])
  assert.equal(await isCurrent('parallel', 'good', 'pet'), true)
  assert.equal(await isCurrent('parallel', 'bad', 'break'), true)
})
