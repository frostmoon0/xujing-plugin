// 交互互斥改为后进先出(LIFO)栈: 同一用户可同时挂多个待处理交互(逛街/渡劫/换装/分解…)
// 数字指令永远路由给栈顶(最新发起)的交互; 栈顶处理完(unlock)后次新的顶上继续答
// 被埋在下层的交互保留各自待选状态, 等回到栈顶再恢复; unlock 只摘除自己, 不影响他人
// 用法: await forceLock(gid, uid, 'street') → {ok, prev, prevCN}; 完成后 await unlock(gid, uid, type)
const TTL = 5 * 60//交互占用默认5分钟(与逛街/换装超时一致)
// 太初沿用同一LIFO交互栈，不能抢占其他数字菜单。
const TYPE_CN = { 'sect-war': '宗门战争', street: '逛街', break: '渡劫', equip: '换装', gift: '赠送', sell: '出售', go: '跨区', list: '上架', 'dismantle-color': '分解彩装', dismantle: '分解红装', 'wanhun-shop': '魔窟商人', 'wanhun-cave': '万魂窟', pet: '搜寻灵兽', realm: '秘境', 'craft-color': '合成彩装', 'craft-rainbow': '合成彩武', 'wanhun-craft': '万魂炼制', 'puppet-craft': '傀儡炼制', 'dynasty-siege': '王朝攻城', sellgf: '出售功法', ambush: '伏击处置' }

TYPE_CN.taichu = '太初古墟'

/** 交互 key(同旧实现, 不含 type: 一个用户在一个群只对应一个栈) */
function iKey (gid, uid) {
  return `xujing:interact:${gid}:${uid}`
}

/* ---------- 纯函数: 栈操作(可单测) ---------- */

/** 把 type 压到栈顶(数组尾): 同 type 已存在则移到栈顶, 保证每种交互至多一条 */
export function pushStack (arr, type) {
  const next = Array.isArray(arr) ? arr.filter(x => x && x.type !== type) : []
  next.push({ type, ts: Date.now() })
  return next
}

/** 取栈顶类型(空栈返回 null) */
export function topType (arr) {
  if (!Array.isArray(arr) || !arr.length) return null
  const last = arr[arr.length - 1]
  return last && last.type ? last.type : null
}

/** 移除指定 type(无论栈顶还是被埋, 都只摘除自己); 同 type 多实例时全部移除 */
export function removeType (arr, type) {
  if (!Array.isArray(arr)) return []
  return arr.filter(x => x && x.type !== type)
}

/* 同一用户的读改写串行；不同群/用户互不阻塞。失败也必须释放队列。 */
const mutationQueues = new Map()
async function mutateStack (key, fn) {
  const previous = mutationQueues.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(fn)
  mutationQueues.set(key, current)
  try { return await current } finally {
    if (mutationQueues.get(key) === current) mutationQueues.delete(key)
  }
}

/* ---------- Redis 读写 ---------- */

/** 读取栈(空/损坏返回 null, 兼容旧版单类型字符串直接视为无锁) */
async function readStack (key) {
  const raw = await redis.get(key)
  if (!raw) return null
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : null
  } catch (err) {
    return null
  }
}

/** 写回栈(空栈删 key) */
async function writeStack (key, arr) {
  if (!Array.isArray(arr) || !arr.length) {
    await redis.del(key)
    return
  }
  await redis.set(key, JSON.stringify(arr), { EX: TTL })
}

/**
 * 压栈某类型交互: 压到栈顶(最新发起, 优先被回复), 不终止下层交互
 * @returns {Promise<{ok:boolean, prev:string|null, prevCN:string}>} prev 为旧的栈顶类型
 */
export async function forceLock (gid, uid, type) {
  const key = iKey(gid, uid)
  return mutateStack(key, async () => {
    const stack = await readStack(key)
    const prev = topType(stack)
    await writeStack(key, pushStack(stack, type))
    return { ok: true, prev, prevCN: prev ? TYPE_CN[prev] || prev : '' }
  })
}

/**
 * 校验指定类型是否在栈顶(用于数字指令路由: 不是栈顶则说明被其它交互埋住, 让位)
 */
export async function isCurrent (gid, uid, type) {
  const stack = await readStack(iKey(gid, uid))
  return topType(stack) === type
}

/** 摘除指定类型的交互(栈顶/被埋均可, 只移除自己, 不影响其它交互) */
export async function unlock (gid, uid, type) {
  const key = iKey(gid, uid)
  return mutateStack(key, async () => {
    const stack = await readStack(key)
    if (!Array.isArray(stack)) return
    await writeStack(key, removeType(stack, type))
  })
}

/** 查询当前(栈顶)交互类型 */
export async function currentInteract (gid, uid) {
  const stack = await readStack(iKey(gid, uid))
  const type = topType(stack)
  return type ? { type, cn: TYPE_CN[type] || type } : null
}
