/* ============================================================
 * 洗劫藏宝阁(隐藏玩法) - 数据与核心逻辑
 * 开放: 每天 20:30~24:00 ; 30分钟洗劫 + 10分钟逃亡 ; 可随时终止
 * 20档难度(自命名); 每档3名守卫道号(随机1~3人值守); 随机侍卫换防
 * PVP: 围剿可连环(螳螂捕蝉黄雀在后); 惩罚: 扣背包0~20件(穿身不扣)/天牢0~2小时
 * 联动: 当天被洗劫 → 次日拍卖行系统上架"好东西减少"
 * ============================================================ */
import fs from 'fs'
import path from 'path'
import { Save_Path } from './plugin.js'
import { EQUIP_TPL, ITEM_TPL, MATERIAL_TPL, GONGFA_TPL, getBag, consumeItem, gongfaPrice, ARRAY_MATS, itemIcon } from './equip_data.js'
import { fightBestOf5, realmPower, guardWinRate } from './fight.js'

/* ---------- 开放时间 ---------- */
const OPEN_HOUR = 20.5 // 20:30
const CLOSE_HOUR = 24 // 24:00

export function raidOpen (now = new Date()) {
  const h = now.getHours() + now.getMinutes() / 60
  return h >= OPEN_HOUR && h < CLOSE_HOUR
}

/* ---------- 20个难度档位(自命名, 由浅入深) ----------
 * power = 守卫强度系数(守卫战力 = 建议境界战力 × power × 人数系数 × 换防)
 * 2026-08-13 平衡①~④迭代后, 用户指令"全部档位+0.1"
 */
export const RAID_LEVELS = [
  { name: '藏珍堂',   power: 0.70, req: 5  },
  { name: '聚宝厅',   power: 0.71, req: 8  },
  { name: '百宝阁',   power: 0.72, req: 11 },
  { name: '奇珍阁',   power: 0.74, req: 14 },
  { name: '万宝楼',   power: 0.75, req: 17 },
  { name: '琳琅殿',   power: 0.77, req: 20 },
  { name: '珍宝坊',   power: 0.79, req: 23 },
  { name: '天珍阁',   power: 0.81, req: 26 },
  { name: '瑶光阁',   power: 0.83, req: 29 },
  { name: '琼华殿',   power: 0.85, req: 32 },
  { name: '琉璃阁',   power: 0.87, req: 35 },
  { name: '珊瑚殿',   power: 0.89, req: 38 },
  { name: '玛瑙堂',   power: 0.90, req: 41 },
  { name: '明珠阁',   power: 0.91, req: 44 },
  { name: '碧玉阁',   power: 0.92, req: 47 },
  { name: '紫晶殿',   power: 0.95, req: 50 },
  { name: '金珠宝殿', power: 0.97, req: 53 },
  { name: '元宝宝库', power: 0.98, req: 56 },
  { name: '天工宝库', power: 0.99, req: 59 },
  { name: '藏宝总阁', power: 1.00, req: 62 } // 总阁核心: 真正的宝贝
]
export const RAID_LEVEL_COUNT = RAID_LEVELS.length

/* 小境界 → 境界名(与修炼系统一致) */
const REALMS = ['炼气期', '筑基期', '金丹期', '元婴期', '化神期', '炼虚期', '合体期', '大乘期', '渡劫期', '人仙', '天仙', '金仙', '大罗金仙', '九天玄仙', '罗天上仙', '仙君', '仙帝']
const STAGES = ['初期', '中期', '后期', '巅峰']
export function realmNameOf (level) {
  level = Number(level) || 0
  if (level <= 0) return '炼气期'
  const i = Math.floor((level - 1) / 4)
  const j = (level - 1) % 4
  if (i >= REALMS.length) return '仙帝'
  return REALMS[i] + STAGES[j]
}

/* 每档3名守卫道号(正常修仙名, 不挂钩藏宝阁) */
export const RAID_GUARDS = [
  ['清虚真人', '玄机子', '云中子'],
  ['太岳道人', '静玄真人', '空尘子'],
  ['无尘子', '玉衡真人', '玄真子'],
  ['青云真人', '白鹤道人', '松溪子'],
  ['紫阳真人', '无涯子', '灵虚子'],
  ['明空真人', '观云子', '玄微真人'],
  ['紫薇真人', '天罡子', '青莲道人'],
  ['赤松子', '玄霄真人', '云台道人'],
  ['抱朴真人', '玉虚子', '白石道人'],
  ['广成子', '冲虚真人', '玄都子'],
  ['太乙真人', '灵宝子', '紫府真人'],
  ['玉清真人', '无相子', '元中子'],
  ['太清真人', '紫微子', '玄穹真人'],
  ['北斗真人', '天璇子', '灵光真人'],
  ['紫霄真人', '玉枢子', '神霄真人'],
  ['太虚真人', '虚皇子', '玄元真人'],
  ['九天玄女', '苍梧子', '紫皇真人'],
  ['混沌子', '玄黄真人', '无极子'],
  ['混元真人', '太初子', '鸿蒙真人'],
  ['帝君真人', '太虚元君', '天枢子']
]

/** 随机1~3名值守守卫(返回{names, count}) */
export function pickGuards (levelIdx) {
  const pool = RAID_GUARDS[levelIdx - 1] || RAID_GUARDS[0]
  const count = 1 + Math.floor(Math.random() * 3)
  const shuffled = [...pool].sort(() => Math.random() - 0.5)
  return { names: shuffled.slice(0, count), count }
}

/* ---------- 侍卫换防(随机, 基于当天seed确定) ---------- */
function daySeed (d) {
  const s = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
function genGuardWindows (seed) {
  const win = []
  let rnd = seed || 1
  const rnd01 = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return rnd / 4294967296 }
  // 8:00~24:00 内每 15~30 分钟一次换防(保证等换防不超过30分钟), 时间点随机, 每次3分钟
  const startMin = 8 * 60
  const endMin = 24 * 60
  let cur = startMin + Math.floor(rnd01() * 15) // 首窗口 8:00~8:15 之间随机
  while (cur < endMin - 3) {
    win.push({ start: cur, end: cur + 3 }) // 换防中3分钟
    cur += 15 + Math.floor(rnd01() * 16) // 间隔 15~30 分钟
  }
  return win
}
/** 换防信息: 当前是否换防 / 距下次换防分钟数 */
export function guardChangeInfo (now = new Date()) {
  const mins = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60
  const win = genGuardWindows(daySeed(now))
  /* 管理员一次性覆盖: 把下一次换防提前到指定时刻(用后即清, 恢复每日seed排程) */
  const ov = readGuardOverride()
  if (ov) {
    const s = Number(ov.startMs)
    const e = s + 3 * 60 * 1000
    if (now.getTime() >= e) clearGuardOverride() // 窗口已过, 一次性用尽
    else if (now.getTime() >= s) return { inChange: true, nextMin: 0 }
    else {
      const ovMins = mins + (s - now.getTime()) / 60000
      if (ovMins > mins && ovMins < CLOSE_HOUR * 60) win.push({ start: ovMins, end: ovMins + 3 })
    }
  }
  win.sort((a, b) => a.start - b.start)
  for (const w of win) if (mins >= w.start && mins < w.end) return { inChange: true, nextMin: 0 }
  let next = null
  for (const w of win) if (w.start > mins) { next = w.start; break }
  if (next === null) next = CLOSE_HOUR * 60 + 60 // 已过最后窗口, 明天才有(仅窗口内会询问, 兜底)
  return { inChange: false, nextMin: Math.max(1, Math.round(next - mins)) }
}

/* ---------- 守卫战力/战斗 ---------- */
/** 守卫强度系数(档位强度 × 值守人数 × 换防状态; 换防时守卫松懈) */
export function guardMul (levelIdx, guardCount, inChange) {
  const lv = RAID_LEVELS[levelIdx - 1] || RAID_LEVELS[0]
  let m = lv.power * (1 + 0.08 * (guardCount - 1))
  if (inChange) m *= 0.7 // 换防时守卫松懈, 难度降低
  return m
}
/**
 * 守卫最终战力: 绝对战力(基于该档推荐境界, 不随玩家战力缩放)
 *  - 守卫 = 推荐境界战力 × 档位强度 × 人数 × 换防 × 稀有加成(固定值)
 *  - guardMult 守卫削弱系数: 围剿接手后第一次×0.8, 之后连环每次×0.89(黄雀更易得手)
 *  - 玩家境界/装备远超该档推荐 → 碾压; 低于推荐 → 苦战
 */
export function guardPowerFor (playerPower, levelIdx, guardCount, inChange, rareBoost = 1, guardMult = 1) {
  const lv = RAID_LEVELS[levelIdx - 1] || RAID_LEVELS[0]
  const gp = realmPower(lv.req) * guardMul(levelIdx, guardCount, inChange) * (rareBoost || 1) * (guardMult || 1)
  return Math.round(gp)
}
/** 守卫战斗: 使用统一五局三胜模拟 */
export function guardFight (playerPower, guardPower, dmgMe, dmgOpp, defMe = 1) {
  const win = guardWinRate(playerPower, guardPower)
  return fightBestOf5(win, { dmgMe, dmgOpp, defMe })
}

/* ---------- 战利品 ---------- */
const byQ = (tpl, q) => Object.keys(tpl).filter(k => tpl[k].quality === q)
const LOW_EQUIP = [].concat(byQ(EQUIP_TPL, 1), byQ(EQUIP_TPL, 2), byQ(EQUIP_TPL, 3))
const MID_EQUIP = byQ(EQUIP_TPL, 4)
const HIGH_EQUIP = byQ(EQUIP_TPL, 5)
const RED_EQUIP = byQ(EQUIP_TPL, 6)
const LOW_PILL = ['修为丹', '破障丹']
const MID_PILL = ['聚宝丹', '灵犀丹', '行运丹', '同心丹', '玉甲丹', '凝露丹', '慧心丹', '摄魂丹']
const LOW_GF = [].concat(byQ(GONGFA_TPL, 1), byQ(GONGFA_TPL, 2), byQ(GONGFA_TPL, 3))
const MID_GF = byQ(GONGFA_TPL, 4)
const GOLD_GF = byQ(GONGFA_TPL, 5)
const RED_GF = byQ(GONGFA_TPL, 6)
export const COLOR_GF = ['太阴月华诀']
const WANHUN_ONLY_MATS = new Set(['万魂幡残卷', '阴魂砂', '游魂骨', '鬼火草', '幽冥木', '摄魂铁', '阴魂石', '玄阴玉', '镇魂晶', '血煞髓', '万魂帝晶'])
/* 功法残卷是分解重复傀儡术的专属材料，不属于藏宝阁可抢战利品。 */
/* 镇海珠专属材料只从东海「镇海海眼」产出, 不进藏宝阁任何池 */
const ZHENHAI_ONLY_MATS = new Set(['镇海砂', '龙宫珊瑚', '海眼寒铁', '潮汐月华', '沧溟珠泪'])
const RAID_EXCLUDED_MATS = new Set([...WANHUN_ONLY_MATS, ...ZHENHAI_ONLY_MATS, '功法残卷'])
/* 妖丹只由世界Boss掉落, 不加入藏宝阁奖励池 */
const YAODAN_MATS = new Set(['一阶妖丹', '二阶妖丹', '三阶妖丹', '四阶妖丹', '五阶妖丹', '六阶妖丹', '七阶妖丹'])
const regularByQ = (tpl, q) => byQ(tpl, q).filter(name => !RAID_EXCLUDED_MATS.has(name) && !YAODAN_MATS.has(name))
const MID_MAT = [].concat(regularByQ(MATERIAL_TPL, 4), regularByQ(MATERIAL_TPL, 5))
const RED_MAT = regularByQ(MATERIAL_TPL, 6).filter(name => !ARRAY_MATS.includes(name))
/* 万魂窟专属材料只从万魂窟产出，不加入藏宝阁奖励池。 */
/* 出彩分两池: 彩色材料(云裳仙蕊/造梦神玉)正常出彩但不触发守卫难度翻倍;
   彩色功法(太阴月华诀)是唯一触发守卫难度翻倍的出彩, 概率保持改版前等效值(原彩色池1%等权3取1 ≈ 1/300), 不上调 */
export const COLOR_MATS = regularByQ(MATERIAL_TPL, 7)
const COLOR_GF_CHANCE = 1 / 300

/* 垃圾池(任何档都可能抢到, 越高档占比越高): 低级丹药/材料 */
const JUNK_POOL = ['修为丹', '破障丹', '星霜草', '青鸾草', '月魄石', '星璇石']
/* 普通池(该档常见货, 不含红/彩; 红色只从稀有roll出, 受上限控制) */
const COMMON_POOL = {
  1: [...LOW_EQUIP, ...LOW_PILL, ...LOW_GF, ...MID_MAT],
  2: [...MID_EQUIP, ...MID_PILL, ...MID_GF, ...LOW_GF, ...MID_MAT],
  3: [...MID_EQUIP, ...HIGH_EQUIP, ...GOLD_GF, ...MID_GF, ...MID_PILL, ...MID_MAT],
  4: [...HIGH_EQUIP, ...GOLD_GF, ...MID_PILL, ...MID_MAT],
  5: [...HIGH_EQUIP, ...GOLD_GF, ...MID_PILL, ...MID_MAT],
  6: [...HIGH_EQUIP, ...GOLD_GF, ...MID_PILL, ...MID_MAT]
}
/* 稀有池(红/彩从这里出, 一场最多5件红彩) */
const RARE_POOL = {
  1: [...MID_EQUIP, ...MID_GF],
  2: [...HIGH_EQUIP, ...GOLD_GF, ...RED_MAT],
  3: [...HIGH_EQUIP, ...GOLD_GF, ...RED_GF, ...RED_MAT],
  4: [...RED_EQUIP, ...RED_GF, ...RED_MAT],
  5: [...RED_EQUIP, ...RED_GF, ...RED_MAT],
  6: [...RED_EQUIP, ...RED_GF, ...RED_MAT]
}
function tierOf (levelIdx) {
  if (levelIdx <= 5) return 1
  if (levelIdx <= 10) return 2
  if (levelIdx <= 14) return 3
  if (levelIdx <= 17) return 4
  if (levelIdx <= 19) return 5
  return 6
}
const pickFrom = (arr) => (arr && arr.length) ? arr[Math.floor(Math.random() * arr.length)] : null

/** 物品品质(红=6, 彩=7) */
function itemQuality (name) {
  if (EQUIP_TPL[name]) return EQUIP_TPL[name].quality
  if (GONGFA_TPL[name]) return GONGFA_TPL[name].quality
  if (MATERIAL_TPL[name]) return MATERIAL_TPL[name].quality
  return 0
}
/** 一场洗劫的红彩(品质≥6)总件数上限 / 彩色(品质7)上限 */
export const RARE_CAP = 5
export const COLOR_CAP = 1
/** 统计战利品中的红彩件数 / 彩色件数 */
export function countRare (loots) { return (loots || []).reduce((s, l) => s + (itemQuality(l.name) >= 6 ? l.count : 0), 0) }
export function countColor (loots) { return (loots || []).reduce((s, l) => s + (itemQuality(l.name) >= 7 ? l.count : 0), 0) }

/** 一次洗劫的掉落总数上限(件): 档1=12 → 档20=50 */
export function raidLootCap (levelIdx) {
  return Math.min(50, 10 + (levelIdx || 1) * 2)
}

/** 是否彩色功法(太阴月华诀): 抢到 → 后续守卫难度翻2.2倍(彩色材料不触发) */
export function isColorfulGf (name) {
  return COLOR_GF.includes(name)
}

/** 抢到彩色功法后, 所有后续守卫判定的难度倍率 */
export function colorfulGuardBoost (raidState) {
  return raidState && raidState.rareFlag ? 2.2 : 1
}

/** 稀有/彩色概率(每件), 受境界差影响(低抢高翻倍, 高抢低减半)
 *  - rare      : 红色(品质6)概率
 *  - colorful : 彩色材料(品质7: 云裳仙蕊/造梦神玉)概率 —— 阵法材料按其中单个材料同概率加入, 但自身仍为红色品质6
 *  - colorfulGf: 彩色功法(太阴月华诀)概率 —— 彩功法唯一触发守卫难度翻倍
 */
export function rarityChance (levelIdx, lowGap, highGap) {
  let rare = 0, colorful = 0, colorfulGf = 0
  if (levelIdx <= 4) { rare = 0.01 }
  else if (levelIdx <= 9) { rare = 0.03 }
  else if (levelIdx <= 14) { rare = 0.06; colorful = 0.01 }
  else if (levelIdx <= 17) { rare = 0.10; colorful = 0.02 }
  else if (levelIdx <= 19) { rare = 0.14; colorful = 0.03 }
  else { rare = 0.18; colorful = 0.04; colorfulGf = COLOR_GF_CHANCE } // 档20: 稀有18% + 彩色材料4% + 彩功法≈0.33%
  if (lowGap > 0) {
    rare = Math.min(0.35, rare * 2)
    colorful = Math.min(0.10, colorful * 2)
    colorfulGf = Math.min(0.06, colorfulGf * 2)
  }
  if (highGap > 0) {
    rare *= 0.5
    colorful *= 0.5
    colorfulGf *= 0.5
  }
  return { rare, colorful, colorfulGf }
}

/**
 * 生成该档一个5分钟片段的战利品(随机性重构)
 *  - 数量随机波动大; 整场上限 raidLootCap(档20最多50件)
 *  - 高档也常出垃圾(丹药/材料), 稀有好货受概率+硬上限控制
 *  - 红彩(品质≥6)整场最多 RARE_CAP=5 件, 彩色(品质7)最多 COLOR_CAP=1 件
 *  - 出彩分两池: 彩色材料概率上调且不触发守卫难度翻倍; 彩色功法(太阴月华诀)保持原概率, 才触发
 *  - 低抢高(富贵险中求): 稀有概率翻倍; 高抢低: 稀有概率减半
 */
export function genSegmentLoots (levelIdx, playerLevel = 0, budget = 999, rareLeft = RARE_CAP, colorLeft = COLOR_CAP) {
  const tier = tierOf(levelIdx)
  const lv = RAID_LEVELS[levelIdx - 1] || RAID_LEVELS[0]
  const req = Number(lv.req) || levelIdx * 3
  const pl = Number(playerLevel) || 0
  const lowGap = Math.max(0, req - pl)
  const highGap = Math.max(0, pl - req)
  // 本片段数量: 以"总上限/6"为均值, 波动0.3~1.8倍(随机性); 高抢低略减
  const perSeg = Math.max(1, Math.round(raidLootCap(levelIdx) / 6))
  let n = Math.max(1, Math.round(perSeg * (0.3 + Math.random() * 1.5)))
  if (highGap > 0) n = Math.max(1, n - Math.min(2, Math.floor(highGap / 4)))
  n = Math.min(n, Math.max(0, budget))
  const { rare, colorful, colorfulGf } = rarityChance(levelIdx, lowGap, highGap)
  const loots = []
  let remain = n
  let rl = Math.max(0, rareLeft)
  let cl = Math.max(0, colorLeft)
  for (let i = 0; i < n && remain > 0; i++) {
    const r = Math.random()
    let name = null
    if (r < colorful && cl > 0) name = pickFrom(COLOR_MATS)
    else if (r < colorful + colorfulGf && cl > 0) name = pickFrom(COLOR_GF)
    else if (r < colorful + colorfulGf + colorful * 2 && rl > 0) name = pickFrom(ARRAY_MATS)
    else if (r < colorful + colorfulGf + colorful * 2 + rare && rl > 0) name = pickFrom(RARE_POOL[tier])
    else {
      // 普通: 越高档垃圾占比越高(档1约40% → 档20约60%), 高档也常出垃圾
      const junkChance = 0.4 + (levelIdx / 20) * 0.2
      name = Math.random() < junkChance ? pickFrom(JUNK_POOL) : pickFrom(COMMON_POOL[tier])
    }
    if (!name) continue
    const count = ARRAY_MATS.includes(name) ? 1 : Math.min(1 + Math.floor(Math.random() * (1 + Math.floor(levelIdx / 5))), remain)
    const q = itemQuality(name)
    if (q >= 7) { // 彩色: 整场最多1件(按件数扣)
      if (cl < count) continue
      cl -= count
      rl = Math.max(0, rl - count)
    } else if (q >= 6) { // 红色: 整场最多5件红彩(按件数扣)
      if (rl < count) continue
      rl -= count
    }
    remain -= count
    const ex = loots.find(x => x.name === name)
    if (ex) ex.count += count
    else loots.push({ name, count })
  }
  return loots
}

/** 单件价值(用于惩罚档位与联动) */
export function lootValue (name) {
  if (EQUIP_TPL[name]) return [0, 50, 150, 400, 1200, 6000, 30000, 90000][EQUIP_TPL[name].quality] || 0
  if (GONGFA_TPL[name]) {
    const gq = GONGFA_TPL[name].quality
    if (gq <= 5) return gongfaPrice(name) || 0
    return [0, 0, 0, 0, 0, 0, 80000, 300000][gq] || 0 // 红功法书8万, 彩功法书30万(不售,按稀有估值)
  }
  if (ITEM_TPL[name]) {
    const p = { '修为丹': 500, '破障丹': 1000, '聚宝丹': 10000, '灵犀丹': 6000, '行运丹': 7000, '同心丹': 6000, '玉甲丹': 12000, '凝露丹': 10000, '慧心丹': 12000, '摄魂丹': 8000 }
    return p[name] || 500
  }
  if (MATERIAL_TPL[name]) return [0, 0, 0, 0, 1200, 4000, 12000, 40000][MATERIAL_TPL[name].quality] || 0
  return 500
}
export function sumLootValue (loots) {
  return (loots || []).reduce((s, l) => s + lootValue(l.name) * l.count, 0)
}
/** 物品图标 */
export function lootIcon (name) {
  return itemIcon(name)
}

/* ---------- 惩罚: 按"所抢档位"随机扣背包(穿身不扣), 每件按样数扣 ---------- */
export function penaltyCount (levelIdx) {
  // 90%会扣(2026-08-14): 10%概率运气好什么都扣不到
  if (Math.random() < 0.10) return 0
  // 件数翻1倍: 每档扣除上限翻倍(第1档上限8件 → 第20档上限40件), 且至少扣1件
  const cap = Math.min(40, 8 + Math.round((levelIdx - 1) / 19 * 32))
  return 1 + Math.floor(Math.random() * cap)
}
/** 随机扣背包物品(排除穿身装备), 返回被扣列表[{name,count}] */
export function deductRandomItems (uid, gid, count) {
  const bag = getBag(uid, gid)
  const equipped = bag.equipped || {}
  const equippedSet = new Set(Object.values(equipped).filter(Boolean))
  const pool = Object.keys(bag.items || {}).filter(n =>
    !equippedSet.has(n) && (ITEM_TPL[n] || EQUIP_TPL[n] || GONGFA_TPL[n] || MATERIAL_TPL[n]))
  const taken = []
  let n = count
  while (n > 0 && pool.length) {
    const i = Math.floor(Math.random() * pool.length)
    const name = pool[i]
    const have = (bag.items[name] && bag.items[name].count) || 0
    if (have <= 0) { pool.splice(i, 1); continue }
    consumeItem(uid, name, 1, null, gid)
    const ex = taken.find(x => x.name === name)
    if (ex) ex.count++
    else taken.push({ name, count: 1 })
    n--
  }
  return taken
}

/* ---------- 本地备份(redis 数据丢失时兜底恢复, 不依赖 redis 持久化) ---------- */
const backupDir = Save_Path
const backupFile = path.join(backupDir, 'raid_backup.json')

/** 读取本地备份(损坏/不存在/缺字段时返回完整空结构) */
function readBackup () {
  let data = null
  try {
    if (fs.existsSync(backupFile)) data = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
  } catch (err) { }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {}
  if (!data.raids || typeof data.raids !== 'object' || Array.isArray(data.raids)) data.raids = {}
  if (!data.jails || typeof data.jails !== 'object' || Array.isArray(data.jails)) data.jails = {}
  if (!data.happened || typeof data.happened !== 'object' || Array.isArray(data.happened)) data.happened = {}
  return data
}

/** 写入本地备份(临时文件+改名, 避免写一半损坏) */
function writeBackup (data) {
  try {
    fs.mkdirSync(backupDir, { recursive: true })
    const tmp = `${backupFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data))
    if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile)
    fs.renameSync(tmp, backupFile)
  } catch (err) { }
}

/* ---------- 换防时间一次性覆盖(管理员活动/测试用, 用后即清) ---------- */
const guardOverrideFile = path.join(backupDir, 'guard_override.json')
let guardOverrideCache = null
function readGuardOverride () {
  if (guardOverrideCache !== null) return guardOverrideCache
  try {
    if (fs.existsSync(guardOverrideFile)) {
      const o = JSON.parse(fs.readFileSync(guardOverrideFile, 'utf8'))
      guardOverrideCache = (o && Number(o.startMs) > 0) ? o : false
    } else guardOverrideCache = false
  } catch (err) { guardOverrideCache = false }
  return guardOverrideCache
}
function clearGuardOverride () {
  guardOverrideCache = false
  try { if (fs.existsSync(guardOverrideFile)) fs.unlinkSync(guardOverrideFile) } catch (err) { }
}
/** 把下一次侍卫换防一次性提前到指定时刻(epoch ms, 换防窗口3分钟); startMs<=0 表示清除覆盖恢复每日排程 */
export function setGuardChangeAt (startMs) {
  if (!Number(startMs)) { clearGuardOverride(); return { startMs: 0 } }
  const o = { startMs: Number(startMs) }
  guardOverrideCache = o
  try {
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(guardOverrideFile, JSON.stringify(o))
  } catch (err) { }
  return o
}

/* ---------- 洗劫状态(redis + 本地文件双写; redis 丢失时从文件恢复) ---------- */
const raidKey = (gid, uid) => `xujing:raid:${gid}:${uid}`
export async function getRaid (gid, uid) {
  const key = raidKey(gid, uid)
  try {
    const v = await redis.get(key)
    if (v) return JSON.parse(v)
  } catch (err) { }
  // redis 无数据 → 尝试本地备份恢复
  const st = (readBackup().raids || {})[key] || null
  if (st) { try { await redis.set(key, JSON.stringify(st)) } catch (err) { } }
  return st
}
export async function setRaid (gid, uid, st) {
  const key = raidKey(gid, uid)
  try { await redis.set(key, JSON.stringify(st)) } catch (err) { }
  const b = readBackup()
  b.raids[key] = st
  writeBackup(b)
}
export async function delRaid (gid, uid) {
  const key = raidKey(gid, uid)
  try { await redis.del(key) } catch (err) { }
  const b = readBackup()
  delete b.raids[key]
  writeBackup(b)
}
export async function allRaids () {
  const out = []
  const seen = new Set()
  try {
    const keys = await redis.keys('xujing:raid:*')
    for (const k of keys) {
      try {
        const m = k.match(/xujing:raid:([^:]+):([^:]+)$/)
        if (!m) continue
        const st = JSON.parse((await redis.get(k)) || 'null')
        if (st) { out.push({ gid: m[1], uid: m[2], st }); seen.add(k) }
      } catch (err) { }
    }
  } catch (err) { }
  // 合并本地备份中 redis 缺失的记录(redis 被清空/重启丢失后也能恢复)
  const bk = readBackup()
  for (const key of Object.keys(bk.raids || {})) {
    if (seen.has(key)) continue
    const m = key.match(/xujing:raid:([^:]+):([^:]+)$/)
    if (!m) continue
    const st = bk.raids[key]
    if (st) {
      out.push({ gid: m[1], uid: m[2], st })
      try { await redis.set(key, JSON.stringify(st)) } catch (err) { }
    }
  }
  return out
}

/* ---------- 天牢(redis + 本地文件双写) ---------- */
const jailKey = uid => `xujing:raid-jail:${uid}`
/**
 * 读取天牢记录(兼容两种格式):
 *  - 旧格式: 纯数字 = 到期时间戳(until)
 *  - 新格式: JSON { at(被抓时间), until(到期时间), gid(所属群) }
 */
function parseJail (v) {
  try {
    const o = JSON.parse(v)
    if (o && o.until) return { at: Number(o.at) || 0, until: Number(o.until) || 0, gid: String(o.gid || '') }
  } catch (err) { }
  const t = Number(v) || 0
  return { at: 0, until: t, gid: '' }
}
export async function setJail (uid, minutes, gid = '') {
  const at = Date.now()
  const until = at + Math.max(1, minutes) * 60 * 1000
  const val = JSON.stringify({ at, until, gid: String(gid || '') })
  try { await redis.set(jailKey(uid), val) } catch (err) { }
  const b = readBackup()
  b.jails[String(uid)] = val
  writeBackup(b)
}
export async function getJailRemain (uid) {
  let v = null
  try { v = await redis.get(jailKey(uid)) } catch (err) { }
  if (!v) v = (readBackup().jails || {})[String(uid)] || null
  if (!v) return 0
  const o = parseJail(v)
  const r = Math.ceil((o.until - Date.now()) / 1000)
  return r > 0 ? r : 0
}
export async function isJailed (uid) {
  return (await getJailRemain(uid)) > 0
}
/** 释放某人: 清除其天牢(redis + 本地备份同步删除) */
export async function delJail (uid) {
  try { await redis.del(jailKey(uid)) } catch (err) { }
  const b = readBackup()
  delete b.jails[String(uid)]
  writeBackup(b)
}
/** 所有在牢用户(redis + 本地备份合并, 自动过滤已到期; 返回 {uid, at, expireAt, gid}) */
export async function allJails () {
  const out = []
  const seen = new Set()
  const now = Date.now()
  try {
    const keys = await redis.keys('xujing:raid-jail:*')
    for (const k of keys) {
      try {
        const uid = k.replace(/^xujing:raid-jail:/, '')
        const v = await redis.get(k)
        if (!v) continue
        const o = parseJail(v)
        if (o.until > now) { out.push({ uid, at: o.at || 0, expireAt: o.until, gid: o.gid || '' }); seen.add(k) }
      } catch (err) { }
    }
  } catch (err) { }
  const bk = readBackup()
  for (const uid of Object.keys(bk.jails || {})) {
    if (seen.has(jailKey(uid))) continue
    const o = parseJail(bk.jails[uid])
    if (o.until > now) out.push({ uid, at: o.at || 0, expireAt: o.until, gid: o.gid || '' })
  }
  return out
}

/* ---------- 联动: 当天是否被洗劫(次日拍卖好货减半) ---------- */
export async function markRaidHappened (gid, date) {
  try { await redis.set(`xujing:raid-happened:${gid}:${date}`, '1') } catch (err) { }
  const b = readBackup()
  if (!b.happened) b.happened = {}
  b.happened[`${gid}:${date}`] = 1
  writeBackup(b)
}
export async function raidHappened (gid, date) {
  try {
    const v = await redis.get(`xujing:raid-happened:${gid}:${date}`)
    if (v) return true
  } catch (err) { }
  return !!((readBackup().happened || {})[`${gid}:${date}`])
}
