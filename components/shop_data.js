import { withGameLock } from './game_lock.js'
/* ============================================================
 * 虚境三阁 · 动态补货系统
 * - 丹阁(dange)/器阁(qige)/藏宝阁(cangbaoge) 每群独立库存
 * - 随机 0~4小时 补货一次(惰性: 玩家打开商店/购买时若到点自动补货)
 * - 补货量按"上一补货周期内活跃玩家数"加成(玩的人越多货越多):
 *     丹阁/藏宝阁: 加成 = ⌊活跃人数÷2×1.5⌋
 *     器阁: 随机抽部位上架, 每+2活跃多抽1个部位
 * - 售罄后只能等下次补货
 * ============================================================ */
import { EQUIP_TPL, GONGFA_TPL, PARTS } from './equip_data.js'
import { getWorld, getRate, addTax, saveWorld, bossOf, REGIONS, taxFor } from './world_data.js'

const RESTOCK_MIN = 0 // 最短 0 分钟(可能立即补货)
const RESTOCK_MAX = 4 * 60 * 60 * 1000 // 最长 4 小时

/* ---- redis key(库存/补货/活跃均按大区独立: 各区数量时间各自不一) ---- */
const actKey = (gid, region) => `xujing:shop-act:${gid}:${region || 'center'}` // 活跃 hash: uid -> 时间戳(按大区)
const stockKey = (gid, shop, region) => `xujing:shop-stock:${shop}:${gid}:${region || 'center'}` // 库存 JSON(按大区)
const lastKey = (gid, shop, region) => `xujing:shop-last:${shop}:${gid}:${region || 'center'}` // 上次补货时间戳(按大区)
const nextKey = (gid, shop, region) => `xujing:shop-next:${shop}:${gid}:${region || 'center'}` // 下次补货时间戳(按大区)

/* ================= 活跃度统计(按大区独立) ================= */

/** 记录一次有效互动(同一用户覆盖为最新时间); region=玩家所在大区 */
export async function recordActive (gid, uid, region) {
  if (!gid || !uid) return
  try { await redis.hSet(actKey(String(gid), region), String(uid), String(Date.now())) } catch (err) {}
}

/** 统计 since 之后有互动的去重人数(仅该大区) */
export async function countActive (gid, since, region) {
  try {
    const all = await redis.hGetAll(actKey(String(gid), region))
    if (!all) return 0
    let n = 0
    for (const k of Object.keys(all)) if (Number(String(all[k])) >= since) n++
    return n
  } catch (err) { return 0 }
}

/** 清理 since 之前的活跃记录(补货后调用,保留最新周期) */
async function pruneActive (gid, since, region) {
  try {
    const all = await redis.hGetAll(actKey(String(gid), region))
    if (!all) return
    const keep = {}
    for (const k of Object.keys(all)) if (Number(String(all[k])) >= since) keep[k] = all[k]
    if (Object.keys(keep).length) await redis.hSet(actKey(String(gid), region), keep)
    else await redis.del(actKey(String(gid), region))
  } catch (err) {}
}

/* ================= 补货 ================= */

/** 加成: 多2人多1.5(向下取整); 2026-08-14 活跃人数加成减少1/3(×2/3) */
const activeBonus = n => Math.floor((Number(n) || 0) / 2 * 1.5 * 2 / 3)
const rand = n => Math.floor(Math.random() * (n + 1))

function shuffle (arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 藏宝阁功法加权抽取: 白绿蓝多 / 紫中 / 金稀有 */
function pickGongfa () {
  const pool = Object.keys(GONGFA_TPL).filter(n => GONGFA_TPL[n].quality <= 5)
  const w = { 1: 5, 2: 5, 3: 4, 4: 3, 5: 1 }
  let total = 0
  const ws = pool.map(n => { const t = w[GONGFA_TPL[n].quality] || 1; total += t; return { n, t } })
  let r = Math.random() * total
  for (const it of ws) { r -= it.t; if (r <= 0) return it.n }
  return ws[ws.length - 1].n
}

/** 生成指定商店的库存(无数量上限, 随活跃人数线性增长; 各区随机浮动保证数量不一) */
function genStock (shop, act) {
  const bonus = activeBonus(act)
  if (shop === 'dange') {
    // 补货数量: 原2.5倍(2026-08-15) → 再减1/3(×2/3), 至少留1颗
    return {
      '修为丹': Math.max(1, Math.floor(((3 + bonus) * 3 + rand(2)) * 2.5 * 2 / 3)),
      '破障丹': Math.max(1, Math.floor((2 + bonus + rand(1)) * 2.5 * 2 / 3))
    }
  }
  if (shop === 'qige') {
    // 随机抽部位: 基础固定3个, 每+2活跃多抽1个(部位数受限于6种装备部位, 但数量不封顶)
    const partCount = 3 + Math.floor((Number(act) || 0) / 2)
    const parts = shuffle(Object.keys(PARTS)).slice(0, partCount)
    const stock = {}
    for (const part of parts) {
      const pool = Object.keys(EQUIP_TPL).filter(n => EQUIP_TPL[n].type === part && EQUIP_TPL[n].quality <= 4)
      if (!pool.length) continue
      const name = pool[Math.floor(Math.random() * pool.length)]
      stock[name] = 1
    }
    return stock
  }
  if (shop === 'cangbaoge') {
    // 基础1~2本 + 加成(无上限)
    const count = 1 + Math.floor(Math.random() * 2) + bonus
    const stock = {}
    for (let i = 0; i < count; i++) {
      const n = pickGongfa()
      stock[n] = (stock[n] || 0) + 1
    }
    return stock
  }
  return {}
}

/** 检查并补货(惰性): 到点或首次则补货, 返回是否补了; region=大区key(各区独立)
 *  丹阁: 到点但丹药还有剩余 → 跳过本次补货, 只进入下一次冷却 */
export function ensureRestock (gid, shop, region) { return withGameLock(gid, () => ensureRestockUnlocked(gid, shop, region)) }
async function ensureRestockUnlocked (gid, shop, region) {
  const g = String(gid)
  const rg = region || 'center'
  try {
    const now = Date.now()
    const nextAt = Number(await redis.get(nextKey(g, shop, rg))) || 0
    if (nextAt && now < nextAt) return false
    /* 丹阁: 时间到了但丹药还有剩余 → 缺哪个补哪个(只补缺货的丹药, 有剩余的保留);
     * 两种丹药都还有剩余才跳过本次补货, 直接进入下一次冷却 */
    if (shop === 'dange') {
      try {
        const cur = JSON.parse((await redis.get(stockKey(g, shop, rg))) || '{}')
        const kinds = ['修为丹', '破障丹'] // 丹阁固定两种丹药
        const missing = kinds.filter(k => !(Number(cur[k]) > 0))
        if (missing.length === 0) {
          await redis.set(nextKey(g, shop, rg), String(now + RESTOCK_MIN + Math.floor(Math.random() * (RESTOCK_MAX - RESTOCK_MIN))))
          return false
        }
        // 缺哪个补哪个: 只重填缺货的丹药, 有剩余的保留不动(补货量仍按活跃人数)
        const lastAt = Number(await redis.get(lastKey(g, shop, rg))) || (now - RESTOCK_MIN)
        const act = await countActive(g, lastAt, rg)
        const fresh = genStock('dange', act)
        for (const k of missing) if (Number(fresh[k]) > 0) cur[k] = fresh[k]
        await redis.set(stockKey(g, shop, rg), JSON.stringify(cur))
        await redis.set(lastKey(g, shop, rg), String(now))
        await redis.set(nextKey(g, shop, rg), String(now + RESTOCK_MIN + Math.floor(Math.random() * (RESTOCK_MAX - RESTOCK_MIN))))
        await pruneActive(g, lastAt, rg)
        return true
      } catch (err) { }
    }
    const lastAt = Number(await redis.get(lastKey(g, shop, rg))) || (now - RESTOCK_MIN)
    const act = await countActive(g, lastAt, rg)
    const stock = genStock(shop, act)
    await redis.set(stockKey(g, shop, rg), JSON.stringify(stock))
    await redis.set(lastKey(g, shop, rg), String(now))
    await redis.set(nextKey(g, shop, rg), String(now + RESTOCK_MIN + Math.floor(Math.random() * (RESTOCK_MAX - RESTOCK_MIN))))
    await pruneActive(g, lastAt, rg)
    return true
  } catch (err) { return false }
}

/** 读取库存(会先触发惰性补货); region=大区key */
export async function getStock (gid, shop, region) {
  const g = String(gid)
  const rg = region || 'center'
  await ensureRestock(g, shop, rg)
  try { return JSON.parse((await redis.get(stockKey(g, shop, rg))) || '{}') } catch (err) { return {} }
}

/** 购买扣库存: 返回 { ok, soldout, count }; region=大区key */
export function buyStock (gid, shop, name, want = 1, region) { return withGameLock(gid, () => buyStockUnlocked(gid, shop, name, want, region)) }
async function buyStockUnlocked (gid, shop, name, want = 1, region) {
  const g = String(gid)
  const rg = region || 'center'
  await ensureRestock(g, shop, rg)
  try {
    const stock = JSON.parse((await redis.get(stockKey(g, shop, rg))) || '{}')
    const have = Number(stock[name]) || 0
    if (have <= 0) return { ok: false, soldout: true, count: 0 }
    const n = Math.min(have, Math.max(1, Number(want) || 1))
    stock[name] = have - n
    if (stock[name] <= 0) delete stock[name]
    await redis.set(stockKey(g, shop, rg), JSON.stringify(stock))
    return { ok: true, soldout: false, count: n }
  } catch (err) { return { ok: false, soldout: false, count: 0 } }
}

/** 下次补货倒计时文案; region=大区key */
export async function restockIn (gid, shop, region) {
  const g = String(gid)
  const rg = region || 'center'
  try {
    const nextAt = Number(await redis.get(nextKey(g, shop, rg))) || 0
    if (!nextAt) return '即将补货'
    const diff = nextAt - Date.now()
    if (diff <= 0) return '即将补货'
    const m = Math.ceil(diff / 60000)
    if (m >= 60) {
      const h = Math.floor(m / 60)
      const mm = m % 60
      return mm ? `${h}小时${mm}分后` : `${h}小时后`
    }
    return `${m}分钟后`
  } catch (err) { return '' }
}

/** 商店中文名 */
export const SHOP_CN = { dange: '丹阁', qige: '器阁', cangbaoge: '藏宝阁' }

/** 三阁销售扣税: 买家付款金额不变, 销售收入按买家所在大区税率扣税计入该区繁荣度;
 *  返回 { rate, tax, owner }, 与其他交易(摆摊等)一致的"上交"归属 */
export function shopSaleTax (gid, region, amount, memberSect = null) {
  try {
    const w = getWorld(gid)
    const rg = region || 'center'
    const rate = taxFor(w, rg, memberSect)
    const tax = Math.max(1, Math.round((Number(amount) || 0) * rate / 100))
    if (tax > 0) { addTax(w, rg, tax); saveWorld(w) }
    const boss = bossOf(w, rg)
    const owner = boss ? `${REGIONS[rg].name}${boss}` : `${REGIONS[rg].name}各占领宗门`
    return { rate, tax, owner }
  } catch (err) { return { rate: 0, tax: 0, owner: '' } }
}
