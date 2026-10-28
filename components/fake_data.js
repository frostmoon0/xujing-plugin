/* ============================================================
 * 天下大事 · 伪玩家宗门世界 - 数据与核心逻辑
 * 伪玩家(含魔修/善恶性格)分布于宗门, 每天持续生成千奇百怪事件
 * 入世补员固定每30分钟1名, 直到在世人数达到上限
 * 职位(可空缺): 宗主1/副宗主2/太上长老2/执事5/弟子N
 * 晋升: 达到本职位带上限(巅峰)+在宗资历达标 → 空缺时递补
 * 宗门战争: 统一由 components/sect/war.js 管理攻打、守备、结算与俘虏
 * 宗门覆灭: 换皮重建(改名+新宗主+慢慢招徒弟, 身份不变)
 * ============================================================ */
import fs from 'fs'
import YAML from 'yaml'
import { writeJsonAtomic } from './json_store.js'
import { recoverCorruptJson } from './save_backup.js'
import { saveOrDefer, withDeferredSaveContext } from './deferred_save.js'
import { Plugin_Path, Save_Path } from './plugin.js'
import { getWorld, saveWorld, getRate, addTax, taxFor, regionNameOf, REGION_KEYS, DEFAULT_REGION, REGIONS, levelNameOf } from './world_data.js' // 摆摊交税/跨区/攻打位置校验需世界经济
import { REALM_MAX_LEVEL } from './realm_cap.js'
import { ITEM_PRICE, ITEM_TPL, MATERIAL_TPL, GONGFA_TPL, EQUIP_TPL, equipPrice, gongfaPrice, getTotalAttr, isBound, vaultEquipContrib, ensureBagShape, addItemToBag, consumeBagItem, autoEquipBest, rollEquipAttr, attrPower, itemIcon } from './equip_data.js'
import { getStock, buyStock, recordActive, SHOP_CN } from './shop_data.js'
import { RAID_LEVELS, guardPowerFor } from './raid_data.js' // 伪玩家洗劫藏宝阁(与玩家同20档难度, 用守卫战力判定成败)
import {
  PET_CFG, getPetState, savePetState, tickPetGroup, settlePet,
  resolveEncounter, petPower, canBattle, getActivePetPower, maturePet
} from './pet_data.js'
import { speciesMeta, qualityNameOf } from './pet_species.js'

const SLOT_MAP = { weapon: 'weapon', helmet: 'helmet', chest: 'chest', pants: 'pants', shoes: 'shoes', ring: 'ring' }

/** 伪玩家背包统一使用真实玩家的 canonical 格式；未知剧情物品仍保留为 { count }。 */
function ensureFakeBag (bag) {
  if (!bag || typeof bag !== 'object') return { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} }
  ensureBagShape(bag, { removeEquippedFromItems: false })
  return bag
}
function itemCount (item) {
  if (item && typeof item === 'object') return Math.max(0, Math.floor(Number(item.count) || 0))
  return Math.max(0, Math.floor(Number(item) || 0))
}
function fakeAddItem (bag, name, count = 1, attr = null, autoEquip = true) {
  bag = ensureFakeBag(bag)
  count = Math.floor(Number(count) || 0)
  if (count <= 0 || !name) return []
  if (EQUIP_TPL[name] || ITEM_TPL[name] || MATERIAL_TPL[name] || GONGFA_TPL[name]) {
    return addItemToBag(bag, name, count, attr, autoEquip)
  }
  const old = bag.items[name]
  if (!old || typeof old !== 'object') bag.items[name] = { count: itemCount(old) }
  bag.items[name].count = itemCount(bag.items[name]) + count
  return []
}
function fakeTakeItem (bag, name, count = 1, attr = null) {
  bag = ensureFakeBag(bag)
  if (EQUIP_TPL[name] || ITEM_TPL[name] || MATERIAL_TPL[name] || GONGFA_TPL[name]) return consumeBagItem(bag, name, count, attr)
  const it = bag.items[name]
  if (itemCount(it) < count) return false
  it.count = itemCount(it) - count
  if (it.count <= 0) delete bag.items[name]
  return true
}
function fakeTakeEntry (bag, name) {
  bag = ensureFakeBag(bag)
  const it = bag.items[name]
  if (!it || itemCount(it) <= 0) return null
  if (EQUIP_TPL[name]) {
    const group = Array.isArray(it.list) && it.list.length
      ? it.list.find(x => itemCount(x) > 0)
      : null
    const attr = (group && group.attr) || it.attr || null
    if (!fakeTakeItem(bag, name, 1, attr)) return null
    return { name, attr }
  }
  if (!fakeTakeItem(bag, name, 1)) return null
  return { name, attr: null }
}
function fakeTransferEntry (fromBag, toBag, name) {
  const entry = fakeTakeEntry(fromBag, name)
  if (!entry) return false
  fakeAddItem(toBag, entry.name, 1, entry.attr)
  return true
}
function fakeAutoEquip (p) {
  ensureFakeBag(p.bag || (p.bag = {}))
  return autoEquipBest(p.bag)
}
/** 装备好坏评分: 品质优先, 同品质按实际属性战力。 */
function equipScore (name, attr = null) {
  const t = EQUIP_TPL[name]
  if (!t) return 0
  return (t.quality || 0) * 100000 + attrPower(attr || {})
}

const DIR = `${Save_Path}/world`
const FAKE_FILE = `${DIR}/fake.json` // 旧全局档(仅首次迁移用)
const fakeCache = new Map()

/** 每群独立存档: data/.../world/fake_{gid}.json */
function fakeFile (gid) { return `${DIR}/fake_${gid}.json` }
/** 所有活跃群(已有独立存档的群) */
export function activeFakeGroups () {
  try {
    if (!fs.existsSync(DIR)) return []
    return fs.readdirSync(DIR)
      .filter(n => /^fake_\d+\.json$/.test(n))
      .map(n => n.replace(/^fake_|\.json$/g, ''))
  } catch (err) { return [] }
}
const NAME_FILE = `${Plugin_Path}/resources/qylp/fake_names.json`
const SECT_FILE = `${Plugin_Path}/resources/qylp/fake_sect_names.json`
const NAME_CFG_PATH = `${Plugin_Path}/config/xujing.config.yaml`
/* 优先名字缓存(1分钟刷新, 锅巴改配置后最多1分钟生效) */
let prioNameCache = { at: 0, list: [] }
function getPriorityNames () {
  const now = Date.now()
  if (prioNameCache.at && now - prioNameCache.at < 60000) return prioNameCache.list
  try {
    const all = YAML.parse(fs.readFileSync(NAME_CFG_PATH, 'utf8'))
    /* 兼容嵌套 name_cfg.priority_names 与旧版扁平键 */
    const nc = (all && all.name_cfg) || {}
    const nested = Array.isArray(nc.priority_names) ? nc.priority_names : []
    /* 兼容锅巴/旧配置曾写出的扁平键 name_cfg.priority_names */
    const flat = Array.isArray(all && all['name_cfg.priority_names']) ? all['name_cfg.priority_names'] : []
    const arr = [...nested, ...flat]
    prioNameCache = { at: now, list: [...new Set(arr.map(x => String(x).trim()).filter(Boolean))] }
  } catch (err) {
    prioNameCache = { at: now, list: [] }
  }
  return prioNameCache.list
}

/** 同步优先名字池: 配置中的名字从普通池迁移到优先池, 兼容旧档 */
function syncPriorityPool (f, names = getPriorityNames()) {
  if (!f || !Array.isArray(names)) return false
  if (!Array.isArray(f.pool)) f.pool = []
  if (!Array.isArray(f.poolPriority)) f.poolPriority = []
  const configured = new Set(names)
  const rosterNames = new Set(Object.keys(f.roster || {}))
  const unique = arr => [...new Set((arr || []).filter(Boolean))]
  const oldPriority = unique(f.poolPriority)
  const oldPool = unique(f.pool)
  const demoted = oldPriority.filter(n => !configured.has(n) && !rosterNames.has(n))
  const priority = names.filter(n => !rosterNames.has(n))
  const normal = oldPool.filter(n => !configured.has(n) && !rosterNames.has(n))
  f.poolPriority = unique(priority)
  f.pool = unique([...normal, ...demoted])
  return JSON.stringify(oldPriority) !== JSON.stringify(f.poolPriority) || JSON.stringify(oldPool) !== JSON.stringify(f.pool)
}

/* ---------- 常量 ---------- */
/** 职位配置: 满编人数(max=null 不限) / 修为带[下,上] / 中文名
 * 太上长老(41~56)凌驾于宗主(29~44)之上, 平时闭关, 灭顶之灾才出手 */
export const POS = {
  zongzhu: { max: 1, band: [29, 44], cn: '宗主' },
  fuzong: { max: 2, band: [17, 32], cn: '副宗主' },
  taishang: { max: 2, band: [41, 56], cn: '太上长老' },
  zhishi: { max: 5, band: [5, 16], cn: '执事' },
  dizi: { max: null, band: [1, 12], cn: '弟子' }
}
/** 初始境界(低起步): 伪玩家和玩家一样靠修炼/突破自然成长, 不凭空给高境界(职位 band 仅用于晋升判定/显示) */
export const SECT_START_BAND = {
  zongzhu: [7, 12], fuzong: [5, 9], taishang: [10, 15], zhishi: [3, 6], dizi: [1, 3]
}
/** 线性晋升链: 目标职位 ← 来源职位(所需在宗天数已去掉, 晋升只看修为实力) */
export const PROMO = [
  ['zhishi', 'dizi', 0],
  ['fuzong', 'zhishi', 0],
  ['zongzhu', 'fuzong', 0]
]
/** 伪玩家初始人数(之后每30分钟固定新增1名, 直到达到上限) */
export const FAKE_INIT = 350
/** 伪玩家在世人数上限: 达到后停止补员 */
export const FAKE_MAX = 399
function fakeAliveCount (f) {
  return Object.values(f && f.roster ? f.roster : {}).filter(p => p && p.alive).length
}
/** 补员周期: 每30分钟固定新增1名伪玩家 */
const TOPUP_INTERVAL = 30 * 60000
/** 夜间暂停(凌晨1~6点): 与修仙世界/世界boss一致 */
const FAKE_NIGHT_START = 1
const FAKE_NIGHT_END = 6
function isFakeNight () {
  const h = new Date().getHours()
  return h >= FAKE_NIGHT_START && h < FAKE_NIGHT_END
}
/** 灭门后重建延迟(分钟): 散修创建宗门随机等 5~30 分钟(用户要求灭门后尽快重生) */
export const REBUILD_MIN = [30, 30] // 伪玩家灭门重建固定30分钟(灭门空位玩家可立即覆盖建宗, 伪玩家等30分钟)
/** 伪玩家境界上限: 与玩家一致, 最高仙帝第499重(level 567) */
const FAKE_MAX_LEVEL = REALM_MAX_LEVEL
/** 散修修为带(受境界上限约束) */
const SCATTER_BAND = [1, FAKE_MAX_LEVEL]
/** 修为带: 宗门成员/散修共用同一境界上限(仙帝第499重) */
function levelBand (p) {
  return [1, FAKE_MAX_LEVEL]
}
/** 宗门目标规模(弟子+管理层, 慢慢招到上限为止) */
export const SECT_TARGET = 20
/** 玩家+伪玩家宗门共用上限(与 sect_system.js 的 CFG.MAX_SECTS=15 同步) */
export const FAKE_SECT_MAX = 15

/* ---------- 随机工具 ---------- */
const rand = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1))
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t
  }
  return arr
}
const dayStr = (t) => new Date(t).toISOString().slice(0, 10)

/* ---------- 性格 / 魔修 ---------- */
function rollPath () { return Math.random() < 0.2 ? '魔道' : '正道' }
function rollTrait (path) {
  const r = Math.random() * 100
  if (path === '魔道') return r < 30 ? '好斗' : (r < 75 ? '嗜杀' : '平和')
  return r < 22 ? '善良' : (r < 52 ? '平和' : (r < 80 ? '好斗' : '嗜杀'))
}
/** 行为性格(决定修炼/摆摊等频率): 苦修→勤修炼, 贪玩→爱摆摊逛街, 懒散→都少 */
function rollAct () {
  const r = Math.random() * 100
  if (r < 12) return '苦修'
  if (r < 28) return '勤勉'
  if (r < 62) return '普通'
  if (r < 80) return '懒散'
  return '贪玩'
}
/** 行为性格系数: cult=修炼/突破意愿, play=摆摊/逛街意愿 */
const ACT_FX = {
  '苦修': { cult: 1.3, play: 0.4 },
  '勤勉': { cult: 1.1, play: 0.8 },
  '普通': { cult: 0.8, play: 1.0 },
  '懒散': { cult: 0.3, play: 0.6 },
  '贪玩': { cult: 0.5, play: 1.3 }
}
function actFx (p) { return ACT_FX[p && p.act] || ACT_FX['普通'] }

/* ---------- 数据读写 ---------- */
function emptyFake () {
  return {
    pool: [], sects: {}, roster: {}, sectMap: {}, areas: {},
    trades: [], day: '', lastSettle: 0, lastEvents: 0, lastHistoryCleanup: 0,
    sectMines: {}, lastMaint: 0, mineEvents: [],
    evSeq: 0,
    major: [], minor: [], byPerson: {}, bySect: {},
    players: {}, // 玩家宗门身份表: uid -> { name, sect, pos, joinAt, contribution, injury }
    injuries: {}, // 玩家负伤(散修/无宗门档案也记录): uid -> { level, at }, 与宗门身份解耦
    /* 玩家宗门系统: 小区护城阵 / 玩家攻打队列 / 目标冷却 / 小区产出面板 */
    areaDef: {}, sectAttacks: [], targetCd: {}, areaOut: [], sectSeq: 0, lastAreaOut: 0, aiNextAt: 0,
    lastResourceFlow: 0, // 宗门资源自用流转(炼丹/制宝/弟子取丹吃丹)上次执行时间
    lastPromote: 0, // 伪玩家宗主任命(修为达标即提拔)上次执行时间(每小时)
    lastPower: 0, // 高修为者夺权(强者为尊)上次执行时间(每6小时)
    lastDiplomacy: 0, // AI 宗门外交(主动结盟/议和)上次执行时间(每10分钟)
    sectJoinReqs: {}, sectJoinNotify: {}, // 散修入宗申请(兼容旧档审批, 新逻辑直接入宗) / 上次@宗主时间
    sectJails: {}, // 宗门天牢: sectId -> [{ uid, name, until, atkId }]
    raidJail: [], // 藏宝阁天牢(洗劫藏宝阁被抓, 0~120分钟): [{ name, at, until }]
    kickBans: {}, // 被逐出宗门的伪玩家: name -> 2天内不主动入宗的截止时间戳
    sectLeaveBans: {}, // 玩家主动退出: uid -> { sectId: 原宗门禁入截止时间戳 }
    poolBans: {}, // 死亡/被处决名字禁用期: name -> until
    deathRecords: {}, // 已陨落伪玩家: name -> { t, txt, sect, pos, level, path, trait }
    sectDeadNames: {}, // 永久除名宗门: sectId -> 最后名称(历史战报/关系引用不再显示"未知")
    ambushHeat: {}, // 伏击热度(风声紧): loc -> { c, at } 玩家伏击大区次数(1小时内), 世界会躲落单
    ambushRecent: {} // 伏击目标冷却: name -> 允许再次成为目标的时间戳, 世界会躲落单
  }
}
/** 旧档回填: 永久除名宗门的名称从历史战争"宣战"日志恢复(宗门被彻底除名后 sectName 查不到 → 战报显示"未知") */
export function backfillSectDeadNames (f) {
  const d = f.sectDeadNames || (f.sectDeadNames = {})
  let changed = false
  for (const a of (f.sectAttacks || [])) {
    /* 只补宗门目标/宗门攻方 已永久除名的战争: 从首条宣战日志里取目标名/攻方名 */
    const need = []
    if (a.targetType === 'sect' && a.target && !f.sects[a.target] && !d[a.target]) need.push([a.target, 'target'])
    if (a.atkSect && !f.sects[a.atkSect] && !d[a.atkSect]) need.push([a.atkSect, 'atk'])
    if (!need.length) continue
    const first = (a.log && a.log[0] && a.log[0].txt) || ''
    if (!first.includes('宣战')) continue
    for (const [sid, role] of need) {
      const m = role === 'target' ? first.match(/向【([^】]+)】宣战/) : first.match(/^【宣战】(.+?)向【/)
      const name = m && m[1].trim()
      if (name && name !== '未知') { d[sid] = name; changed = true }
    }
  }
  return changed
}

export function getFake (gid) {
  const g = String(gid || '')
  const cached = fakeCache.get(g)
  if (cached) return cached
  const file = fakeFile(g)
  if (!fs.existsSync(file)) {
    /* 旧全局档迁移: 尚无任何独立存档时, 旧 fake.json 归第一个群(不浪费历史) */
    if (fs.existsSync(FAKE_FILE) && !activeFakeGroups().length) {
      try { fs.renameSync(FAKE_FILE, file) } catch (err) { }
    }
    if (!fs.existsSync(file)) {
      const f = emptyFake()
      f.gid = g
      initFake(f)
      fakeCache.set(g, f)
      saveFake(f, g)
      return f
    }
  }
  let loaded
  try {
    loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    /* 只有"内容解析不了"才算损坏(全0字节/断电半写); 读盘错误(占用/权限)原样抛出, 不许动文件 */
    if (!(err instanceof SyntaxError)) throw err
    /* 损坏: 隔离现场 → 用最近可用备份写回; 没有可用备份就继续拒绝, 不用空档覆盖上千伪玩家 */
    const r = recoverCorruptJson(file, `world/fake_${g}.json`, d => !!(d && d.sects && Object.keys(d.sects).length))
    if (r.restored) {
      console.log(`[天下大事]宗门档损坏(${err.message})，已隔离到 ${r.bak}，并从备份 ${r.dir} 恢复：${file}`)
      return getFake(g) // 重新读一遍恢复出来的档
    }
    console.log(`[天下大事]宗门档损坏(${err.message})且无可用备份${r.error ? `(${r.error})` : ''}，已隔离到 ${r.bak}，拒绝覆盖：${file}`)
    throw new Error(`[天下大事]宗门存档解析失败，拒绝覆盖：${file}`)
  }
  const f = Object.assign(emptyFake(), loaded || {})
  f.gid = g
  /* 只有成功解析出的真正空档才允许初始化 */
  if (!Object.keys(f.sects || {}).length || !Object.values(f.roster || {}).some(p => p && p.alive)) {
    const nf = emptyFake()
    nf.gid = g
    initFake(nf)
    fakeCache.set(g, nf)
    saveFake(nf, g)
    return nf
  }
  /* 兼容旧档: 补齐玩家化/关系链字段 */
  for (const p of Object.values(f.roster)) {
    personDefaults(p)
    bindFakeGid(p, g)
  }
  /* 兼容旧档: 玩家宗门身份表 */
  if (!f.players || typeof f.players !== 'object') f.players = {}
  /* 兼容旧档: 宗门设施/宝库/玩家宗主/敌人/大区/创建标记 */
  let sChanged = false
  for (const [sid, sm] of Object.entries(f.sects || {})) {
    if (!sm || typeof sm !== 'object') continue
    if (!sm.facilities || typeof sm.facilities !== 'object') { sm.facilities = { yanwu: 0, hushan: 0, lingmai: 0 }; sChanged = true }
    if (!sm.vault || typeof sm.vault !== 'object') { sm.vault = { stones: 100000, mats: {}, pills: {} }; sChanged = true } else {
      if (typeof sm.vault.stones !== 'number' || Number.isNaN(sm.vault.stones)) { sm.vault.stones = 100000; sChanged = true }
      if (!sm.vault.mats || typeof sm.vault.mats !== 'object') { sm.vault.mats = {}; sChanged = true }
      if (!sm.vault.pills || typeof sm.vault.pills !== 'object') { sm.vault.pills = {}; sChanged = true }
    }
    if (sm.owner === undefined) { sm.owner = null; sChanged = true }
    if (!Array.isArray(sm.enemies)) { sm.enemies = []; sChanged = true }
    if (!Array.isArray(sm.allies)) { sm.allies = []; sChanged = true }
    if (sm.region === undefined) { sm.region = ''; sChanged = true }
    if (!sm.createdAt) { sm.createdAt = 0; sChanged = true }
    if (sm.lastSalaryAt === undefined) { sm.lastSalaryAt = Date.now(); sChanged = true }
    if (sm.atkCdUntil === undefined) { sm.atkCdUntil = 0; sChanged = true }
    /* 兼容旧档: 灭门时远遁的宗主(看情况重建宗门) */
    if (sm.masterExile === undefined) { sm.masterExile = null; sChanged = true }
    /* 兼容旧档: 所有宗门自带1级药园(建立宗门就有, 基础产出) */
    if (!sm.facilities || !sm.facilities.yaoyuan) {
      if (!sm.facilities) sm.facilities = {}
      sm.facilities.yaoyuan = 1
      sChanged = true
    }
  }
  /* 旧档: 宗门大区按占领小区推定(小区最多的大区) */
  for (const sid of Object.keys(f.sects || {})) {
    const sm = f.sects[sid]
    if (sm && !sm.region) {
      const cnt = {}
      for (const [area, owner] of Object.entries(f.areas || {})) {
        if (owner === sid) { const r = regionOfArea(area); if (r) cnt[r] = (cnt[r] || 0) + 1 }
      }
      let best = 'center'
      let bn = 0
      for (const [r, n] of Object.entries(cnt)) if (n > bn) { best = r; bn = n }
      sm.region = best
      sChanged = true
    }
  }
  /* 兼容旧档: 小区护城阵(默认1级) */
  if (!f.areaDef || typeof f.areaDef !== 'object') { f.areaDef = {}; sChanged = true }
  for (const area of Object.keys(f.areas || {})) {
    if (!f.areaDef[area]) { f.areaDef[area] = { level: 1, maintainAt: 0 }; sChanged = true }
  }
  if (!Array.isArray(f.sectAttacks)) { f.sectAttacks = []; sChanged = true }
  /* 旧版战争队列已统一迁移到 sectAttacks；删除旧字段，避免再次被任何流程读取。 */
  if (Array.isArray(f.attacks)) { delete f.attacks; sChanged = true }
  /* 兼容旧档: 永久除名宗门名登记表 + 从历史战争宣战日志回填(宗门被彻底除名后, 历史战报不再显示"未知") */
  if (!f.sectDeadNames || typeof f.sectDeadNames !== 'object') { f.sectDeadNames = {}; sChanged = true }
  if (backfillSectDeadNames(f)) sChanged = true
  if (!f.targetCd || typeof f.targetCd !== 'object') { f.targetCd = {}; sChanged = true }
  if (!Array.isArray(f.areaOut)) { f.areaOut = []; sChanged = true }
  if (!f.sectSeq) f.sectSeq = 0
  if (!f.lastAreaOut) f.lastAreaOut = 0
  if (!f.aiNextAt) f.aiNextAt = 0
  if (!f.lastResourceFlow) f.lastResourceFlow = 0
  if (!f.lastPromote) f.lastPromote = 0
  if (!f.lastPower) f.lastPower = 0
  if (!f.sectJoinReqs || typeof f.sectJoinReqs !== 'object') { f.sectJoinReqs = {}; sChanged = true }
  if (!f.sectJoinNotify || typeof f.sectJoinNotify !== 'object') { f.sectJoinNotify = {}; sChanged = true }
  if (!f.sectJails || typeof f.sectJails !== 'object') { f.sectJails = {}; sChanged = true }
  if (!f.sectMines || typeof f.sectMines !== 'object') { f.sectMines = {}; sChanged = true }
  if (!Array.isArray(f.mineEvents)) { f.mineEvents = []; sChanged = true }
  if (!f.sectLeaveBans || typeof f.sectLeaveBans !== 'object') { f.sectLeaveBans = {}; sChanged = true }
  if (!f.lastMaint) f.lastMaint = 0
  if (!f.ambushHeat || typeof f.ambushHeat !== 'object') { f.ambushHeat = {}; sChanged = true }
  if (!f.deathRecords || typeof f.deathRecords !== 'object') { f.deathRecords = {}; sChanged = true }
  /* 配置里的优先名字从普通池迁移到优先池, 兼容旧档/扁平配置 */
  if (syncPriorityPool(f)) sChanged = true
  if (sChanged) saveFake(f, g)
  /* 兼容旧档: 补齐宗门职位数组(所有档都保证是数组) */
  let sectChanged = false
  for (const [id, sm] of Object.entries(f.sectMap || {})) {
    if (!sm) continue
    for (const key of ['fuzong', 'taishang', 'zhishi', 'dizi']) {
      if (!Array.isArray(sm[key])) { sm[key] = []; sectChanged = true }
    }
  }
  /* 清理死亡/离宗后残留的职位名单, 避免宗门详情显示并错误占用职位 */
  if (cleanSectMaps(f)) sectChanged = true
  /* 仅旧档迁移时(无预演标记): 以修为最高者静默补足2席太上(新档正常运行太上死光则空缺, 由promoteSettle补/走向灭门) */
  if (!f.preRan) {
    for (const [id, sm] of Object.entries(f.sectMap || {})) {
      if (!sm) continue
      while (sm.taishang.length < POS.taishang.max) {
        const cands = Object.values(f.roster).filter(p =>
          p.alive && !p.realmBusy && p.status === 'sect' && p.sect === id && p.pos !== 'taishang' && p.pos !== 'zongzhu')
        if (!cands.length) break
        cands.sort((a, b) => b.level - a.level || a.joinAt - b.joinAt)
        const c = cands[0]
        if (c.pos === 'dizi') sm.dizi = sm.dizi.filter(x => x !== c.name)
        else sm[c.pos] = sm[c.pos].filter(x => x !== c.name)
        c.pos = 'taishang'
        c.level = Math.max(c.level, POS.taishang.band[0]) // 补位修为抬至太上带下限
        sm.taishang.push(c.name)
        sectChanged = true
      }
    }
  }
  if (sectChanged) saveFake(f, g)
  /* 旧档无预演标记(老代码初始化): 自动补3小时推演历史 */
  if (!f.preRan) {
    f.preRan = true
    preRun3h(f)
    saveFake(f, g)
  }
  /* 旧档迁移: 单列表 events 并入小事存储(上限200), 释放旧字段 */
  if (Array.isArray(f.events) && f.events.length) {
    f.minor = (f.minor || []).concat(f.events.map(x => ({ ...x, major: !!x.major }))).slice(-200)
    delete f.events
    saveFake(f, g)
  }
  /* 伪玩家背包迁移到 canonical 格式；版本命中后不再重复扫描全部人口。 */
  const FAKE_BAG_VERSION = 1
  if ((Number(f.bagVersion) || 0) < FAKE_BAG_VERSION) {
    for (const p of Object.values(f.roster || {})) {
      if (!p) continue
      const bag = p.bag || (p.bag = {})
      ensureBagShape(bag, { removeEquippedFromItems: false })
      autoEquipBest(bag)
    }
    f.bagVersion = FAKE_BAG_VERSION
    saveFake(f, g)
  }
  fakeCache.set(g, f)
  return f
}
export function saveFake (f, gid) {
  const g = String(gid || f.gid || '')
  const file = fakeFile(g)
  fakeCache.set(g, f)
  try {
    return saveOrDefer(file, () => writeJsonAtomic(file, f, '\t'))
  } catch (err) {
    console.log('[天下大事]保存失败:', err && err.message)
    return false
  }
}

/* ---------- 初始化: 抽150人入8宗 ---------- */
function initFake (f) {
  let names = []
  try { names = JSON.parse(fs.readFileSync(NAME_FILE, 'utf8')) } catch (err) { names = [] }
  if (!Array.isArray(names)) names = []
  shuffle(names)
  const prio = getPriorityNames()
  const nonPrio = names.filter(n => !prio.includes(n))
  const used = nonPrio.slice(0, FAKE_INIT)
  f.pool = nonPrio.slice(FAKE_INIT)
  f.poolPriority = prio.slice() // 优先名字保留用于优先抽取(不占初始150人)
  /* 宗门: 按 world.json 当前小区占领宗门建立(与玩家经济同一身份) */
  const w = getWorld(f.gid)
  const sectNames = [...new Set(Object.values(w.sectMap || {}))].filter(Boolean)
  if (!sectNames.length) sectNames.push('万剑宗', '青云宗', '天机阁', '太虚门', '玄冥教', '紫霄殿', '丹霞谷', '御兽宗')
  const sid = {}
  sectNames.forEach((n, i) => {
    const id = `sect_${i + 1}`
    sid[n] = id
    f.sects[id] = {
      name: n, foundedAt: Date.now(), wipeAt: 0, rebuildAt: 0,
      recruit: { next: Date.now() + rand([0, 4]) * 3600000 },
      /* 玩家宗门系统字段(新档直接带齐, 旧档由 getFake 兼容补齐) */
      facilities: { yanwu: 0, hushan: 0, lingmai: 0, yaoyuan: 1 },
      vault: { stones: 100000, mats: {}, pills: {} },
      owner: null, enemies: [], region: '', createdAt: 0
    }
    f.sectMap[id] = { zongzhu: null, fuzong: [], taishang: [], zhishi: [], dizi: [] }
  })
  for (const [area, n] of Object.entries(w.sectMap || {})) {
    if (sid[n]) f.areas[area] = sid[n]
  }
  /* 新档: 小区护城阵默认1级(旧档由 getFake 兼容段补齐) */
  for (const area of Object.keys(f.areas || {})) f.areaDef[area] = { level: 1, maintainAt: 0 }
  /* 分配人员: 每宗 1宗主+2副宗主+2太上+5执事+8~9弟子(共18~19, 总150) */
  let k = 0
  const ids = Object.keys(f.sects)
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const diziCount = 8 + (i < 6 ? 1 : 0) // 前6宗9弟子, 后2宗8弟子 → 总70弟子
    const plan = [
      ['zongzhu', 1], ['fuzong', 2], ['taishang', 2], ['zhishi', 5], ['dizi', diziCount]
    ]
    for (const [pos, cnt] of plan) {
      for (let j = 0; j < cnt; j++) {
        const name = used[k++]
        if (!name) break
        /* 初始全员低境界起步: 和玩家一样靠修炼/突破自然成长, 不再凭空给高境界 */
        const lv = rand(SECT_START_BAND[pos] || [1, 3])
        addPerson(f, name, id, pos, lv)
      }
    }
  }
  /* 多余名字回池 */
  for (; k < used.length; k++) f.pool.push(used[k])
  f.day = dayStr(Date.now())
  f.lastEvents = Date.now()
  /* 新档预演3小时: 让江湖一上来就有历史(事件+少量在途攻打, 不预演易主) */
  preRun3h(f)
  f.preRan = true
}

/** 一键重洗天下: 删除本群全部伪玩家/宗门数据, 重新初始化+预演(主人指令 #重洗天下 用) */
export function rewashFake (gid) {
  const g = String(gid || '')
  const file = fakeFile(g)
  const fakePetFile = `${Save_Path}/pet/pet_fake_${g}.json`
  try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch (err) { }
  try { if (fs.existsSync(fakePetFile)) fs.unlinkSync(fakePetFile) } catch (err) { }
  const f = emptyFake()
  f.gid = g
  initFake(f)
  saveFake(f, g)
  return f
}

/* ---------- 新档预演 ---------- */
export function preRun3h (f) {
  const end = Date.now()
  const start = end - 3 * 3600000
  /* 3小时事件(每小时3~20起, 最少3件; 每条事件时间戳秒级独立随机分散) */
  for (let h = 0; h < 3; h++) {
    const n = 3 + rand([0, 17])
    let made = 0
    let tries = 0
    while (made < n && tries < n * 3) {
      tries++
      try {
        const gen = pick(EVENT_GENS)
        const et = start + h * 3600000 + rand([0, 55 * 60]) * 1000
        const ev = gen(f, et)
        if (ev) { logEvent(f, ev.type, ev.txt, et, ev); made++ }
      } catch (err) { }
    }
  }
  /* 战争由 sectTick 统一调度；初始化只生成历史事件，避免旧版战争队列污染新系统。 */
  f.lastEvents = end
}

/* ---------- 人物 / 职位操作 ---------- */
/** 伪玩家累计池(accum): 达到当前境界峰值后溢出的灵力, 固定上限10000; 突破时并入主灵力(与玩家累积池一致) */
const FAKE_ACCUM_CAP = 10000
/** 灵力增长统一入口: 主灵力先填到当前境界阈值(fakeSubThreshold(level+1)), 溢出进累计池(固定上限10000, 再溢出消散) */
function addExp (p, gain) {
  gain = Number(gain) || 0
  if (gain <= 0) return
  p.exp = Number(p.exp) || 0
  p.accum = Number(p.accum) || 0
  const need = fakeSubThreshold(p.level + 1)
  const toMain = Math.max(0, Math.min(gain, need - p.exp))
  p.exp += toMain
  const overflow = gain - toMain
  if (overflow > 0) p.accum = Math.min(FAKE_ACCUM_CAP, p.accum + overflow)
}
/** 突破并入累计池: 突破成功时把累计池灵力并入主灵力并清零(与玩家一致) */
function mergeAccum (p) {
  p.accum = Number(p.accum) || 0
  if (p.accum > 0) {
    p.exp = (Number(p.exp) || 0) + p.accum
    p.accum = 0
  }
}
/** 给内存中的伪玩家绑定群号(不可序列化), 让战力计算能读取独立伪玩家灵兽档 */
function bindFakeGid (p, gid) {
  if (!p || !gid) return p
  try {
    Object.defineProperty(p, '__fakeGid', { value: String(gid), writable: true, configurable: true, enumerable: false })
  } catch (err) { p.__fakeGid = String(gid) }
  return p
}

/* 补齐伪玩家默认字段(玩家化: 钱/exp/背包/活动/大区位置 + 关系链), 兼容旧档 */
function personDefaults (p) {
  if (!p) return p
  if (!p.relations) p.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], confidants: [], siblings: [], kin: [] }
  if (!p.relations.confidants) p.relations.confidants = []
  if (!p.relations.siblings) p.relations.siblings = []
  /* 参战表现(宗门战争维护): 累计出战/最近出战/连续避战次数 */
  if (p.lastFightAt === undefined) p.lastFightAt = 0
  if (p.fightCount === undefined) p.fightCount = 0
  if (p.absentStreak === undefined) p.absentStreak = 0
  if (p.money === undefined) p.money = 500 + Math.floor(Math.random() * 5000)
  /* 攒钱目标(消费驱动, 由 tryFakeBuy 维护): null 或 {type, tier, price, at} */
  if (p.wish === undefined) p.wish = null
  /* 杀孽业障(因果): 杀人/灭口累积, 记录杀孽(无负面效果, #查人可见) */
  if (p.sin === undefined) p.sin = 0
  if (p.exp === undefined) p.exp = 0
  /* 灵力=累计灵力(只增不减, 与玩家一致); 历史灵力低于当前境界阈值时补足, 保证灵力和境界对应 */
  if (p.level > 0 && (p.exp || 0) < fakeSubThreshold(p.level)) p.exp = fakeSubThreshold(p.level)
  /* 累计池: 默认0, 旧档上限收敛到10000(不再限制主灵力) */
  if (p.accum === undefined) p.accum = 0
  p.accum = Math.min(FAKE_ACCUM_CAP, Number(p.accum) || 0)
  if (!p.bag) p.bag = { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} }
  ensureFakeBag(p.bag)
  if (!p.activities) p.activities = { lastCultivate: 0, lastStall: 0, lastRaid: 0, lastFight: 0 }
  if (p.activities.nextPetAt === undefined) p.activities.nextPetAt = 0
  if (!p.loc) p.loc = pick(REGION_KEYS.filter(k => !(REGIONS[k] && REGIONS[k].special))) // 所在大区(中州/东海/西域/北境/南疆, 不含简月王朝), 用于摆摊税率/远行
  /* 忠诚度(0~100): 对宗门/归属的忠诚, 影响离宗/叛逃/被挖/守城响应 */
  if (p.loyalty === undefined) p.loyalty = initLoyalty(p)
  p.loyalty = clamp(Number(p.loyalty) || 0, 0, 100)
  /* 宗门贡献点: 伪玩家上供后用于兑换宝库资源, 兼容旧档缺失字段 */
  if (p.contribution === undefined) p.contribution = 0
  p.contribution = Math.max(0, Number(p.contribution) || 0)
  /* 灭门仇恨(宗门被灭时的幸存者): null 或 { sectName, culprit, culpritType, at } */
  if (!p.vendetta) p.vendetta = null
  /* 伤势(负伤): null 或 { level(1轻/2中/3重), at } — 重伤逃命者/被伏击打伤/战场重伤退出, 负伤期间战力下降 */
  if (p.injury === undefined) p.injury = null
  /* 进入遗蜕秘境期间暂停外部行为; { realmId, gid }，秘境结束再清除 */
  if (p.realmBusy === undefined) p.realmBusy = null
  return p
}
/** 宗门所在大区(新门人/远行回归用): 优先 sects.region, 否则按占领小区推定 */
function regionOfArea (area) {
  for (const k of Object.keys(REGIONS)) {
    if (REGIONS[k] && REGIONS[k].areas && REGIONS[k].areas.includes(area)) return k
  }
  return null
}
function sectLocOf (f, sectId) {
  const s = f.sects && f.sects[sectId]
  if (s && s.region) return s.region
  const cnt = {}
  for (const [area, o] of Object.entries(f.areas || {})) {
    if (o !== sectId) continue
    const r = regionOfArea(area)
    if (r) cnt[r] = (cnt[r] || 0) + 1
  }
  let best = 'center'
  let bn = 0
  for (const [r, n] of Object.entries(cnt)) if (n > bn) { best = r; bn = n }
  return best
}
export function addPerson (f, name, sectId, pos, level) {
  if (!f.roster[name] && fakeAliveCount(f) >= FAKE_MAX) return null
  const path = rollPath()
  const p = personDefaults({
    name, sect: sectId, pos, status: 'sect', path, trait: rollTrait(path), act: rollAct(),
    level: clamp(level, 1, FAKE_MAX_LEVEL), alive: true, joinAt: Date.now(), kills: 0, lastFight: 0
  })
  bindFakeGid(p, f.gid)
  /* 新门人默认在宗门所在大区(宗门的人喜欢待在自己宗门的大区) */
  p.loc = sectLocOf(f, sectId)
  f.roster[name] = p
  const sm = f.sectMap[sectId]
  if (sm) {
    if (pos === 'zongzhu') sm.zongzhu = name
    else sm[pos].push(name)
  }
  return p
}
/** 从职位名单移除(用于死亡/叛逃) */
export function removeFromSectMap (f, sectId, name) {
  const sm = f.sectMap[sectId]
  if (!sm) return
  if (sm.zongzhu === name) sm.zongzhu = null
  for (const key of ['fuzong', 'taishang', 'zhishi', 'dizi']) {
    if (Array.isArray(sm[key])) sm[key] = sm[key].filter(x => x !== name)
  }
}
/** 清理宗门职位名单中的无效伪玩家(死亡/已离宗/旧档残留), 释放被错误占用的职位 */
export function cleanSectMaps (f) {
  if (!f || !f.sectMap) return false
  let changed = false
  const valid = (sid, name) => {
    const p = name && f.roster && f.roster[name]
    return !!(p && p.alive && !p.realmBusy && p.status === 'sect' && p.sect === sid)
  }
  for (const [sid, sm] of Object.entries(f.sectMap)) {
    if (!sm) continue
    if (sm.zongzhu && !valid(sid, sm.zongzhu)) {
      sm.zongzhu = null
      changed = true
    }
    for (const key of ['fuzong', 'taishang', 'zhishi', 'dizi']) {
      const old = Array.isArray(sm[key]) ? sm[key] : []
      const next = [...new Set(old.filter(name => valid(sid, name)))]
      if (!Array.isArray(sm[key]) || next.length !== old.length || next.some((name, i) => name !== old[i])) {
        sm[key] = next
        changed = true
      }
    }
  }
  return changed
}

/** 死亡名禁用期: 补员抽名避开刚死/被处决者 6 小时(避免立即同名复活) */
export const POOL_BAN_MS = 6 * 3600000
/** 从池抽一个名字: 未达人数上限时优先池优先, 但不会绕过死亡禁用期 */
export function drawName (f) {
  if (fakeAliveCount(f) >= FAKE_MAX) return null
  const now = Date.now()
  const bans = f.poolBans || (f.poolBans = {})
  for (const k of Object.keys(bans)) if (bans[k] <= now) delete bans[k]
  if (!Array.isArray(f.poolPriority)) f.poolPriority = []
  const priorityAvail = f.poolPriority.filter(n => !bans[n] && !(f.roster && f.roster[n] && f.roster[n].alive))
  if (priorityAvail.length) {
    const n = priorityAvail[Math.floor(Math.random() * priorityAvail.length)]
    f.poolPriority.splice(f.poolPriority.indexOf(n), 1)
    return n
  }
  if (!Array.isArray(f.pool) || !f.pool.length) return null
  const avail = f.pool.filter(n => !bans[n])
  if (!avail.length) return null
  const n = avail[Math.floor(Math.random() * avail.length)]
  f.pool.splice(f.pool.indexOf(n), 1)
  return n
}
/** 名字回池(优先名字回优先池, 普通名字回普通池; 去重) */
function returnName (f, name) {
  if (!name) return
  const isPriority = getPriorityNames().includes(name)
  if (!Array.isArray(f.pool)) f.pool = []
  if (!Array.isArray(f.poolPriority)) f.poolPriority = []
  f.pool = f.pool.filter(n => n !== name)
  const target = isPriority ? f.poolPriority : f.pool
  if (!target.includes(name)) target.push(name)
}
/** 宗门名(宗门已被永久除名时回退到 sectDeadNames 里登记的最后名称, 历史战报不显示"未知") */
export function sectName (f, id) {
  return (f.sects[id] && f.sects[id].name) || (f.sectDeadNames && f.sectDeadNames[id]) || '未知'
}
/** 玩家所属宗门名(无宗门/无档案返回null): 供税率减半判定 */
export function playerSectName (gid, uid) {
  try {
    const f = getFake(gid)
    const pl = f.players && f.players[String(uid)]
    if (pl && pl.sect && f.sects && f.sects[pl.sect]) return sectName(f, pl.sect)
  } catch (err) { }
  return null
}
/** 宗门名 → id */
export function sectIdByName (f, name) {
  for (const id of Object.keys(f.sects)) if (f.sects[id].name === name) return id
  return null
}
/** 宗门在世伪玩家 */
export function sectAlive (f, id) {
  return Object.values(f.roster).filter(p => p.alive && !p.realmBusy && p.sect === id && p.status === 'sect')
}
/** 伪玩家战力 = 修为 + 已穿装备加成(按品质) + 已学功法加成(按品质, 运转的1.5倍) */
/** 境界战力换算(与玩家 realmPower 一致: 每小境界100, 大境界权重6/4) */
export function realmPowerOf (level) {
  level = Math.min(Number(level) || 0, REALM_MAX_LEVEL)
  return ((level % 4) + Math.floor(level / 4) * 6) * 100
}
/* ---------- 玩家同款修炼/突破公式(getSubThreshold/getBreakRate 复刻) ---------- */
const IMMORTAL_STEP = 5000
/** 大境界n巅峰累计灵力(与玩家 duel_exercise 一致) */
const getRealmPeak = (n) => {
  const base = 100 * n * (n + 1)
  if (n < 5) return base
  if (n < 10) return 2000 + (base - 2000) * 2
  return Math.round(120000 * Math.pow(1.5, n - 10))
}
/** 突破到 level 级所需累计灵力(与玩家 getSubThreshold 一致) */
export function fakeSubThreshold (level) {
  level = Number(level) || 0
  if (level <= 0) return 0
  if (level > 68) return getRealmPeak(17) + (level - 68) * IMMORTAL_STEP
  const i = Math.floor((level - 1) / 4)
  const step = (level - 1) % 4 + 1
  const prev = i === 0 ? 0 : getRealmPeak(i)
  const peak = getRealmPeak(i + 1)
  return Math.round(prev + (peak - prev) * step / 4)
}
/** 基础突破成功率(与玩家一致: 初始20%, 每大境界-1%, 最低5%) */
export function fakeBreakRate (level) {
  const realmIndex = Math.min(16, Math.max(0, Math.floor((Number(level) - 1) / 4)))
  return Math.max(5, 20 - realmIndex)
}
/** 伪玩家突破成功率(玩家同款: 基础 + 运转功法break加成 + 宗门演武场×2%/级; 散修无演武场) */
export function fakeBreakRateFull (f, p) {
  let rate = fakeBreakRate(p.level)
  const g = p.activeGongfa && GONGFA_TPL[p.activeGongfa]
  if (g && g.fx && g.fx.break) rate += Number(g.fx.break) || 0
  const yanwu = (p.status === 'sect' && p.sect && f.sects[p.sect] && f.sects[p.sect].facilities) ? (f.sects[p.sect].facilities.yanwu || 0) : 0
  rate += yanwu * 2
  return Math.max(5, Math.min(100, rate))
}
/** 伤势扣减/恢复(与 sect_system 玩家 INJURY_PCT/INJURY_RECOVER 一致): 轻/中/重伤 扣20/40/60%战力, 恢复30/120/480分钟 */
const FAKE_INJ_PCT = [0, 20, 40, 60]
const FAKE_INJ_RECOVER_MIN = [0, 30, 120, 480]
/** 伪玩家战力 = 玩家同口径换算: (境界战力 + 装备战力 + 出战灵兽战力) × (功法+丹药)攻击倍率; 负伤按有效伤势扣减(随时间衰减恢复) */
export function personPower (p) {
  const realm = realmPowerOf(p.level)
  const equip = getTotalAttr(p.bag || {}).power
  const pet = p && p.__fakeGid ? getActivePetPower(p.__fakeGid, p.name, 'fake') : 0
  /* 功法攻击倍率(与玩家一致: 运转功法 fx.atk 百分比) */
  let atk = 1
  const g = p.activeGongfa && GONGFA_TPL[p.activeGongfa]
  if (g && g.fx) atk += Number(g.fx.atk) || 0
  /* 丹药buff(与玩家一致: 惊鸿丹攻击+20%等) */
  if (p.pill && p.pill.until > Date.now()) {
    const b = PILL_BUFF[p.pill.name]
    if (b && b.atk) atk += b.atk
  }
  let pw = Math.max(0, Math.round((realm + equip + pet) * atk))
  /* 负伤: 有效伤势等级随时间衰减, 轻/中/重伤 扣20/40/60%战力 — 伪玩家受伤后战力真实下降, 不再"活蹦乱跳" */
  if (p.injury && p.injury.level) {
    const total = FAKE_INJ_RECOVER_MIN[p.injury.level] * 60000
    const el = Date.now() - (p.injury.at || 0)
    if (el >= total) {
      p.injury = null
    } else {
      const eff = Math.max(1, Math.ceil(p.injury.level * (1 - el / total)))
      pw = Math.max(0, Math.round(pw * (1 - FAKE_INJ_PCT[eff] / 100)))
    }
  }
  return pw
}
/** 宗门总战力 = 在世伪玩家战力(修为+装备+功法)和
 *  太上长老平时闭关不参与战力(includeTai=true 才计入, 灭顶之灾出关时用) */
export function sectPower (f, id, includeTai = false) {
  let s = sectAlive(f, id).reduce((a, p) => a + personPower(p), 0)
  if (!includeTai) {
    for (const n of ((f.sectMap[id] && f.sectMap[id].taishang) || [])) {
      const tp = f.roster[n]
      if (tp) s -= personPower(tp)
    }
  }
  return Math.max(0, s)
}
/** 宗门占领小区数 */
export function areaCount (f, id) {
  return Object.values(f.areas).filter(v => v === id).length
}
/** 伪玩家是否正在遗蜕秘境中；秘境内暂停外部行为 */
export function isRealmBusy (p, realmId = null) {
  if (!p || !p.realmBusy) return false
  return !realmId || p.realmBusy.realmId === realmId
}
export function setRealmBusy (f, names, realmId, gid) {
  let changed = false
  for (const name of names || []) {
    const p = f.roster && f.roster[name]
    if (p && p.alive && (!p.realmBusy || p.realmBusy.realmId !== realmId)) {
      p.realmBusy = { realmId: String(realmId), gid: String(gid || f.gid || '') }
      changed = true
    }
  }
  if (changed) saveFake(f, gid || f.gid)
  return changed
}
export function clearRealmBusy (f, names, realmId = null, gid) {
  let changed = false
  for (const name of names || []) {
    const p = f.roster && f.roster[name]
    if (p && p.realmBusy && (!realmId || p.realmBusy.realmId === realmId)) {
      delete p.realmBusy
      changed = true
    }
  }
  if (changed) saveFake(f, gid || f.gid)
  return changed
}
/** 散修列表 */
function scatters (f) { return Object.values(f.roster).filter(p => p.alive && !p.realmBusy && p.status === 'scatter' && !p.servantOf && !isInSectMine(f, p.name)) }

/* ---------- 事件记录 ---------- */
/** 自动归类为大事的事件类型(江湖格局变化) */
const AUTO_MAJOR = new Set(['attack', 'wipe', 'rebuild', 'promote', 'player', 'raid'])
/** 事件元数据: 由人物生成 who/region/sect(供 #天下小事 按人/大区/宗门查询) */
export function evMeta (p) {
  return {
    who: p ? [p.name] : [],
    region: p ? (p.loc || DEFAULT_REGION) : '',
    sect: (p && p.status === 'sect' && p.sect) ? p.sect : ''
  }
}
/** 多人物事件索引: 返回 who/region/sect 片段(单人或数组), 供双人/群体事件入个人事迹 */
function evWho (ps) {
  const list = (Array.isArray(ps) ? ps : [ps]).filter(Boolean)
  const who = list.map(x => x && x.name).filter(Boolean)
  const first = list[0]
  return {
    who,
    region: first ? (first.loc || DEFAULT_REGION) : '',
    sect: (first && first.status === 'sect' && first.sect) ? first.sect : ''
  }
}
/** 大境界子阶数(每大境界4小阶) */
const STAGE_N = 4
/** 修为变化统一入口: 按带上限clamp, 返回是否跨大境界(大事) */
function bumpLevel (p, delta) {
  const band = levelBand(p)
  const oldLv = Number(p.level) || 0
  const newLv = clamp(oldLv + delta, band[0], band[1])
  if (newLv === oldLv) return false
  const oldRealm = Math.floor((oldLv - 1) / STAGE_N)
  const newRealm = Math.floor((newLv - 1) / STAGE_N)
  p.level = newLv
  return newRealm > oldRealm
}
/** 每类事件独立存储上限(大事/小事/每个人/每个宗门 各200条) */
const EV_CAP = 200
/** 压入并保底上限(保留最新 EV_CAP 条) */
const capPush = (arr, ev) => { arr.push(ev); if (arr.length > EV_CAP) arr.splice(0, arr.length - EV_CAP) }
export function logEvent (f, type, txt, t = Date.now(), opts = {}) {
  const major = !!opts.major || AUTO_MAJOR.has(type)
  const who = Array.isArray(opts.who) ? opts.who : (opts.who ? [opts.who] : [])
  const ev = {
    t, type, txt, major, who,
    region: opts.region || '',
    sect: opts.sect || ''
  }
  if (!f.major) f.major = []
  if (!f.minor) f.minor = []
  if (!f.byPerson) f.byPerson = {}
  if (!f.bySect) f.bySect = {}
  f.evSeq = (f.evSeq || 0) + 1
  /* 大事/小事 各自独立200条; onlyPerson 只记个人事迹(#查人), 不进天下大事/小事 */
  if (!opts.onlyPerson) {
    if (major) capPush(f.major, ev)
    else capPush(f.minor, ev)
  }
  /* 每个人独立200条(含该人大事+小事) */
  for (const n of who) {
    if (!f.byPerson[n]) f.byPerson[n] = []
    capPush(f.byPerson[n], ev)
  }
  /* 每个宗门独立200条(含该宗大事+小事) */
  if (ev.sect) {
    if (!f.bySect[ev.sect]) f.bySect[ev.sect] = []
    capPush(f.bySect[ev.sect], ev)
  }
}

const HISTORY_CLEANUP_INTERVAL = 24 * 3600000
const ACTIVE_PERSON_HISTORY_CAP = 100
const DEAD_PERSON_HISTORY_CAP = 20
const DEAD_PERSON_HISTORY_KEEP_MS = 3 * 86400000
/** 陨落记录保留窗口与硬上限(供 #查人 查已故者; 比 byPerson 的 3 天宽, 但不无限增长) */
const DEATH_RECORD_KEEP_MS = 30 * 86400000
const DEATH_RECORD_CAP = 5000

/**
 * 清理天下大事中不会再使用的历史索引。
 * byPerson 的单人数组虽有上限, 但死亡人物的 key 永远不会自动删除, 才是存档膨胀的主因。
 * 死亡摘要仍保留在 deathRecords, 因此旧生平记录可以安全裁剪。
 */
export function cleanupFakeHistory (f, now = Date.now()) {
  if (!f || typeof f !== 'object') return { changed: false, removed: 0, expired: 0 }
  let changed = false
  let removed = 0
  let expired = 0
  const roster = f.roster && typeof f.roster === 'object' ? f.roster : {}
  const deathRecords = f.deathRecords && typeof f.deathRecords === 'object' ? f.deathRecords : {}
  const nextByPerson = {}

  for (const [name, history] of Object.entries(f.byPerson || {})) {
    if (!Array.isArray(history)) {
      changed = true
      removed++
      continue
    }
    let keep = []
    if (roster[name]) {
      keep = history.slice(-ACTIVE_PERSON_HISTORY_CAP)
    } else {
      const deathAt = Number(deathRecords[name] && deathRecords[name].t) || 0
      if (deathAt && now - deathAt <= DEAD_PERSON_HISTORY_KEEP_MS) {
        keep = history.slice(-DEAD_PERSON_HISTORY_CAP)
      }
    }
    if (!keep.length) {
      changed = true
      removed++
      continue
    }
    if (keep.length !== history.length) changed = true
    nextByPerson[name] = keep
  }
  if (changed) f.byPerson = nextByPerson

  const activeSects = new Set(Object.keys(f.sects || {}))
  if (f.bySect && typeof f.bySect === 'object') {
    for (const [sid, history] of Object.entries(f.bySect)) {
      if (!activeSects.has(sid) || !Array.isArray(history)) {
        delete f.bySect[sid]
        changed = true
        removed++
      }
    }
  }

  const pruneExpiryMap = (map) => {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return
    for (const [key, value] of Object.entries(map)) {
      if (!(Number(value) > now)) {
        delete map[key]
        changed = true
        expired++
      }
    }
  }
  pruneExpiryMap(f.poolBans)
  pruneExpiryMap(f.kickBans)
  pruneExpiryMap(f.targetCd)
  pruneExpiryMap(f.ambushRecent)

  if (f.sectLeaveBans && typeof f.sectLeaveBans === 'object') {
    for (const [uid, bans] of Object.entries(f.sectLeaveBans)) {
      if (!bans || typeof bans !== 'object' || Array.isArray(bans)) {
        delete f.sectLeaveBans[uid]
        changed = true
        expired++
        continue
      }
      for (const [sid, until] of Object.entries(bans)) {
        if (!(Number(until) > now)) {
          delete bans[sid]
          changed = true
          expired++
        }
      }
      if (!Object.keys(bans).length) {
        delete f.sectLeaveBans[uid]
        changed = true
      }
    }
  }

  /* 陨落记录(name → 摘要, 供 #查人 查已故者)原先只增不减, 是存档膨胀的长期底噪:
     只保留最近 DEATH_RECORD_KEEP_MS 天, 再硬性封顶 DEATH_RECORD_CAP 条(取最新)。
     注意必须放在上面的 byPerson 循环之后——那里要读 deathRecords 判断 3 天保留窗;
     旧记录删掉后, 对应 byPerson 条目下一轮也会因查不到陨落时间而清掉, 两者一致。 */
  for (const name of Object.keys(deathRecords)) {
    const t = Number(deathRecords[name] && deathRecords[name].t) || 0
    if (!t || now - t > DEATH_RECORD_KEEP_MS) {
      delete deathRecords[name]
      changed = true
      expired++
    }
  }
  const keptDeaths = Object.keys(deathRecords)
  if (keptDeaths.length > DEATH_RECORD_CAP) {
    keptDeaths.sort((a, b) =>
      (Number(deathRecords[b] && deathRecords[b].t) || 0) - (Number(deathRecords[a] && deathRecords[a].t) || 0))
    for (const name of keptDeaths.slice(DEATH_RECORD_CAP)) {
      delete deathRecords[name]
      changed = true
      expired++
    }
  }

  return { changed, removed, expired }
}

/** 最近 hours 小时内的事件(按时间倒序); majorOnly=true 只取大事(独立存储, 各限200条) */
export function recentEvents (f, hours = 24, majorOnly = false) {
  const cut = Date.now() - hours * 3600000
  const src = majorOnly ? (f.major || []) : (f.minor || [])
  return src.filter(x => x.t >= cut).sort((a, b) => b.t - a.t)
}
/** 玩家真实事件写入本群天下大事/小事(如: 散修 玩家名 洗劫藏宝阁/被抓=大事, 摆摊=小事); major=false 时写天下小事 */
export function logPlayerEvent (gid, txt, major = true) {
  try {
    const f = getFake(gid)
    logEvent(f, 'player', txt, Date.now(), { major })
    saveFake(f, gid)
  } catch (err) { }
}
/** Boss 现世/重生写入本群天下大事(独立类型 boss, 不带🌙玩家标识) */
export function logBossEvent (gid, txt) {
  try {
    const f = getFake(gid)
    logEvent(f, 'boss', txt, Date.now(), { major: true })
    saveFake(f, gid)
  } catch (err) { }
}
/** 玩家真实三阁购买写入本群江湖交易(#天下交易 与伪玩家交易同面板); 带 player 标记供展示加🌙 */
export function logPlayerTrade (gid, txt) {
  try {
    const f = getFake(gid)
    if (!f.trades) f.trades = []
    f.trades.push({ t: Date.now(), txt, player: true })
    if (f.trades.length > 500) f.trades = f.trades.slice(-500)
    saveFake(f, gid)
  } catch (err) { }
}

/* 群昵称缓存(10分钟失效): gid:uid -> {name, at} */
const nickCache = {}

/** 获取群昵称(定时任务无e对象, 用Bot.pickGroup; 取不到回退QQ号) */
export async function getNick (gid, uid) {
  const k = `${gid}:${uid}`
  const c = nickCache[k]
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.name
  try {
    const g = Bot.pickGroup(gid)
    if (g && g.getMemberMap) {
      const mm = await g.getMemberMap()
      for (const m of mm) {
        if (String(m[1].user_id) === String(uid)) {
          const n = m[1].card || m[1].nickname || ''
          nickCache[k] = { name: n, at: Date.now() }
          return n
        }
      }
    }
  } catch (err) { }
  nickCache[k] = { name: String(uid), at: Date.now() }
  return String(uid)
}
/** 玩家在江湖的称谓: 检查是否有宗门, 有则 `宗门名 昵称`, 无则 `散修 昵称`
 *  玩家暂未开放加入宗门 → 现恒为散修; 未来开放后在此查玩家宗门数据即可 */
export function playerTitle (gid, uid, nickname) {
  const name = nickname || uid || '修士'
  /* 未来: 玩家加入宗门功能开放后, 在此查玩家宗门数据并返回 `宗门名 ${name}` */
  return `散修 ${name}`
}

/* ---------- 死亡处理 ---------- */
/** 伪玩家死亡: 名字回池; 弟子立即补新人(刚刚踏入修仙界); 管理层职位留空等递补 */
export function killPerson (f, p, txt, t = Date.now()) {
  if (!p || !p.alive) return
  p.alive = false
  const isSect = p.status === 'sect' && p.sect
  const sid = p.sect
  if (isSect) removeFromSectMap(f, sid, p.name)
  /* 死亡记录保留在 roster 删除后, 供 #查人 查询死因 */
  if (!f.deathRecords || typeof f.deathRecords !== 'object') f.deathRecords = {}
  f.deathRecords[p.name] = {
    t,
    txt: String(txt || '').trim(),
    sect: isSect ? sectName(f, sid) : '散修',
    pos: p.pos || '',
    level: p.level || 0,
    path: p.path || '',
    trait: p.trait || ''
  }
  delete f.roster[p.name]
  /* 清理其他在世者仇人名单里对死者的引用, 避免面板(#查人)残留已死之人 */
  for (const op of Object.values(f.roster)) {
    if (!op.alive || !op.relations) continue
    const en = op.relations.enemies
    if (en && en.includes(p.name)) op.relations.enemies = en.filter(n => n !== p.name)
  }
  returnName(f, p.name)
  /* 死亡/被处决名 1 天禁用: 补员(drawName)避开, 避免同名"复活"观感 */
  if (!f.poolBans) f.poolBans = {}
  f.poolBans[p.name] = Date.now() + POOL_BAN_MS
  logEvent(f, 'death', txt, t, evMeta(p))
  if (isSect && p.pos === 'dizi') {
    const n = drawName(f)
    if (n) {
      addPerson(f, n, sid, 'dizi', 1)
      logEvent(f, 'join', `【入宗】${n} 刚刚踏入修仙界，拜入 ${sectName(f, sid)} 为弟子`, t)
    }
  }
}

/* 杀人越货战利品: 把 v 的灵石 + 背包全部物品(装备/丹药/材料/未修炼功法书) + 穿身装备 全部抢到 k 背包; 返回 [战利品描述,...] */
export function robSpoils (f, k, v) {
  const loot = []
  const gold = Math.floor(v.money || 0)
  if (gold > 0) {
    v.money = 0
    k.money = (k.money || 0) + gold
    loot.push(`${gold}灵石`)
  }
  v.bag = ensureFakeBag(v.bag || {})
  k.bag = ensureFakeBag(k.bag || {})
  const source = v.bag
  const target = k.bag
  /* 背包和穿戴中的装备都逐属性组转移，避免随机属性被名称合并后丢失。 */
  for (const [name, raw] of Object.entries(source.items || {})) {
    if (isBound(name)) continue
    const it = raw && typeof raw === 'object' ? raw : { count: itemCount(raw) }
    const groups = EQUIP_TPL[name]
      ? (Array.isArray(it.list) && it.list.length ? it.list : [{ count: itemCount(it), attr: it.attr }])
      : [{ count: itemCount(it), attr: null }]
    for (const g of groups) {
      const count = itemCount(g)
      if (count <= 0) continue
      fakeAddItem(target, name, count, g.attr || null, false)
      loot.push(`${itemIcon(name)}${name}×${count}`)
    }
    delete source.items[name]
  }
  for (const [slot, name] of Object.entries(source.equipped || {})) {
    if (!name || isBound(name)) continue
    const attr = source.equippedAttr && source.equippedAttr[slot]
    source.equipped[slot] = ''
    if (source.equippedAttr) source.equippedAttr[slot] = null
    fakeAddItem(target, name, 1, attr || null, false)
    loot.push(`${itemIcon(name)}${name}×1`)
  }
  autoEquipBest(target)
  return loot
}

/** 人物是否被宗门矿山扣押；矿工不参加普通江湖活动、宗门活动或交易 */
export function isInSectMine (f, name) {
  for (const arr of Object.values(f.sectMines || {})) {
    if ((arr || []).some(x => x && x.name === name)) return true
  }
  return false
}

/* ---------- 事件生成(千奇百怪, 0~4起/小时) ---------- */
function pickAlive (f, except = null) {
  const arr = Object.values(f.roster).filter(p => p.alive && !p.realmBusy && p.name !== except && !isInSectMine(f, p.name))
  return arr.length ? pick(arr) : null
}
function pickBy (f, pred) {
  const arr = Object.values(f.roster).filter(p => p.alive && !p.realmBusy && !isInSectMine(f, p.name) && pred(p))
  return arr.length ? pick(arr) : null
}
function otherSect (f, id) {
  const ids = Object.keys(f.sects).filter(x => x !== id)
  return ids.length ? pick(ids) : null
}
/** 受害者加权挑选(修仙世界: 软柿子+肥羊): 散修无宗门庇护×3(杀了白杀), 身家越厚越易被盯上(财不外露), 背包越鼓越招祸 */
function pickVictim (f, except = null) {
  const cand = [...scatters(f), ...Object.values(f.roster).filter(p => p.alive && !p.realmBusy && p.status === 'sect' && p.name !== except && !isInSectMine(f, p.name))].filter(p => p.name !== except)
  if (!cand.length) return null
  const w = cand.map(p => {
    let w0 = p.status === 'sect' && p.sect ? 1 : 3
    w0 *= 1 + (Number(p.money) || 0) / 5000 // 身家越厚越易被劫
    const bagN = p.bag && p.bag.items ? Object.keys(p.bag.items).length : 0
    w0 *= 1 + bagN / 5 // 背包越鼓越招祸
    return { p, w0 }
  })
  const total = w.reduce((a, x) => a + x.w0, 0)
  let r = Math.random() * total
  for (const x of w) { r -= x.w0; if (r <= 0) return x.p }
  return w[0].p
}
/** 是否下杀手: 散修易被灭口(无靠山); 宗门弟子除非穷凶极恶(嗜杀/魔道)否则只抢不杀(杀=结仇) */
function shouldKill (f, k, v) {
  const evil = k.path === '魔道' || k.trait === '嗜杀'
  if (v && v.status === 'sect' && v.sect) return evil && Math.random() < 0.4
  return Math.random() < (evil ? 0.5 : 0.3)
}
/** 击杀宗门弟子 = 与对方全宗结仇(同门/好友记入双方仇人名单, 驱动复仇/仇杀/和解) */
function createKillGrudge (f, k, v) {
  if (!k || !v || v.status !== 'sect' || !v.sect) return
  if (!k.relations) k.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], confidants: [], kin: [] }
  if (!v.relations) v.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], confidants: [], kin: [] }
  const mates = sectAlive(f, v.sect).map(p => p.name).filter(n => n !== v.name)
  const kin = [...new Set([...mates, ...(v.relations.friends || []), ...(v.relations.confidants || []), ...(v.relations.kin || [])])]
  for (const n of kin) {
    const p = f.roster[n]
    if (!p || !p.alive) continue
    if (!p.relations) p.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], confidants: [], kin: [] }
    if (!p.relations.enemies.includes(k.name)) p.relations.enemies.push(k.name)
    if (!k.relations.enemies.includes(p.name)) k.relations.enemies.push(p.name)
  }
}
/** 杀人(带结仇): 先结仇再击杀; 杀孽业障累积(因果缠身, 杀宗门弟子罪孽更重) */
function killWithGrudge (f, k, v, txt, t) {
  createKillGrudge(f, k, v)
  k.kills = (k.kills || 0) + 1
  k.sin = (k.sin || 0) + (v && v.status === 'sect' && v.sect ? 2 : 1)
  killPerson(f, v, txt, t)
}
/** 关系池(驱动行为的词条): 挚友/知己/手足/亲族/道侣/师父/徒弟/师兄弟 + 可选同门; 返回在世的名字列表(不含自己) */
function relPoolOf (f, a, includeSectMate = true) {
  const r = (a && a.relations) || {}
  const pool = new Set()
  for (const n of [].concat(r.friends || [], r.confidants || [], r.siblings || [], r.kin || [], r.spouse ? [r.spouse] : [], r.master ? [r.master] : [], r.disciples || [])) {
    if (n && n !== a.name && f.roster[n] && f.roster[n].alive) pool.add(n)
  }
  /* 师兄弟: 师父的其他弟子(可能已不同宗) */
  if (r.master && f.roster[r.master] && (f.roster[r.master].relations || {}).disciples) {
    for (const n of f.roster[r.master].relations.disciples) {
      if (n !== a.name && f.roster[n] && f.roster[n].alive) pool.add(n)
    }
  }
  if (includeSectMate && a.status === 'sect' && a.sect) {
    for (const p of sectAlive(f, a.sect)) if (p.name !== a.name) pool.add(p.name)
  }
  return [...pool]
}
/** 关系标签(查人/互动用): 道侣/知己/手足/师父/徒弟/挚友/师兄弟/同门/故人 */
function relLabelOf (f, a, bName) {
  const r = (a && a.relations) || {}
  const b = f.roster[bName]
  if (r.spouse === bName) return '道侣'
  if ((r.confidants || []).includes(bName)) return '知己'
  if ((r.siblings || []).includes(bName)) return '手足'
  if (r.master === bName) return '师父'
  if ((r.disciples || []).includes(bName)) return '徒弟'
  if (b && b.relations && b.relations.master === a.name) return '徒弟'
  if ((r.friends || []).includes(bName)) return '挚友'
  if (r.master && f.roster[r.master] && (f.roster[r.master].relations || {}).disciples && f.roster[r.master].relations.disciples.includes(bName)) return '师兄弟'
  if (a.status === 'sect' && a.sect && b && b.status === 'sect' && a.sect === b.sect) return '同门'
  return '故人'
}

/* 1.切磋 */
function genFight (f, t) {
  const a = pickAlive(f)
  if (!a) return null
  const b = pickAlive(f, a.name)
  if (!b) return null
  a.lastFight = t; b.lastFight = t
  const win = Math.random() < 0.5 ? a : b
  win.kills = (win.kills || 0) + 1
  const place = pick(['山门前', '演武场', '秘境入口', '集市', '论道台'])
  return { type: 'fight', ...evWho([a, b]), txt: `【切磋】${a.name} 与 ${b.name} 于${place}切磋，${win.name} 技高一筹` }
}
/* 2.仇杀(嗜杀/好斗/魔修; 优先仇人, 其次异宗) */
function genMurder (f, t) {
  const k = pickBy(f, p => p.trait === '嗜杀' || p.trait === '好斗')
  if (!k) return null
  let v = null
  const enemies = (k.relations && k.relations.enemies) || []
  if (enemies.length) v = pickBy(f, p => p.alive && p.name !== k.name && enemies.includes(p.name))
  if (!v) v = pickBy(f, p => p.alive && p.name !== k.name && (!p.sect || p.sect !== k.sect))
  if (!v) v = pickAlive(f, k.name)
  if (!v) return null
  k.kills = (k.kills || 0) + 1
  killPerson(f, v, `【仇杀】${k.name} 出手狠辣，${v.name} 命丧其手`, t)
  return null
}
/* 3.杀人越货→叛徒(散修或投他宗) */
export function genRobKill (f, t) {
  const k = pickBy(f, p => p.trait === '嗜杀' || p.path === '魔道')
  if (!k) return null
  let v = null
  /* 有一定概率对好友下黑手(好友也可能背叛) */
  const friends = ((k.relations && k.relations.friends) || []).concat((k.relations && k.relations.confidants) || []).filter(n => f.roster[n] && f.roster[n].alive)
  if (friends.length && Math.random() < 0.25) v = f.roster[pick(friends)]
  if (!v) v = pickVictim(f, k.name)
  if (!v) return null
  const wasSect = k.status === 'sect' && k.sect
  const oldSect = k.sect
  const oldSectName = wasSect ? sectName(f, oldSect) : ''
  /* 境界/战力不敌目标时，杀人越货失败，不能越级强杀 */
  if (personPower(k) < personPower(v)) {
    const whoK = wasSect ? oldSectName : '散修'
    const whoV = v.status === 'sect' && v.sect ? sectName(f, v.sect) : '散修'
    return { type: 'fight', ...evWho([k, v]), txt: `【杀人越货】${whoK} ${k.name} 试图劫杀 ${whoV} ${v.name}，却因境界/战力不足被击退` }
  }
  /* 杀人越货: 先把对方灵石/装备(含穿身)/未修炼的功法书全抢到自己背包 */
  const loot = robSpoils(f, k, v)
  const lootTxt = loot.length ? `，劫得 ${loot.join('、')}` : ''
  killWithGrudge(f, k, v, `【杀人越货】${k.name} 劫掠并杀害了 ${v.name}${lootTxt}`, t)
  if (!wasSect) return null
  /* 管理层: 宗主杀人越货永不叛逃(宗门即己身); 太上/副宗平时不叛, 仅宗门严重衰落/忠诚极低(离心)时才有极低概率弃宗(凡事不绝对) */
  if (k.pos === 'zongzhu') return null
  if (k.pos === 'taishang' || k.pos === 'fuzong') {
    if (!leaderRootless(f, k)) return null
    if (Math.random() >= 0.15) return null
  }
  removeFromSectMap(f, oldSect, k.name)
  if (Math.random() < 0.5) {
    k.status = 'scatter'; k.sect = null; k.pos = null
    return { type: 'betray', ...evMeta(k), txt: `【叛逃】${k.name} 杀人越货后叛出${oldSectName}，沦为散修` }
  }
  const target = otherSect(f, oldSect)
  if (target && f.sectMap[target] && f.sectMap[target].zongzhu) {
    k.sect = target; k.pos = 'dizi'; k.status = 'sect'
    k.level = clamp(k.level, POS.dizi.band[0], POS.dizi.band[1]) // 入宗修为收敛到弟子带
    f.sectMap[target].dizi.push(k.name)
    return { type: 'betray', ...evMeta(k), txt: `【叛逃】${k.name} 杀人越货后叛出${oldSectName}，转投${sectName(f, target)}` }
  }
  k.status = 'scatter'; k.sect = null; k.pos = null
  return { type: 'betray', ...evMeta(k), txt: `【叛逃】${k.name} 杀人越货后叛出${oldSectName}，沦为散修` }
}
/* 4.暴毙(职位留空) */
function genSuddenDeath (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  const posCn = p.status === 'sect' ? POS[p.pos].cn : '散修'
  killPerson(f, p, `【暴毙】${p.name} 突然暴毙${p.status === 'sect' ? `，${sectName(f, p.sect)}${posCn}之位悬空` : '，客死他乡'}`, t)
  return null
}
/** 宗门弟子上限: 20 + 演武场等级×10(伪玩家与玩家宗门一致, 升级演武场扩容) */
export function sectCap (f, sid) {
  const s = f.sects && f.sects[sid]
  const yanwu = (s && s.facilities && s.facilities.yanwu) || 0
  return SECT_TARGET + yanwu * 10
}
/** 宗门是否超员(在世成员数 > 上限): 超员后弟子更容易离宗/叛宗 */
function isSectOver (f, id) {
  return !!id && sectAlive(f, id).length > sectCap(f, id)
}
/** 是否有同宗羁绊(师父/道侣/知己/手足/徒弟/挚友在宗内): 羁绊越深越不愿离开 */
function hasBondInSect (f, p) {
  if (!p || p.status !== 'sect' || !p.sect) return false
  const r = p.relations || {}
  const names = [].concat(r.master ? [r.master] : [], r.spouse ? [r.spouse] : [], r.confidants || [], r.siblings || [], r.disciples || [], r.friends || []).filter(Boolean)
  return names.some(n => f.roster[n] && f.roster[n].alive && f.roster[n].sect === p.sect)
}
/** 管理层"离心"(凡事不绝对): 宗门严重衰落(兴衰≤25→人心思变×1.6)或忠诚极低(<25)时, 太上/副宗也可能弃宗/叛逃/出走——但极罕见; 宗主是宗门根基, 永不弃宗 */
function leaderRootless (f, p) {
  if (!p || !p.sect) return false
  const st = sectStability(f, p.sect)
  const loy = Number(p.loyalty) >= 0 ? (p.loyalty || 0) : 60
  return st >= 1.4 || loy < 25
}
/* 宗门超员结算: 每分钟按超员人数累积概率, 让弟子离宗/叛宗(超员越狠概率越高, 封顶85%); 优先挤走无同宗羁绊者 */
function overCapSettle (f, now = Date.now()) {
  for (const id of Object.keys(f.sects || {})) {
    const s = f.sects[id]
    if (!s) continue
    const alive = sectAlive(f, id)
    const over = alive.length - sectCap(f, id)
    if (over <= 0) continue
    const p = Math.min(0.85, 0.15 * over)
    if (Math.random() >= p) continue
    /* 超员挤走只挤弟子/执事, 管理层(宗主/太上/副宗)不会被挤走 */
    let cands = alive.filter(x => !x.servantOf && !isInSectMine(f, x.name) && x.pos !== 'zongzhu' && x.pos !== 'taishang' && x.pos !== 'fuzong' && !hasBondInSect(f, x))
    if (!cands.length) cands = alive.filter(x => !x.servantOf && !isInSectMine(f, x.name) && x.pos !== 'zongzhu' && x.pos !== 'taishang' && x.pos !== 'fuzong')
    if (!cands.length) continue
    const p2 = cands[Math.floor(Math.random() * cands.length)]
    const old = sectName(f, id)
    removeFromSectMap(f, id, p2.name)
    /* 性格恶劣/概率 → 叛宗(可能转投他宗); 否则离宗 */
    const betray = p2.trait === '好斗' || p2.trait === '嗜杀' || Math.random() < 0.4
    if (betray && Math.random() < 0.6) {
      const target = otherSect(f, id)
      if (target && f.sectMap[target] && f.sectMap[target].zongzhu) {
        p2.sect = target; p2.pos = 'dizi'; p2.status = 'sect'
        p2.level = clamp(p2.level, POS.dizi.band[0], POS.dizi.band[1])
        f.sectMap[target].dizi.push(p2.name)
        logEvent(f, 'betray', `【叛宗】${p2.name} 因${old}人满为患，叛出并转投${sectName(f, target)}`, now, evMeta(p2))
        continue
      }
    }
    p2.status = 'scatter'; p2.sect = null; p2.pos = null
    logEvent(f, betray ? 'betray' : 'leave', betray ? `【叛宗】${p2.name} 因${old}人满为患，叛出宗门沦为散修` : `【离宗】${p2.name} 因${old}人满为患，收拾行囊离开`, now, evMeta(p2))
  }
}
/* 5.叛逃(离宗→散修/转宗; 有同宗羁绊者叛逃概率大降) */
function genBetray (f, t) {
  const p = pickBy(f, x => {
    /* 宗主永不叛逃(宗门即己身); 太上/副宗平时不叛逃, 仅宗门严重衰落/忠诚极低(离心)时才有极低概率叛逃(凡事不绝对) */
    if (x.servantOf || isInSectMine(f, x.name) || x.status !== 'sect' || x.pos === 'zongzhu') return false
    if ((x.pos === 'taishang' || x.pos === 'fuzong') && !leaderRootless(f, x)) return false
    const over = isSectOver(f, x.sect)
    const bond = hasBondInSect(f, x)
    const st = sectStability(f, x.sect) // 宗门兴衰影响人心: 衰落更想走, 兴旺更愿留
    const lead = (x.pos === 'taishang' || x.pos === 'fuzong') ? 0.15 : 1 // 身居高位者即便离心, 叛逃也极罕见
    if (x.trait === '好斗' || x.trait === '嗜杀') return bond ? Math.random() < 0.4 * st * lead : Math.random() < 0.85 * st * lead
    return Math.random() < (over ? 0.9 : 0.3) * (bond ? 0.3 : 1) * st * lead
  })
  if (!p) return null
  const old = sectName(f, p.sect)
  const sid = p.sect
  removeFromSectMap(f, sid, p.name)
  if (Math.random() < 0.6) {
    p.status = 'scatter'; p.sect = null; p.pos = null
    return { type: 'betray', ...evMeta(p), txt: `【叛逃】${p.name} 与宗门不和，叛出${old}，沦为散修` }
  }
  const target = otherSect(f, sid)
  if (target && f.sectMap[target].zongzhu) {
    p.sect = target; p.pos = 'dizi'; p.status = 'sect'
    p.level = clamp(p.level, POS.dizi.band[0], POS.dizi.band[1]) // 入宗修为收敛到弟子带
    f.sectMap[target].dizi.push(p.name)
    return { type: 'betray', ...evMeta(p), txt: `【叛逃】${p.name} 叛出${old}，转投${sectName(f, target)}` }
  }
  p.status = 'scatter'; p.sect = null; p.pos = null
  return { type: 'betray', ...evMeta(p), txt: `【叛逃】${p.name} 叛出${old}，沦为散修` }
}
/* 6.离宗(不开心/超员; 有同宗羁绊者更愿留下) */
function genLeave (f, t) {
  const p = pickBy(f, x => {
    if (x.servantOf || isInSectMine(f, x.name) || x.status !== 'sect' || x.pos !== 'dizi') return false
    const over = isSectOver(f, x.sect)
    const bond = hasBondInSect(f, x)
    const st = sectStability(f, x.sect) // 宗门兴衰影响人心: 衰落更想走, 兴旺更愿留
    return Math.random() < (over ? 0.95 : 0.5) * (bond ? 0.3 : 1) * st
  })
  if (!p) return null
  const old = sectName(f, p.sect)
  removeFromSectMap(f, p.sect, p.name)
  p.status = 'scatter'; p.sect = null; p.pos = null
  return { type: 'leave', ...evMeta(p), txt: `【离宗】${p.name} 在${old}待得不开心，收拾行囊离开了` }
}
/* 7.散修入宗 */
function genScatterJoin (f, t) {
  const sc = scatters(f)
  if (!sc.length) return null
  /* 按入宗意愿加权挑散修(愿意的更可能主动入宗: 平和/苦修积极, 嗜杀/贪玩懒散难招) */
  const total = sc.reduce((a, p) => a + joinWilling(p), 0) || 1
  let r = Math.random() * total
  let pickP = sc[0]
  for (const p of sc) { r -= joinWilling(p); if (r <= 0) { pickP = p; break } }
  /* 挑一个可入的宗门(含玩家宗门, 直接进; 排除有仇人/被逐出2天的; 正邪偏好) */
  const target = pickSectFor(f, pickP.name)
  if (!target) return null
  const ts = f.sects[target]
  const ev = fakeJoinSect(f, pickP.name, target)
  if (!ev) return null
  return { type: 'join', ...evMeta(pickP), txt: `【散修入宗】${pickP.path === '魔道' ? '魔修' : '散修'} ${pickP.name} 被${ts.name}收编为弟子` }
}
/* 新弟子归属感: 入宗<48h 的新弟子更容易与同门结为师兄弟/挚友/道侣, 增强归属感(降低离宗/被挖) */
function genWelcome (f, t) {
  const fresh = Object.values(f.roster).filter(p => p.alive && !p.realmBusy && !p.servantOf && !isInSectMine(f, p.name) && p.status === 'sect' && p.sect && (t - (p.joinAt || t)) < 48 * 3600000 && p.pos === 'dizi')
  if (!fresh.length) return null
  const a = pick(fresh)
  const mates = sectAlive(f, a.sect).filter(p => p.name !== a.name)
  if (!mates.length) return null
  if (Math.random() < 0.35) return null // 部分新弟子低调修行
  const b = pick(mates)
  const ra = a.relations || (a.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], confidants: [], siblings: [], kin: [] })
  const rb = b.relations || (b.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], confidants: [], siblings: [], kin: [] })
  const whoA = sectName(f, a.sect)
  const kind = Math.random()
  if (kind < 0.5) {
    /* 义结金兰 → 师兄弟/手足 */
    if ((ra.siblings || []).includes(b.name)) return null
    if (!ra.siblings) ra.siblings = []
    if (!rb.siblings) rb.siblings = []
    ra.siblings.push(b.name); rb.siblings.push(a.name)
    if (!ra.kin.includes(b.name)) ra.kin.push(b.name)
    if (!rb.kin.includes(a.name)) rb.kin.push(a.name)
    return { type: 'flavor', ...evWho([a, b]), txt: `【结缘】${whoA} 新弟子 ${a.name} 拜入山门，与 ${b.name} 一见如故，义结金兰结为异姓手足` }
  }
  if (kind < 0.8) {
    /* 结为挚友 */
    if ((ra.friends || []).includes(b.name)) return null
    if (!ra.friends) ra.friends = []
    if (!rb.friends) rb.friends = []
    ra.friends.push(b.name); rb.friends.push(a.name)
    return { type: 'flavor', ...evWho([a, b]), txt: `【结缘】${whoA} 新弟子 ${a.name} 与 ${b.name} 同门情深，结为挚友` }
  }
  /* 日久生情 → 道侣 */
  if (ra.spouse || rb.spouse || ra.master === b.name || rb.master === a.name || (ra.disciples || []).includes(b.name) || (rb.disciples || []).includes(a.name)) return null
  ra.spouse = b.name; rb.spouse = a.name
  return { type: 'flavor', ...evWho([a, b]), txt: `【结缘】${whoA} 新弟子 ${a.name} 与 ${b.name} 日久生情，结为道侣` }
}
/* 灭门复仇: 幸存者寻仇(劫道/打劫/激战/击杀仇人; 仇人皆亡或放下恩怨则释然) */
function genVendetta (f, t) {
  const av = pickBy(f, p => p.alive && p.vendetta)
  if (!av) return null
  const v = av.vendetta || {}
  const enemies = ((av.relations && av.relations.enemies) || []).filter(n => n !== av.name && f.roster[n] && f.roster[n].alive)
  if (enemies.length) {
    const target = f.roster[pick(enemies)]
    const whoA = av.status === 'sect' && av.sect ? sectName(f, av.sect) : '散修'
    const act = Math.random()
    if (act < 0.35) {
      /* 劫道打劫 */
      const loot = robSpoils(f, av, target)
      const lootTxt = loot.length ? `，劫走 ${loot.join('、')}` : ''
      return { type: 'fight', ...evWho([av, target]), txt: `【寻仇】${whoA} ${av.name} 为${v.sectName || '故宗'}覆灭之仇劫道${target.name}${lootTxt}` }
    }
    if (act < 0.6) {
      /* 手刃仇人, 大仇得报 */
      av.kills = (av.kills || 0) + 1
      killWithGrudge(f, av, target, `【寻仇】${whoA} ${av.name} 手刃${v.sectName || '故宗'}之仇人 ${target.name}，大仇得报`, t)
      av.vendetta = null
      return null
    }
    return { type: 'fight', ...evWho([av, target]), txt: `【寻仇】${whoA} ${av.name} 为${v.sectName || '故宗'}覆灭之仇，与 ${target.name} 激战一场` }
  }
  /* 仇人皆亡/无仇人: 一半发奋重建, 一半放下恩怨 */
  if (Math.random() < 0.5) {
    av.vendetta = null
    return { type: 'flavor', ...evMeta(av), txt: `【释然】${av.name} 淡看${v.sectName || '故宗'}覆灭之仇，放下恩怨重新修行` }
  }
  return null
}
/* 散修开宗立派(无地盘的散修也能建宗): 开宗者就任宗主, 拉兄弟好友/旧同门/投缘散修一起入伙; 新宗暂无地盘 */
function genScatterFoundSect (f, t) {
  /* 有灭门宗门时暂停散修开宗: 灭门空位留给玩家立即建, 伪玩家重建等30分钟 */
  if (Object.values(f.sects || {}).some(s => s && s.wipeAt)) return null
  const aiCnt = Object.values(f.sects || {}).filter(s => s && !s.owner && !s.wipeAt).length
  if (aiCnt >= FAKE_SECT_MAX) return null
  const sc = scatters(f).filter(x => (x.level || 0) >= 8)
  if (!sc.length) return null
  if (Math.random() < 0.5) return null
  const p = pick(sc)
  const name = drawSectName(f)
  if (!name) return null
  f.sectSeq = (f.sectSeq || 0) + 1
  const id = 'sect_' + f.sectSeq
  const now = t || Date.now()
  f.sects[id] = {
    name, foundedAt: now, wipeAt: 0, rebuildAt: 0,
    recruit: { next: now + rand([0, 4]) * 3600000 },
    facilities: { yanwu: 0, hushan: 0, lingmai: 0, yaoyuan: 1 },
    vault: { stones: 50000, mats: {}, pills: {} },
    owner: null, enemies: [], allies: [], region: p.loc || DEFAULT_REGION, createdAt: 0
  }
  f.sectMap[id] = { zongzhu: null, fuzong: [], taishang: [], zhishi: [], dizi: [] }
  /* 开宗者本人就任宗主 */
  p.sect = id; p.pos = 'zongzhu'; p.status = 'sect'
  f.sectMap[id].zongzhu = p.name
  /* 拉兄弟好友/旧同门(在世散修优先)一起入伙 */
  const r = p.relations || {}
  const kin = [].concat(r.friends || [], r.confidants || [], r.siblings || [], r.kin || [],
    r.master ? [r.master] : [], r.disciples || [])
  const mates = new Set(kin.filter(n => f.roster[n] && f.roster[n].alive && f.roster[n].status === 'scatter'))
  const joinTxt = []
  for (const nm of mates) {
    const q = f.roster[nm]
    q.sect = id; q.pos = 'dizi'; q.status = 'sect'
    q.level = clamp(q.level, POS.dizi.band[0], POS.dizi.band[1])
    f.sectMap[id].dizi.push(q.name)
    joinTxt.push(q.name)
  }
  /* 再拉若干投缘散修凑足门庭 */
  const extra = scatters(f).filter(x => x.name !== p.name && !mates.has(x.name)).slice(0, rand([1, 3]))
  for (const q of extra) {
    q.sect = id; q.pos = 'dizi'; q.status = 'sect'
    q.level = clamp(q.level, POS.dizi.band[0], POS.dizi.band[1])
    f.sectMap[id].dizi.push(q.name)
    joinTxt.push(q.name)
  }
  return { type: 'rebuild', ...evMeta(p), who: [p.name, ...joinTxt],
    txt: `【开宗】散修 ${p.name} 于${regionNameOf(p.loc || DEFAULT_REGION)}开宗立派，创立【${name}】！${joinTxt.length ? `${joinTxt.join('、')} 一同入伙` : ''}` }
}
/* 8.收养遗孤(新弟子入宗) */
function genAdopt (f, t) {
  const ids = Object.keys(f.sects).filter(id => f.sectMap[id] && f.sectMap[id].zongzhu && sectAlive(f, id).length < sectCap(f, id))
  if (!ids.length) return null
  const target = pick(ids)
  const n = drawName(f)
  if (!n) return null
  addPerson(f, n, target, 'dizi', 1)
  return { type: 'join', who: f.roster[n] ? [f.roster[n].name] : [], txt: `【入宗】${n} 刚刚踏入修仙界，拜入 ${sectName(f, target)} 为弟子` }
}
/* 9.奇遇(灵力大涨, 修为只走玩家修炼→突破体系) */
function genFortune (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  const gain = rand([50, 150])
  addExp(p, gain)
  return { type: 'fortune', ...evMeta(p), txt: `【奇遇】${p.name} 于秘境得奇遇，灵力大涨（+${gain}）` }
}
/* 10.闭关突破(玩家体系: 灵力达标 getSubThreshold 才能尝试突破, 成功率同玩家) */
async function genBreakthrough (f, t) {
  const now = Date.now() // 冷却必须用真实时间(fakeTick传入的t是过去事件时间戳,用它冷却永不满足)
  const p = pickBy(f, x => x.status === 'sect' && now >= ((x.activities || {}).lastBreak2 || 0))
  if (!p) return null
  return await breakPerson(f, p)
}
/** 指定宗门成员闭关突破(灵力达标 → 连续突破直到灵力不足/到巅峰/失败; 破障丹或买得起则本次90%突破; 成功跨大境界为大事) */
export async function breakPerson (f, p) {
  const now = Date.now()
  if (!p.activities) p.activities = {}
  p.activities.lastBreak2 = now // 突破无冷却(灵力达标即可反复尝试/连续突破)
  const band = levelBand(p)
  if (p.level >= band[1]) return null // 巅峰不产事件
  if ((p.exp || 0) < fakeSubThreshold(p.level + 1)) return null // 灵力不足不产事件
  /* 有破障丹 → 服丹(本次90%); 没有且有钱 → 自动从丹阁买(玩家一致); 否则用基础成功率(功法+演武场) */
  let usedPill = false
  if (p.bag && p.bag.items && itemCount(p.bag.items['破障丹']) > 0) {
    fakeTakeItem(p.bag, '破障丹')
    usedPill = true
  } else if (await buyPillForBreak(f, p)) {
    usedPill = true
  }
  /* 灵力达标 → 连续突破(每次成功后若灵力仍够下一级则继续), 直到灵力不足/到巅峰/失败 */
  const oldRealm = Math.floor((p.level - 1) / 4)
  let up = 0
  let guard = 0
  while (p.level < band[1] && (p.exp || 0) >= fakeSubThreshold(p.level + 1) && guard < 50) {
    guard++
    const rate = (usedPill && up === 0) ? 90 : fakeBreakRateFull(f, p) // 破障丹只保第一次突破
    if (Math.random() * 100 > rate) break
    p.level++
    mergeAccum(p) // 突破并入累计池
    up++
  }
  if (up <= 0) {
    /* 突破失败静默(灵力仍在, 下小时再试; 不刷失败事件) */
    return null
  }
  const major = Math.floor((p.level - 1) / 4) > oldRealm
  const txt = usedPill
    ? (up > 1 ? `【突破】${p.name} 服下${itemIcon('破障丹')}破障丹势如破竹，连破 ${up} 重天，直达${levelNameOf(p.level)}！` : `【突破】${p.name} 服下${itemIcon('破障丹')}破障丹，冲破瓶颈，突破至${levelNameOf(p.level)}！`)
    : (up > 1 ? `【突破】${p.name} 闭关苦修厚积薄发，连破 ${up} 重天，直达${levelNameOf(p.level)}！` : `【突破】${p.name} 闭关苦修，成功突破至${levelNameOf(p.level)}`)
  return { type: 'break', major, ...evMeta(p), txt }
}
/* 11.走火入魔(纯剧情, 灵力只增不减与玩家一致) */
function genBackfire (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  return { type: 'backfire', ...evMeta(p), txt: `【走火入魔】${p.name} 修炼时走火入魔，气血翻涌（幸未伤及修为）` }
}
/* 12.渡劫(灵力只增不减与玩家一致: 成功加灵力, 失败纯剧情) */
function genTribulation (f, t) {
  const p = pickBy(f, x => x.level >= 36)
  if (!p) return null
  if (Math.random() < 0.55) {
    const gain = rand([100, 300])
    addExp(p, gain)
    return { type: 'break', ...evMeta(p), txt: `【渡劫】${p.name} 引来天劫，成功渡劫，灵力大进（+${gain}）` }
  }
  return { type: 'backfire', ...evMeta(p), txt: `【渡劫】${p.name} 渡劫失败，元气大伤（修养后再战）` }
}
/* 13.收徒(真实关系链: 师父修为≥徒弟1~4大境界(4~16级)才合情合理, 不会出现人仙收筑基徒) */
function genDisciple (f, t) {
  const p = pickBy(f, x => x.level >= 17)
  if (!p) return null
  const n = pickAlive(f)
  if (!n || n.name === p.name) return null
  const gap = p.level - n.level
  if (gap < 4 || gap > 16) return null // 修为差须在1~4大境界之间(太高/太低都不合理)
  if (n.relations.master) return null // 已有师父
  if ((p.relations.disciples || []).length >= 3) return null
  n.relations.master = p.name
  p.relations.disciples.push(n.name)
  return { type: 'flavor', ...evWho([p, n]), txt: `【收徒】${p.name} 见${n.name}根骨清奇，收其为亲传弟子` }
}
/* 13b.兄弟姐妹(同辈结拜/血亲: 修为接近(差≤2大境界), 非同门师徒/道侣/已有手足) */
function genSibling (f, t) {
  const a = pickAlive(f)
  if (!a) return null
  const cands = Object.values(f.roster).filter(p => p.alive && !p.realmBusy && p.name !== a.name && Math.abs((p.level || 0) - (a.level || 0)) <= 8)
  if (!cands.length) return null
  const b = pick(cands)
  const ra = a.relations || (a.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], confidants: [], siblings: [], kin: [] })
  const rb = b.relations || (b.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], confidants: [], siblings: [], kin: [] })
  if (ra.spouse === b.name || rb.spouse === a.name) return null
  if (ra.master === b.name || rb.master === a.name) return null
  if ((ra.disciples || []).includes(b.name) || (rb.disciples || []).includes(a.name)) return null
  if ((ra.siblings || []).includes(b.name)) return null
  if (!ra.siblings) ra.siblings = []
  if (!rb.siblings) rb.siblings = []
  ra.siblings.push(b.name)
  rb.siblings.push(a.name)
  if (!ra.kin.includes(b.name)) ra.kin.push(b.name)
  if (!rb.kin.includes(a.name)) rb.kin.push(a.name)
  const sameSect = a.status === 'sect' && a.sect && a.sect === b.sect
  const whoA = a.status === 'sect' && a.sect ? sectName(f, a.sect) : '散修'
  return { type: 'flavor', ...evWho([a, b]), txt: `【手足】${whoA} ${a.name} 与 ${b.name} ${sameSect ? '本为同门，义结金兰结为兄弟姐妹' : '义结金兰，结为异姓兄弟姐妹'}，情同手足` }
}
/* 13c.师徒互动(师徒关系驱动: 师父传功指点 / 徒弟孝敬师父) */
function genTeacherDisciple (f, t) {
  const a = pickBy(f, p => p.alive && p.relations && ((p.relations.master && f.roster[p.relations.master] && f.roster[p.relations.master].alive) || ((p.relations.disciples || []).some(n => f.roster[n] && f.roster[n].alive))))
  if (!a) return null
  const r = a.relations
  const hasMaster = r.master && f.roster[r.master] && f.roster[r.master].alive
  const dNames = (r.disciples || []).filter(n => f.roster[n] && f.roster[n].alive)
  const whoA = a.status === 'sect' && a.sect ? sectName(f, a.sect) : '散修'
  if (dNames.length && Math.random() < 0.6) {
    /* 师父传功/指点徒弟 */
    const dName = pick(dNames)
    const d = f.roster[dName]
    const gain = rand([40, 120])
    addExp(d, gain)
    return { type: 'flavor', ...evWho([a, d]), txt: `【传功】${whoA} ${a.name} 指点爱徒 ${dName} 修行，${dName} 灵力精进（+${gain}）` }
  }
  if (!hasMaster) return null
  /* 徒弟孝敬师父(送灵石/物品) */
  const m = f.roster[r.master]
  const whoM = m.status === 'sect' && m.sect ? sectName(f, m.sect) : '散修'
  if (Math.random() < 0.5) {
    const gold = Math.min((a.money || 0), rand([100, 600]))
    if (gold <= 0) return null
    a.money -= gold
    m.money = (m.money || 0) + gold
    return { type: 'flavor', ...evWho([a, m]), txt: `【孝敬】${whoA} ${a.name} 将 ${gold} 灵石孝敬给师父 ${whoM} ${r.master}` }
  }
  const items = a.bag && a.bag.items ? Object.keys(a.bag.items) : []
  if (!items.length) return null
  const item = pick(items)
  fakeTakeItem(a.bag, item)
  if (!m.bag) m.bag = { items: {}, equipped: {} }
  fakeAddItem(m.bag, item, 1)
  return { type: 'flavor', ...evWho([a, m]), txt: `【孝敬】${whoA} ${a.name} 将【${item}】孝敬给师父 ${whoM} ${r.master}` }
}
/* 14.结怨(真实关系链: 互为仇人; 正魔相遇正邪不两立必结仇) */
function genGrudge (f, t) {
  const a = pickAlive(f)
  if (!a) return null
  const b = pickAlive(f, a.name)
  if (!b) return null
  a.lastFight = t
  if (!a.relations.enemies.includes(b.name)) a.relations.enemies.push(b.name)
  if (!b.relations.enemies.includes(a.name)) b.relations.enemies.push(a.name)
  if (a.path !== b.path) {
    return { type: 'grudge', ...evWho([a, b]), txt: `【结怨】${a.name}（${a.path}）与 ${b.name}（${b.path}）正邪不两立，狭路相逢结下死仇` }
  }
  return { type: 'grudge', ...evWho([a, b]), txt: `【结怨】${a.name} 与 ${b.name} 因争夺宝物结下仇怨` }
}
/* 15.姻缘(真实关系链: 结为道侣) */
function genRomance (f, t) {
  const a = pickAlive(f)
  if (!a) return null
  const b = pickAlive(f, a.name)
  if (!b) return null
  if (a.relations.spouse || b.relations.spouse) return null // 已有道侣
  a.relations.spouse = b.name
  b.relations.spouse = a.name
  return { type: 'flavor', ...evWho([a, b]), txt: `【姻缘】${a.name} 与 ${b.name} 结为道侣，双修共进` }
}
/* 16.宗门内讧 */
function genStrife (f, t) {
  const ids = Object.keys(f.sects)
  if (!ids.length) return null
  const id = pick(ids)
  const a = pickBy(f, x => x.sect === id)
  const b = pickBy(f, x => x.sect === id && x.name !== (a && a.name))
  if (!a || !b) return null
  /* 内讧负气出走: 弟子/执事可负气出走; 太上/副宗仅在宗门严重衰落/忠诚极低(离心)时才有极低概率出走(凡事不绝对); 宗主永不弃宗 */
  if (Math.random() < 0.2 && (a.pos === 'dizi' || a.pos === 'zhishi' || ((a.pos === 'taishang' || a.pos === 'fuzong') && leaderRootless(f, a) && Math.random() < 0.15))) {
    removeFromSectMap(f, id, a.name)
    a.status = 'scatter'; a.sect = null; a.pos = null
    return { type: 'strife', ...evMeta(a), txt: `【内讧】${sectName(f, id)}内讧，${a.name} 负气出走沦为散修` }
  }
  return { type: 'strife', ...evWho([a, b]), txt: `【内讧】${sectName(f, id)}内讧，${a.name} 与 ${b.name} 争执不下` }
}
/* 17.妖兽袭击 */
function genBeast (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  const beast = pick(['赤炎妖虎', '九幽阴蛇', '噬魂魔鸦', '黑水玄蛟', '石甲蛮猿'])
  if (Math.random() < 0.25) {
    killPerson(f, p, `【妖兽】${p.name} 遭${beast}袭击，不幸陨落`, t)
    return null
  }
  return { type: 'flavor', ...evMeta(p), txt: `【妖兽】${p.name} 遭遇${beast}，奋力搏杀后将其击退` }
}
/* 18.夺宝(修仙世界: 天材地宝现世群雄逐鹿, 强者得宝, 弱者或伤或亡) */
function genTreasure (f, t) {
  const cand = Object.values(f.roster).filter(p => p.alive && !p.realmBusy)
  if (cand.length < 2) return null
  const n = Math.min(4, 2 + Math.floor(Math.random() * 2)) // 2~3人争抢
  const players = []
  const pool = [...cand]
  for (let i = 0; i < n && pool.length; i++) { const idx = Math.floor(Math.random() * pool.length); players.push(pool.splice(idx, 1)[0]) }
  const winner = players.reduce((a, b) => (personPower(a) >= personPower(b) ? a : b))
  const tr = pick(['上古灵剑', '九转金丹', '太乙精金', '龙纹玉佩', '天蚕宝衣', '万年灵芝', '玄冰玉髓'])
  const gain = rand([500, 3000])
  winner.money = (winner.money || 0) + gain
  addExp(winner, rand([50, 200]))
  let died = null
  for (const l of players) {
    if (l === winner) continue
    if (Math.random() < 0.15) {
      killPerson(f, l, `【夺宝】${l.name} 争夺${tr}不敌，身死道消`, t)
      if (!died) died = l
    } else {
      const drop = rand([1, 2])
      l.level = Math.max(1, l.level - drop)
      if ((l.exp || 0) < fakeSubThreshold(l.level)) l.exp = fakeSubThreshold(l.level)
    }
  }
  const whoW = winner.status === 'sect' && winner.sect ? sectName(f, winner.sect) : '散修'
  return { type: 'flavor', ...evWho([winner, ...players]), txt: `【夺宝】${tr}现世，${players.map(p => p.name).join('、')} 群雄逐鹿，${whoW} ${winner.name} 技压群雄夺得至宝（+${gain}灵石）${died ? `，${died.name} 身死道消` : ''}` }
}
/* 65.强者欺压(修仙世界: 强者为尊, 高境界盘剥低境界——收保护费/羞辱教训, 弱者敢怒不敢言或反抗结仇) */
export function genBully (f, t) {
  const strong = pickBy(f, p => p.alive && (p.level || 0) >= 15)
  if (!strong) return null
  const weak = pickVictim(f, strong.name)
  if (!weak || (weak.level || 0) >= (strong.level || 0) - 3) return null
  /* 同门不互欺压: 欺压本宗弟子/自家宗主是内讧(已有专门事件), 恃强凌弱只发生在异宗/散修之间 */
  if (weak.sect && weak.sect === strong.sect) return null
  const whoS = strong.status === 'sect' && strong.sect ? sectName(f, strong.sect) : '散修'
  const whoW = weak.status === 'sect' && weak.sect ? sectName(f, weak.sect) : '散修'
  const gap = (strong.level || 0) - (weak.level || 0)
  /* 收保护费(软柿子挑身家) */
  if (Math.random() < 0.5 && (weak.money || 0) > 0) {
    const gold = Math.min((weak.money || 0), Math.max(50, Math.floor((weak.money || 0) * 0.3)))
    if (gold >= 50) {
      weak.money -= gold
      strong.money = (strong.money || 0) + gold
      return { type: 'flavor', ...evWho([strong, weak]), txt: `【欺压】${whoS} ${strong.name} 拦住${whoW} ${weak.name}收保护费，强索 ${gold} 灵石（境界压制）` }
    }
  }
  /* 弱者反抗: 境界差大被教训, 差小敢反抗结仇 */
  if (Math.random() < (gap >= 10 ? 0.8 : 0.3)) {
    weak.level = Math.max(1, weak.level - 1)
    if ((weak.exp || 0) < fakeSubThreshold(weak.level)) weak.exp = fakeSubThreshold(weak.level)
    return { type: 'flavor', ...evWho([strong, weak]), txt: `【欺压】${whoS} ${strong.name} 当众教训${whoW} ${weak.name}，弱者敢怒不敢言（修为受挫）` }
  }
  if (!weak.relations.enemies.includes(strong.name)) weak.relations.enemies.push(strong.name)
  if (!strong.relations.enemies.includes(weak.name)) strong.relations.enemies.push(weak.name)
  return { type: 'flavor', ...evWho([strong, weak]), txt: `【反抗】${whoW} ${weak.name} 不甘受辱奋起反抗，虽不敌却与${whoS} ${strong.name}结下仇怨` }
}
/* 19.魔修血祭(魔道嗜杀) */
function genDemonRitual (f, t) {
  const mo = pickBy(f, p => p.path === '魔道')
  if (!mo) return null
  const v = pickBy(f, p => p !== mo && (p.level || 0) < 10)
  if (!v) return null
  mo.kills = (mo.kills || 0) + 1
  killPerson(f, v, `【血祭】魔修${mo.name} 血祭活人修炼魔功，${v.name} 殒命`, t)
  return null
}
/* 20.除魔卫道(正道善良 vs 魔修) */
function genExorcism (f, t) {
  const zheng = pickBy(f, p => p.path === '正道' && (p.trait === '善良' || p.trait === '平和'))
  const mo = pickBy(f, p => p.path === '魔道')
  if (!zheng || !mo) return null
  zheng.kills = (zheng.kills || 0) + 1
  mo.kills = (mo.kills || 0) + 1
  if (Math.random() < 0.5) {
    killPerson(f, mo, `【除魔】${zheng.name} 除魔卫道，诛杀魔修${mo.name}`, t)
    return null
  }
  killPerson(f, zheng, `【除魔】${zheng.name} 除魔不成，反被魔修${mo.name}所害`, t)
  return null
}
/* 21.追杀叛徒 */
function genHuntTraitor (f, t) {
  const tr = scatters(f).find(x => (x.kills || 0) > 0)
  if (!tr) return null
  const hunter = pickBy(f, p => p.path === '正道' && (p.trait === '善良' || p.trait === '好斗'))
  if (!hunter) return null
  hunter.kills = (hunter.kills || 0) + 1
  killPerson(f, tr, `【追杀】叛徒${tr.name} 被${hunter.name} 追杀，伏诛于荒野`, t)
  return null
}
/* 22.坐化(寿元尽) */
function genPassing (f, t) {
  const p = pickBy(f, x => x.level >= 30)
  if (!p) return null
  killPerson(f, p, `【坐化】${p.name} 寿元将尽，于洞府安然坐化`, t)
  return null
}
/* 23.论道(纯剧情) */
function genDaoTalk (f, t) {
  const a = pickAlive(f)
  if (!a) return null
  const b = pickAlive(f, a.name)
  if (!b) return null
  return { type: 'flavor', ...evWho([a, b]), txt: `【论道】${a.name} 与 ${b.name} 论道三日，互有感悟` }
}
/* 24.炼丹炼器(玩家化: 背包有药材时合成丹药, 失败小伤; 只消耗伪玩家自己背包) */
function genCraft (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  /* 有药材 → 合成丹药 */
  const herbs = p.bag && p.bag.items ? Object.keys(p.bag.items).filter(n => MATERIAL_TPL[n]) : []
  if (herbs.length && Math.random() < 0.6) {
    const herb = pick(herbs)
    fakeTakeItem(p.bag, herb)
    const pill = pick(['修为丹', '破障丹', '聚宝丹', '惊鸿丹'])
    if (!p.bag) p.bag = { items: {}, equipped: {} }
    fakeAddItem(p.bag, pill, 1)
    return { type: 'flavor', ...evMeta(p), txt: `【炼丹】${who} ${p.name} 以【${herb}】炼成一枚${pill}！` }
  }
  if (Math.random() < 0.2) {
    return { type: 'backfire', ...evMeta(p), txt: `【炼丹】${who} ${p.name} 炼丹炸炉，身负轻伤（药材损毁）` }
  }
  return { type: 'flavor', ...evMeta(p), txt: `【炼丹】${who} ${p.name} 开炉炼丹，炼成一炉上品灵丹` }
}
/* 25.游历拜访(纯剧情) */
function genVisit (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  return { type: 'flavor', ...evMeta(p), txt: `【游历】${p.name} 云游四方，途经${pick(['中州', '东海', '西域', '北境', '南疆'])}，广结善缘` }
}
/* 26.拍卖风波(纯剧情) */
function genAuction (f, t) {
  const a = pickAlive(f)
  if (!a) return null
  const b = pickAlive(f, a.name)
  if (!b) return null
  return { type: 'flavor', ...evWho([a, b]), txt: `【拍卖】拍卖会上 ${a.name} 与 ${b.name} 为一件灵宝竞价，${Math.random() < 0.5 ? a.name : b.name} 拍得宝物` }
}

/* 27.复仇(关系人死亡后为其复仇, 真实关系链驱动) */
function genRevenge (f, t) {
  const alive = Object.values(f.roster).filter(p => p.alive && !p.realmBusy)
  const avenger = alive.find(p => {
    const r = p.relations || {}
    const xd = (r.master && f.roster[r.master] && (f.roster[r.master].relations || {}).disciples) ? f.roster[r.master].relations.disciples.filter(n => n !== p.name) : []
    const rels = [r.spouse, r.master, ...(r.disciples || []), ...(r.friends || []), ...(r.confidants || []), ...(r.siblings || []), ...(r.kin || []), ...xd].filter(Boolean)
    return rels.some(nm => !f.roster[nm])
  })
  if (!avenger) return null
  const r = avenger.relations || {}
  const xd = (r.master && f.roster[r.master] && (f.roster[r.master].relations || {}).disciples) ? f.roster[r.master].relations.disciples.filter(n => n !== avenger.name) : []
  const deadRels = [r.spouse, r.master, ...(r.disciples || []), ...(r.friends || []), ...(r.confidants || []), ...(r.siblings || []), ...(r.kin || []), ...xd].filter(nm => nm && !f.roster[nm])
  const deadName = deadRels[Math.floor(Math.random() * deadRels.length)]
  const relLabel = r.spouse === deadName ? '道侣' : (r.master === deadName ? '师父' : (r.disciples || []).includes(deadName) ? '徒弟' : (r.friends || []).includes(deadName) ? '挚友' : (r.confidants || []).includes(deadName) ? '知己' : (r.siblings || []).includes(deadName) ? '手足' : xd.includes(deadName) ? '师兄弟' : '亲人')
  let v = null
  const enemies = (r.enemies || []).filter(nm => f.roster[nm] && f.roster[nm].alive)
  if (enemies.length) v = f.roster[enemies[Math.floor(Math.random() * enemies.length)]]
  if (!v) v = pickBy(f, p => p.path === '魔道' || p.trait === '嗜杀')
  if (!v) return null
  avenger.kills = (avenger.kills || 0) + 1
  if (Math.random() < 0.4) {
    killPerson(f, v, `【复仇】${avenger.name} 为${relLabel}${deadName}复仇，手刃${v.name}`, t)
    return null
  }
  return { type: 'fight', ...evWho([avenger, v]), txt: `【复仇】${avenger.name} 为${relLabel}${deadName}复仇，与${v.name}激战一场` }
}
/* 28.修炼(玩家同款: 灵力1~20+宗门演武场加成; 灵力达 getSubThreshold 自动突破, 成功率同玩家, 突破不清零灵力) */
async function genCultivate (f, t) {
  const now = Date.now() // 冷却必须用真实时间(fakeTick传入的t是过去事件时间戳,用它冷却永不满足)
  const p = pickBy(f, x => x.alive && now >= ((x.activities || {}).lastCultivate2 || 0))
  if (!p) return null
  return await cultivatePerson(f, p)
}
/** 指定人修炼(每人30分钟一次, 与玩家修炼冷却一致; 巅峰不产事件; 灵力达标自动突破, 成功跨大境界为大事; 有破障丹或买得起服丹90%) */
export async function cultivatePerson (f, p) {
  const now = Date.now()
  if (!p.activities) p.activities = {}
  p.activities.lastCultivate2 = now + 30 * 60000 // 冷却与玩家一致(30分钟)
  const band = levelBand(p)
  if (p.level >= band[1]) return null // 巅峰不产事件
  /* 玩家同款: 灵力随机1~20, 宗门演武场+8%/级(散修无加成); 伪玩家修炼收益2000%(×20 → 20~400) */
  const sectCultivate = (p.status === 'sect' && p.sect && f.sects[p.sect] && f.sects[p.sect].facilities) ? (f.sects[p.sect].facilities.yanwu || 0) * 8 : 0
  /* 收益: 宗门弟子恢复2000%(×20 → 20~400 + 演武场); 散修砍到500%(×5 → 5~100, 无演武场) */
  const gain = (p.status === 'sect' && p.sect && f.sects[p.sect])
    ? Math.round((1 + 19 * Math.random()) * 20 * (1 + sectCultivate / 100))
    : Math.round((1 + 19 * Math.random()) * 5)
  addExp(p, gain)
  /* 玩家体系: 灵力达标尝试突破(不清零灵力, 累计制; 有破障丹或买得起服丹90%, 否则基础+功法+演武场) */
  if (p.level < REALM_MAX_LEVEL && p.exp >= fakeSubThreshold(p.level + 1)) {
    let usedPill = false
    let rate = fakeBreakRateFull(f, p)
    if (p.bag && p.bag.items && itemCount(p.bag.items['破障丹']) > 0) {
      fakeTakeItem(p.bag, '破障丹')
      usedPill = true
      rate = 90
    } else if (await buyPillForBreak(f, p)) {
      usedPill = true
      rate = 90
    }
    if (Math.random() * 100 <= rate) {
      const oldRealm = Math.floor((p.level - 1) / 4)
      p.level++
      mergeAccum(p) // 突破并入累计池
      const major = Math.floor((p.level - 1) / 4) > oldRealm
      return { type: 'break', major, ...evMeta(p), txt: usedPill ? `【突破】${p.name} 服下${itemIcon('破障丹')}破障丹，冲破瓶颈，成功突破至${levelNameOf(p.level)}！` : `【突破】${p.name} 潜心修炼，灵力圆满，成功突破至${levelNameOf(p.level)}！` }
    }
    return { type: 'backfire', ...evMeta(p), txt: usedPill ? `【突破】${p.name} 服下${itemIcon('破障丹')}破障丹冲击瓶颈，惜败未破境` : `【突破】${p.name} 灵力已足，冲击境界失败，来日再试` }
  }
  return { type: 'flavor', ...evMeta(p), txt: `【修炼】${p.name} 闭关修炼，灵力精进（+${gain}）` }
}
/* 46.顿悟(散修: 灵力大涨, 修为走玩家体系) */
function genEnlightenment (f, t) {
  const p = pickBy(f, x => x.status !== 'sect')
  if (!p) return null
  const gain = rand([150, 400])
  addExp(p, gain)
  return { type: 'break', ...evMeta(p), txt: `【顿悟】散修 ${p.name} 一朝顿悟，灵力大涨（+${gain}）` }
}
/* 29.摆摊(复用玩家#摆摊公式: 赚200~500, 按大区动态税率扣税计入繁荣度)
 * 只记个人事迹(#查人可见), 不进天下大事/小事 */
function genStall (f, t) {
  const now = Date.now() // 冷却必须用真实时间(fakeTick传入的t是过去事件时间戳,用它冷却永不满足)
  const p = pickBy(f, x => x.alive && now >= ((x.activities || {}).lastStall2 || 0))
  if (!p) return null
  return stallPerson(f, p)
}
/** 指定人摆摊(照玩家#摆摊: 60分钟冷却, 收入200~500, 按大区动态税率扣税上交大区; 只记个人事迹) */
export function stallPerson (f, p) {
  const now = Date.now()
  if (!p.activities) p.activities = {}
  p.activities.lastStall2 = now + 60 * 60000 // 与玩家#摆摊冷却一致(60分钟)
  const loc = p.loc || DEFAULT_REGION
  /* 玩家摆摊: 随机200~500(伪玩家无房子加成); 宗门弟子800%(×8 → 1600~4000), 散修一半(×4 → 800~2000) */
  const mult = (p.status === 'sect' && p.sect && f.sects[p.sect]) ? 8 : 4
  const earn = Math.round((Math.random() * 300 + 200) * mult)
  const w = getWorld(f.gid)
  const rate = taxFor(w, loc, p.sect ? sectName(f, p.sect) : null)
  const tax = Math.floor(earn * rate / 100)
  p.money = (p.money || 0) + (earn - tax)
  /* 税上交大区(与玩家#摆摊一致: addTax 计入大区税收/繁荣度, 不进个人背包) */
  if (tax > 0) { addTax(w, loc, tax); saveWorld(w) }
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  return { type: 'flavor', ...evMeta(p), onlyPerson: true, txt: `【摆摊】${who} ${p.name} 在${regionNameOf(loc)}摆摊，赚得 ${earn - tax} 灵石（税率${rate}%，扣税 ${tax}）` }
}
/* 30.采买(玩家化: 花灵石购丹入背包; 同步进天下大事+江湖交易, 同 genTrade) */
function genShop (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  const item = pick(['修为丹', '破障丹', '聚宝丹'])
  const price = { '修为丹': 100, '破障丹': 500, '聚宝丹': 800 }[item]
  if ((p.money || 0) < price) return null
  p.money -= price
  if (!p.bag) p.bag = { items: {}, equipped: {} }
  fakeAddItem(p.bag, item, 1)
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  const txt = `【采买】${who} ${p.name} 于坊市购得【${item}】（-${price}灵石）`
  logTrade(f, txt)
  return { type: 'flavor', ...evMeta(p), txt }
}
/* 31.洗劫藏宝阁(伪玩家: 与玩家一样分20档难度——贪者富贵险中求选高难度, 怂者保平安选低难度;
 * 成败按个人战力 vs 该档守卫判定; 被抓真押入藏宝阁天牢0~120分钟, 可在#天下天牢查看) */
const VAULT_LOOT = ['修为丹', '破障丹', '聚宝丹', '星霜草', '望舒花', '月魄石', '流光玉', '青锋剑', '功法残卷', '灵石袋']
const VAULT_HIGH_LOOT = ['惊鸿丹', '玉甲丹', '凝露丹', '慧心丹', '摄魂丹', '紫霞功', '红莲神功', '赤霄剑', '星璇石', '望舒花']
/** 贪怂倾向(0~1): 贪=魔道/嗜杀/好斗/贪玩 → 高难度; 怂=平和/善良/懒散 → 低难度 */
function vaultTend (p) {
  let t = 0.5
  if (p.trait === '嗜杀') t += 0.25
  if (p.trait === '好斗') t += 0.15
  if (p.path === '魔道') t += 0.15
  if (p.trait === '贪玩' || p.act === '贪玩') t += 0.1
  if (p.trait === '平和') t -= 0.25
  if (p.trait === '善良') t -= 0.15
  if (p.act === '懒散') t -= 0.15
  if (p.act === '苦修') t -= 0.1
  return Math.max(0, Math.min(1, t))
}
function genVaultRob (f, t) {
  let p = Math.random() < 0.6 ? pickBy(f, x => x.path === '魔道' || x.trait === '嗜杀') : null
  if (!p) p = pickAlive(f)
  if (!p) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  /* 贪怂 → 20档难度: 怂(低)→1~6, 中→7~14, 贪(高)→15~20 */
  const tend = vaultTend(p)
  let levelIdx
  if (tend < 0.35) levelIdx = rand([1, 6])
  else if (tend > 0.65) levelIdx = rand([15, 20])
  else levelIdx = rand([7, 14])
  const lv = RAID_LEVELS[levelIdx - 1] || RAID_LEVELS[0]
  /* 成败: 个人战力 vs 该档守卫(1~3人值守, 守卫按推荐境界定, 不随个人缩放); 伪玩家略微占优(换防时机) */
  const guards = 1 + Math.floor(Math.random() * 3)
  const guardPower = Math.round(guardPowerFor(0, levelIdx, guards, false) * 0.85)
  const myPw = personPower(p)
  const winRate = Math.max(0.05, Math.min(0.95, myPw / (myPw + guardPower)))
  if (Math.random() < winRate) {
    /* 得手: 难度越高抢得越多越好(高档混入增益丹/功法/稀有材料) */
    const pool = levelIdx >= 13 ? [...VAULT_LOOT, ...VAULT_HIGH_LOOT] : VAULT_LOOT
    const n = Math.max(1, Math.min(5, 1 + Math.floor(levelIdx / 5) + (Math.random() < 0.3 ? 1 : 0)))
    const used = new Set()
    for (let i = 0; i < n; i++) used.add(pick(pool))
    if (!p.bag) p.bag = { items: {}, equipped: {} }
    for (const it of used) fakeAddItem(p.bag, it, 1)
    return { type: 'raid', ...evMeta(p), txt: `【洗劫】${who} ${p.name} 夜闯【${lv.name}】（第${levelIdx}档）得手，夺得${[...used].map(x => `【${x}】`).join('')}` }
  }
  /* 被抓: 真押入藏宝阁天牢(0~120分钟, 与玩家一致) + 扣灵石 */
  const jailMin = Math.floor(Math.random() * 121)
  f.raidJail = f.raidJail || []
  f.raidJail.push({ name: p.name, at: t, until: t + jailMin * 60000 })
  const lose = Math.min((p.money || 0), rand([100, 1000]))
  p.money = Math.max(0, (p.money || 0) - lose)
  return { type: 'raid', ...evMeta(p), txt: `【洗劫】${who} ${p.name} 洗劫【${lv.name}】（第${levelIdx}档）被守卫抓获，${lose ? `被搜走${lose}灵石后` : ''}押入藏宝阁天牢${jailMin}分钟` }
}
/* 32.远行(玩家化: 跨大区旅行, 真实地名, 到南疆/中州等; 宗门门人大多回宗门所在大区; 路费自己出) */
function genTravel (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  const from = p.loc || DEFAULT_REGION
  /* 日常瞎逛传送费自己出, 和玩家一样交 2000 灵石(宗门跨区作战才宗门出) */
  const cost = 2000
  if ((p.money || 0) < cost) return null
  const sReg = (p.status === 'sect' && p.sect) ? sectLocOf(f, p.sect) : null
  let dest
  if (sReg && sReg !== from && Math.random() < 0.6) dest = sReg
  else {
    const dests = REGION_KEYS.filter(k => k !== from && !(REGIONS[k] && REGIONS[k].special)) // 伪修士远行不含简月王朝
    if (!dests.length) return null
    dest = pick(dests)
  }
  p.money -= cost
  p.loc = dest
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  return { type: 'flavor', ...evMeta(p), txt: `【远行】${who} ${p.name} 离开${regionNameOf(from)}，远赴${regionNameOf(dest)}游历（传送费 ${cost} 灵石）` }
}
/* 33.赠礼(玩家化: 伪玩家之间互送物品/灵石; 好友/之交好友/同门优先) */
function genGift (f, t) {
  const a = pickAlive(f)
  if (!a) return null
  /* 词条驱动: 优先送挚友/知己/手足/师兄弟/师徒/道侣/同门 */
  let b = null
  const relPool = relPoolOf(f, a, true)
  if (relPool.length && Math.random() < 0.7) b = f.roster[pick(relPool)]
  if (!b) b = pickAlive(f, a.name)
  if (!b) return null
  const whoA = a.status === 'sect' && a.sect ? sectName(f, a.sect) : '散修'
  const whoB = b.status === 'sect' && b.sect ? sectName(f, b.sect) : '散修'
  const giftLabel = relLabelOf(f, a, b.name)
  if (Math.random() < 0.5) {
    /* 送物品 */
    const items = a.bag && a.bag.items ? Object.keys(a.bag.items) : []
    if (!items.length) return null
    const item = pick(items)
    if (!b.bag) b.bag = { items: {}, equipped: {} }
    if (!fakeTransferEntry(a.bag, b.bag, item)) return null
    return { type: 'gift', ...evWho([a, b]), txt: `【赠礼】${whoA} ${a.name} 将【${item}】赠予${giftLabel} ${whoB} ${b.name}` }
  }
  /* 送灵石 */
  const gold = Math.min((a.money || 0), rand([50, 500]))
  if (gold <= 0) return null
  a.money -= gold
  b.money = (b.money || 0) + gold
  return { type: 'gift', ...evWho([a, b]), txt: `【赠礼】${whoA} ${a.name} 将 ${gold} 灵石赠予${giftLabel} ${whoB} ${b.name}` }
}
/* 34.打劫(修仙世界真实: 劫修洗劫一空, 经常杀人灭口; 撞见熟人——同门/道侣/师徒/知己/挚友/手足/亲族/师兄弟——才手下留情) */
export function genRob (f, t) {
  const k = pickBy(f, p => p.path === '魔道' || p.trait === '嗜杀' || p.trait === '好斗')
  if (!k) return null
  const v = pickVictim(f, k.name)
  if (!v) return null
  const whoK = k.status === 'sect' && k.sect ? sectName(f, k.sect) : '散修'
  const whoV = v.status === 'sect' && v.sect ? sectName(f, v.sect) : '散修'
  /* 撞见熟人 → 手下留情(只小讨或放过, 绝不灭口) */
  const relLabel = relLabelOf(f, k, v.name)
  if (relLabel !== '故人') {
    const gold = Math.min((v.money || 0), rand([10, 100]))
    if (gold > 0) {
      v.money -= gold
      k.money = (k.money || 0) + gold
      return { type: 'rob', ...evWho([k, v]), txt: `【打劫】${whoK} ${k.name} 撞见${relLabel}${v.name}，碍于旧情只讨了 ${gold} 灵石便放行` }
    }
    return { type: 'flavor', ...evWho([k, v]), txt: `【打劫】${whoK} ${k.name} 本想劫道，认出${relLabel}${v.name}，讪讪罢手离去` }
  }
  /* 无关系: 洗劫一空(灵石+背包+穿身装备全抢) */
  const loot = robSpoils(f, k, v)
  const lootTxt = loot.length ? `，劫走 ${loot.join('、')}` : ''
  /* 灭口率 = 劫修性格 × 受害者靠山(修仙世界: 散修无依无靠最好欺负杀了白杀, 宗门弟子有宗门护着"打狗看主人", 有强靠山更忌惮) */
  const evil = k.path === '魔道' || k.trait === '嗜杀'
  let killRate = evil ? 0.8 : 0.45
  const vHasSect = v.status === 'sect' && v.sect && f.sects[v.sect]
  if (!vHasSect) killRate = Math.min(0.95, killRate + 0.15) // 散修: 杀了白杀
  else killRate *= 0.4 // 宗门弟子: 怕宗门报复
  const rv = v.relations || {}
  const strong = [rv.master, rv.spouse].filter(Boolean).some(n => { const np = f.roster[n]; return np && np.alive && (np.level || 0) >= (v.level || 0) + 10 })
  if (strong) killRate *= 0.5 // 有强靠山(高境界师父/道侣): 更忌惮
  const kill = Math.random() < killRate
  if (kill) {
    killWithGrudge(f, k, v, `【灭口】${whoK} ${k.name} 洗劫了 ${whoV} ${v.name}${lootTxt}，随即杀人灭口！`, t)
    return null
  }
  /* 活口记仇: 被洗劫的会寻仇; 宗门弟子被劫 → 同门(好斗/嗜杀/有羁绊者)也记仇, 宗门庇护 */
  if (!v.relations.enemies.includes(k.name)) v.relations.enemies.push(k.name)
  if (vHasSect) {
    for (const m of sectAlive(f, v.sect)) {
      if (m.name === v.name) continue
      const isBonded = relLabelOf(f, m, v.name) !== '故人'
      if (m.trait === '好斗' || m.trait === '嗜杀' || m.path === '魔道' || isBonded) {
        if (!m.relations.enemies.includes(k.name)) m.relations.enemies.push(k.name)
      }
    }
  }
  return { type: 'rob', ...evWho([k, v]), txt: `【打劫】${whoK} ${k.name} 将 ${whoV} ${v.name} 洗劫一空${lootTxt}，结下仇怨` }
}
/* 63.劫道(骑砍2式+修仙世界真实: 恶人埋伏劫道, 按战力判定——打不过被击退/反杀; 得手即洗劫一空, 经常杀人灭口; 撞见熟人——同门/道侣/师徒/知己/挚友/手足/亲族/师兄弟——才手下留情) */
export function genAmbush (f, t) {
  const k = pickBy(f, p => p.alive && (p.path === '魔道' || p.trait === '嗜杀' || p.trait === '好斗'))
  if (!k) return null
  const v = pickVictim(f, k.name)
  if (!v) return null
  const whoK = k.status === 'sect' && k.sect ? sectName(f, k.sect) : '散修'
  const whoV = v.status === 'sect' && v.sect ? sectName(f, v.sect) : '散修'
  const road = pick(['官道', '荒岭古道', '密林小径', '峡谷要道', '渡口'])
  /* 按战力判定: 劫匪不敌路人则被击退/反杀(骑砍2式; 实力越悬殊越易被反杀, 境界压制) */
  if (personPower(k) < personPower(v) * 0.9) {
    const gapPct = Math.max(0, Math.min(1, 1 - personPower(k) / (personPower(v) * 0.9)))
    if (Math.random() < 0.2 + gapPct * 0.3) {
      killPerson(f, k, `【劫道】${whoK} ${k.name} 于${road}劫道不成，反被 ${whoV} ${v.name} 当场斩杀！`, t)
      return null
    }
    return { type: 'fight', ...evWho([k, v]), txt: `【劫道】${whoK} ${k.name} 于${road}欲劫 ${whoV} ${v.name}，反被击退` }
  }
  /* 撞见熟人 → 手下留情(只小讨或放过, 绝不灭口) */
  const relLabel = relLabelOf(f, k, v.name)
  if (relLabel !== '故人') {
    const gold = Math.min((v.money || 0), rand([10, 100]))
    if (gold > 0) {
      v.money -= gold
      k.money = (k.money || 0) + gold
      return { type: 'rob', ...evWho([k, v]), txt: `【劫道】${whoK} ${k.name} 于${road}截住${relLabel}${v.name}，认出旧识只讨了 ${gold} 灵石` }
    }
    return { type: 'flavor', ...evWho([k, v]), txt: `【劫道】${whoK} ${k.name} 于${road}截住${relLabel}${v.name}，认出旧识，拱手放行` }
  }
  /* 无关系: 洗劫一空(灵石+背包+穿身装备全抢) + 灭口率按劫修性格×受害者靠山 */
  const loot = robSpoils(f, k, v)
  const lootTxt = loot.length ? `，劫走 ${loot.join('、')}` : ''
  const evil = k.path === '魔道' || k.trait === '嗜杀'
  let killRate = evil ? 0.8 : 0.45
  const vHasSect = v.status === 'sect' && v.sect && f.sects[v.sect]
  if (!vHasSect) killRate = Math.min(0.95, killRate + 0.15) // 散修: 杀了白杀
  else killRate *= 0.4 // 宗门弟子: 怕宗门报复
  const rv = v.relations || {}
  const strong = [rv.master, rv.spouse].filter(Boolean).some(n => { const np = f.roster[n]; return np && np.alive && (np.level || 0) >= (v.level || 0) + 10 })
  if (strong) killRate *= 0.5 // 有强靠山: 更忌惮
  const kill = Math.random() < killRate
  if (kill) {
    killWithGrudge(f, k, v, `【劫道】${whoK} ${k.name} 于${road}劫杀 ${whoV} ${v.name}${lootTxt}，灭口！`, t)
    return null
  }
  /* 活口记仇: 被洗劫的会寻仇; 宗门弟子被劫 → 同门记仇, 宗门庇护 */
  if (!v.relations.enemies.includes(k.name)) v.relations.enemies.push(k.name)
  if (vHasSect) {
    for (const m of sectAlive(f, v.sect)) {
      if (m.name === v.name) continue
      const isBonded = relLabelOf(f, m, v.name) !== '故人'
      if (m.trait === '好斗' || m.trait === '嗜杀' || m.path === '魔道' || isBonded) {
        if (!m.relations.enemies.includes(k.name)) m.relations.enemies.push(k.name)
      }
    }
  }
  return { type: 'rob', ...evWho([k, v]), txt: `【劫道】${whoK} ${k.name} 于${road}截住 ${whoV} ${v.name}，洗劫一空${lootTxt}，结下仇怨` }
}
/* 35.挂机(玩家化: 挂机攒灵石/灵力) */
function genIdle (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  const gold = rand([200, 1000])
  /* 行运丹: 挂机收益翻倍(与玩家一致) */
  const expBase = rand([5, 20])
  const exp = (p.pill && p.pill.name === '行运丹' && p.pill.until > Date.now()) ? expBase * 2 : expBase
  p.money = (p.money || 0) + gold
  addExp(p, exp)
  return { type: 'flavor', ...evMeta(p), txt: `【挂机】${who} ${p.name} 于洞府挂机修炼，结出 ${gold} 灵石、灵力+${exp}${exp > expBase ? `（${itemIcon('行运丹')}行运丹翻倍）` : ''}` }
}
/* 36.低保(玩家化: 穷困伪玩家领取救济; 宗门弟子领宗门救济, 散修领救济; 管理层有金库取用权限不会沦落领救济) */
export function genPoor (f, t) {
  const p = pickBy(f, x => (x.money || 0) < 300 && x.pos !== 'zongzhu' && x.pos !== 'taishang' && x.pos !== 'fuzong')
  if (!p) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  const get = rand([300, 900])
  p.money = (p.money || 0) + get
  const src = p.status === 'sect' && p.sect ? '宗门救济' : '救济'
  return { type: 'flavor', ...evMeta(p), txt: `【低保】${who} ${p.name} 囊中羞涩，领取${src} ${get} 灵石` }
}
/* 37.上交(玩家化: 给道侣上交灵石, 只涉及伪玩家道侣) */
function genSubmit (f, t) {
  const a = pickBy(f, p => p.alive && p.relations && p.relations.spouse && f.roster[p.relations.spouse] && f.roster[p.relations.spouse].alive)
  if (!a) return null
  const b = f.roster[a.relations.spouse]
  const gold = Math.min((a.money || 0), rand([100, 800]))
  if (gold <= 0) return null
  const whoA = a.status === 'sect' && a.sect ? sectName(f, a.sect) : '散修'
  const whoB = b.status === 'sect' && b.sect ? sectName(f, b.sect) : '散修'
  a.money -= gold
  b.money = (b.money || 0) + gold
  return { type: 'flavor', ...evWho([a, b]), txt: `【上交】${whoA} ${a.name} 将 ${gold} 灵石上交给道侣 ${whoB} ${b.name}` }
}
/* 38.双修(玩家化: 与道侣双修得灵力, 只涉及伪玩家道侣) */
function genShuangxiu (f, t) {
  const a = pickBy(f, p => p.alive && p.relations && p.relations.spouse && f.roster[p.relations.spouse] && f.roster[p.relations.spouse].alive)
  if (!a) return null
  const b = f.roster[a.relations.spouse]
  const gain = rand([20, 60])
  /* 灵犀丹: 双修收益翻倍(与玩家一致) */
  const mul = (a.pill && a.pill.name === '灵犀丹' && a.pill.until > Date.now()) ? 2 : 1
  addExp(a, gain * mul)
  addExp(b, gain * mul)
  const whoA = a.status === 'sect' && a.sect ? sectName(f, a.sect) : '散修'
  return { type: 'flavor', ...evWho([a, b]), txt: `【双修】${whoA} ${a.name} 与道侣 ${b.name} 双双灵力精进（+${gain * mul}${mul > 1 ? `，${itemIcon('灵犀丹')}灵犀丹翻倍` : ''}）` }
}
/* 39.互动(玩家化: 与道侣/知己/手足/师兄弟/师徒/同门等把酒言欢, 关系词条驱动) */
function genIntimate (f, t) {
  const a = pickBy(f, p => p.alive && relPoolOf(f, p, true).length)
  if (!a) return null
  const pool = relPoolOf(f, a, true)
  if (!pool.length) return null
  const bName = pick(pool)
  const b = f.roster[bName]
  const label = relLabelOf(f, a, bName)
  const whoA = a.status === 'sect' && a.sect ? sectName(f, a.sect) : '散修'
  return { type: 'flavor', ...evWho([a, b]), txt: `【互动】${whoA} ${a.name} 与${label} ${bName} 把酒言欢，情谊更笃` }
}
/* 40.修习功法(玩家化: 学会背包里的功法书) */
function genPractice (f, t) {
  const p = pickBy(f, x => x.alive && x.bag && x.bag.items && Object.keys(x.bag.items).some(n => GONGFA_TPL[n]))
  if (!p) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  /* 学背包里评分最高的功法(知道好坏, 不随机学第一本); 学会后自动运转它 */
  const gongfa = Object.keys(p.bag.items).filter(n => GONGFA_TPL[n]).sort((a, b) => gongfaScore(b) - gongfaScore(a))[0]
  fakeTakeItem(p.bag, gongfa)
  if (!p.learnedGongfa) p.learnedGongfa = []
  if (!p.learnedGongfa.includes(gongfa)) p.learnedGongfa.push(gongfa)
  /* 学会最好的功法 → 运转它(战力最大化) */
  if (!p.activeGongfa || gongfaScore(gongfa) > gongfaScore(p.activeGongfa)) p.activeGongfa = gongfa
  return { type: 'flavor', ...evMeta(p), txt: `【修习】${who} ${p.name} 闭关参悟《${gongfa}》，习得此功法` }
}
/* 秘境掉落(药材/矿物, 只进伪玩家背包) */
const SECRET_LOOT = ['星霜草', '青鸾草', '望舒花', '月华芝', '凤栖花', '月魄石', '星璇石', '流光玉', '织云石', '凤羽玉', '云裳仙蕊', '造梦神玉']
/* 41.秘境探索(玩家化: 得药材/矿物) */
function genSecret (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  const item = pick(SECRET_LOOT)
  if (!p.bag) p.bag = { items: {}, equipped: {} }
  fakeAddItem(p.bag, item, 1)
  return { type: 'flavor', ...evMeta(p), txt: `【秘境】${who} ${p.name} 探索秘境，寻得【${item}】` }
}
/* 41b.好友结伴探索秘境(同门/好友/之交好友同行, 各有所获) */
function genSecretWith (f, t) {
  const a = pickBy(f, p => p.alive && !p.realmBusy && p.status === 'sect' && p.sect && sectAlive(f, p.sect).length > 1)
  if (!a) return null
  const relPool = relPoolOf(f, a, true)
  if (!relPool.length) return null
  const bName = pick(relPool)
  const b = f.roster[bName]
  if (!a.bag) a.bag = { items: {}, equipped: {} }
  if (!b.bag) b.bag = { items: {}, equipped: {} }
  const itemA = pick(SECRET_LOOT)
  const itemB = pick(SECRET_LOOT)
  fakeAddItem(a.bag, itemA, 1)
  fakeAddItem(b.bag, itemB, 1)
  const whoA = sectName(f, a.sect)
  return { type: 'flavor', ...evWho([a, b]), txt: `【同行】${whoA} ${a.name} 与 ${bName} 结伴探索秘境，各有所获（${a.name}得【${itemA}】／${bName}得【${itemB}】）` }
}
/* 41c.好友结伴劫修(2打1): 两个好友/之交好友联手劫落单者 */
function genTeamRob (f, t) {
  const leader = pickBy(f, p => p.alive && (p.path === '魔道' || p.trait === '嗜杀' || p.trait === '好斗'))
  if (!leader) return null
  const mates = relPoolOf(f, leader, false).filter(n => n !== leader.name)
  if (!mates.length) return null
  const mateName = pick(mates)
  const mate = f.roster[mateName]
  const v = pickVictim(f, leader.name)
  if (!v || v.name === mateName) return null
  const whoL = leader.status === 'sect' && leader.sect ? sectName(f, leader.sect) : '散修'
  const whoM = mate.status === 'sect' && mate.sect ? sectName(f, mate.sect) : '散修'
  const whoV = v.status === 'sect' && v.sect ? sectName(f, v.sect) : '散修'
  if (shouldKill(f, leader, v)) {
    const loot = robSpoils(f, leader, v)
    const lootTxt = loot.length ? `，劫得 ${loot.join('、')}` : ''
    killWithGrudge(f, leader, v, `【劫修】${whoL} ${leader.name} 与好友 ${whoM} ${mateName} 联手劫杀落单的 ${whoV} ${v.name}${lootTxt}！`, t)
    return null
  }
  const gold = Math.min((v.money || 0), rand([100, 1500]))
  if (gold > 0) {
    v.money -= gold
    const half = Math.floor(gold / 2)
    leader.money = (leader.money || 0) + half
    mate.money = (mate.money || 0) + (gold - half)
    return { type: 'rob', ...evWho([leader, mate, v]), txt: `【劫修】${whoL} ${leader.name} 与好友 ${whoM} ${mateName} 联手围住 ${whoV} ${v.name}，抢走 ${gold} 灵石` }
  }
  const items = v.bag && v.bag.items ? Object.keys(v.bag.items) : []
  if (!items.length) return null
  const item = pick(items)
  if (!leader.bag) leader.bag = { items: {}, equipped: {} }
  if (!fakeTransferEntry(v.bag, leader.bag, item)) return null
  return { type: 'rob', ...evWho([leader, mate, v]), txt: `【劫修】${whoL} ${leader.name} 与好友 ${whoM} ${mateName} 联手围住 ${whoV} ${v.name}，抢走【${item}】` }
}
/* 41d.结为知己(同门情深/一见如故 → 之交好友) */
function genBond (f, t) {
  const a = pickAlive(f)
  if (!a) return null
  const r = a.relations || (a.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], confidants: [], siblings: [], kin: [] })
  const pool = relPoolOf(f, a, true).map(n => f.roster[n]).filter(Boolean)
  if (!pool.length) return null
  const b = pick(pool)
  if (b.name === a.name) return null
  if (!b.relations) b.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], confidants: [], kin: [] }
  if (!r.friends.includes(b.name)) {
    r.friends.push(b.name)
    if (!b.relations.friends.includes(a.name)) b.relations.friends.push(a.name)
  }
  const sameSect = a.status === 'sect' && a.sect && a.sect === b.sect
  if ((sameSect || r.spouse === b.name) && !(r.confidants || []).includes(b.name)) {
    if (!r.confidants) r.confidants = []
    r.confidants.push(b.name)
    if (!b.relations.confidants) b.relations.confidants = []
    if (!b.relations.confidants.includes(a.name)) b.relations.confidants.push(a.name)
  }
  const whoA = a.status === 'sect' && a.sect ? sectName(f, a.sect) : '散修'
  return { type: 'flavor', ...evWho([a, b]), txt: `【知己】${whoA} ${a.name} 与 ${b.name} ${sameSect ? '同门情深' : '一见如故'}，结为之交好友` }
}
/* 41e.结仇化解(仇人放下恩怨, 同门更易和解) */
function genReconcile (f, t) {
  const a = pickBy(f, p => p.alive && (p.relations && (p.relations.enemies || []).length))
  if (!a) return null
  const enemies = (a.relations.enemies || []).filter(n => n !== a.name && f.roster[n] && f.roster[n].alive)
  if (!enemies.length) return null
  const bName = pick(enemies)
  const b = f.roster[bName]
  const sameSect = a.status === 'sect' && a.sect && a.sect === b.sect
  if (Math.random() >= (sameSect ? 0.5 : 0.35)) return null
  a.relations.enemies = (a.relations.enemies || []).filter(n => n !== bName)
  if (b.relations) b.relations.enemies = (b.relations.enemies || []).filter(n => n !== a.name)
  if (sameSect && Math.random() < 0.5) {
    if (!a.relations.friends.includes(bName)) a.relations.friends.push(bName)
    if (!b.relations.friends.includes(a.name)) b.relations.friends.push(a.name)
  }
  const whoA = a.status === 'sect' && a.sect ? sectName(f, a.sect) : '散修'
  const whoB = b.status === 'sect' && b.sect ? sectName(f, b.sect) : '散修'
  return { type: 'flavor', ...evWho([a, b]), txt: `【和解】${whoA} ${a.name} 与 ${whoB} ${b.name} 放下恩怨，${sameSect ? '同门重归于好' : '化干戈为玉帛'}` }
}
/* 42.变卖(玩家化: 卖背包物品换灵石, 只卖自己的) */
function genSell (f, t) {
  const p = pickBy(f, x => x.alive && x.bag && x.bag.items && Object.keys(x.bag.items).length)
  if (!p) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  const item = pick(Object.keys(p.bag.items))
  fakeTakeItem(p.bag, item)
  const price = GONGFA_TPL[item] ? gongfaPrice(item) : (ITEM_TPL[item] ? (ITEM_PRICE[item] || 50) : 50)
  const gain = Math.max(10, Math.floor(price / 2))
  p.money = (p.money || 0) + gain
  return { type: 'flavor', ...evMeta(p), txt: `【变卖】${who} ${p.name} 将 ${item} 变卖，得 ${gain} 灵石` }
}
/* 43.夺爱(玩家化: 恶人抢他人道侣, 只抢伪玩家的道侣) */
function genStealWife (f, t) {
  const k = pickBy(f, p => p.path === '魔道' || p.trait === '嗜杀' || p.trait === '好斗')
  if (!k) return null
  const target = pickBy(f, p => p.alive && p.name !== k.name && p.relations && p.relations.spouse && f.roster[p.relations.spouse] && f.roster[p.relations.spouse].alive)
  if (!target) return null
  const spouse = f.roster[target.relations.spouse]
  const whoK = k.status === 'sect' && k.sect ? sectName(f, k.sect) : '散修'
  const whoT = target.status === 'sect' && target.sect ? sectName(f, target.sect) : '散修'
  target.relations.spouse = null
  if (!spouse.relations) spouse.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], kin: [] }
  spouse.relations.spouse = k.name
  if (!k.relations) k.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], kin: [] }
  k.relations.spouse = spouse.name
  target.relations.enemies = (target.relations.enemies || []).concat(k.name)
  return { type: 'flavor', ...evWho([k, target, spouse]), txt: `【夺爱】${whoK} ${k.name} 强夺了 ${whoT} ${target.name} 的道侣 ${spouse.name}，结为道侣！` }
}
/* 44.情变(玩家化: 道侣感情破裂反目成仇) */
function genBreakup (f, t) {
  const a = pickBy(f, p => p.alive && p.relations && p.relations.spouse && f.roster[p.relations.spouse] && f.roster[p.relations.spouse].alive)
  if (!a) return null
  const b = f.roster[a.relations.spouse]
  const whoA = a.status === 'sect' && a.sect ? sectName(f, a.sect) : '散修'
  const whoB = b.status === 'sect' && b.sect ? sectName(f, b.sect) : '散修'
  a.relations.spouse = null
  if (b.relations) b.relations.spouse = null
  a.relations.enemies = (a.relations.enemies || []).concat(b.name)
  if (b.relations) b.relations.enemies = (b.relations.enemies || []).concat(a.name)
  return { type: 'flavor', ...evWho([a, b]), txt: `【情变】${whoA} ${a.name} 与道侣 ${whoB} ${b.name} 感情破裂，反目成仇` }
}
/* 47.天才(宗门弟子天赋异禀, 灵力一日千里, 修为走玩家体系) */
function genProdigy (f, t) {
  const p = pickBy(f, x => x.status === 'sect' && x.pos === 'dizi' && x.level >= 5)
  if (!p) return null
  const gain = rand([200, 500])
  addExp(p, gain)
  return { type: 'break', ...evMeta(p), txt: `【天才】${sectName(f, p.sect)}弟子 ${p.name} 天赋异禀，修炼一日千里（灵力+${gain}）` }
}
/* 48.灵潮(天降灵气潮, 全宗灵力大涨) */
function genHeavenly (f, t) {
  const ids = Object.keys(f.sects).filter(id => sectAlive(f, id).length > 0)
  if (!ids.length) return null
  const id = pick(ids)
  let n = 0
  const got = []
  for (const p of sectAlive(f, id)) {
    if (Math.random() < 0.5) { addExp(p, rand([20, 60])); n++; got.push(p) }
  }
  return { type: 'flavor', ...evWho(got), sect: id, txt: `【灵潮】灵气潮汐席卷${sectName(f, id)}，${n} 位修士灵力大涨` }
}
/* 49.遗迹(上古遗迹现世, 得宝/灵力机缘) */
function genRelic (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  if (Math.random() < 0.5) {
    const gain = rand([100, 300])
    addExp(p, gain)
    return { type: 'fortune', ...evMeta(p), txt: `【遗迹】${who} ${p.name} 探得上古遗迹，灵力大涨（+${gain}）` }
  }
  const item = pick(SECRET_LOOT)
  if (!p.bag) p.bag = { items: {}, equipped: {} }
  fakeAddItem(p.bag, item, 1)
  return { type: 'fortune', ...evMeta(p), txt: `【遗迹】${who} ${p.name} 于上古遗迹寻得【${item}】` }
}
/* 50.心魔(高修为修士心魔滋生, 修为大跌或疯魔伤人) */
function genHeartDemon (f, t) {
  const p = pickBy(f, x => x.level >= 20)
  if (!p) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  if (Math.random() < 0.6) {
    return { type: 'backfire', ...evMeta(p), txt: `【心魔】${who} ${p.name} 心魔滋生，险些走火（幸而压制，灵力无损）` }
  }
  const v = pickAlive(f, p.name)
  if (!v) return null
  p.kills = (p.kills || 0) + 1
  killPerson(f, v, `【心魔】${who} ${p.name} 走火入魔，错杀 ${v.name}`, t)
  return null
}
/* 52.结盟(两宗缔结盟约联姻, 门人结为道侣) */
function genAlliance (f, t) {
  const ids = Object.keys(f.sects).filter(id => sectAlive(f, id).length > 0)
  if (ids.length < 2) return null
  /* 宗门文化: 平和/善良宗主宗门更易结盟(加权优先), 好斗/嗜杀/魔修宗门好战结盟意愿低 */
  const peaceLoving = ids.filter(id => {
    const zz = f.sectMap[id] && f.sectMap[id].zongzhu ? f.roster[f.sectMap[id].zongzhu] : null
    return zz && (zz.trait === '平和' || zz.trait === '善良')
  })
  if (peaceLoving.length && Math.random() < 0.45) {
    const a = pick(peaceLoving)
    const b = pick(ids.filter(x => x !== a))
    return genAlliancePair(f, a, b, t)
  }
  const a = pick(ids)
  const b = pick(ids.filter(x => x !== a))
  /* 好战宗门不喜结盟 */
  for (const id of [a, b]) {
    const zz = f.sectMap[id] && f.sectMap[id].zongzhu ? f.roster[f.sectMap[id].zongzhu] : null
    if (zz && (zz.trait === '好斗' || zz.trait === '嗜杀') && Math.random() < 0.5) return null
  }
  return genAlliancePair(f, a, b, t)
}
/** 结盟具体实现(两宗联姻道侣) */
function genAlliancePair (f, a, b, t) {
  const ma = pick(sectAlive(f, a))
  const mb = pick(sectAlive(f, b))
  if (!ma || !mb) return null
  if (!ma.relations) ma.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], kin: [] }
  if (!mb.relations) mb.relations = { master: null, disciples: [], spouse: null, enemies: [], friends: [], kin: [] }
  ma.relations.spouse = mb.name
  mb.relations.spouse = ma.name
  return { type: 'flavor', major: true, ...evWho([ma, mb]), sect: a, txt: `【结盟】${sectName(f, a)} 与 ${sectName(f, b)} 缔结盟约，${ma.name} 与 ${mb.name} 结为道侣，两宗交好` }
}
/* 53.兽潮(妖兽潮袭击宗门, 弟子死伤) */
function genBeastTide (f, t) {
  const ids = Object.keys(f.sects).filter(id => sectAlive(f, id).length > 0)
  if (!ids.length) return null
  const id = pick(ids)
  const name = sectName(f, id)
  const ld = randomMember(f, id)
  if (ld) {
    killPerson(f, ld, `【兽潮】妖兽潮袭击${name}，弟子 ${ld.name} 战死`, t)
    return null
  }
  const guard = randomMember(f, id)
  return { type: 'flavor', major: true, ...evWho(guard), sect: id, txt: `【兽潮】妖兽潮来袭，${name} 众志成城守御山门` }
}
/* 54.传功(隐世高人指点, 灵力大涨) */
function genMaster (f, t) {
  const p = pickAlive(f)
  if (!p) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  const gain = rand([80, 200])
  addExp(p, gain)
  return { type: 'flavor', ...evMeta(p), txt: `【传功】${who} ${p.name} 得隐世高人指点，灵力大涨（+${gain}）` }
}
/* 55.试炼(宗门试炼大比, 胜者受赏灵力) */
function genTrial (f, t) {
  const ids = Object.keys(f.sects).filter(id => sectAlive(f, id).length >= 3)
  if (!ids.length) return null
  const id = pick(ids)
  const winner = [...sectAlive(f, id)].sort((a, b) => b.level - a.level)[0]
  if (!winner) return null
  const gain = rand([60, 150])
  addExp(winner, gain)
  if (!winner.bag) winner.bag = { items: {}, equipped: {} }
  fakeAddItem(winner.bag, '修为丹', 1)
  return { type: 'flavor', ...evMeta(winner), txt: `【试炼】${sectName(f, id)}举行试炼大比，${winner.name} 拔得头筹，获宗门嘉奖（灵力+${gain}、${itemIcon('修为丹')}修为丹）` }
}
/* 56.疫病(宗门疫病蔓延, 弟子染病灵力受损) */
function genPlague (f, t) {
  const ids = Object.keys(f.sects).filter(id => sectAlive(f, id).length > 0)
  if (!ids.length) return null
  const id = pick(ids)
  const sick = pick(sectAlive(f, id))
  if (!sick) return null
  return { type: 'backfire', major: true, ...evMeta(sick), txt: `【疫病】${sectName(f, id)}爆发疫病，${sick.name} 染病（休养数日，灵力无损）` }
}
/* 57.内斗(宗门派系内斗, 有人负气出走沦为散修) */
function genFaction (f, t) {
  const ids = Object.keys(f.sects).filter(id => sectAlive(f, id).length >= 4)
  if (!ids.length) return null
  const id = pick(ids)
  const leaver = pick(sectAlive(f, id).filter(p => p.pos === 'dizi' || p.pos === 'zhishi'))
  if (!leaver) return null
  removeFromSectMap(f, id, leaver.name)
  leaver.status = 'scatter'
  leaver.sect = null
  leaver.pos = null
  return { type: 'flavor', ...evMeta(leaver), txt: `【内斗】${sectName(f, id)}派系内斗，${leaver.name} 负气出走，沦为散修` }
}
/* 58.夺宝(高修为恶人强夺他人宝物) */
function genLoot (f, t) {
  const k = pickBy(f, x => x.level >= 20 && (x.path === '魔道' || x.trait === '嗜杀' || x.trait === '好斗'))
  if (!k) return null
  const v = pickBy(f, x => x.alive && x.name !== k.name && x.bag && x.bag.items && Object.keys(x.bag.items).length)
  if (!v) return null
  const item = pick(Object.keys(v.bag.items))
  if (!k.bag) k.bag = { items: {}, equipped: {} }
  if (!fakeTransferEntry(v.bag, k.bag, item)) return null
  const whoK = k.status === 'sect' && k.sect ? sectName(f, k.sect) : '散修'
  const whoV = v.status === 'sect' && v.sect ? sectName(f, v.sect) : '散修'
  return { type: 'rob', ...evWho([k, v]), txt: `【夺宝】${whoK} ${k.name} 强夺了 ${whoV} ${v.name} 的【${item}】` }
}
/* 59.交易(玩家化: 伪玩家之间互易, 钱换物或以物易物; 同步进天下大事+江湖交易) */
function genTrade (f, t) {
  const a = pickAlive(f)
  if (!a) return null
  const b = pickAlive(f, a.name)
  if (!b) return null
  const whoA = a.status === 'sect' && a.sect ? sectName(f, a.sect) : '散修'
  const whoB = b.status === 'sect' && b.sect ? sectName(f, b.sect) : '散修'
  /* 钱换物: A 花钱向 B 买一件背包物品(市价8折) */
  if (Math.random() < 0.5) {
    const bItems = b.bag && b.bag.items ? Object.keys(b.bag.items) : []
    if (!bItems.length) return null
    const item = pick(bItems)
    const price = GONGFA_TPL[item] ? gongfaPrice(item) : (ITEM_TPL[item] ? (ITEM_PRICE[item] || 50) : 50)
    const cost = Math.max(20, Math.floor(price * 0.8))
    if ((a.money || 0) < cost) return null
    a.money -= cost
    /* 买家花费不变; 卖家按所在大区税率缴税(税计入该大区繁荣度) */
    const w = getWorld(f.gid)
    const bl = b.loc || DEFAULT_REGION
    const rate = taxFor(w, bl, b.sect ? sectName(f, b.sect) : null)
    const tax = Math.max(1, Math.round(cost * rate / 100))
    b.money = (b.money || 0) + (cost - tax)
    addTax(w, bl, tax)
    saveWorld(w)
    if (!a.bag) a.bag = { items: {}, equipped: {} }
    if (!fakeTransferEntry(b.bag, a.bag, item)) return null
    const txt = `【交易】${whoA} ${a.name} 花 ${cost} 灵石向 ${whoB} ${b.name} 购得 ${item} ×1（${regionNameOf(bl)}税率${rate}%，卖家缴税${tax}灵石）`
    logTrade(f, txt)
    return { type: 'trade', ...evWho([a, b]), txt }
  }
  /* 以物易物: A 拿自己一件物品换 B 一件物品 */
  const aItems = a.bag && a.bag.items ? Object.keys(a.bag.items) : []
  const bItems = b.bag && b.bag.items ? Object.keys(b.bag.items) : []
  if (!aItems.length || !bItems.length) return null
  const aItem = pick(aItems)
  const bItem = pick(bItems)
  const aEntry = fakeTakeEntry(a.bag, aItem)
  const bEntry = fakeTakeEntry(b.bag, bItem)
  if (!aEntry || !bEntry) return null
  fakeAddItem(a.bag, bEntry.name, 1, bEntry.attr)
  fakeAddItem(b.bag, aEntry.name, 1, aEntry.attr)
  const txt = `【交易】${whoA} ${a.name} 用 ${aItem} 与 ${whoB} ${b.name} 换得 ${bItem}`
  logTrade(f, txt)
  return { type: 'trade', ...evWho([a, b]), txt }
}
/* 丹药列表(修为/破障/增益) */
const PILL_BONUS = ['惊鸿丹', '玉甲丹', '凝露丹', '慧心丹', '摄魂丹', '聚宝丹', '灵犀丹', '行运丹', '同心丹']
const ALL_PILLS = ['修为丹', '破障丹', ...PILL_BONUS]
/* 丹药战斗效果(与玩家一致): 惊鸿丹攻击+20%等 */
const PILL_BUFF = {
  '惊鸿丹': { atk: 0.2, txt: '攻击+20%' },
  '玉甲丹': { def: 0.2, txt: '防御+20%' },
  '凝露丹': { hp: 0.2, txt: '生命+20%' },
  '慧心丹': { crit: 0.3, txt: '暴击率+30%' },
  '摄魂丹': { cdmg: 0.5, txt: '爆伤+50%' }
}
/** 丹药药效文案(与玩家一致) */
function pillFxTxt (name) {
  if (PILL_BUFF[name]) return PILL_BUFF[name].txt
  if (name === '灵犀丹') return '双修收益翻倍'
  if (name === '行运丹') return '挂机收益翻倍'
  if (name === '聚宝丹') return '幸运提升'
  if (name === '同心丹') return '道侣好感+1000'
  return ''
}
/* 62.服丹(伪玩家: 消耗背包丹药, 修为丹涨灵力/破障丹破瓶颈/增益丹12h战力+5) */
function genPill (f, t) {
  const p = pickBy(f, x => x.alive && x.bag && x.bag.items && Object.keys(x.bag.items).some(n => ALL_PILLS.includes(n)))
  if (!p) return null
  return pillPerson(f, p)
}
/** 指定人吃丹(背包有丹吃, 每人90分钟一次; 破障丹仅突破时用, 灵力不足留着)
 *  增益丹(战斗/生活)一律不吃——只留给打架时(fakeCombatPill)用, 平时省着 */
export function pillPerson (f, p) {
  const now = Date.now()
  if (!p.activities) p.activities = {}
  const pills = p.bag && p.bag.items ? Object.keys(p.bag.items).filter(n => ['修为丹', '破障丹'].includes(n)) : []
  if (!pills.length) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  const band = levelBand(p)
  const canBreak = (p.exp || 0) >= fakeSubThreshold(p.level + 1) && p.level < band[1]
  /* 丹药决策(知道好坏): 修为丹=修炼刚需随时吃; 破障丹=灵力达标才吃(90%破境), 否则省着;
   *  增益丹一律不吃留打架(fakeCombatPill) */
  const has = (n) => pills.includes(n)
  let pill = null
  if (canBreak) {
    /* 灵力达标可突破: 破障丹最优先, 没有则吃修为丹冲灵力 */
    pill = has('破障丹') ? '破障丹' : '修为丹'
  } else {
    /* 灵力不足: 吃修为丹攒灵力; 没有则省着(破障丹留给突破, 增益丹留给打架) */
    pill = has('修为丹') ? '修为丹' : null
  }
  if (!pill) return null // 没有值得现在吃的 → 攒着
  fakeTakeItem(p.bag, pill)
  if (pill === '修为丹') {
    p.activities.lastPill2 = now + rand([30, 60]) * 60000 // 吃丹冷却30~60分钟
    addExp(p, 200)
    return { type: 'flavor', ...evMeta(p), txt: `【服丹】${who} ${p.name} 服下${itemIcon('修为丹')}修为丹，灵力大涨（+200）` }
  }
  if (pill === '破障丹') {
    p.activities.lastPill2 = now + rand([30, 60]) * 60000 // 吃丹冷却30~60分钟
    /* 玩家一致: 破障丹突破成功率90% (此时灵力已达标) */
    if (Math.random() * 100 <= 90) {
      const oldRealm = Math.floor((p.level - 1) / 4)
      p.level++
      mergeAccum(p) // 突破并入累计池
      const major = Math.floor((p.level - 1) / 4) > oldRealm
      return { type: 'break', major, ...evMeta(p), txt: `【服丹】${who} ${p.name} 服下${itemIcon('破障丹')}破障丹，冲破瓶颈，突破至${levelNameOf(p.level)}！` }
    }
    return { type: 'backfire', ...evMeta(p), txt: `【服丹】${who} ${p.name} 服下${itemIcon('破障丹')}破障丹冲击瓶颈，惜败未破境` }
  }
  return { type: 'flavor', ...evMeta(p), txt: `【服丹】${who} ${p.name} 服下${pill}` }
}

/* 仙帝丹: 玩家不可服用(可自由交易); 伪玩家拿到后自动服用, 直接升到仙帝第10重(level 78) */
export const EMPEROR_PILL = '仙帝丹'
export const EMPEROR_TARGET_LEVEL = 78
export function fakeEatEmperorPill (f, p, now = Date.now()) {
  if (!p || !p.bag || !p.bag.items) return null
  if (itemCount(p.bag.items[EMPEROR_PILL]) <= 0) return null
  if ((Number(p.level) || 0) >= EMPEROR_TARGET_LEVEL) return null
  if (!fakeTakeItem(p.bag, EMPEROR_PILL)) return null
  p.level = EMPEROR_TARGET_LEVEL
  p.levelname = levelNameOf(p.level)
  p.exp = Math.max(Number(p.exp) || 0, fakeSubThreshold(p.level))
  return { type: 'break', major: true, ...evMeta(p), txt: `【突破】${p.name} 服下${itemIcon(EMPEROR_PILL)}仙帝丹，一步登临${levelNameOf(p.level)}！` }
}
/** 伪玩家打架前吃增益丹(出征/守城/驰援参战时调用): 从背包挑一颗战斗增益丹(惊鸿/玉甲/凝露/慧心/摄魂)服下, 提升战力; 返回是否吃了 */
export function fakeCombatPill (f, p) {
  try {
    if (!p || !p.bag || !p.bag.items) return false
    const now = Date.now()
    const combatPills = ['惊鸿丹', '玉甲丹', '凝露丹', '慧心丹', '摄魂丹']
    const name = combatPills.find(n => itemCount(p.bag.items[n]) > 0)
    if (!name) return false
    fakeTakeItem(p.bag, name)
    p.pill = { name, until: now + 3600000 }
    const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
    try { logEvent(f, 'flavor', `【服丹】${who} ${p.name} 临战服下${itemIcon(name)}${name}，${pillFxTxt(name)}（持续1小时）`, now, { onlyPerson: true, ...evMeta(p) }) } catch (err) { }
    return true
  } catch (err) { return false }
}
/* 60.穿戴(伪玩家: 把背包里最好的装备穿上, 获得战力加成) */
/** 功法好坏评分: 品质为主, 同品质比战力相关效果(攻击/防御/生命加成) */
function gongfaScore (name) {
  const t = GONGFA_TPL[name]
  if (!t) return 0
  const fx = t.fx || {}
  const powerFx = (fx.atk || 0) + (fx.def || 0) + (fx.hp || 0)
  return (t.quality || 0) * 100000 + Math.round(powerFx * 1000)
}
function genEquip (f, t) {
  const p = pickBy(f, x => x.alive && x.bag && x.bag.items && Object.keys(x.bag.items).some(n => EQUIP_TPL[n]))
  if (!p) return null
  const worn = equipPerson(f, p)
  if (!worn) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  return { type: 'flavor', ...evMeta(p), txt: `【穿戴】${who} ${p.name} 换上【${worn}】，实力大增` }
}
/* 61.运转功法(伪玩家: 运转已学里最好的功法, 战力加成最高) */
function runBestGongfa (f, p) {
  if (!p.learnedGongfa || !p.learnedGongfa.length) return ''
  const best = p.learnedGongfa.slice().sort((a, b) => gongfaScore(b) - gongfaScore(a))[0]
  if (!best || best === p.activeGongfa) return '' // 已运转最好的, 不重复
  p.activeGongfa = best
  return best
}
function genRunGongfa (f, t) {
  const p = pickBy(f, x => x.alive && x.learnedGongfa && x.learnedGongfa.length)
  if (!p) return null
  const best = runBestGongfa(f, p)
  if (!best) return null
  const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
  return { type: 'flavor', ...evMeta(p), txt: `【运转】${who} ${p.name} 运转功法《${best}》，实力大增` }
}
/* 伪玩家自动穿戴: 把背包里各部位评分最高的装备穿上(知道好坏, 换装旧装备还回背包不丢失); 返回本次穿上的装备名 */
function equipPerson (f, p) {
  if (!p) return ''
  const changed = fakeAutoEquip(p)
  return changed.join('、')
}
/** 事件生成器池(只保留伪玩家=玩家行为对应的行为事件: 打斗/抢劫/交易/宗门/修炼生活;
 *  奇遇/顿悟/天才/灵潮/遗迹/传功/试炼/兽潮/妖兽/论道/游历/拍卖/坐化/血祭/除魔/追杀/暴毙/收养/内讧/内斗/收徒/复仇/结盟/情变 等玩家没有的"江湖剧情"已移除;
 *  修炼/突破/摆摊/服丹 由 perPersonActs 驱动) */
export const EVENT_GENS = [
  /* 战斗/打劫(骑砍2式: 切磋/仇杀/杀人越货/打劫/劫道) */
  genFight, genMurder, genRobKill, genRob, genAmbush,
  /* 宗门(加入/离开/叛逃/散修开宗立派/迎新结缘/灭门复仇) */
  genBetray, genLeave, genScatterJoin, genScatterFoundSect, genWelcome, genVendetta,
  /* 关系(结怨/结为道侣/抢道侣/知己/手足/师徒互动/和解/同行秘境/结伴劫修) */
  genGrudge, genRomance, genStealWife, genBond, genSibling, genTeacherDisciple, genReconcile, genSecretWith, genTeamRob,
  /* 修炼生活(炼丹/采买/洗劫藏宝阁/远行/赠礼/挂机/低保/上交/双修/互动/修习/秘境/变卖/夺宝/交易) */
  genCraft, genShop, genVaultRob, genTravel, genGift,
  genIdle, genPoor, genSubmit, genShuangxiu, genIntimate, genPractice,
  genSecret, genSell, genLoot, genTrade,
  /* 装备功法(穿戴/运转) */
  genEquip, genRunGongfa,
  /* 修仙世界运行逻辑: 强者欺压(境界压制) */
  genBully
]
/** 每人核心行为(冷却完必执行, 类似玩家指令): 修炼/吃丹/突破/摆摊.
 *  全部只记个人事迹(#查人), 不进天下大事/小事(防突破/修炼刷屏) */
/** 伪玩家是否正在被俘(等处置): 在某个在途/待处置场次的俘虏名单里 → 暂停活动 */
export function isFakeCaptive (f, name) {
  return (f.sectAttacks || []).some(a => {
    const list = (a.captives && a.captives.fakes) || []
    return list.length && list.includes(name)
  })
}
/** 伪玩家是否被关在宗门天牢(无限期) → 暂停活动; 越狱由天牢结算(settleSectJails)驱动 */
export function isInSectJail (f, name) {
  for (const sid of Object.keys(f.sectJails || {})) {
    if ((f.sectJails[sid] || []).some(x => x.name === name)) return true
  }
  return false
}
/** 伪玩家是否被关在藏宝阁天牢(洗劫藏宝阁被抓, 0~120分钟) → 暂停活动 */
export function isInRaidJail (f, name) {
  const now = Date.now()
  return (f.raidJail || []).some(x => x.name === name && x.until > now)
}
/** 藏宝阁天牢当前在押名单(过滤已到期), 供 #天下天牢 展示 */
export function raidJailList (f, now = Date.now()) {
  return (f.raidJail || []).filter(x => x.until > now)
}
/** 藏宝阁天牢结算(每分钟, fakeTick 调用): 到期的自动释放 + 记【出狱】; 有变化返回 true */
export function raidJailSettle (f, now = Date.now()) {
  const arr = f.raidJail || []
  if (!arr.length) return false
  const remain = []
  let changed = false
  for (const x of arr) {
    if (x.until > now) { remain.push(x); continue }
    changed = true
    try {
      logEvent(f, 'raid', `【出狱】${x.name} 藏宝阁天牢刑满，重获自由（共关押约 ${Math.max(1, Math.round((now - (x.at || now)) / 60000))} 分钟）`, now, { who: [x.name] })
    } catch (err) { }
  }
  f.raidJail = remain
  return changed
}
export function fakeVaultSupply (f, p, now = Date.now()) {
  if (!p || p.status !== 'sect' || !p.sect || !p.bag) return false
  const s = f.sects && f.sects[p.sect]
  const vault = s && s.vault
  const contribution = Math.max(0, Number(p.contribution) || 0)
  if (!vault || contribution <= 0) return false
  if (!vault.pills) vault.pills = {}
  if (!vault.equips) vault.equips = {}
  if (!p.bag.items) p.bag.items = {}
  /* 丹药兑换价与宗门兑换一致: 修为丹1贡献, 破障丹2贡献 */
  const canBreak = (p.exp || 0) >= fakeSubThreshold(p.level + 1)
  const pill = canBreak
    ? (itemCount(p.bag.items['破障丹']) <= 0 && (vault.pills['破障丹'] || 0) > 0 && contribution >= 2 ? '破障丹' : null)
    : (itemCount(p.bag.items['修为丹']) < 2 && (vault.pills['修为丹'] || 0) > 0 && contribution >= 1 ? '修为丹' : null)
  const bonusPill = PILL_BONUS.find(name =>
    itemCount(p.bag.items[name]) <= 0 && (vault.pills[name] || 0) > 0 && contribution >= 10)
  const pillName = pill || bonusPill
  if (pillName) {
    const cost = pillName === '破障丹' ? 2 : (pillName === '修为丹' ? 1 : 10)
    vault.pills[pillName]--
    if (vault.pills[pillName] <= 0) delete vault.pills[pillName]
    fakeAddItem(p.bag, pillName, 1)
    p.contribution = contribution - cost
    logEvent(f, 'flavor', `【兑换】${sectName(f, p.sect)} ${p.name} 以${cost}贡献兑换宗门宝库${itemIcon(pillName)}${pillName}`, now, { onlyPerson: true, ...evMeta(p) })
    return true
  }
  /* 装备兑换放在丹药之后, 避免修炼/突破刚需长期被装备占用贡献 */
  const equipScoreOf = n => equipScore(n)
  const equipContribCost = n => Math.max(1, Math.floor(vaultEquipContrib(n) / 10))
  const curScore = {}
  for (const [slot, n] of Object.entries(p.bag.equipped || {})) curScore[slot] = equipScoreOf(n)
  const candidates = Object.keys(vault.equips || {}).filter(n => {
    const t = EQUIP_TPL[n]
    if (!t || (vault.equips[n] || 0) <= 0) return false
    const slot = SLOT_MAP[t.type] || 'weapon'
    return equipScoreOf(n) > (curScore[slot] || 0)
  }).sort((a, b) => equipScoreOf(b) - equipScoreOf(a))
  /* 最高品质买不起时继续尝试次高品质，避免伪玩家长期卡在兑换入口 */
  const name = candidates.find(n => p.contribution >= equipContribCost(n))
  if (name) {
    const cost = equipContribCost(name) // 伪玩家贡献来源有限，按玩家兑换价的1/10结算
    if (cost > 0 && p.contribution >= cost) {
      vault.equips[name]--
      if (vault.equips[name] <= 0) delete vault.equips[name]
      const changed = fakeAddItem(p.bag, name, 1)
      p.contribution -= cost
      if (changed.length) p.activities = { ...(p.activities || {}), lastEquip2: now + rand([10, 30]) * 60000 }
      logEvent(f, 'flavor', `【兑换】${sectName(f, p.sect)} ${p.name} 以${cost}贡献兑换宗门宝库装备${itemIcon(name)}【${name}】`, now, { onlyPerson: true, ...evMeta(p) })
      return true
    }
  }
  return false
}

async function perPersonActs (f, now = Date.now()) {
  for (const p of Object.values(f.roster)) {
    if (!p.alive || p.realmBusy) continue
    /* 仙帝丹: 有就立刻吃, 不受吃丹冷却/被俘/坐牢影响 */
    try {
      const emperorEv = fakeEatEmperorPill(f, p, now)
      if (emperorEv) logEvent(f, emperorEv.type, emperorEv.txt, now, { ...emperorEv })
    } catch (err) { }
    if (isFakeCaptive(f, p.name) || isInSectJail(f, p.name) || isInRaidJail(f, p.name) || isInSectMine(f, p.name)) continue // 被俘/关押/送矿中: 暂停普通活动
    try {
      const acts = p.activities || (p.activities = {})
      const fx = actFx(p)
      /* 修炼: 冷却到 + 性格概率(苦修勤/懒散惰), 未触发也进冷却防重复判定; 只记个人事迹 */
      if (now >= (acts.lastCultivate2 || 0)) {
        if (Math.random() < 0.65 * fx.cult) { const ev = await cultivatePerson(f, p); if (ev) logEvent(f, ev.type, ev.txt, now, { ...ev, onlyPerson: true }) }
        else acts.lastCultivate2 = now + 60 * 60000
      }
      /* 吃丹: 有丹大概率吃(90%) */
      if (now >= (acts.lastPill2 || 0)) {
        if (Math.random() < 0.9) { const ev = pillPerson(f, p); if (ev) logEvent(f, ev.type, ev.txt, now, { ...ev, onlyPerson: true }) }
        else acts.lastPill2 = now + rand([30, 60]) * 60000
      }
      /* 闭关突破: 无冷却, 灵力达标必尝试(连续突破直到灵力不足/失败); 只记个人事迹(#查人), 不进天下大事防刷屏 */
      if (now >= (acts.lastBreak2 || 0)) {
        const ev = await breakPerson(f, p)
        if (ev) logEvent(f, ev.type, ev.txt, now, { ...ev, onlyPerson: true })
      }
      /* 摆摊: 冷却到 + 性格概率(贪玩爱摆摊) */
      if (now >= (acts.lastStall2 || 0)) {
        if (Math.random() < 0.6 * fx.play) { const ev = stallPerson(f, p); if (ev) logEvent(f, ev.type, ev.txt, now, { ...ev, onlyPerson: true }) }
        else acts.lastStall2 = now + 120 * 60000
      }
      /* 穿戴: 冷却到自动把背包最好的装备穿上；无装备时不消耗长冷却，购买后可立即触发 */
      if (now >= (acts.lastEquip2 || 0)) {
        try {
          const worn = equipPerson(f, p)
          acts.lastEquip2 = now + (worn ? rand([10, 30]) : 5) * 60000
          if (worn) {
            const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
            logEvent(f, 'flavor', `【穿戴】${who} ${p.name} 换上 ${worn}，实力大增`, now, { onlyPerson: true, ...evMeta(p) })
          }
        } catch (err) { }
      }
      /* 运转功法: 冷却到(10~30分钟)自动运转已学中最好的功法(战力最大化; 用户要求意愿改大, 原30~90) */
      if (now >= (acts.lastRunGongfa2 || 0)) {
        acts.lastRunGongfa2 = now + rand([10, 30]) * 60000
        try {
          const gf = runBestGongfa(f, p)
          if (gf) {
            const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
            logEvent(f, 'flavor', `【运转】${who} ${p.name} 运转功法${itemIcon(gf)}《${gf}》，实力大增`, now, { onlyPerson: true, ...evMeta(p) })
          }
        } catch (err) { }
      }
      /* 上供: 宗门成员伪玩家冷却到(3~8小时)向宗门上供灵石/材料, 得贡献点
       *  材料很大概率(80%)全部上交宗门——宗门材料来源=弟子秘境所得上交, 不凭空生成 */
      if (p.status === 'sect' && p.sect && now >= (acts.lastOffer2 || 0)) {
        acts.lastOffer2 = now + rand([3, 8]) * 3600000
        try {
          const s = f.sects && f.sects[p.sect]
          if (s && s.vault) {
            const who = sectName(f, p.sect)
            const matNames = Object.keys(p.bag && p.bag.items ? p.bag.items : {}).filter(n => MATERIAL_TPL[n] && itemCount(p.bag.items[n]) > 0)
            /* 灵石优先: 伪玩家先通过灵石上供获得贡献；只有灵石不足时才上交材料 */
            if ((p.money || 0) >= 500) {
              /* 从可支配余额中按5%~15%上供，保留最低100灵石，避免浮点rand产生105%上供 */
              const reserve = 100
              const spendable = Math.max(0, Math.floor((p.money || 0) - reserve))
              const pct = rand([5, 15])
              const amt = Math.min(spendable, Math.floor((p.money || 0) * pct / 100))
              if (amt >= 100) {
                p.money -= amt
                s.vault.stones = (s.vault.stones || 0) + amt
                const contrib = Math.floor(amt / 100)
                p.contribution = (p.contribution || 0) + contrib
                logEvent(f, 'flavor', `【上供】${who} ${p.name} 上供 ${amt} 灵石，得贡献 +${contrib}`, now, { onlyPerson: true, ...evMeta(p) })
              }
            } else if (matNames.length) {
              /* 灵石不足: 上供1件材料；材料只入宝库，不产生贡献 */
              const m = pick(matNames)
              fakeTakeItem(p.bag, m)
              
              if (!s.vault.mats) s.vault.mats = {}
              s.vault.mats[m] = (s.vault.mats[m] || 0) + 1
              logEvent(f, 'flavor', `【上供】${who} ${p.name} 上供 ${itemIcon(m)}${m}×1（材料上供不计贡献）`, now, { onlyPerson: true, ...evMeta(p) })
            }
          }
        } catch (err) { }
      }
      /* 不依赖上供时机：普通弟子按独立冷却持续购买宗门宝库资源 */
      if (p.status === 'sect' && p.sect && now >= (acts.lastVaultSupply2 || 0)) {
        acts.lastVaultSupply2 = now + rand([30, 90]) * 60000
        try { fakeVaultSupply(f, p, now) } catch (err) { }
      }
      /* 取用宗门金库: AI 宗门核心职位人员(宗主/副宗/太上/执事)冷却到(2~6小时)取灵石自用——位高权重者动用宗门资源, 与玩家核心职位#取用宝库一致 */
      if (p.status === 'sect' && p.sect && now >= (acts.lastVaultTake || 0)) {
        acts.lastVaultTake = now + rand([2, 6]) * 3600000
        try {
          const s = f.sects && f.sects[p.sect]
          if (s && !s.owner && s.vault && (s.vault.stones || 0) > 0) {
            const rate = { zongzhu: 0.12, taishang: 0.12, fuzong: 0.08, zhishi: 0.05 }[p.pos] || 0
            if (rate > 0) {
              const take = Math.min(Math.floor((s.vault.stones || 0) * rate), 20000)
              if (take >= 100) {
                s.vault.stones -= take
                p.money = (p.money || 0) + take
                const who = sectName(f, p.sect)
                logEvent(f, 'flavor', `【取用】${who}${POS[p.pos].cn} ${p.name} 取用宗门金库 ${take} 灵石`, now, { onlyPerson: true, ...evMeta(p) })
              }
            }
          }
        } catch (err) { }
      }
    } catch (err) { }
  }
}
export async function runPersonActs (f, now = Date.now()) { return perPersonActs(f, now) }
/* 宗门炼丹丹方(与玩家配方台 mix.js RECIPES 一致; 只用药材; 修为丹/破障丹无丹方不炼, 只能战利品/丹阁采购获得) */
const SECT_RECIPES = {
  '惊鸿丹': [['望舒花', 1], ['星霜草', 2]],
  '聚宝丹': [['凤栖花', 1], ['青鸾草', 2]],
  '灵犀丹': [['月华芝', 1], ['星霜草', 2]],
  '行运丹': [['望舒花', 1], ['月华芝', 1]],
  '同心丹': [['月华芝', 1], ['青鸾草', 2]],
  '玉甲丹': [['凤栖花', 1], ['月华芝', 1]],
  '凝露丹': [['凤栖花', 1], ['星霜草', 2]],
  '慧心丹': [['凤栖花', 1], ['望舒花', 1]],
  '摄魂丹': [['望舒花', 1], ['青鸾草', 2]]
}
/** 宗门资源自用流转(宗门, 每30分钟): 按丹方炼丹/炼红装彩装给核心弟子、弟子按需取丹、服用增益丹——位高者用最好; 玩家宗门同样流转(作用于伪玩家弟子) */
function sectResourceFlow (f, now = Date.now()) {
  for (const [sid, s] of Object.entries(f.sects || {})) {
    if (!s || s.wipeAt) continue // AI 与玩家宗门都流转
    const vault = s.vault || (s.vault = { stones: 0, mats: {}, pills: {}, equips: {} })
    if (!vault.mats) vault.mats = {}
    if (!vault.pills) vault.pills = {}
    if (!vault.equips) vault.equips = {}
    const sm = f.sectMap && f.sectMap[sid]
    if (!sm) continue
    const members = sectAlive(f, sid)
    if (!members.length) continue
    /* 1. 炼丹(按丹方, 只炼有丹方的丹药; 修为丹/破障丹无丹方不炼, 只能战利品/丹阁采购获得) */
    for (const [pill, mats] of Object.entries(SECT_RECIPES)) {
      if ((vault.pills[pill] || 0) >= 3) continue
      if (mats.some(([m, c]) => (vault.mats[m] || 0) < c)) continue
      for (const [m, c] of mats) { vault.mats[m] -= c; if (vault.mats[m] <= 0) delete vault.mats[m] }
      vault.pills[pill] = (vault.pills[pill] || 0) + 1
    }
    /* 2. 核心弟子用最好: 炼红装/彩装赐予核心(职位优先级), 材料与玩家配方一致(红装=5种非彩色矿物各1, 彩装=6造梦神玉) */
    const RED_ORE = ['月魄石', '星璇石', '流光玉', '织云石', '凤羽玉']//与玩家红装配方一致
    const COLOR_ORE = '造梦神玉'//与玩家彩装配方一致的彩色矿物
    const reds = Object.keys(EQUIP_TPL).filter(k => EQUIP_TPL[k].quality === 6)
    const colors = Object.keys(EQUIP_TPL).filter(k => EQUIP_TPL[k].quality === 7)
    for (const pos of ['zongzhu', 'taishang', 'fuzong', 'zhishi']) {
      const names = Array.isArray(sm[pos]) ? sm[pos] : (sm[pos] ? [sm[pos]] : [])
      for (const n of names) {
        const p = f.roster[n]
        if (!p || !p.alive) continue
        if (!p.bag) p.bag = { items: {}, equipped: {} }
        if (!p.bag.equipped) p.bag.equipped = {}
        const cur = Math.max(0, ...Object.values(p.bag.equipped).map(en => (EQUIP_TPL[en] ? EQUIP_TPL[en].quality : 0)))
        /* 彩装(6造梦神玉, 核心职位专属, 与玩家彩装同用彩色矿物): 身上无彩且够材料 */
        if (colors.length && cur < 7 && (vault.mats[COLOR_ORE] || 0) >= 6 && ['zongzhu', 'fuzong', 'taishang'].includes(pos)) {
          vault.mats[COLOR_ORE] -= 6
          if (vault.mats[COLOR_ORE] <= 0) delete vault.mats[COLOR_ORE]
          const c = pick(colors)
          const changed = fakeAddItem(p.bag, c, 1, rollEquipAttr(EQUIP_TPL[c].type, EQUIP_TPL[c].quality))
          if (changed.length) p.activities = { ...(p.activities || {}), lastEquip2: now + rand([10, 30]) * 60000 }
          logEvent(f, 'promote', `【炼宝】${sectName(f, sid)} 举宗之力炼成彩装${itemIcon(c)}【${c}】，献予${POS[pos].cn} ${p.name}`, now, { who: [p.name], sect: sid })
          continue
        }
        /* 红装(5种非彩色矿物各1, 与玩家红装配方一致): 身上无红且够材料 */
        if (reds.length && cur < 6 && RED_ORE.every(m => (vault.mats[m] || 0) >= 1)) {
          for (const m of RED_ORE) { vault.mats[m] -= 1; if (vault.mats[m] <= 0) delete vault.mats[m] }
          const r = pick(reds)
          const changed = fakeAddItem(p.bag, r, 1, rollEquipAttr(EQUIP_TPL[r].type, EQUIP_TPL[r].quality))
          if (changed.length) p.activities = { ...(p.activities || {}), lastEquip2: now + rand([10, 30]) * 60000 }
          logEvent(f, 'promote', `【炼宝】${sectName(f, sid)} 以宗门矿物炼成红装${itemIcon(r)}【${r}】，赐予${POS[pos].cn} ${p.name}`, now, { who: [p.name], sect: sid })
        }
      }
    }
    /* 3. 弟子按需取丹 + 服用增益丹(核心每1~3小时, 普通弟子每3~8小时) */
    const coreSet = new Set(['zongzhu', 'taishang', 'fuzong', 'zhishi'].flatMap(pos => Array.isArray(sm[pos]) ? sm[pos] : (sm[pos] ? [sm[pos]] : [])))
    for (const p of members) {
      if (!p.bag) p.bag = { items: {}, equipped: {} }
      if (!p.bag.items) p.bag.items = {}
      /* 突破需破障丹 */
      if ((p.exp || 0) >= fakeSubThreshold(p.level + 1) && itemCount(p.bag.items['破障丹']) <= 0 && (vault.pills['破障丹'] || 0) > 0) {
        vault.pills['破障丹']--
        if (vault.pills['破障丹'] <= 0) delete vault.pills['破障丹']
        fakeAddItem(p.bag, '破障丹', 1)
      }
      /* 修炼需修为丹 */
      if ((p.exp || 0) < fakeSubThreshold(p.level + 1) && itemCount(p.bag.items['修为丹']) < 2 && (vault.pills['修为丹'] || 0) > 0) {
        vault.pills['修为丹']--
        if (vault.pills['修为丹'] <= 0) delete vault.pills['修为丹']
        fakeAddItem(p.bag, '修为丹', 1)
      }
      /* 服用增益丹 */
      if (!p.activities) p.activities = {}
      const isCore = coreSet.has(p.name)
      const cd = isCore ? rand([1, 3]) : rand([3, 8])
      if (now >= (p.activities.lastBuffPill || 0)) {
        p.activities.lastBuffPill = now + cd * 3600000
        const buffs = PILL_BONUS.filter(n => (vault.pills[n] || 0) > 0)
        if (buffs.length) {
          const b = pick(buffs)
          vault.pills[b]--
          if (vault.pills[b] <= 0) delete vault.pills[b]
          p.pill = { name: b, until: now + 3600000 }
          logEvent(f, 'flavor', `【服丹】${sectName(f, sid)}${POS[p.pos] ? POS[p.pos].cn : '弟子'} ${p.name} 服下宗门宝库的${itemIcon(b)}${b}，${pillFxTxt(b)}（持续1小时）`, now, { onlyPerson: true, ...evMeta(p) })
        }
      }
    }
  }
}
/* 兼容旧调用方：宗门资源生产已统一由 sectTick 负责，禁止再次执行旧版流转。 */
export async function runSectResourceFlow (f, now = Date.now()) { return false }

/** 伪玩家从宗门宝库直接学习供奉功法；每次流转每名伪玩家最多学习一本。 */
export function learnSectGongfa (f, now = Date.now()) {
  let changed = false
  for (const [sid, s] of Object.entries(f.sects || {})) {
    if (!s || s.wipeAt) continue
    const vault = s.vault
    if (!vault || !vault.gongfas) continue
    for (const name of Object.keys(vault.gongfas)) {
      if (!GONGFA_TPL[name] || GONGFA_TPL[name].quality > 6 || Number(vault.gongfas[name]) <= 0) delete vault.gongfas[name]
      else vault.gongfas[name] = Math.floor(Number(vault.gongfas[name]))
    }
    const members = sectAlive(f, sid)
    for (const p of members) {
      if (!p || !p.alive) continue
      if (!Array.isArray(p.learnedGongfa)) p.learnedGongfa = []
      const learned = new Set(p.learnedGongfa)
      const gongfa = Object.keys(vault.gongfas).filter(name =>
        (vault.gongfas[name] || 0) > 0 && !learned.has(name)
      ).sort((a, b) => gongfaScore(b) - gongfaScore(a))[0]
      if (!gongfa) continue
      vault.gongfas[gongfa]--
      if (vault.gongfas[gongfa] <= 0) delete vault.gongfas[gongfa]
      p.learnedGongfa.push(gongfa)
      if (!p.activeGongfa || gongfaScore(gongfa) > gongfaScore(p.activeGongfa)) p.activeGongfa = gongfa
      logEvent(f, 'flavor', `【修习】${sectName(f, sid)} ${p.name} 从宗门宝库取出${itemIcon(gongfa)}《${gongfa}》参悟，习得此功法`, now, { onlyPerson: true, ...evMeta(p) })
      changed = true
    }
  }
  return changed
}

/* ---------- 晋升(空缺时/AI宗主任命: 修为达标即提拔, 不看入宗资历) ---------- */
function pickPromo (f, id, fromPos, toPos) {
  const minLevel = POS[toPos].band[0] // 达到目标职位修为下限(实力至上, 不看资历)
  const cand = Object.values(f.roster).filter(p =>
    p.alive && !p.realmBusy && p.sect === id && p.status === 'sect' && p.pos === fromPos &&
    p.level >= minLevel)
  cand.sort((a, b) => b.level - a.level || a.joinAt - b.joinAt)
  return cand[0] || null
}
function promotePerson (f, id, p, toPos) {
  const sm = f.sectMap[id]
  const fromPos = p.pos
  if (fromPos === 'zongzhu') sm.zongzhu = null
  else if (fromPos === 'dizi') sm.dizi = sm.dizi.filter(x => x !== p.name)
  else sm[fromPos] = sm[fromPos].filter(x => x !== p.name)
  p.pos = toPos
  if (toPos === 'zongzhu') sm.zongzhu = p.name
  else sm[toPos].push(p.name)
  logEvent(f, 'promote', `【递补】${p.name} 继任${sectName(f, id)}${POS[toPos].cn}`)
}
function promoteSettle (f) {
  for (const id of Object.keys(f.sects)) {
    const sm = f.sectMap[id]
    if (!sm) continue
    /* 玩家主导的宗门(玩家宗主坐镇): 伪玩家职位链由玩家管理, 跳过伪玩家晋升/夺权 */
    if (f.sects[id] && f.sects[id].owner) continue
    /* 太上长老(凌驾宗主): 宗主修为达太上带下限 → 禅让退位为太上, 副宗主继任 */
    while (sm.taishang.length < POS.taishang.max) {
      const zz = sm.zongzhu ? f.roster[sm.zongzhu] : null
      if (zz && zz.level >= POS.taishang.band[0]) {
        promotePerson(f, id, zz, 'taishang') // 宗主禅让为太上
        const nc = pickPromo(f, id, 'fuzong', 'zongzhu')
        if (nc) promotePerson(f, id, nc, 'zongzhu')
        continue
      }
      /* 太上空缺: 宗内修为≥太上下限的非宗主成员晋升(隐世老祖) */
      const c = Object.values(f.roster).filter(p =>
        p.alive && !p.realmBusy && p.sect === id && p.status === 'sect' && p.pos !== 'zongzhu' &&
        p.pos !== 'taishang' && p.level >= POS.taishang.band[0])
        .sort((a, b) => b.level - a.level || a.joinAt - b.joinAt)[0]
      if (c) { promotePerson(f, id, c, 'taishang'); continue }
      break
    }
    /* 线性: 弟子→执事→副宗主→宗主; 无副宗主可递补时太上长老出山主持大局 */
    if (!sm.zongzhu) {
      const c = pickPromo(f, id, 'fuzong', 'zongzhu')
      if (c) {
        promotePerson(f, id, c, 'zongzhu')
      } else if (sm.taishang && sm.taishang.length) {
        const tai = sm.taishang[0]
        const taiP = f.roster[tai]
        if (taiP) {
          sm.taishang = sm.taishang.filter(x => x !== tai)
          taiP.pos = 'zongzhu'
          sm.zongzhu = tai
          logEvent(f, 'promote', `【出山】${sectName(f, id)}太上长老 ${tai} 出山主持大局，继任宗主`)
        }
      }
    }
    while (sm.fuzong.length < POS.fuzong.max) {
      const c = pickPromo(f, id, 'zhishi', 'fuzong')
      if (!c) break
      promotePerson(f, id, c, 'fuzong')
    }
    while (sm.zhishi.length < POS.zhishi.max) {
      const c = pickPromo(f, id, 'dizi', 'zhishi')
      if (!c) break
      promotePerson(f, id, c, 'zhishi')
    }
    /* 高修为者夺权移到 powerStruggleSettle(每日一次, 避免频繁动荡) */
  }
}
/** 夺权(强者为尊, 每日一次): 成员修为远超现任宗主(>3级)且无更高职位时, 不满现状发起夺权 */
function powerStruggleSettle (f) {
  for (const id of Object.keys(f.sects)) {
    const sm = f.sectMap[id]
    if (!sm) continue
    if (f.sects[id] && f.sects[id].owner) continue
    if (sm.zongzhu && f.roster[sm.zongzhu] && f.roster[sm.zongzhu].alive) {
      const zz = f.roster[sm.zongzhu]
      const challenger = sectAlive(f, id)
        .filter(p => p.pos !== 'zongzhu' && p.level > zz.level + 3)
        .sort((a, b) => b.level - a.level)[0]
      if (challenger && Math.random() < 0.4) {
        const whoT = sectName(f, id)
        const oldName = zz.name
        /* 原宗主: 太上有空位则退居太上, 否则黯然离宗转散修 */
        if (sm.taishang.length < POS.taishang.max) {
          sm.zongzhu = null
          sm.taishang.push(oldName)
          zz.pos = 'taishang'
          logEvent(f, 'promote', `【退位】${whoT}宗主 ${oldName} 被夺权，退居太上长老`)
        } else {
          removeFromSectMap(f, id, oldName)
          zz.status = 'scatter'
          zz.sect = null
          zz.pos = null
          logEvent(f, 'promote', `【退位】${whoT}宗主 ${oldName} 被夺权，黯然离宗`)
        }
        /* 挑战者从原职位移除 → 继任宗主 */
        if (challenger.pos === 'dizi') sm.dizi = sm.dizi.filter(x => x !== challenger.name)
        else sm[challenger.pos] = sm[challenger.pos].filter(x => x !== challenger.name)
        challenger.pos = 'zongzhu'
        sm.zongzhu = challenger.name
        logEvent(f, 'promote', `【夺权】${whoT} ${challenger.name} 修为凌驾宗主，发起夺权取而代之，继任宗主！`)
      }
    }
  }
}

/* ---------- 修为每日稳定(玩家体系: 每日灵力沉淀, 不直接改修为) ---------- */
function realmSettle (f) {
  for (const p of Object.values(f.roster)) {
    if (!p.alive || p.realmBusy) continue
    addExp(p, rand([10, 30]))
  }
}

/* ---------- 慢慢招徒弟 ---------- */
function recruitSettle (f) {
  const now = Date.now()
  for (const id of Object.keys(f.sects)) {
    const s = f.sects[id]
    if (!s.recruit || !s.recruit.next || now < s.recruit.next) continue
    const sm = f.sectMap[id]
    if (!sm) continue
    /* 宗门无宗主但太上长老尚在 → 太上扶持新宗主(不至于灭门); 玩家宗门不触发 */
    if (!s.owner && !sm.zongzhu) {
      const tai = (sm.taishang || [])[0]
      if (tai && sectAlive(f, id).length <= 1) {
        const n = drawName(f)
        if (n) {
          addPerson(f, n, id, 'zongzhu', rand(POS.zongzhu.band))
          logEvent(f, 'rebuild', `【扶持】${sectName(f, id)}太上长老 ${tai} 扶持 ${n} 继任新宗主`)
        }
      }
      s.recruit.next = now + 3600000
      continue
    }
    /* 有新弟子: 挑一个可入的宗门(玩家宗门也直接进; 排除有仇人/被逐出2天的散修与宗门) */
    const n = drawName(f)
    if (n) {
      const target = pickSectFor(f, n)
      if (target) {
        fakeJoinSect(f, n, target)
        logEvent(f, 'join', `【入宗】散修 ${n} 拜入 ${sectName(f, target)} 为弟子`)
      }
    }
    /* 意愿增强: 招募间隔缩短(0~4小时) */
    s.recruit.next = now + rand([0, 4]) * 3600000
  }
}

/* ---------- 伪玩家入宗公共逻辑(招募/事件/玩家招揽共用) ---------- */
/** 伪玩家加入宗门: 散修转正入宗或新建弟子; 满员/已有宗门/灭门返回null */
export function fakeJoinSect (f, name, sid) {
  const s = f.sects[sid]
  if (!s || s.wipeAt) return null
  if (sectAlive(f, sid).length >= sectCap(f, sid)) return null
  const np = f.roster[name]
  if (np && np.alive && np.sect) return null // 已有宗门
  if (np && np.servantOf) return null // 已是玩家仆从(收服), 不可再入宗
  if (np && np.alive && np.status === 'scatter') {
    np.sect = sid; np.pos = 'dizi'; np.status = 'sect'
    /* 保留修为: 高手入宗仍是高手(不再压到弟子带1~12, 避免宗门被新招低修弟子拉低; 修为高会被AI宗主重用) */
    if (f.sectMap[sid] && !f.sectMap[sid].dizi.includes(name)) f.sectMap[sid].dizi.push(name)
  } else {
    addPerson(f, name, sid, 'dizi', 1)
  }
  return { type: 'join', who: [name], sect: sid, txt: `【入宗】${name} 拜入 ${s.name} 为弟子` }
}
/* ---------- 忠诚度 / 宗门兴衰 / 宗门文化 / 灭门复仇 ---------- */
/** 初始忠诚(性格): 苦修/平和/善良忠诚高, 好斗/嗜杀/魔修/贪玩低 */
function initLoyalty (p) {
  const t = { 善良: 72, 平和: 78, 好斗: 48, 嗜杀: 36 }[p && p.trait] ?? 60
  const a = { 苦修: 12, 勤勉: 6, 普通: 0, 懒散: -8, 贪玩: -14 }[p && p.act] ?? 0
  const path = (p && p.path === '魔道') ? -18 : 0
  return clamp(t + a + path, 20, 88)
}
/** 宗门兴衰度(0~100): 地盘×15 + 宝库灵石/5万, 封顶100; 兴旺→弟子安心, 衰落→人心思变 */
export function sectVitality (f, id) {
  const s = f.sects && f.sects[id]
  if (!s || s.wipeAt) return 0
  const areas = Object.keys(f.areas || {}).filter(a => f.areas[a] === id).length
  const vault = (s.vault && s.vault.stones) || 0
  return clamp(areas * 15 + Math.floor(vault / 50000), 0, 100)
}
/** 宗门兴衰对人心/离宗的影响系数: 衰落×1.6 更难留住人, 兴旺×0.5 更安心 */
export function sectStability (f, id) {
  const v = sectVitality(f, id)
  if (v <= 25) return 1.6
  if (v >= 60) return 0.5
  return 1
}
/** 宗门文化: 风格 + 魔修占比(伪玩家宗按宗主性格, 玩家宗按成员魔修占比) */
export function sectCulture (f, id) {
  const s = f.sects && f.sects[id]
  if (!s || s.wipeAt) return { style: '废墟', demon: 0, desc: '名存实亡' }
  const alive = sectAlive(f, id)
  const n = alive.length
  const demon = n ? Math.round(alive.filter(p => p.path === '魔道').length / n * 100) : 0
  const zz = f.sectMap[id] && f.sectMap[id].zongzhu ? f.roster[f.sectMap[id].zongzhu] : null
  let style = '中正平和'
  if (s.owner) style = demon >= 50 ? '亦正亦邪' : '名门正派'
  else if (zz) {
    if (zz.trait === '好斗' || zz.trait === '嗜杀') style = demon >= 40 ? '凶焰滔天' : '尚武好战'
    else if (zz.trait === '善良') style = '乐善好施'
    else if (zz.path === '魔道') style = '诡秘莫测'
    else style = '祥和仁厚'
  } else if (demon >= 50) style = '魔气森然'
  return { style, demon, desc: `${style}（魔修占比 ${demon}%）` }
}
/** 同宗羁绊数(师父/道侣/知己/手足/徒弟/挚友在世且同宗) */
function bondCountInSect (f, p) {
  if (!p || p.status !== 'sect' || !p.sect) return 0
  const r = p.relations || {}
  const names = [].concat(r.master ? [r.master] : [], r.spouse ? [r.spouse] : [], r.confidants || [], r.siblings || [], r.disciples || [], r.friends || []).filter(Boolean)
  return names.filter(n => f.roster[n] && f.roster[n].alive && f.roster[n].sect === p.sect).length
}
/** 忠诚度每日调整: 入宗越久越忠诚 + 同宗羁绊 + 宗门兴衰; 散修趋中 */
function loyaltySettle (f, now = Date.now()) {
  for (const p of Object.values(f.roster)) {
    if (!p.alive || p.realmBusy) continue
    let loy = Number(p.loyalty)
    if (!(loy >= 0)) loy = initLoyalty(p)
    let d = 0
    if (p.status === 'sect' && p.sect) {
      const days = Math.floor((now - (p.joinAt || now)) / 86400000)
      d += Math.min(30, days * 2) // 入宗每24小时+2(上限+30)
      d += Math.min(12, bondCountInSect(f, p) * 2) // 每名同宗羁绊+2(上限+12)
      const v = sectVitality(f, p.sect)
      d += v >= 60 ? 6 : (v <= 25 ? -10 : 0) // 宗门兴衰
    } else {
      d = Math.round((50 - loy) * 0.3) // 散修无归属, 忠诚趋中
    }
    p.loyalty = clamp(loy + d, 0, 100)
  }
}
/** 性格化动作词(事件文案): 不同性格不同反应 */
export function traitFlavor (p) {
  if (!p) return ''
  if (p.path === '魔道') return pick(['冷笑一声', '眼中杀意一闪', '嗤之以鼻'])
  switch (p.trait) {
    case '好斗': return pick(['拍案而起', '勃然大怒', '攥紧拳头'])
    case '嗜杀': return pick(['杀意毕露', '舔了舔刀锋', '狞笑一声'])
    case '善良': return pick(['默默垂泪', '叹息一声', '黯然神伤'])
    case '平和': return pick(['神色平静', '淡然一笑', '拂袖而去'])
    default: return pick(['沉默不语', '摇了摇头', '若有所思'])
  }
}
/** 灭门复仇: 宗门被灭时, 散尽的弟子中 好斗/嗜杀/魔修 或与宗主/管理层有羁绊者 → 记仇
 *  culprit: 灭门者名单(伪玩家名 或 玩家昵称); culpritType: 'rogue'(散修小队) / 'fate'(天灾覆灭)
 *  须在散尽(removeFromSectMap)前调用 */
export function createVendetta (f, sid, culprit = [], culpritType = 'fate', now = Date.now()) {
  const s = f.sects && f.sects[sid]
  if (!s) return 0
  const sm = f.sectMap[sid] || {}
  const coreNames = [sm.zongzhu, ...(sm.fuzong || []), ...(sm.taishang || [])].filter(Boolean)
  let n = 0
  for (const p of sectAlive(f, sid)) {
    const r = p.relations || {}
    const bonded = coreNames.some(c => c === r.master || c === r.spouse ||
      (r.confidants || []).includes(c) || (r.friends || []).includes(c) ||
      (r.siblings || []).includes(c) || (r.kin || []).includes(c))
    const vengeful = p.trait === '好斗' || p.trait === '嗜杀' || p.path === '魔道' || bonded
    if (!vengeful) continue
    if (!r.enemies) r.enemies = []
    for (const c of culprit) {
      if (c && f.roster[c] && f.roster[c].alive && !r.enemies.includes(c)) r.enemies.push(c)
    }
    p.vendetta = { sectName: s.name, culprit: culprit.slice(0, 6), culpritType, at: now }
    logEvent(f, 'vendetta', `【灭门之仇】${s.name} 覆灭，${p.name} ${traitFlavor(p)}，誓要报仇雪恨`, now, { who: [p.name], major: true })
    n++
  }
  return n
}
/** 宗门正邪: 伪玩家宗按宗主path, 玩家宗默认正道 */
function sectPathOf (f, id) {
  const s = f.sects[id]
  if (!s || s.owner) return '正道'
  const sm = f.sectMap[id]
  const zz = sm && sm.zongzhu ? f.roster[sm.zongzhu] : null
  return (zz && zz.path) || '正道'
}
/** 散修入宗意愿(性格驱动): trait×act, 魔道减半(爱独行劫杀) */
export function joinWilling (p) {
  const t = { 善良: 0.8, 平和: 0.85, 好斗: 0.55, 嗜杀: 0.3 }[p.trait] ?? 0.7
  const a = { 苦修: 1.3, 勤勉: 1.1, 普通: 1.0, 懒散: 0.5, 贪玩: 0.4 }[p.act] ?? 1
  return t * a * (p.path === '魔道' ? 0.5 : 1)
}
/** 挑一个可入的宗门(排除满员/灭门/有仇人在世/被逐出2天内; 正邪偏好加权: 同path更易进) */
export function pickSectFor (f, name) {
  const p = f.roster[name]
  const enemies = new Set((p && p.relations && p.relations.enemies) || [])
  const bans = f.kickBans || {}
  if ((bans[name] || 0) > Date.now()) return null // 被逐出2天内不主动入宗
  const myPath = (p && p.path) || '正道'
  const cand = Object.keys(f.sects).filter(id2 => {
    const s2 = f.sects[id2]
    if (!s2 || s2.wipeAt) return false
    if (sectAlive(f, id2).length >= sectCap(f, id2)) return false
    if (enemies.size && sectAlive(f, id2).some(x => enemies.has(x.name))) return false // 宗门里有仇人, 不想进
    /* 灭门仇家玩家在宗内 → 不愿入 */
    if (p && p.vendetta && p.vendetta.culprit && p.vendetta.culprit.length) {
      if (Object.values(f.players || {}).some(pp => pp && pp.sect === id2 && p.vendetta.culprit.includes(pp.name))) return false
    }
    return true
  })
  if (!cand.length) return null
  /* 正邪偏好: 同path宗门权重3, 异path权重1(非硬排除) */
  const weighted = cand.map(id2 => ({ id: id2, w: sectPathOf(f, id2) === myPath ? 3 : 1 }))
  const tw = weighted.reduce((a, x) => a + x.w, 0)
  let r = Math.random() * tw
  for (const x of weighted) { r -= x.w; if (r <= 0) return x.id }
  return weighted[0].id
}

/* ---------- 宗门覆灭与重建(换皮: 改名+新宗主+慢慢招徒) ---------- */
function drawSectName (f) {
  try {
    const pool = JSON.parse(fs.readFileSync(SECT_FILE, 'utf8'))
    const used = new Set(Object.values(f.sects).map(s => s.name))
    const avail = pool.filter(n => !used.has(n))
    return avail.length ? pick(avail) : null
  } catch (err) { return null }
}
export function rebuildSettle (f) {
  const now = Date.now()
  for (const id of Object.keys(f.sects)) {
    const s = f.sects[id]
    const sm = f.sectMap[id]
    if (!sm) continue
    /* 玩家坐镇(玩家宗主或玩家太上长老) → 宗门不会灭门 */
    const ownerUid = s.owner || null
    const hasPlayerTai = Object.values(f.players || {}).some(x => x && x.sect === id && x.pos === 'taishang')
    if (ownerUid || hasPlayerTai) {
      if (s.wipeAt) { s.wipeAt = 0; s.rebuildAt = 0 }
      continue
    }
    const alive = sectAlive(f, id)
    /* 核心管理层(宗主/副宗/太上)是否还有人: 全死则灭宗, 除非宗门内有玩家接管 */
    const hasCore = !!(sm.zongzhu && f.roster[sm.zongzhu] && f.roster[sm.zongzhu].alive) ||
      (sm.fuzong || []).some(n => f.roster[n] && f.roster[n].alive) ||
      (sm.taishang || []).some(n => f.roster[n] && f.roster[n].alive)
    if (hasCore) {
      if (s.wipeAt) { s.wipeAt = 0; s.rebuildAt = 0 }
      continue
    }
    /* 核心管理层尽灭: 只有核心职位玩家(宗主/副宗/太上)晋升继任宗主, 宗门不灭; 非核心玩家(执事/弟子) → 随宗灭门 */
    const playersIn = Object.entries(f.players || {}).filter(([, pp]) => pp && pp.sect === id)
    const coreP = playersIn.filter(([, pp]) => pp.pos === 'zongzhu' || pp.pos === 'fuzong' || pp.pos === 'taishang')
    if (coreP.length) {
      coreP.sort((a, b) => (a[1].joinAt || 0) - (b[1].joinAt || 0))
      const [uid2, pp] = coreP[0]
      pp.pos = 'zongzhu'
      s.owner = String(uid2)
      s.wipeAt = 0; s.rebuildAt = 0
      logEvent(f, 'promote', `【继任】🌙 玩家 ${pp.name} 于宗门危难之际继任【${s.name}】宗主，宗门不灭！`)
      continue
    }
    /* 无玩家接管 → 灭门(树倒猢狲散): 剩余弟子离开宗门流落江湖, 宗门名存实亡 → 换皮重建 */
    if (!s.wipeAt) {
      s.wipeAt = now
      s.rebuildAt = now + rand(REBUILD_MIN) * 60000
      /* 灭门: 占领小区无主化(产出/护城阵不再流入灭门宗门) */
      for (const [area, owner] of Object.entries(f.areas || {})) {
        if (owner === id) { delete f.areas[area]; if (f.areaDef) delete f.areaDef[area] }
      }
      /* 灭门复仇: 散尽前给幸存弟子记仇(好斗/嗜杀/魔修/与宗主管理层有羁绊者) */
      createVendetta(f, id, [], 'fate', now)
      for (const p of alive) {
        removeFromSectMap(f, id, p.name)
        p.status = 'scatter'
        p.sect = null
        p.pos = null
        logEvent(f, 'leave', `【散尽】${s.name} 树倒猢狲散，弟子 ${p.name} 黯然离开宗门，流落江湖`)
      }
      /* 玩家成员(仅执事及以下)随宗门覆灭被踢出转散修 */
      for (const [uid2, pp] of Object.entries(f.players || {})) {
        if (pp && pp.sect === id) {
          delete f.players[uid2]
          logEvent(f, 'player', `【散尽】玩家 ${pp.name} 随宗门覆灭被逐出，沦为散修`, now)
        }
      }
      logEvent(f, 'wipe', `【灭门】${s.name} 管理层尽数陨落，宗门名存实亡……`)
    } else if (s.rebuildAt && s.rebuildAt - now > REBUILD_MIN[1] * 60000) {
      /* 旧档/超长延迟修正: 灭门宗门若重建剩余超过新上限(旧代码 6~24h 遗留的 rebuildAt), 缩短到 5~30 分钟内重生 */
      s.rebuildAt = now + rand(REBUILD_MIN) * 60000
    } else if (s.rebuildAt && now >= s.rebuildAt) {
      /* 远遁的原宗主看情况重建: 在世且仍为散修(未另投宗门)时按意愿重建(保留原名与原修为);
       *  否则宗门名额让给其他散修(换皮开宗: 新名+新宗主) */
      const ex = s.masterExile
      const exP = ex && f.roster[ex.name]
      if (exP && exP.alive && !exP.sect && Math.random() < 0.5) {
        exP.sect = id
        exP.pos = 'zongzhu'
        exP.status = 'sect'
        exP.joinAt = now
        if (!f.sectMap[id]) f.sectMap[id] = { zongzhu: null, fuzong: [], taishang: [], zhishi: [], dizi: [] }
        f.sectMap[id].zongzhu = ex.name
        s.recruit = { next: now + rand([0, 4]) * 3600000 }
        logEvent(f, 'rebuild', `【重建】远遁的宗主 ${ex.name} 重出江湖，于废墟之上重建【${s.name}】`)
        s.wipeAt = 0; s.rebuildAt = 0; s.masterExile = null
      } else {
        const newName = drawSectName(f)
        if (newName) {
          s.name = newName // 每群独立: 只改本群宗门名, 不再动world.json
          /* 重建不继承旧宗门的关系(敌对/结盟全清); 设施与地盘由同id天然继承 */
          s.enemies = []
          s.allies = []
          const zz = drawName(f)
          if (zz) {
            /* 重建宗主从低境界起步, 靠修炼/突破自然成长(不凭空给高境界) */
            addPerson(f, zz, id, 'zongzhu', rand(SECT_START_BAND.zongzhu))
            s.recruit = { next: now + rand([0, 4]) * 3600000 }
            logEvent(f, 'rebuild', `【重建】散修 ${zz} 于废墟之上开宗立派，重立${newName}`)
          } else {
            s.recruit = { next: now + 3600000 }
            logEvent(f, 'rebuild', `【重建】${newName} 于废墟之上重新开宗立派`)
          }
          s.wipeAt = 0; s.rebuildAt = 0; s.masterExile = null
        } else {
          s.rebuildAt = now + 24 * 3600000
        }
      }
    }
  }
}

/* ---------- 每日结算 ---------- */
/** 新增散修(不入宗门, 随机大区游历): 补员的 80% 概率分支 */
function addScatter (f, name) {
  const path = rollPath()
  const p = personDefaults({
    name, sect: null, pos: null, status: 'scatter', path, trait: rollTrait(path), act: rollAct(),
    level: 1, alive: true, joinAt: Date.now(), kills: 0, lastFight: 0
  })
  p.loc = pick(REGION_KEYS.filter(k => !(REGIONS[k] && REGIONS[k].special))) // 新修士初始大区不含简月王朝
  f.roster[name] = p
  return p
}
/** 补 1 个伪玩家入世/入宗(80% 散修 / 20% 随机入宗); 名字池耗尽返回 false */
function topupOne (f, now) {
  const n = drawName(f)
  if (!n) return false
  /* 80% 概率散修入世 */
  if (Math.random() < 0.8) {
    const p = addScatter(f, n)
    logEvent(f, 'join', `【入世】${n} 于${regionNameOf(p.loc)}入世修行，成为散修游历四方`, now, evMeta(p))
    return true
  }
  /* 20% 入宗: 在世所有宗门(含玩家宗门)中, 未满员的随机挑一个进 */
  const open = Object.keys(f.sects).filter(id => {
    const s = f.sects[id]
    const sm = f.sectMap[id]
    return s && !(s.wipeAt > 0) && sm && sm.zongzhu && sectAlive(f, id).length < sectCap(f, id)
  })
  if (!open.length) {
    /* 所有宗门都满员/无在世宗门: 同样入世为散修 */
    const p = addScatter(f, n)
    logEvent(f, 'join', `【入世】${n} 于${regionNameOf(p.loc)}入世修行，成为散修游历四方`, now, evMeta(p))
    return true
  }
  const target = pick(open)
  const p = addPerson(f, n, target, 'dizi', 1)
  logEvent(f, 'join', `【入宗】${n} 刚刚踏入修仙界，拜入 ${sectName(f, target)} 为弟子`, now, evMeta(p))
  return true
}
/** 固定补员: 不论在世人数多少, 每30分钟新增1名伪玩家, 达到 FAKE_MAX 后停止
 *  80% 概率为散修(不入宗门); 20% 概率入宗: 在世所有宗门(含玩家宗门)中, 未满员的随机挑一个 */
export function topupFake (f, now = Date.now()) {
  if (fakeAliveCount(f) >= FAKE_MAX) return false
  if (now < (f.lastTopup || 0) + TOPUP_INTERVAL) return false
  f.lastTopup = now
  return topupOne(f, now)
}
export function dailySettle (f) {
  /* 先按昨日状态晋升(巅峰判定不被今日修为波动影响), 再修为稳定/招收/重建/保底补员
   * AI(伪玩家)攻打统一由 sectTick 的 spawnAiSectAttacks 负责(与玩家同一套流程) */
  promoteSettle(f)
  loyaltySettle(f) // 忠诚度每日调整(入宗时长/羁绊/宗门兴衰)
  realmSettle(f)
  recruitSettle(f)
  rebuildSettle(f)
  topupFake(f)
}

/* ---------- 伪玩家三阁购买(动态补货参与: 购买也算活跃) ---------- */
/** 记录江湖交易(三阁购买) */
function logTrade (f, txt) {
  if (!f.trades) f.trades = []
  f.trades.push({ t: Date.now(), txt })
  if (f.trades.length > 500) f.trades = f.trades.slice(-500)
}
/** 单个伪玩家尝试买 1 件(随机挑三阁/在售品, 买得起的才买; 扣库存+灵石+入背包, 并计入活跃) */
/* 攒钱目标(消费驱动, 按自身需求+性格+财富):
 *  - 有部位空着 → 先补装备(缺什么补什么)
 *  - 快突破且无破障丹 → 买破障丹(突破刚需)
 *  - 未学任何功法 → 买功法书
 *  - 已穿装备品质不高 → 想换更好装备
 *  - 攻击型想买武器, 求道型想买功法/丹药, 越富目标越高级(白200/绿1000/蓝4000/紫12000/金30000) */
function fakeWish (f, p) {
  const money = p.money || 0
  const trait = p.trait || ''
  const act = p.act || ''
  const bag = p.bag || {}
  const equipped = bag.equipped || {}
  const items = bag.items || {}
  const SLOTS = ['weapon', 'helmet', 'chest', 'pants', 'shoes', 'ring']
  /* 1. 空着的部位 → 先补装备(缺什么补什么) */
  const emptySlots = SLOTS.filter(s => !equipped[s] && !Object.keys(items).some(n => EQUIP_TPL[n] && (SLOT_MAP[EQUIP_TPL[n].type] || 'weapon') === s && itemCount(items[n]) > 0))
  if (emptySlots.length) {
    const part = emptySlots[Math.floor(Math.random() * emptySlots.length)]
    const tiers = money < 1000 ? [1, 2] : (money < 3000 ? [2, 3] : (money < 8000 ? [3, 4] : [4, 5]))
    const tier = tiers[Math.floor(Math.random() * tiers.length)]
    const price = [0, 200, 1000, 4000, 12000, 30000][tier]
    return { type: 'weapon', part, tier, price, at: Date.now() }
  }
  /* 2. 快突破且无破障丹 → 买破障丹(突破刚需, 攒着等突破用) */
  const need = fakeSubThreshold(p.level + 1)
  const nearBreak = (p.exp || 0) >= need * 0.7
  if (nearBreak && itemCount(items['破障丹']) <= 0) {
    const price = ITEM_PRICE['破障丹'] || 1000
    if (money >= price) return { type: 'pill', tier: 2, price, at: Date.now() }
  }
  /* 3. 未学任何功法 → 买功法书(学最强功法) */
  if (!p.learnedGongfa || !p.learnedGongfa.length) {
    const tier = money < 3000 ? 2 : (money < 8000 ? 3 : 4)
    const price = [0, 200, 1000, 4000, 12000, 30000][tier]
    return { type: 'gongfa', tier, price, at: Date.now() }
  }
  /* 4. 性格驱动目标 */
  let type
  if (trait === '好斗' || trait === '嗜杀' || p.path === '魔道' || act === '贪玩') type = 'weapon'
  else if (act === '苦修') type = 'pill'
  else if (act === '勤勉' || trait === '善良') type = 'gongfa'
  else type = Math.random() < 0.5 ? 'weapon' : 'gongfa'
  /* 财富档位: 越富目标越高级 */
  const tiers = money < 1000 ? [1, 2] : (money < 3000 ? [2, 3] : (money < 8000 ? [3, 4] : [4, 5]))
  const tier = tiers[Math.floor(Math.random() * tiers.length)]
  const price = [0, 200, 1000, 4000, 12000, 30000][tier]
  return { type, tier, price, at: Date.now() }
}
/** 买攒钱目标物品(从商店实际库存挑对应档位武器/功法/丹药, 同档无货降档, 再无货任意买一件在售); 返回是否买到 */
async function buyWishItem (f, gid, p, w) {
  const rg = p.loc || 'center'
  let shop = null
  let kind = null
  if (w.type === 'weapon') { shop = 'qige'; kind = 'weapon' }
  else if (w.type === 'gongfa') { shop = 'cangbaoge'; kind = 'gongfa' }
  else { shop = 'dange'; kind = 'pill' }
  try {
    const stock = await getStock(gid, shop, rg)
    const names = Object.keys(stock)
    if (!names.length) return false
    /* 补装备: 只挑目标部位(空部位)的装备 */
    let scope = names
    if (kind === 'weapon' && w.part) {
      const part = SLOT_MAP[w.part] || w.part
      scope = names.filter(n => EQUIP_TPL[n] && (SLOT_MAP[EQUIP_TPL[n].type] || 'weapon') === part)
      if (!scope.length) scope = names // 该部位无货: 退回任意武器
    }
    const qOf = (n) => {
      if (kind === 'pill') return (n === '破障丹' ? 2 : 1)
      const t = EQUIP_TPL[n] || GONGFA_TPL[n]
      return t ? (t.quality || 0) : 0
    }
    let pool = scope.filter(n => qOf(n) === w.tier)
    let t = w.tier
    while (!pool.length && t > 1) { t--; pool = scope.filter(n => qOf(n) === t) }
    if (!pool.length) pool = scope // 目标档位无货: 任意买一件在售(总比空手强)
    /* 同档位内挑评分最高的(知道好坏): 武器按装备评分/功法按功法评分/丹药破障丹>修为丹 */
    const scoreOf = (n) => {
      if (kind === 'pill') return n === '破障丹' ? 2 : (n === '修为丹' ? 1 : 0)
      const tpl = EQUIP_TPL[n] || GONGFA_TPL[n]
      return tpl ? (kind === 'weapon' ? equipScore(n) : gongfaScore(n)) : 0
    }
    pool.sort((a, b) => scoreOf(b) - scoreOf(a))
    const name = pool[0] // 买评分最高的, 不随机
    const price = w.type === 'pill' ? (ITEM_PRICE[name] || 500) : (w.type === 'weapon' ? equipPrice(name) : gongfaPrice(name))
    if ((p.money || 0) < price) return false
    const res = await buyStock(gid, shop, name, 1, rg)
    if (!res || !res.ok || (res.count || 0) < 1) return false
    p.money -= price
    if (!p.bag) p.bag = { items: {}, equipped: {} }
    const changed = fakeAddItem(p.bag, name, 1)
    /* 购买装备后立即装备；若新装备没有超过当前装备，不延长装备冷却。 */
    if (kind === 'weapon' && changed.length) {
      p.activities = { ...(p.activities || {}), lastEquip2: Date.now() + rand([10, 30]) * 60000 }
    }
    /* 三阁销售扣税: 伪玩家付款不变, 销售收入按所在大区税率计入该区繁荣度 */
    const tw = getWorld(f.gid)
    const trate = taxFor(tw, rg, p.sect ? sectName(f, p.sect) : null)
    const ttax = Math.max(1, Math.round(price * trate / 100))
    addTax(tw, rg, ttax)
    saveWorld(tw)
    const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
    try { logTrade(f, `【${SHOP_CN[shop] || shop}·${regionNameOf(rg)}】${who} ${p.name} 攒够灵石购得 ${itemIcon(name)}${name} ×1（-${price}灵石，税率${trate}%缴税${ttax}）`) } catch (err) { }
    try { logEvent(f, 'flavor', `【购宝】${who} ${p.name} 攒钱买下 ${itemIcon(name)}${name}（${price}灵石）`, Date.now(), { onlyPerson: true, ...evMeta(p) }) } catch (err) { }
    try { await recordActive(gid, 'fake:' + p.name, rg) } catch (err) { }
    return true
  } catch (err) { return false }
}
/** 单个伪玩家消费(攒钱目标驱动, 购买不限制):
 *  - 有攒钱目标 → 攒够就买高级货(武器/功法/丹药), 买完重新定目标
 *  - 攒钱中不乱花钱, 仅突破急需时补破障丹(刚需)
 *  - 不再"有钱就花"导致永远攒不住钱 */
async function tryFakeBuy (f, gid, p, now) {
  const rg = p.loc || 'center'
  try {
    if (!p.wish) p.wish = fakeWish(f, p)
    const money = p.money || 0
    /* 攒够目标 → 买! */
    if (money >= p.wish.price) {
      const ok = await buyWishItem(f, gid, p, p.wish)
      if (ok) p.wish = null // 买完重新定目标
      return ok
    }
    /* 攒钱中: 突破急需破障丹(背包无且灵力达标)才应急买; 平时不乱花 */
    const needPill = p.bag && p.bag.items && itemCount(p.bag.items['破障丹']) <= 0 && (p.exp || 0) >= fakeSubThreshold(p.level + 1)
    if (needPill && money >= (ITEM_PRICE['破障丹'] || 1000)) {
      const res = await buyStock(gid, 'dange', '破障丹', 1, rg)
      if (res && res.ok && (res.count || 0) >= 1) {
        p.money -= (ITEM_PRICE['破障丹'] || 1000)
        if (!p.bag) p.bag = { items: {}, equipped: {} }
        fakeAddItem(p.bag, '破障丹', 1)
        const who = p.status === 'sect' && p.sect ? sectName(f, p.sect) : '散修'
        try { logTrade(f, `【丹阁·${regionNameOf(rg)}】${who} ${p.name} 购得 ${itemIcon('破障丹')}破障丹 ×1（-${ITEM_PRICE['破障丹'] || 1000}灵石）`) } catch (err) { }
        try { await recordActive(gid, 'fake:' + p.name, rg) } catch (err) { }
        return true
      }
    }
    return false
  } catch (err) { return false }
}
/** 突破时自动买破障丹(玩家一致: 丹阁价, 按所在大区库存; 买不起/售罄返回false) */
async function buyPillForBreak (f, p) {
  try {
    const price = ITEM_PRICE['破障丹'] || 1000
    if ((p.money || 0) < price) return false
    const rg = p.loc || 'center'
    const res = await buyStock(f.gid, 'dange', '破障丹', 1, rg)
    if (!res || !res.ok || (res.count || 0) < 1) return false
    p.money -= price
    /* 销售税(玩家一致: 按所在大区税率计入该区繁荣度) */
    const tw = getWorld(f.gid)
    const trate = taxFor(tw, rg, p.sect ? sectName(f, p.sect) : null)
    const ttax = Math.max(1, Math.round(price * trate / 100))
    addTax(tw, rg, ttax)
    saveWorld(tw)
    try { logTrade(f, `【丹阁·${regionNameOf(rg)}】${p.sect ? sectName(f, p.sect) : '散修'} ${p.name} 购得 ${itemIcon('破障丹')}破障丹 ×1（-${price}灵石，税率${trate}%缴税${ttax}）`) } catch (err) { }
    try { await recordActive(f.gid, 'fake:' + p.name, rg) } catch (err) { }
    return true
  } catch (err) { return false }
}
/** 每分钟交易推进: 每个在世伪玩家尝试买 1 件(短冷却1~3分钟, 有钱就买但不刷屏掩盖修炼/摆摊; 买不起/售罄自动跳过) */
async function tradeTick (f, gid, now) {
  let changed = false
  for (const p of Object.values(f.roster)) {
    if (!p || !p.alive || p.realmBusy || isInSectMine(f, p.name)) continue
    if (!p.activities) p.activities = {}
    if (now < (p.activities.nextShop || 0)) continue
    const bought = await tryFakeBuy(f, gid, p, now)
    p.activities.nextShop = now + (1 + Math.floor(Math.random() * 3)) * 60000 // 1~3分钟后(原5~15分钟, 用户要求去限制; 无冷却会刷屏)
    if (bought) changed = true
  }
  return changed
}

/* ---------- 伪玩家灵兽推进 ---------- */
const FAKE_PET_NEXT_MIN = 5
const FAKE_PET_NEXT_MAX = 30
const FAKE_PET_START_PER_TICK = 10
function fakePetDelay () {
  return (FAKE_PET_NEXT_MIN + Math.floor(Math.random() * (FAKE_PET_NEXT_MAX - FAKE_PET_NEXT_MIN + 1))) * 60000
}
function fakePetOwner (f, p) {
  return !!(p && p.name && p.alive && !p.realmBusy && !isFakeCaptive(f, p.name) && !isInSectJail(f, p.name) && !isInRaidJail(f, p.name) && !isInSectMine(f, p.name))
}
function fakePetName (pet) {
  return pet.customName || speciesMeta(pet.speciesId)?.species.name || pet.speciesId
}

/* 伪玩家灵兽策略: 白/绿(quality<=2)算垃圾, 最多留战力最高的 3 只 */
const FAKE_PET_KEEP = 3
const FAKE_PET_JUNK_QUALITY = 2

/**
 * 放生垃圾灵兽: 白/绿品质直接放生(只保留最强的一只兜底),
 * 其余按战力只留 FAKE_PET_KEEP 只。原地修改 state.bag[name]。
 * @returns {boolean} 是否有放生/出战槽位被清理
 */
export function pruneFakePets (state, name) {
  const bag = state && state.bag && state.bag[name]
  if (!Array.isArray(bag) || bag.length <= 1) return false
  const ranked = [...bag].sort((a, b) => (petPower(b) - petPower(a)) || ((Number(b.quality) || 0) - (Number(a.quality) || 0)))
  const best = ranked[0]
  const keep = new Set()
  for (const pet of ranked) {
    if (keep.size >= FAKE_PET_KEEP) break
    const junk = (Number(pet.quality) || 0) <= FAKE_PET_JUNK_QUALITY
    if (junk && pet !== best) continue
    keep.add(pet.pid)
  }
  const next = bag.filter(pet => keep.has(pet.pid))
  let changed = next.length !== bag.length
  if (changed) state.bag[name] = next
  /* 出战槽位指向被放生的灵兽 → 摘掉, 后面自动出战会重选最强 */
  if (state.active && state.active[name] !== undefined && !keep.has(state.active[name])) {
    delete state.active[name]
    changed = true
  }
  return changed
}

/**
 * 伪玩家灵兽统一整理: 旧灵兽补到满成长(蜕变), 并放生垃圾。
 * 新捕获的灵兽在 resolveEncounter({ instantGrow: true }) 里直接是蜕变。
 * @returns {boolean} 是否有变更
 */
export function tidyFakePets (state, owners, now = Date.now()) {
  let changed = false
  for (const p of owners || []) {
    const bag = state.bag && state.bag[p.name]
    if (!Array.isArray(bag) || !bag.length) continue
    for (const pet of bag) {
      if (pet && pet.stage !== '蜕变') { maturePet(pet, now); changed = true }
    }
    if (pruneFakePets(state, p.name)) changed = true
  }
  return changed
}
/** 伪玩家自动搜寻/捕获/出战灵兽; 与真实玩家共用规则, 但使用独立 fake pet 存档 */
export function fakePetTick (f, gid, now = Date.now()) {
  const state = getPetState(gid, 'fake')
  const owners = Object.values(f.roster || {}).filter(p => p && p.alive)
  const liveNames = new Set(owners.map(p => p.name))
  let changed = false
  /* 死亡/除名伪玩家不再占用 fake 灵兽榜或出战槽位 */
  for (const section of ['bag', 'search', 'encounter', 'pokedex', 'active']) {
    for (const name of Object.keys(state[section] || {})) {
      if (!liveNames.has(name)) { delete state[section][name]; changed = true }
    }
  }
  owners.forEach(p => bindFakeGid(p, gid))
  /* 伪玩家灵兽: 旧灵兽补到满成长(蜕变); 白/绿垃圾放生, 最多留战力最强的 3 只 */
  if (tidyFakePets(state, owners, now)) changed = true
  let started = 0
  /* 尚未搜寻的伪玩家按独立冷却开始一轮 0~30 分钟搜寻, 大区取自身所在位置 */
  for (const p of owners) {
    if (started >= FAKE_PET_START_PER_TICK) break
    if (!fakePetOwner(f, p)) continue
    if (!p.activities) p.activities = {}
    if (p.activities.nextPetAt === undefined) p.activities.nextPetAt = 0
    if (state.search[p.name] || state.encounter[p.name] || now < p.activities.nextPetAt) continue
    const region = p.loc || DEFAULT_REGION
    const huntMin = Number(PET_CFG.huntMin) || 0
    const huntMax = Math.max(huntMin, Number(PET_CFG.huntMax) || huntMin)
    const readyAt = now + (huntMin + Math.floor(Math.random() * (huntMax - huntMin + 1))) * 60000
    state.search[p.name] = { startAt: now, readyAt, region }
    p.activities.nextPetAt = readyAt
    started++
    changed = true
  }

  /* 共用核心 tick: 开红/彩窗、滚出遇宠、孵化和成长 */
  const notices = tickPetGroup(state, gid, now)
  for (const n of notices) {
    if (n.type === 'red-window' || n.type === 'rainbow-window') {
      const kind = n.type === 'red-window' ? '红品' : '彩品'
      logEvent(f, 'pet', `【灵兽天机】伪玩家灵兽${kind}机缘降临${regionNameOf(n.region)}，仅供伪玩家捕获`, now)
    } else if (n.type === 'encounter') {
      const p = f.roster && f.roster[n.uid]
      /* 伪玩家无论当前是否仍可行动都要清理遇宠, 避免 fake 状态卡死 */
      const r = p && fakePetOwner(f, p)
        ? resolveEncounter(state, n.uid, 1, now, personPower(p), { instantGrow: true })
        : resolveEncounter(state, n.uid, 2, now, 0)
      if (p) {
        if (!p.activities) p.activities = {}
        p.activities.nextPetAt = now + fakePetDelay()
      }
      if (r && r.ok && r.pet && p) {
        logEvent(f, 'pet', `【灵兽】伪玩家 ${p.name} 捕获${qualityNameOf(r.pet.quality)}灵兽【${fakePetName(r.pet)}】`, now, { who: [p.name] })
      }
      changed = true
    } else if (n.type === 'encounter-expire') {
      const p = f.roster && f.roster[n.uid]
      if (p) {
        if (!p.activities) p.activities = {}
        p.activities.nextPetAt = now + fakePetDelay()
      }
      changed = true
    } else if (n.type === 'hatched' || n.type === 'upgraded') {
      const p = f.roster && f.roster[n.uid]
      if (p && n.pet) logEvent(f, 'pet', `【灵兽】伪玩家 ${p.name} 的【${fakePetName(n.pet)}】${n.type === 'hatched' ? '破壳' : `成长至${n.pet.stage}`}`, now, { who: [p.name] })
      changed = true
    }
  }

  /* 新捕获的灵兽可能让袋子超额: 再整理一次, 放生最弱的 */
  for (const p of owners) {
    if (state.bag[p.name] && pruneFakePets(state, p.name)) changed = true
  }

  /* 自动出战当前最强成熟灵兽; 只改 fake state, 不会影响真实玩家出战状态 */
  for (const p of owners) {
    const bag = state.bag[p.name] || []
    for (const pet of bag) settlePet(pet, now)
    const ready = bag.filter(pet => canBattle(pet.stage)).sort((a, b) => petPower(b) - petPower(a))
    const activePid = state.active[p.name]
    const active = bag.find(pet => pet.pid === activePid)
    if (!ready.length) {
      if (activePid) { delete state.active[p.name]; changed = true }
      continue
    }
    const best = ready[0]
    if (!active || petPower(best) > petPower(active)) {
      state.active[p.name] = best.pid
      changed = true
    }
  }
  if (changed || notices.length) savePetState(state)
  return { notices, changed }
}

/* ---------- 进程内按群串行锁 ---------- */
const fakeLocks = new Map()
export async function withFakeLock (gid, fn) {
  const g = String(gid || '')
  const previous = fakeLocks.get(g) || Promise.resolve()
  let release
  const current = new Promise(resolve => { release = resolve })
  fakeLocks.set(g, current)
  await previous
  try { return await fn() } finally {
    if (fakeLocks.get(g) === current) fakeLocks.delete(g)
    release()
  }
}

/* ---------- 每分钟推进(存档每3分钟批量落盘) ---------- */
export async function fakeTick (gid) {
  return withFakeLock(gid, () => withDeferredSaveContext(() => fakeTickUnlocked(gid)))
}

async function fakeTickUnlocked (gid) {
  try {
    /* 夜间(凌晨1~6点)暂停运转: 不产事件/不打理攻打/不购买/不结算, 到点自动恢复 */
    if (isFakeNight()) return
    const f = getFake(gid)
    const now = Date.now()
    if (now - (Number(f.lastHistoryCleanup) || 0) >= HISTORY_CLEANUP_INTERVAL) {
      const report = cleanupFakeHistory(f, now)
      f.lastHistoryCleanup = now
      if (report.changed) console.log(`[天下大事]历史索引清理: ${gid} 删除${report.removed}项, 过期状态${report.expired}项`)
    }
    try { fakePetTick(f, gid, now) } catch (err) { console.log('[灵兽]伪玩家推进异常:', err && err.stack) }
    /* 宗门战争唯一由 sectTick 推进；旧版 f.attacks 已迁移并不再结算。 */
    try {
      const ss = await import('./sect_system.js')
      await ss.sectTick(f, gid, now)
    } catch (err) { console.log('[宗门系统]推进异常:', err && err.stack) }
    /* 每分钟: 灭门检查(核心管理层全死→灭门/玩家继任; 不必等每日结算) */
    try { rebuildSettle(f) } catch (err) { console.log('[宗门系统]灭门检查异常:', err && err.stack) }
    /* 每分钟: 宗门超员→弟子离宗/叛宗概率大增 */
    try { overCapSettle(f, now) } catch (err) { console.log('[宗门系统]超员结算异常:', err && err.stack) }
    /* 每分钟: 藏宝阁天牢结算(洗劫藏宝阁被抓的伪玩家刑满释放, 记【出狱】) */
    try { raidJailSettle(f, now) } catch (err) { console.log('[天下大事]藏宝阁天牢结算异常:', err && err.stack) }
    /* 每分钟: 每人核心行为(冷却到按性格概率执行: 修炼/吃丹/突破/摆摊), 重启后立即可见 */
    await perPersonActs(f, now)
    /* 宗门新版 sectTick 已负责唯一的材料炼丹/炼器和药园产出；旧 sectResourceFlow 会重复消耗材料并绕过统一穿戴，停用。 */
    /* 每30分钟: 旧版宗门资源自用流转已移除 */
    /* 每小时: 伪玩家宗主任命(修为达标即提拔补职位空缺——当天达标当天升, 不用等每日结算) */
    if (now - (f.lastPromote || 0) >= 3600000) {
      f.lastPromote = now
      try { promoteSettle(f) } catch (err) { console.log('[宗门系统]宗主任命异常:', err && err.stack) }
    }
    /* 每6小时: 高修为者夺权(强者为尊, >宗主+3级 40%概率; 用户要求 每日→6小时) */
    if (now - (f.lastPower || 0) >= 6 * 3600000) {
      f.lastPower = now
      try { powerStruggleSettle(f) } catch (err) { console.log('[宗门系统]夺权结算异常:', err && err.stack) }
    }
    /* 每分钟: 必产 1~2 起江湖事件(无批次/数量硬限制, 系统驱动持续更新; 时间戳近1分钟内秒级分散, 保证天下大事/小事一直有新内容) */
    {
      const n = 1 + rand([0, 1])
      let made = 0
      let tries = 0
      while (made < n && tries < n * 4) {
        tries++
        try {
          const gen = pick(EVENT_GENS)
          const et = now - rand([0, 60]) * 1000 // 近1分钟(秒级分散, 避免同秒堆积)
          const ev = gen(f, et)
          if (ev) { logEvent(f, ev.type, ev.txt, et, ev); made++ }
        } catch (err) { }
      }
    }
    /* 散修更倾向加入宗门: 散修江湖险恶(易被劫杀), 额外入宗机会(意愿增强, 每分钟60%) */
    try {
      if (Math.random() < 0.6) {
        const et2 = now - rand([0, 60]) * 1000
        const ev = genScatterJoin(f, et2)
        if (ev) logEvent(f, ev.type, ev.txt, et2, ev)
      }
    } catch (err) { }
    /* 每30分钟固定新增1名伪玩家, 不受当前在世人数影响 */
    topupFake(f, now)
    /* 每分钟: 伪玩家逛三阁购买(限购/买装备丹药/计入补货活跃) */
    await tradeTick(f, gid, now)
    /* 每日结算(按日期切换) */
    const today = dayStr(now)
    if (f.day !== today) {
      f.day = today
      dailySettle(f)
    }
    /* 后台推进只登记最新状态，每3分钟由 world_news 统一批量写盘。 */
    saveFake(f, gid)
  } catch (err) {
    console.log('[天下大事]推进异常:', err && err.stack)
  }
}
