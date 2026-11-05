/* ============================================================
 * 镇海珠: 世界级控制法宝(5阶)
 * - 拥有即生效, 不占装备栏, 不参与战力;
 * - 封海作用于使用者当前所在大区(简月王朝除外);
 * - 封印有血条, 被封区域内的非使用者可攻击;
 * - 高阶顶低阶, 同阶比使用者战力。
 * 纯数据/纯逻辑, 不读写磁盘, 不触碰 Bot/Redis。
 * ============================================================ */

export const ZHENHAI_NAME = '镇海珠'
export const ZHENHAI_ICON = '🔮'

/** 五阶参数: hits 为"阶位基础次数", 实际血量 = hits × 使用者战力 */
export const ZHENHAI_TIERS = [
  null,
  { rank: 1, name: '镇浪', durationMin: 15, cooldownHours: 2, hits: 20, cost: 50000 },
  { rank: 2, name: '定潮', durationMin: 30, cooldownHours: 4, hits: 44, cost: 100000 },
  { rank: 3, name: '锁海', durationMin: 45, cooldownHours: 6, hits: 70, cost: 200000 },
  { rank: 4, name: '禁界', durationMin: 60, cooldownHours: 8, hits: 100, cost: 400000 },
  { rank: 5, name: '镇海', durationMin: 90, cooldownHours: 12, hits: 140, cost: 800000 }
]

export const ZHENHAI_MAX_RANK = 5
/** 封印可作用的大区(排除特殊大区简月王朝) */
export const ZHENHAI_SEALABLE_REGIONS = ['center', 'east', 'west', 'north', 'south']

/** 5 种专属材料: 只从东海「镇海海眼」产出 */
export const ZHENHAI_MATERIALS = ['镇海砂', '龙宫珊瑚', '海眼寒铁', '潮汐月华', '沧溟珠泪']
/** 掉落权重与单次数量 */
export const ZHENHAI_DROP_TABLE = [
  { name: '镇海砂', weight: 50, min: 1, max: 3 },
  { name: '龙宫珊瑚', weight: 25, min: 1, max: 2 },
  { name: '海眼寒铁', weight: 14, min: 1, max: 1 },
  { name: '潮汐月华', weight: 8, min: 1, max: 1 },
  { name: '沧溟珠泪', weight: 3, min: 1, max: 1 }
]
/** 镇海海眼内每件正常掉落的专属判定概率 */
export const ZHENHAI_DROP_CHANCE = 0.45

/** 打造 1 阶与升阶配方 */
export const ZHENHAI_RECIPES = {
  craft: {
    mats: { 镇海砂: 30, 龙宫珊瑚: 10, 海眼寒铁: 1, 沧溟珠泪: 1 },
    money: 300000
  },
  2: { mats: { 镇海砂: 50, 龙宫珊瑚: 20, 海眼寒铁: 2 }, money: 500000 },
  3: { mats: { 镇海砂: 80, 龙宫珊瑚: 35, 海眼寒铁: 8, 潮汐月华: 2 }, money: 800000 },
  4: { mats: { 镇海砂: 120, 龙宫珊瑚: 55, 海眼寒铁: 14, 潮汐月华: 6, 沧溟珠泪: 2 }, money: 1200000 },
  5: { mats: { 镇海砂: 180, 龙宫珊瑚: 90, 海眼寒铁: 24, 潮汐月华: 10, 沧溟珠泪: 4 }, money: 2000000 }
}

export function clampRank (rank) {
  return Math.max(1, Math.min(ZHENHAI_MAX_RANK, Math.floor(Number(rank) || 1)))
}

export function tierInfo (rank) {
  return ZHENHAI_TIERS[clampRank(rank)]
}

export function rankName (rank) {
  return `${clampRank(rank)}阶·${tierInfo(rank).name}`
}

/** 读取背包中的镇海珠; 旧档字段补齐。没有返回 null */
export function getZhenhai (bag) {
  const a = bag && bag.artifacts && bag.artifacts.zhenhai
  if (!a || typeof a !== 'object') return null
  a.rank = clampRank(a.rank)
  a.cooldownUntil = Math.max(0, Number(a.cooldownUntil) || 0)
  a.lastSealAt = Math.max(0, Number(a.lastSealAt) || 0)
  a.sealCount = Math.max(0, Math.floor(Number(a.sealCount) || 0))
  return a
}

export function hasZhenhai (bag) {
  return !!getZhenhai(bag)
}

/** 新建 1 阶镇海珠(原地写入 bag.artifacts, 不保存) */
export function createZhenhai (bag, now = Date.now()) {
  if (!bag.artifacts || typeof bag.artifacts !== 'object') bag.artifacts = {}
  bag.artifacts.zhenhai = {
    rank: 1,
    craftedAt: now,
    cooldownUntil: 0,
    lastSealAt: 0,
    sealCount: 0
  }
  return bag.artifacts.zhenhai
}

export function cooldownLeft (artifact, now = Date.now()) {
  if (!artifact) return 0
  return Math.max(0, (Number(artifact.cooldownUntil) || 0) - now)
}

/** 当前是否可封海 */
export function canActivate (artifact, now = Date.now()) {
  if (!artifact) return { ok: false, msg: `你还没有${ZHENHAI_NAME}。` }
  const left = cooldownLeft(artifact, now)
  if (left > 0) return { ok: false, msg: `${ZHENHAI_NAME}尚在冷却中，还需 ${Math.ceil(left / 60000)} 分钟。` }
  return { ok: true }
}

/**
 * 封印血量 = 阶位基础次数 × 使用者战力
 * @param {number} rank
 * @param {number} ownerPower
 */
export function sealMaxHp (rank, ownerPower) {
  const hits = tierInfo(rank).hits
  const power = Math.max(10000, Math.floor(Number(ownerPower) || 0))
  return Math.round(hits * power)
}

/** 按权重抽一个镇海材料, 返回 {name,count} */
export function rollZhenhaiMaterial (random = Math.random) {
  const total = ZHENHAI_DROP_TABLE.reduce((sum, x) => sum + x.weight, 0)
  let cursor = random() * total
  for (const item of ZHENHAI_DROP_TABLE) {
    cursor -= item.weight
    if (cursor < 0) {
      const count = item.min + Math.floor(random() * (item.max - item.min + 1))
      return { name: item.name, count }
    }
  }
  return { name: '镇海砂', count: 3 }
}

/** 配方 → 文本 */
export function recipeText (recipe, itemIcon = (n) => n) {
  const mats = Object.entries(recipe.mats || {}).map(([name, count]) => `${itemIcon(name)}${name}×${count}`)
  if (recipe.money) mats.push(`💰${recipe.money}灵石`)
  return mats.join(' + ')
}
