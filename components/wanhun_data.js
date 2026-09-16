import fs from 'fs'
import path from 'path'
import { Plugin_Name, Save_Path } from './plugin.js'
import xujing_data from './xujing_data.js'
import {
  getBag, saveBag, addItem, consumeItem, MATERIAL_TPL, ITEM_TPL, tryGiveSecretKey,
  EQUIP_TPL, GONGFA_TPL, rainbowAtk, hasDingxianyou, isDingxianyouEquipped, itemIcon
} from './equip_data.js'
import { getWorld, getLoc, levelNameOf } from './world_data.js'
import { disablePuppets, puppetArtifactLine } from './puppet_data.js'
import { calcCombatPower, getBuffs, fightBestOf5, guardWinRate, realmPower } from './fight.js'
import { fakeSubThreshold } from './fake_data.js'

const SAVE_DIR = `${Save_Path}/wanhun`
const RANK_CAPACITY = [0, 20, 30, 50, 100, 300, 500, 1000, 5000, 10000]
const RANK_NAMES = ['','一阶','二阶','三阶','四阶','五阶','六阶','七阶','八阶','九阶']
const SOUL_MATS = ['阴魂砂', '游魂骨', '鬼火草', '幽冥木', '摄魂铁', '阴魂石', '玄阴玉', '镇魂晶', '血煞髓', '万魂帝晶']
const SHOP_REFRESH_MS = 7 * 60 * 60 * 1000
/* ===== 主魂/副魂培育 ===== */
/* 魂境界名(对应玩家17大境界, 魂帝为最高): 与 world_data.levelNameOf 同构 */
const SOUL_REALMS = ['魂徒', '魂兵', '魂士', '魂卫', '魂将', '魂帅', '魂王', '魂侯', '魂公', '魂皇', '魂尊', '魂圣', '魂仙', '魂灵', '魂神', '魂主', '魂帝']
const SOUL_STAGES = ['初期', '中期', '后期', '巅峰']
const SOUL_STAGE_COUNT = 4
const SOUL_MAX_LEVEL = SOUL_REALMS.length * SOUL_STAGE_COUNT
const SOUL_DECAY_MS = 30 * 60 * 1000
const SOUL_TRAIN_COST = 50
const SOUL_TRAIN_ITEM = '无主幽魂'
/* 按万魂幡阶位允许的副魂数: 5阶1个 / 7阶2个 / 9阶3个 */
const DEPUTY_MAX_BY_RANK = [0, 0, 0, 0, 0, 1, 1, 2, 2, 3]
const GHOST_ENCOUNTER_CHANCE = 0.05
const UPGRADE = [
  null,
  { souls: 30, karma: 5 },
  { souls: 100, karma: 15 },
  { souls: 300, karma: 30 },
  { souls: 800, karma: 60 },
  { souls: 1800, karma: 100 },
  { souls: 4000, karma: 160 },
  { souls: 8000, karma: 250 },
  { souls: 15000, karma: 400 }
]

function ensureDir () {
  if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true })
}
function fileOf (gid) { return path.join(SAVE_DIR, `wanhun_${String(gid || 'global')}.json`) }
function emptyGroup (gid) { return { gid: String(gid || 'global'), users: {}, shops: {} } }
function readGroup (gid) {
  ensureDir()
  const file = fileOf(gid)
  let data = emptyGroup(gid)
  try { if (fs.existsSync(file)) data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8'))) } catch (err) { data = emptyGroup(gid) }
  if (!data.users || typeof data.users !== 'object') data.users = {}
  if (!data.shops || typeof data.shops !== 'object') data.shops = {}
  return data
}
function saveGroup (gid, data) {
  ensureDir()
  const file = fileOf(gid)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, '\t'))
    fs.renameSync(tmp, file)
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (e) {}
    throw err
  }
}
function defaultUser () {
  return {
    cave: null,
    lostUntil: 0,
    lostInCave: false,
    realmDrop: { count: 0, nextRecoverAt: 0 },
    lastWarningAt: 0
  }
}
function userState (data, uid) {
  const key = String(uid)
  if (!data.users[key] || typeof data.users[key] !== 'object') data.users[key] = defaultUser()
  const u = data.users[key]
  if (!Object.prototype.hasOwnProperty.call(u, 'lostUntil')) u.lostUntil = 0
  if (!Object.prototype.hasOwnProperty.call(u, 'lostInCave')) u.lostInCave = false
  if (!u.realmDrop || typeof u.realmDrop !== 'object') u.realmDrop = { count: 0, nextRecoverAt: 0 }
  if (!Number.isFinite(Number(u.realmDrop.count))) u.realmDrop.count = 0
  if (!Number.isFinite(Number(u.realmDrop.nextRecoverAt))) u.realmDrop.nextRecoverAt = 0
  return u
}
function artifactOf (bag) {
  if (!bag.artifacts || typeof bag.artifacts !== 'object') bag.artifacts = {}
  const a = bag.artifacts.wanhun || null
  ensureSoulFields(a)
  return a
}
function artifactName (artifact) { return String(artifact?.name || '万魂幡') }
function artifactDisplayName (name) { return `🏴${name}` }
function normalizeArtifactName (name) {
  return String(name || '').trim().replace(/[#＃]/g, '').slice(0, 8)
}
function setArtifact (bag, artifact) {
  if (!bag.artifacts || typeof bag.artifacts !== 'object') bag.artifacts = {}
  bag.artifacts.wanhun = artifact
}
/* ===== 主魂/副魂 辅助函数 ===== */
/* 旧档懒迁移: 万魂幡补上主魂/副魂字段默认值 */
function ensureSoulFields (artifact) {
  if (!artifact) return
  if (artifact.mainSoul === undefined) artifact.mainSoul = null
  if (!Array.isArray(artifact.deputySouls)) artifact.deputySouls = []
}
/* 魂境界名: 与玩家等级阶梯同构, 魂帝为最高 */
function soulLevelNameOf (level) {
  level = Number(level) || 0
  if (level <= 0) return '残魂'
  if (level > SOUL_MAX_LEVEL) return `魂帝第${level - SOUL_MAX_LEVEL}重`
  const i = Math.floor((level - 1) / SOUL_STAGE_COUNT)
  const j = (level - 1) % SOUL_STAGE_COUNT
  return SOUL_REALMS[i] + SOUL_STAGES[j]
}
/* 新育魂: 从最低境界开始, 初始魂魄为最低境界所需 */
function newSoul () {
  return { level: 1, souls: fakeSubThreshold(1), lastDecayAt: now() }
}
/* 懒追赶掉魂: 每30分钟掉1点；魂魄不足维持当前境界时自动降境，最低继续掉到0魂魄。 */
function decaySoul (soul, t = now()) {
  if (!soul) return false
  const last = Number(soul.lastDecayAt) || t
  const periods = Math.max(0, Math.floor((t - last) / SOUL_DECAY_MS))
  if (periods <= 0) return false
  soul.souls = Math.max(0, (Number(soul.souls) || 0) - periods)
  soul.level = Math.max(0, Number(soul.level) || 0)
  while (soul.level > 0 && soul.souls < fakeSubThreshold(soul.level)) soul.level -= 1
  soul.lastDecayAt = last + periods * SOUL_DECAY_MS
  return true
}
function countOf (bag, name) { return Number(bag.items?.[name]?.count) || 0 }
function costFor (rank) {
  const cost = {}
  const low = 20 + Math.max(0, rank - 1) * 10
  /* 初始打造已使用前两种白色材料；每次进阶额外解锁下一种材料，并额外消耗万魂幡残卷×5、云裳仙蕊×1。 */
  for (let i = 0; i <= rank + 1; i++) {
    cost[SOUL_MATS[i]] = i === rank + 1 ? 5 + Math.max(0, rank - 1) * 5 : low
  }
  cost['云裳仙蕊'] = 1
  cost['万魂幡残卷'] = 5
  return cost
}
function hasCost (bag, cost) {
  return Object.entries(cost).every(([n, c]) => countOf(bag, n) >= c)
}
function takeCost (bag, cost) {
  for (const [name, count] of Object.entries(cost)) {
    const item = bag.items[name]
    item.count -= count
    if (item.count <= 0) delete bag.items[name]
  }
}
function fmtCost (cost) { return Object.entries(cost).map(([n, c]) => `${itemIcon(n)}${n}×${c}`).join('、') }
/* 进阶到下一阶所需材料文本(含品质图标), 与升级实际消耗同一来源; 供路线/攻略展示 */
export function fmtUpgradeCost (rank) {
  return fmtCost(costFor(rank))
}
/* 缺少的材料清单: 返回 [{name, need, have}], 只列当前不够的项 */
export function missingCost (bag, cost) {
  const missing = []
  for (const [name, need] of Object.entries(cost || {})) {
    const have = countOf(bag, name)
    if (have < need) missing.push({ name, need, have })
  }
  return missing
}
/* 缺失材料文本: 逐项展示需要数量、当前持有与缺少数量 */
export function fmtMissing (missing) {
  return missing.map(({ name, need, have }) => `${itemIcon(name)}${name}×${need}（当前${have}，缺${need - have}）`).join('、')
}
function randomInt (min, max) { return min + Math.floor(Math.random() * (max - min + 1)) }
function pick (arr) { return arr[Math.floor(Math.random() * arr.length)] }
function now () { return Date.now() }
/* 阴魂战力曲线:整体下调20%；80分钟约4万，之后每10分钟增加约8000。 */
function caveEnemyPower (minutes) {
  const elapsed = Math.max(0, Number(minutes) || 0)
  const base = 500
  const scale = power => Math.round(power * 0.8)
  if (elapsed < 45) {
    const progress = elapsed / 45
    return scale(base + (35000 - base) * progress * progress)
  }
  if (elapsed < 60) return scale(35000 + (40000 - 35000) * (elapsed - 45) / 15)
  if (elapsed < 80) return scale(40000 + (50000 - 40000) * (elapsed - 60) / 20)
  return scale(50000 + (elapsed - 80) * 1000)
}

/* 白/绿/蓝材料从进入时就有；30分钟后开放紫/金/红材料的常规掉落；彩色材料50分钟后提高概率。 */
const CAVE_BASE_MATERIALS = ['阴魂砂', '游魂骨', '鬼火草', '幽冥木', '摄魂铁', '阴魂石']
/* 普通材料兜底按权重抽取: 白色5 > 绿色4/3 > 蓝色2/1, 低级材料更易掉落 */
const CAVE_BASE_WEIGHTS = [5, 4, 3, 2, 2, 1]
/* 万魂窟彩色掉落仅残卷与万魂帝晶; 造梦神玉/云裳仙蕊不由万魂窟产出(分别在秘境/配方台获取) */
const CAVE_COLOR_MATERIALS = ['万魂幡残卷', '万魂帝晶']
const CAVE_ADVANCED_MATERIALS = ['玄阴玉', '镇魂晶', '血煞髓']
const CAVE_ENEMY_NAMES = {
  low: ['游魂', '云间魂灵', '月影魂使', '青灯魂客', '轻风阴灵', '流霞魂影'],
  mid: ['玄音魂将', '星河魂卫', '雾隐魂使', '青冥魂将', '玉衡魂灵', '霜华魂官'],
  high: ['幽境镇守', '星渊魂将', '太虚魂侯', '云海魂尊', '玄冥魂帅', '万魂守御']
}

/* 万魂窟战斗掉落: 每战掉落 N 次(30分钟前1~4次, 30~50分钟4~8次, 50分钟后4~12次);
   每次掉落独立判定一次档次——彩色 > 进阶 > 普通, 命中即掉1个, 数量不再成倍。 */
export function caveDropCount (minutes, rand = Math.random) {
  const elapsed = Math.max(0, Number(minutes) || 0)
  if (elapsed < 30) return 1 + Math.floor(rand() * 4)   // 1~4
  if (elapsed < 50) return 4 + Math.floor(rand() * 5)   // 4~8
  return 4 + Math.floor(rand() * 9)                     // 4~12
}

/* 单次掉落: 依次按彩色/进阶各材料概率判定, 命中即掉该材料; 全未命中则按权重掉普通材料(白色>绿色>蓝色)。 */
export function caveRollOne (minutes, rand = Math.random) {
  for (const name of CAVE_COLOR_MATERIALS) {
    if (rand() < caveColorChance(name, minutes)) return name
  }
  for (const name of CAVE_ADVANCED_MATERIALS) {
    if (rand() < caveAdvancedChance(name, minutes)) return name
  }
  const total = CAVE_BASE_WEIGHTS.reduce((sum, w) => sum + w, 0)
  let roll = rand() * total
  for (let i = 0; i < CAVE_BASE_MATERIALS.length; i++) {
    roll -= CAVE_BASE_WEIGHTS[i]
    if (roll < 0) return CAVE_BASE_MATERIALS[i]
  }
  return CAVE_BASE_MATERIALS[CAVE_BASE_MATERIALS.length - 1]
}

export function rollCaveLoot (minutes, rand = Math.random) {
  const rewards = {}
  const drops = caveDropCount(minutes, rand)
  for (let i = 0; i < drops; i++) {
    const name = caveRollOne(minutes, rand)
    rewards[name] = (rewards[name] || 0) + 1
  }
  return rewards
}

/* 紫/金/红材料:30分钟前也有极低概率，30分钟后正式提升；起步与封顶概率均已下调为原来的1/3。 */
export function caveAdvancedChance (name, minutes) {
  if (!CAVE_ADVANCED_MATERIALS.includes(name)) return 0
  const elapsed = Math.max(0, Number(minutes) || 0)
  if (elapsed < 30) return 0.005
  const base = { 玄阴玉: 0.02, 镇魂晶: 0.015, 血煞髓: 0.01 }[name]
  const cap = { 玄阴玉: 0.1, 镇魂晶: 0.08, 血煞髓: 0.05 }[name]
  return Math.min(cap, base + Math.floor((elapsed - 30) / 10) * 0.015)
}

/* 万魂幡残卷单独在30分钟进入正式曲线；30分钟前基础概率1%，命中即掉1个。爆率已降到原来的1/6（先降1/3再砍半）。 */
export function wanhunScrollChance (minutes) {
  const elapsed = Math.max(0, Number(minutes) || 0)
  if (elapsed < 30) return 0.02 / 6
  return Math.min(0.25 / 6, (0.05 + Math.floor((elapsed - 30) / 10) * 0.01) / 6)
}

/* 彩色材料概率:50分钟前也可能低概率出现，50分钟后正式提高；万魂帝晶爆率砍半。 */
export function caveColorChance (name, minutes) {
  if (!CAVE_COLOR_MATERIALS.includes(name)) return 0
  const elapsed = Math.max(0, Number(minutes) || 0)
  if (name === '万魂幡残卷') return wanhunScrollChance(elapsed)
  if (elapsed < 50) return 0.005
  if (name === '万魂帝晶') return Math.min(0.2, 0.03 + Math.floor((elapsed - 50) / 10) * 0.01)
  return Math.min(0.1, 0.005 + Math.floor((elapsed - 50) / 10) * 0.005)
}

/* ===== 万魂窟内行动拦截(供基类 api.js 代理拦截与测试共用) ===== */
/* 窟内放行的万魂幡/窟内指令(含纯数字 pick; 纯数字由基类 isChoiceMsg 提前放行, 此处兜底) */
export const WANHUN_CAVE_ALLOW_FNCS = new Set([
  'wanhunPanel', 'renameWanhun', 'equipWanhun', 'equipNamedWanhun',
  'unequipWanhun', 'unequipNamedWanhun', 'deployWanhun', 'deployNamedWanhun',
  'recallWanhun', 'recallNamedWanhun', 'craftWanhun',
  'upgradeWanhun', 'enterCave', 'leaveCave', 'caveStatus', 'fightCave',
  'retreatCave', 'takePill', 'oneClickPill', 'rescue', 'merchant', 'route', 'pick',
  /* 玩家自身操作(与秘境/洗劫/伏击/打boss/宗门战锁一致): 窟内战斗中也吃丹/换装/换功法/换灵兽/管理傀儡 */
  'changeEquip', 'takeoff', 'autoequip', 'gongfaRun', 'gongfaClear',
  'petDeploy', 'petRecall', 'craft', 'equip', 'unequip', 'deploy', 'recall',
  'upgrade', 'rename', 'dismantle', 'dismantleTechnique',
  'trainMainSoul', 'trainDeputySoul', 'feedMainSoul', 'feedDeputySoul',
  'wanhunStatus', 'wanhunGuide', 'yanghunStatus', 'yanghunGuide',
  'buildYanghun', 'upgradeYanghun', 'runYanghun', 'stopYanghun', 'destroyYanghun'
])
/* 三阁入口展示指令(丹阁/器阁/藏宝阁): 展示即占用 street 交互并允许数字购买, 探索期间不放行 */
export const STREET_ENTRY_FNCS = new Set(['dangeShow', 'qigeShow', 'cangbaogeShow'])

/* 改名后"动词+名字"指令解析: 返回指令中的名字; 动词不匹配或无名字返回 null */
export function parseWanhunNamedCmd (msg, verb) {
  const m = String(msg || '').match(new RegExp(`^[#＃]?${verb}\\s*(\\S+)$`))
  return m ? m[1] : null
}
/* 改名后"动词+名字"指令正则, 供命令规则注册 */
export function wanhunNamedCmdReg (verb) { return `^[#＃]?${verb}\\s*\\S+$` }

/**
 * 万魂窟探索中某指令是否被拦截。
 * 放行: 纯数字选择(窟内战斗/商人兑换)、万魂幡/窟内指令、查看类指令(三阁展示入口除外)。
 * 拦截: 其余行动指令(去丹阁/去器阁/去藏宝阁、去中州等跨区移动、逛街、交易、决斗等)。
 * @param {string} fnc 指令方法名(代理拦截的 prop)
 * @param {object} opts
 * @param {boolean} [opts.isChoiceMsg] 纯数字选择(基类统一判断, 先短路可省一次读档)
 * @param {boolean} [opts.isView] 是否属于基类 VIEW_METHODS 查看类白名单
 */
export function caveActionBlocked (fnc, { isChoiceMsg = false, isView = false } = {}) {
  if (isChoiceMsg) return false
  if (WANHUN_CAVE_ALLOW_FNCS.has(fnc)) return false
  if (isView && !STREET_ENTRY_FNCS.has(fnc)) return false
  return true
}

function notifyPlayer (gid, uid, text) {
  try {
    const group = Bot.pickGroup(gid)
    if (group && group.sendMsg) group.sendMsg([segment.at(Number(uid)), text])
  } catch (err) { }
}

export const Wanhun = {
  RANK_CAPACITY,
  RANK_NAMES,
  SOUL_MATS,
  UPGRADE,
  capacity (rank) { return RANK_CAPACITY[Math.max(1, Math.min(9, Number(rank) || 1))] || 20 },
  rankName (rank) { return RANK_NAMES[Math.max(1, Math.min(9, Number(rank) || 1))] || '一阶' },
  nameOf (artifact) { return artifactName(artifact) },
  getArtifact (uid, gid = 'global') {
    const bag = getBag(uid, gid)
    const old = artifactOf(bag)
    if (old) return old
    return null
  },
  panel (uid, gid = 'global') {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    const name = artifactName(artifact)
    const dingxianyou = hasDingxianyou(bag)
    const dingxianyouEquipped = isDingxianyouEquipped(bag)
    const lines = []
    const puppetLine = puppetArtifactLine(bag)
    if (puppetLine) {
      lines.push(puppetLine)
    } else if (artifact && artifact.equipped) {
      const cap = this.capacity(artifact.rank)
      lines.push(
        `法宝：🏴${name}（${this.rankName(artifact.rank)}，攻击+${artifact.attack}）`,
        `魂魄：${artifact.souls || 0} / ${cap}`,
        `🏴${name}收魂：${artifact.totalSouls || 0}`,
        `祭出状态：${artifact.deployed ? '已祭出' : '未祭出'}`
      )
    } else if (artifact) {
      lines.push(`法宝：🏴${name}（${this.rankName(artifact.rank)}，未装备）`)
    } else if (dingxianyouEquipped) {
      lines.push('法宝：🦋定仙游', '装备效果：生命+10%（生效中）')
    } else {
      lines.push('法宝：未装备')
    }
    if (dingxianyou) {
      lines.push(
        `定仙游：已拥有（${isDingxianyouEquipped(bag) ? '已装备' : '未装备'}）`,
        `　生命+10%：${isDingxianyouEquipped(bag) ? '生效中' : '需装备后生效'}`,
        '　被动：阴魂撤退100% · 免费跨区传送（拥有即生效）'
      )
    } else {
      lines.push('定仙游：未拥有')
    }
    return {
      equipped: !!(artifact && artifact.equipped),
      deployed: !!(artifact && artifact.deployed),
      artifact,
      text: lines.join('\n')
    }
  },
  rename (uid, gid = 'global', name) {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    if (!artifact) return { ok: false, msg: '你还没有万魂幡，无法改名。' }
    const next = normalizeArtifactName(name)
    if (!next) return { ok: false, msg: '用法：#万魂幡命名 <名字>（最多8字，如：#万魂幡命名 天玄幡）' }
    const old = artifactName(artifact)
    artifact.name = next
    saveBag(uid, bag, gid)
    return { ok: true, msg: `✅ 已将${artifactDisplayName(old)}改名为【${next}】。\n以后可使用 #装备${next}，原指令 #装备万魂幡 仍然有效。` }
  },
  craft (uid, gid = 'global', weaponId = null) {
    const bag = getBag(uid, gid)
    if (artifactOf(bag)) return { ok: false, msg: '你已经拥有万魂幡，不能重复打造。' }
    const cost = { '万魂幡残卷': 5, '阴魂砂': 20, '游魂骨': 20 }
    if (!hasCost(bag, cost)) {
      const missing = fmtMissing(missingCost(bag, cost))
      return { ok: false, msg: `打造万魂幡需要：${fmtCost(cost)}。\n你缺少：${missing}。` }
    }
    const rainbows = Array.isArray(bag.rainbows) ? bag.rainbows : []
    if (!rainbows.length) return { ok: false, msg: '打造万魂幡还需要一把成长性特殊彩武（先用 #铸造特殊彩武 获取）。' }
    /* 默认用第一把; 指定 weaponId 时用对应那把(玩家可选择消耗哪一把) */
    let weapon = rainbows[0]
    if (weaponId && rainbows.length > 1) {
      const hit = rainbows.find(w => String(w.id) === String(weaponId))
      if (hit) weapon = hit
    }
    const ref = `rainbow:${weapon.id}`
    if (bag.equipped?.weapon === ref) {
      bag.equipped.weapon = ''
      if (bag.equippedAttr) bag.equippedAttr.weapon = null
    }
    bag.rainbows = rainbows.filter(w => w !== weapon)
    takeCost(bag, cost)
    const attack = randomInt(100, 500)
    setArtifact(bag, { name: '万魂幡', rank: 1, attack, souls: 0, totalSouls: 0, equipped: false, deployed: false, shieldReady: false, aidUntil: 0, craftedAt: now() })
    saveBag(uid, bag, gid)
    return { ok: true, msg: `禁忌法宝打造成功！🏴万魂幡为一阶，容量${this.capacity(1)}，固定攻击+${attack}。\n已消耗：${fmtCost(cost)}和🌈成长性特殊彩武【${weapon.name || '七彩神兵'}】。\n请使用 #装备万魂幡。` }
  },
  equip (uid, gid = 'global', on = true) {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    if (!artifact) return { ok: false, msg: '你还没有万魂幡，请先收集残卷和材料打造。' }
    if (on && (bag.artifacts?.puppets || []).some(p => p && p.deployed)) return { ok: false, msg: '傀儡正在祭出中，请先使用 #收回傀儡 再切换法宝。' }
    artifact.equipped = !!on
    if (on) {
      if (bag.artifacts.dingxianyou) bag.artifacts.dingxianyou.equipped = false
      disablePuppets(bag)
    }
    if (!on) { artifact.deployed = false; artifact.aidUntil = 0 }
    saveBag(uid, bag, gid)
    const name = artifactName(artifact)
    return { ok: true, msg: on ? `已装备${this.rankName(artifact.rank)}${artifactDisplayName(name)}，固定攻击+${artifact.attack}。` : `已卸下${artifactDisplayName(name)}，临时助战效果结束。` }
  },
  deploy (uid, gid = 'global') {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    const name = artifactName(artifact)
    if (!artifact || !artifact.equipped) return { ok: false, msg: `请先装备${artifactDisplayName(name)}，未装备时不能祭出。` }
    this.tickArtifact(uid, gid, artifact, bag)
    if (artifact.deployed) return { ok: false, msg: `${artifactDisplayName(name)}已经祭出中。` }
    if ((artifact.souls || 0) < 20) return { ok: false, msg: `祭出${artifactDisplayName(name)}需要20魂（百鬼助战10魂+聚魂护体10魂），当前只有${artifact.souls || 0}魂。` }
    artifact.souls -= 20
    artifact.deployed = true
    artifact.aidUntil = now() + 30 * 60 * 1000
    artifact.shieldReady = true
    saveBag(uid, bag, gid)
    return { ok: true, msg: `${artifactDisplayName(name)}已祭出！消耗20魂（百鬼助战10魂、聚魂护体10魂）。百鬼助战持续30分钟，聚魂护体已待命。` }
  },
  recall (uid, gid = 'global') {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    const name = artifactName(artifact)
    if (!artifact || !artifact.deployed) return { ok: false, msg: `${artifactDisplayName(name)}当前没有祭出。` }
    artifact.deployed = false
    artifact.aidUntil = 0
    saveBag(uid, bag, gid)
    return { ok: true, msg: `已收回${artifactDisplayName(name)}。${artifact.shieldReady ? '聚魂护体尚未触发，仍保留待命。' : ''}` }
  },
  tickArtifact (uid, gid, artifact, bag = getBag(uid, gid)) {
    if (!artifact || !artifact.deployed) return false
    let changed = false
    const t = now()
    while (artifact.aidUntil && artifact.aidUntil <= t && artifact.deployed) {
      if ((artifact.souls || 0) < 10) {
        artifact.deployed = false
        artifact.aidUntil = 0
        changed = true
        break
      }
      artifact.souls -= 10
      artifact.aidUntil += 30 * 60 * 1000
      changed = true
    }
    if (changed) saveBag(uid, bag, gid)
    return changed
  },
  aidPercent (rank) { return 0.02 + (Math.max(1, Math.min(9, Number(rank) || 1)) - 1) * (0.98 / 8) },
  getBattleBuff (uid, gid = 'global') {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    if (!artifact || !artifact.equipped || !artifact.deployed) return { atk: 1, def: 1, hp: 1 }
    this.tickArtifact(uid, gid, artifact, bag)
    if (!artifact.deployed) return { atk: 1, def: 1, hp: 1 }
    const p = this.aidPercent(artifact.rank)
    return { atk: 1 + p, def: 1 + p, hp: 1 + p }
  },
  tryShield (uid, gid = 'global') {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    if (!artifact || !artifact.equipped || !artifact.shieldReady) return { used: false, level: null }
    artifact.shieldReady = false
    let replenished = false
    if (artifact.deployed && (artifact.souls || 0) >= 10) {
      artifact.souls -= 10
      artifact.shieldReady = true
      replenished = true
    }
    saveBag(uid, bag, gid)
    return { used: true, level: 0, replenished }
  },
  soulValue (level) {
    level = Number(level) || 0
    if (level <= 5) return 1
    if (level <= 12) return 2
    if (level <= 20) return 5
    if (level <= 30) return 10
    if (level <= 40) return 25
    return 50
  },
  captureSoul (uid, gid = 'global', level, multiplier = 1) {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    if (!artifact || !artifact.equipped) return { gained: 0, value: 0, reason: '未装备' }
    const mult = Number(multiplier)
    const value = Math.max(0, Math.floor(this.soulValue(level) * (Number.isFinite(mult) ? mult : 1)))
    if (value <= 0) return { gained: 0, value: 0, overflow: 0, total: Number(artifact.totalSouls) || 0 }
    const cap = this.capacity(artifact.rank)
    const before = Number(artifact.souls) || 0
    const gained = Math.max(0, Math.min(value, cap - before))
    artifact.souls = before + gained
    artifact.totalSouls = (Number(artifact.totalSouls) || 0) + gained
    saveBag(uid, bag, gid)
    return { gained, value, overflow: value - gained, total: artifact.totalSouls }
  },
  /* 升级到下一阶所需材料文本(含图标), 供路线展示, 与升级实际消耗同一来源 */
  upgradeCostText (rank) { return fmtUpgradeCost(rank) },
  async upgrade (uid, gid = 'global') {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    const name = artifactName(artifact)
    if (!artifact) return { ok: false, msg: '你还没有万魂幡。' }
    const rank = Number(artifact.rank) || 1
    if (rank >= 9) return { ok: false, msg: `${artifactDisplayName(name)}已经是九阶。` }
    const req = UPGRADE[rank]
    const cost = costFor(rank)
    const home = await xujing_data.getQQYUserHome(uid, null, `${gid}.json`, false)
    const karma = Number(home[uid]?.karma) || 0
    if ((artifact.totalSouls || 0) < req.souls || karma < req.karma) return { ok: false, msg: `升级${this.rankName(rank)}${artifactDisplayName(name)}需要累计收魂${req.souls}、业力${req.karma}（当前：${artifact.totalSouls || 0}魂、${karma}业力）。` }
    if (!hasCost(bag, cost)) {
      const missing = fmtMissing(missingCost(bag, cost))
      return { ok: false, msg: `升级${this.rankName(rank)}${artifactDisplayName(name)}材料不足：需要${fmtCost(cost)}。\n你缺少：${missing}。` }
    }
    takeCost(bag, cost)
    artifact.rank = rank + 1
    saveBag(uid, bag, gid)
    return { ok: true, msg: `${artifactDisplayName(name)}进阶成功！现在是${this.rankName(artifact.rank)}，容量${this.capacity(artifact.rank)}。本次成功率固定100%，消耗：${fmtCost(cost)}。` }
  },
  getCave (uid, gid = 'global') {
    const data = readGroup(gid)
    const u = userState(data, uid)
    saveGroup(gid, data)
    return u
  },
  /** 是否正在万魂窟内(只读, 不写档; 供基类行动拦截使用) */
  inCave (uid, gid = 'global') {
    const u = userState(readGroup(gid), uid)
    return !!(u.cave && u.cave.inCave)
  },
  async enterCave (uid, gid = 'global') {
    const data = readGroup(gid)
    const u = userState(data, uid)
    const w = getWorld(gid)
    if (getLoc(w, uid) !== 'west') return { ok: false, msg: '万魂窟位于西域，你必须先前往西域才能探索。' }
    if (u.lostUntil > now()) return { ok: false, msg: `你处于失魂状态，还剩${Math.ceil((u.lostUntil - now()) / 60000)}分钟，无法进入万魂窟。` }
    if (u.cave && u.cave.inCave) return { ok: false, msg: '你已经在万魂窟内，请处理当前探索。' }
    const protectedByStone = consumeItem(uid, '魂石', 1, null, gid)
    const enteredAt = now()
    u.cave = {
      inCave: true,
      enteredAt,
      protectionUntil: protectedByStone ? enteredAt + 10 * 60 * 1000 : enteredAt,
      nextEncounterAt: enteredAt + randomInt(30000, 120000),
      nextRealmDropAt: protectedByStone ? 0 : enteredAt + 60 * 1000,
      unprotected: !protectedByStone,
      pending: null
    }
    u.lostInCave = false
    saveGroup(gid, data)
    return protectedByStone
      ? { ok: true, msg: '你踏入西域万魂窟，已自动消耗1颗🔹魂石，获得10分钟保护。每30秒至2分钟会出现阴魂，遇敌后不能直接退出。' }
      : { ok: true, msg: '你没有🔹魂石，但仍强行踏入了万魂窟！当前处于无保护状态，1分钟后开始临时掉落境界，之后每分钟掉1个，直到境界归零。' }
  },
  /* 默认推送: 无论后台定时器还是命令路径(万魂幡面板/窟内状态/战斗撤退)生成遭遇,
     都要把阴魂/幽魂通知发给玩家——否则玩家在到点瞬间查询状态会静默生成遭遇,
     后台定时器看到 pending 已存在就跳过, 推送通知永远丢失 */
  async tickCave (uid, gid = 'global', notify = (text) => notifyPlayer(gid, uid, text)) {
    const data = readGroup(gid)
    const u = userState(data, uid)
    const t = now()
    let changed = false
    while (u.realmDrop.count > 0 && u.realmDrop.nextRecoverAt > 0 && u.realmDrop.nextRecoverAt <= t) {
      const recovered = await this.recoverOneRealm(uid, gid, u)
      if (!recovered) break
      changed = true
      if (notify) notify(`🌿 临时掉落的境界已恢复1个，当前还剩${u.realmDrop.count}个待恢复。`)
    }
    const cave = u.cave
    if (!cave || !cave.inCave || u.lostInCave) {
      if (changed) saveGroup(gid, data)
      return { state: u, changed }
    }
    if (!cave.nextRealmDropAt) cave.nextRealmDropAt = 0
    if (!cave.pending && cave.nextEncounterAt && cave.nextEncounterAt <= t) {
      const minutes = Math.floor((t - cave.enteredAt) / 60000)
      /* 幽魂遭遇: 随机遇到无主幽魂, 可吸收获得培育材料 */
      if (Math.random() < GHOST_ENCOUNTER_CHANCE) {
        cave.pending = { id: `ghost-${t}`, type: 'ghost', createdAt: t }
        changed = true
        if (notify) notify(`🌫️ 一只无主幽魂在你眼前游荡！\n回复 1：吸收（获得${itemIcon(SOUL_TRAIN_ITEM)}${SOUL_TRAIN_ITEM}）\n回复 2：放走。`)
      } else {
        const power = caveEnemyPower(minutes)
        const battle = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
        const player = battle[uid] || {}
        const bag = getBag(uid, gid)
        const buffs = await getBuffs(uid, gid)
        const playerPower = calcCombatPower(Number(player.level) || 0, bag, buffs, gid, uid).power
        const chance = guardWinRate(playerPower, power)
        const retreatChance = hasDingxianyou(getBag(uid, gid)) ? 100 : chance
        const namePool = minutes >= 60 ? CAVE_ENEMY_NAMES.high : (minutes >= 30 ? CAVE_ENEMY_NAMES.mid : CAVE_ENEMY_NAMES.low)
        const name = pick(namePool)
        cave.pending = { id: `yin-${t}`, type: 'battle', name, power, winChance: chance, retreatChance, createdAt: t }
        changed = true
        if (notify) notify(`🕯️ 阴魂来袭：${name}（战力约${power}）\n当前单局战斗胜率：${chance}%\n当前撤退成功率：${chance}%\n回复 1：战斗（胜利获得掉落，失败进入失魂）\n回复 2：撤退（成功无奖励，失败进入失魂）。`)
      }
    }
    const left = cave.protectionUntil - t
    if (left > 0 && left <= 60 * 1000 && u.lastWarningAt !== cave.protectionUntil) {
      u.lastWarningAt = cave.protectionUntil
      changed = true
      if (notify) notify('⚠️ 🔹魂石保护只剩1分钟！若下个续费节点没有魂石，你将掉落一个境界。')
    }
    if (cave.protectionUntil <= t && !cave.unprotected) {
      if (consumeItem(uid, '魂石', 1, null, gid)) {
        cave.protectionUntil = t + 10 * 60 * 1000
        u.lastWarningAt = 0
        changed = true
        if (notify) notify('🔹魂石自动消耗，万魂窟保护已续期10分钟。')
      } else {
        cave.unprotected = true
        cave.nextRealmDropAt = t
        changed = true
        if (notify) notify('⚠️ 🔹魂石已耗尽，临时掉境界开始！之后每1分钟临时掉落1个境界，直到境界归零。')
      }
    }
    if (cave.unprotected) {
      if (consumeItem(uid, '魂石', 1, null, gid)) {
        cave.unprotected = false
        cave.protectionUntil = t + 10 * 60 * 1000
        cave.nextRealmDropAt = 0
        u.lastWarningAt = 0
        changed = true
        if (notify) notify('🔹补充魂石，临时掉境界停止，保护恢复10分钟。')
      } else if ((cave.nextRealmDropAt || 0) <= t) {
        const dropped = await this.dropOneRealm(uid, gid, u)
        cave.nextRealmDropAt = t + 60 * 1000
        changed = true
        if (notify) notify(dropped ? '⚠️ 阴气侵体，临时掉落1个境界；每小时可恢复1个。' : '⚠️ 你的境界已经归零，无法继续下降。')
      }
    }
    if (changed) saveGroup(gid, data)
    return { state: u, changed }
  },
  async dropOneRealm (uid, gid, user = null) {
    const u = user || userState(readGroup(gid), uid)
    const battle = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
    const p = battle[uid]
    if (!p || (Number(p.level) || 0) <= 0) return false
    const old = Number(p.level) || 0
    p.level = Math.max(0, old - 1)
    p.levelname = levelNameOf(p.level)
    await xujing_data.getQQYUserBattle(uid, battle, true, `${gid}.json`)
    u.realmDrop.count = (Number(u.realmDrop.count) || 0) + 1
    if (!u.realmDrop.nextRecoverAt) u.realmDrop.nextRecoverAt = now() + 60 * 60 * 1000
    return old !== p.level
  },
  async recoverOneRealm (uid, gid, user) {
    if (!user.realmDrop.count || !user.realmDrop.nextRecoverAt || user.realmDrop.nextRecoverAt > now()) return false
    const battle = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
    const p = battle[uid]
    if (!p) return false
    p.level = (Number(p.level) || 0) + 1
    p.levelname = levelNameOf(p.level)
    await xujing_data.getQQYUserBattle(uid, battle, true, `${gid}.json`)
    user.realmDrop.count = Math.max(0, user.realmDrop.count - 1)
    user.realmDrop.nextRecoverAt = user.realmDrop.count ? now() + 60 * 60 * 1000 : 0
    return true
  },
  async caveStatus (uid, gid = 'global') {
    const ret = await this.tickCave(uid, gid)
    const u = ret.state
    const cave = u.cave
    const realmText = u.realmDrop.count > 0
      ? `\n临时掉境界：${u.realmDrop.count}个，下一次恢复还需${Math.max(0, Math.ceil((u.realmDrop.nextRecoverAt - now()) / 60000))}分钟（每小时恢复1个）`
      : ''
    if (u.lostUntil > now()) return `失魂中：还剩${Math.ceil((u.lostUntil - now()) / 60000)}分钟，期间不能行动；可使用 #服用${itemIcon('还魂丹')}还魂丹。${realmText}`
    if (!cave || !cave.inCave) return realmText ? `当前不在万魂窟。${realmText}` : '当前不在万魂窟。'
    const minutes = Math.floor((now() - cave.enteredAt) / 60000)
    const protect = Math.max(0, Math.ceil((cave.protectionUntil - now()) / 60000))
    if (u.lostInCave) return `失魂中：困在万魂窟内，只能使用 #服用${itemIcon('还魂丹')}还魂丹。${realmText}`
    if (cave.pending) {
      if (cave.pending.type === 'ghost') return `🌫️ 一只无主幽魂在你眼前游荡！\n回复 1：吸收（获得${itemIcon(SOUL_TRAIN_ITEM)}${SOUL_TRAIN_ITEM}）\n回复 2：放走。${realmText}`
      return `万魂窟内已遇到【${cave.pending.name}】，战力约${cave.pending.power}。当前单局战斗胜率${cave.pending.winChance || '计算中'}%，撤退成功率${cave.pending.retreatChance || '计算中'}%。请发送 #万魂窟战、#万魂窟撤退，或回复1/2。${realmText}`
    }
    return `万魂窟探索${minutes}分钟，魂石保护还剩${protect}分钟，下一次阴魂即将出现。使用 #退出万魂窟 离开。${realmText}`
  },
  async resolveCave (uid, gid = 'global', action) {
    await this.tickCave(uid, gid)
    const data = readGroup(gid)
    const u = userState(data, uid)
    const cave = u.cave
    if (!cave || !cave.inCave) return { ok: false, msg: '你当前不在万魂窟。' }
    if (u.lostInCave) return { ok: false, msg: '你已失魂并被困，只能使用 #服用🕯️还魂丹。' }
    if (!cave.pending) return { ok: false, msg: '当前没有遭遇，请等待下一次阴魂或幽魂。' }
    const enemy = cave.pending
    /* 幽魂遭遇: 吸收得无主幽魂 / 放走无所得 */
    if (enemy.type === 'ghost') {
      if (action === 'absorb') addItem(uid, SOUL_TRAIN_ITEM, 1, null, gid)
      cave.pending = null
      cave.nextEncounterAt = now() + randomInt(30000, 120000)
      saveGroup(gid, data)
      return { ok: true, msg: action === 'absorb'
        ? `🌫️ 吸收成功！获得${itemIcon(SOUL_TRAIN_ITEM)}${SOUL_TRAIN_ITEM}×1。`
        : '🌫️ 你放走了幽魂，它飘散而去，没有留下任何东西。' }
    }
    const battle = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
    const p = battle[uid] || {}
    const bag = getBag(uid, gid)
    const buffs = await getBuffs(uid, gid)
    const playerPower = calcCombatPower(Number(p.level) || 0, bag, buffs, gid, uid).power
    if (action === 'retreat') {
      const guaranteed = hasDingxianyou(bag)
      const chance = guaranteed ? 100 : guardWinRate(playerPower, enemy.power)
      if (guaranteed || Math.random() * 100 < chance) {
        cave.pending = null
        cave.nextEncounterAt = now() + randomInt(30000, 120000)
        saveGroup(gid, data)
        return { ok: true, msg: guaranteed
          ? '定仙游护佑生效！你从阴魂面前安全撤退（成功率100%），没有获得战利品。'
          : `你成功撤退，当前撤退成功率${chance}%，没有获得战利品。` }
      }
      u.lostInCave = true
      saveGroup(gid, data)
      return { ok: true, lost: true, msg: `撤退失败（成功率${chance}%）！你被阴魂拖入深处，进入失魂状态，只能使用 #服用还魂丹。` }
    }
    const chance = guardWinRate(playerPower, enemy.power)
    const match = fightBestOf5(chance)
    if (match.winner !== 'me') {
      u.lostInCave = true
      saveGroup(gid, data)
      return { ok: true, lost: true, msg: `战斗失败（单局胜率${chance}%）！你陷入失魂状态并被困在万魂窟，只能使用 #服用还魂丹。` }
    }
    const minutes = Math.floor((now() - cave.enteredAt) / 60000)
    const rewards = rollCaveLoot(minutes)
    for (const [name, count] of Object.entries(rewards)) addItem(uid, name, count, null, gid)
    /* 遗蜕古钥: 万魂窟战胜阴魂按彩级概率产, 每日每群最多2把 */
    try { await tryGiveSecretKey(gid, uid) } catch (err) { }
    cave.pending = null
    cave.nextEncounterAt = now() + randomInt(30000, 120000)
    saveGroup(gid, data)
    return { ok: true, msg: `你战胜了【${enemy.name}】（单局胜率${chance}%）！获得：${Object.entries(rewards).map(([n, c]) => `${itemIcon(n)}${n}×${c}`).join('、')}` }
  },
  leaveCave (uid, gid = 'global') {
    const data = readGroup(gid)
    const u = userState(data, uid)
    if (!u.cave || !u.cave.inCave) return { ok: false, msg: '你当前不在万魂窟。' }
    if (u.lostInCave) return { ok: false, msg: '你已失魂，不能退出万魂窟，只能服用🕯️还魂丹。' }
    if (u.cave.pending) return { ok: false, msg: '当前有遭遇未处理（阴魂或幽魂），请先处理完再退出。' }
    u.cave = null
    saveGroup(gid, data)
    return { ok: true, msg: '你离开了万魂窟。' }
  },
  usePill (uid, gid = 'global') {
    const data = readGroup(gid)
    const u = userState(data, uid)
    if (!u.lostInCave && !(u.lostUntil > now())) return { ok: false, msg: '你当前没有失魂状态。' }
    if (!consumeItem(uid, '还魂丹', 1, null, gid)) return { ok: false, msg: '你没有🕯️还魂丹，请到 #配方台 合成。' }
    const hadCaveTrap = u.lostInCave
    u.lostInCave = false
    u.lostUntil = 0
    if (hadCaveTrap && u.cave?.inCave) {
      u.cave.pending = null
      u.cave.nextEncounterAt = now() + randomInt(30000, 120000)
    }
    saveGroup(gid, data)
    return { ok: true, msg: hadCaveTrap && u.cave?.inCave
      ? '🕯️还魂丹生效，失魂状态已解除。当前阴魂遭遇已结束，可以直接使用 #退出万魂窟。'
      : `🕯️还魂丹生效，失魂状态已解除。${u.cave?.inCave ? '你仍在万魂窟内，请处理完遭遇后使用 #退出万魂窟。' : ''}` }
  },
  rescue (target, gid = 'global') {
    const data = readGroup(gid)
    const u = userState(data, target)
    if (!u.lostInCave || !u.cave?.inCave) return { ok: false, msg: '目标当前没有被困在万魂窟。' }
    u.lostInCave = false
    u.cave = null
    u.lostUntil = now() + 10 * 60 * 60 * 1000
    saveGroup(gid, data)
    return { ok: true, msg: `救援成功，目标已被送出万魂窟，但失魂状态还会持续10小时，期间不能行动。` }
  },
  isLocked (uid, gid = 'global') {
    const u = userState(readGroup(gid), uid)
    return u.lostInCave || u.lostUntil > now()
  },
  /* ===== 主魂/副魂 培育与喂养 ===== */
  /* 结算主魂+副魂的懒掉魂(交互时调用, 返回是否变更) */
  tickSoulDecay (bag, t = now()) {
    const artifact = artifactOf(bag)
    if (!artifact) return false
    let changed = false
    if (artifact.mainSoul) changed = decaySoul(artifact.mainSoul, t) || changed
    for (const d of (artifact.deputySouls || [])) {
      if (d) changed = decaySoul(d, t) || changed
    }
    return changed
  },
  /* 读取玩家当前境界等级(主魂/副魂成长上限) */
  async playerLevelOf (uid, gid) {
    try {
      const battle = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
      return Number(battle?.[uid]?.level) || 0
    } catch (err) { return 0 }
  },
  trainMainSoul (uid, gid = 'global') {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    const name = artifactName(artifact)
    if (!artifact) return { ok: false, msg: '你还没有万魂幡。' }
    if ((artifact.rank || 1) < 3) return { ok: false, msg: `需要${this.rankName(3)}及以上${name}才能培育主魂（当前${this.rankName(artifact.rank)}）。` }
    if (artifact.mainSoul) return { ok: false, msg: `${name}已经培育了主魂，不能重复培育。` }
    this.tickSoulDecay(bag)
    if ((Number(artifact.souls) || 0) < SOUL_TRAIN_COST) return { ok: false, msg: `培育主魂需要消耗${artifactDisplayName(name)}当前魂魄${SOUL_TRAIN_COST}，当前只有${artifact.souls || 0}。` }
    if (!consumeItem(uid, SOUL_TRAIN_ITEM, 1, null, gid)) return { ok: false, msg: `培育主魂还需要1个${itemIcon(SOUL_TRAIN_ITEM)}${SOUL_TRAIN_ITEM}（万魂窟探索中随机遇到幽魂，回复1吸收获得）。` }
    artifact.souls = (Number(artifact.souls) || 0) - SOUL_TRAIN_COST
    artifact.mainSoul = newSoul()
    saveBag(uid, bag, gid)
    const s = artifact.mainSoul
    return { ok: true, msg: `主魂培育成功！主魂当前为【${soulLevelNameOf(s.level)}】，魂魄${s.souls}。用 #喂养主魂<数量> 喂万魂幡的魂魄培养它。` }
  },
  trainDeputySoul (uid, gid = 'global', index = 1) {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    const name = artifactName(artifact)
    if (!artifact) return { ok: false, msg: '你还没有万魂幡。' }
    const i = Number(index) || 0
    const rank = artifact.rank || 1
    const maxDeputy = DEPUTY_MAX_BY_RANK[Math.max(0, Math.min(9, rank))]
    if (i < 1 || i > maxDeputy) return { ok: false, msg: `当前${this.rankName(rank)}${name}只能培育${maxDeputy}个副魂（5阶1个、7阶2个、9阶3个），序号应在1~${maxDeputy}。` }
    this.tickSoulDecay(bag)
    if (artifact.deputySouls[i - 1]) return { ok: false, msg: `第${i}个副魂已经培育了，不能重复培育。` }
    if ((Number(artifact.souls) || 0) < SOUL_TRAIN_COST) return { ok: false, msg: `培育副魂需要消耗${artifactDisplayName(name)}当前魂魄${SOUL_TRAIN_COST}，当前只有${artifact.souls || 0}。` }
    if (!consumeItem(uid, SOUL_TRAIN_ITEM, 1, null, gid)) return { ok: false, msg: `培育副魂还需要1个${itemIcon(SOUL_TRAIN_ITEM)}${SOUL_TRAIN_ITEM}（万魂窟探索中随机遇到幽魂，回复1吸收获得）。` }
    artifact.souls = (Number(artifact.souls) || 0) - SOUL_TRAIN_COST
    artifact.deputySouls[i - 1] = newSoul()
    saveBag(uid, bag, gid)
    const s = artifact.deputySouls[i - 1]
    return { ok: true, msg: `第${i}个副魂培育成功！副魂当前为【${soulLevelNameOf(s.level)}】，魂魄${s.souls}。用 #喂养副魂${i} <数量> 喂养。` }
  },
  /* 喂魂自动晋升: 魂魄>=下一级门槛即升级(免突破), 但不能超过玩家境界 */
  async feedMainSoul (uid, gid = 'global', amount = 0) {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    const name = artifactName(artifact)
    if (!artifact) return { ok: false, msg: '你还没有万魂幡。' }
    if (!artifact.mainSoul) return { ok: false, msg: '还没有主魂，请先用 #培育主魂。' }
    const n = Math.max(1, Math.floor(Number(amount) || 0))
    this.tickSoulDecay(bag)
    const available = Number(artifact.souls) || 0
    if (available <= 0) return { ok: false, msg: `${artifactDisplayName(name)}当前魂魄为0，先去万魂窟收魂再来喂养。` }
    const fed = Math.min(n, available)
    const s = artifact.mainSoul
    s.souls = (Number(s.souls) || 0) + fed
    artifact.souls = available - fed
    const cap = await this.playerLevelOf(uid, gid)
    let raised = 0
    while (s.level < cap && s.souls >= fakeSubThreshold(s.level + 1)) { s.level += 1; raised += 1 }
    saveBag(uid, bag, gid)
    return { ok: true, msg: `喂养主魂${fed}魂魄！主魂现在是【${soulLevelNameOf(s.level)}】，魂魄${s.souls}${raised ? `，连续提升${raised}个小境界！` : ''}。` }
  },
  async feedDeputySoul (uid, gid = 'global', index = 1, amount = 0) {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    const name = artifactName(artifact)
    if (!artifact) return { ok: false, msg: '你还没有万魂幡。' }
    const i = Number(index) || 0
    if (i < 1 || !artifact.deputySouls[i - 1]) return { ok: false, msg: `第${i}个副魂还没培育，请先用 #培育副魂${i}。` }
    const n = Math.max(1, Math.floor(Number(amount) || 0))
    this.tickSoulDecay(bag)
    const available = Number(artifact.souls) || 0
    if (available <= 0) return { ok: false, msg: `${artifactDisplayName(name)}当前魂魄为0，先去万魂窟收魂再来喂养。` }
    const fed = Math.min(n, available)
    const s = artifact.deputySouls[i - 1]
    s.souls = (Number(s.souls) || 0) + fed
    artifact.souls = available - fed
    const cap = await this.playerLevelOf(uid, gid)
    let raised = 0
    while (s.level < cap && s.souls >= fakeSubThreshold(s.level + 1)) { s.level += 1; raised += 1 }
    saveBag(uid, bag, gid)
    return { ok: true, msg: `喂养第${i}个副魂${fed}魂魄！副魂现在是【${soulLevelNameOf(s.level)}】，魂魄${s.souls}${raised ? `，连续提升${raised}个小境界！` : ''}。` }
  },
  /* 主魂/副魂战力加成(万魂幡装备时生效): 主魂裸境界战力 + 各副魂裸境界战力×1/3, 且不超过玩家境界 */
  getSoulPower (bag, playerLevel = 0) {
    const artifact = artifactOf(bag)
    if (!artifact || !artifact.equipped || !artifact.mainSoul) return 0
    const cap = Math.max(0, Number(playerLevel) || 0)
    const minLevel = l => Math.max(0, Math.min(cap, Number(l) || 0))
    let p = realmPower(minLevel(artifact.mainSoul.level))
    for (const d of (artifact.deputySouls || [])) {
      if (!d) continue
      p += Math.round(realmPower(minLevel(d.level)) / 3)
    }
    return p
  },
  statusText (uid, gid = 'global') {
    const bag = getBag(uid, gid)
    const artifact = artifactOf(bag)
    const name = artifactName(artifact)
    if (!artifact) return '你还没有万魂幡。'
    const changed = this.tickSoulDecay(bag)
    const lines = [
      `━━━ ${name}状态 ━━━`,
      `阶位：${this.rankName(artifact.rank)}（容量 ${this.capacity(artifact.rank)}）`,
      `魂魄：${artifact.souls || 0} / ${this.capacity(artifact.rank)}｜累计收魂 ${artifact.totalSouls || 0}`,
      `装备：${artifact.equipped ? '已装备' : '未装备'}｜祭出：${artifact.deployed ? '已祭出' : '未祭出'}`
    ]
    const ms = artifact.mainSoul
    if (ms) {
      const next = Math.max(0, Math.ceil((Number(ms.lastDecayAt) + SOUL_DECAY_MS - now()) / 60000))
      lines.push(`【主魂】${soulLevelNameOf(ms.level)}（${ms.level}级）｜魂魄 ${ms.souls}｜${next > 0 ? `${next}分钟后掉1点` : '即将掉魂'}`)
    } else {
      lines.push(`【主魂】未培育（需${this.rankName(3)}以上万魂幡）`)
    }
    const maxDeputy = DEPUTY_MAX_BY_RANK[Math.max(0, Math.min(9, artifact.rank || 1))]
    for (let i = 0; i < maxDeputy; i++) {
      const d = artifact.deputySouls[i]
      if (d) {
        const next = Math.max(0, Math.ceil((Number(d.lastDecayAt) + SOUL_DECAY_MS - now()) / 60000))
        lines.push(`【副魂${i + 1}】${soulLevelNameOf(d.level)}（${d.level}级）｜魂魄 ${d.souls}｜${next > 0 ? `${next}分钟后掉1点` : '即将掉魂'}`)
      } else {
        lines.push(`【副魂${i + 1}】未培育（#培育副魂${i + 1}）`)
      }
    }
    lines.push(
      '━━━ 技能消耗 ━━━',
      '祭出：20魂｜百鬼助战：每30分钟10魂',
      '培育主魂/副魂：当前魂魄50 + ⚪无主幽魂×1',
      '主魂/副魂：每30分钟掉1点魂魄；魂魄不足维持境界时会自动降境（装备万魂幡时，其境界战力加入你的战力）'
    )
    if (changed) saveBag(uid, bag, gid)
    return lines.join('\n')
  },
  guideText () {
    const gates = []
    const costs = []
    for (let rank = 1; rank <= 8; rank++) {
      const next = rank + 1
      const req = UPGRADE[rank]
      gates.push(`· ${this.rankName(rank)}→${this.rankName(next)}：累计收魂${req.souls}、业力${req.karma}`)
      costs.push(`· ${this.rankName(rank)}→${this.rankName(next)}：${this.upgradeCostText(rank)}`)
    }
    return [
      '━━━ 万魂幡 / 万魂窟玩法 ━━━',
      '',
      '【万魂幡】',
      `· #打造万魂幡：消耗${itemIcon('万魂幡残卷')}万魂幡残卷×5、${itemIcon('阴魂砂')}阴魂砂×20、${itemIcon('游魂骨')}游魂骨×20，以及1把🌈成长性特殊彩武；有多把彩武时回复数字选择消耗哪一把。已有万魂幡不能重复打造。`,
      `· 打造后随机固定攻击+100~500；万魂幡为独立法宝栏，不占武器位置。容量：${RANK_NAMES.slice(1).map((name, i) => `${name}${RANK_CAPACITY[i + 1]}`).join('、')}。`,
      `· #万魂幡命名 <名字>：最多8字；改名后可用 #装备<名字>、#祭出<名字>、#收回<名字>、#卸下<名字>，原来的万魂幡指令仍兼容。`,
      '· #装备万魂幡 / #卸下万魂幡：切换法宝装备状态；装备万魂幡会暂时卸下定仙游和已祭出的傀儡。',
      `· #祭出万魂幡：消耗当前魂魄20（百鬼助战10 + 聚魂护体10），百鬼助战持续30分钟；之后每30分钟自动续扣10魂，魂魄不足会自动收回。`,
      `· 祭出时聚魂护体进入待命：下一次受伤时降低1级伤势；若万魂幡仍在祭出且魂魄不少于10，会再消耗10魂并继续待命。${itemIcon('万魂幡')}阶位越高，百鬼助战的攻/防/生命加成越高（一阶约2%，九阶100%）。`,
      '· #收回万魂幡：结束百鬼助战；聚魂护体尚未触发时会保留待命。',
      '',
      '【收魂与进阶】',
      `· 必须先装备${itemIcon('万魂幡')}万魂幡才会收魂；主动击杀伪玩家、秘境击杀、伏击处置、屠城以及宗门战胜方等场景按各自规则收取，容量满出的魂魄会消散。`,
      '· 宗门战中，胜方实际参战且已装备万魂幡的玩家共同分配该场收魂；累计收魂用于进阶，当前魂魄则用于祭出和养魂。',
      '· #进阶万魂幡（#升级万魂幡兼容）：成功率固定100%，必须同时满足累计收魂、业力和逐阶材料；最高九阶。',
      '进阶门槛：',
      ...gates,
      '进阶材料：',
      ...costs,
      '',
      '【主魂 / 副魂】',
      '· #培育主魂：三阶以上万魂幡，消耗万魂幡当前魂魄50和⚪无主幽魂×1；主魂只能培育一次。',
      '· #培育副魂<序号>：五阶可培育1个、七阶2个、九阶3个；每个副魂同样消耗当前魂魄50和⚪无主幽魂×1。',
      '· #喂养主魂<数量> / #喂养副魂<序号> <数量>：从万魂幡当前魂魄池转入对应魂魄；达到下一境界门槛自动晋升，但不会超过玩家自身境界。',
      '· 主魂和副魂每30分钟自然掉1点魂魄；魂魄不足维持境界时自动降境，最低可降至残魂。',
      '· 装备万魂幡时，主魂境界战力全部计入，各副魂境界战力按三分之一计入统一战力；未装备不计入。',
      `· ${itemIcon('无主幽魂')}无主幽魂：在万魂窟探索中随机遇到幽魂，回复1吸收获得；回复2放走则没有奖励。`,
      '',
      '【万魂窟探索】',
      '· 万魂窟位于西域，需先使用 #去西域；#探索万魂窟 可在西域进入。',
      `· 进入会优先消耗1颗${itemIcon('魂石')}魂石，获得10分钟保护；保护到期会每10分钟自动续扣1颗魂石。`,
      `· 没有${itemIcon('魂石')}魂石也能强行进入，但1分钟后开始每分钟临时掉1个境界；每个临时掉落的境界约1小时恢复1个，补充魂石后停止继续掉境界。`,
      '· 进入后每30秒~2分钟随机遇到阴魂或无主幽魂。阴魂出现时回复1战斗、回复2撤退，或使用 #万魂窟战 / #万魂窟撤退；遭遇未处理前不能退出。',
      '· 阴魂越晚出现越强；战斗胜利获得随机掉落，撤退成功安全离开但没有战利品。拥有定仙游时，阴魂撤退成功率为100%。',
      '· #万魂窟状态：查看探索时长、当前阴魂、魂石保护、临时掉境界和恢复时间。#退出万魂窟：处理完遭遇后离开。',
      '',
      '【失魂、还魂与救援】',
      `· 阴魂战斗失败或撤退失败会失魂；失魂困在窟内时只能使用 #服用${itemIcon('还魂丹')}还魂丹，不能直接退出或做其他行动。`,
      `· 其他玩家可用 #救援 @玩家 将失魂者送出；被救出后仍会失魂10小时，期间不能行动，也可服用${itemIcon('还魂丹')}提前解除。`,
      `· #合成还魂丹：${itemIcon('玄阴玉')}玄阴玉×2、${itemIcon('镇魂晶')}镇魂晶×1、${itemIcon('血煞髓')}血煞髓×1、${itemIcon('云裳仙蕊')}云裳仙蕊×1。`,
      '',
      '【掉落与魔窟商人】',
      '· 万魂窟战斗掉落次数会随探索时间增加；白/绿/蓝材料从开始可得，30分钟后紫/金/红材料进入更高概率曲线。',
      `· ${itemIcon('万魂幡残卷')}万魂幡残卷从探索早期就有极低概率，30分钟后概率逐步提高；${itemIcon('万魂帝晶')}万魂帝晶前期低概率出现，50分钟后概率明显提高。${itemIcon('造梦神玉')}造梦神玉和${itemIcon('云裳仙蕊')}云裳仙蕊不由万魂窟掉落。`,
      '· #魔窟商人 / #魔窟老者：只在西域出现，每人独立一份12格货单；前10格可用灵石、材料、丹药或金色及以下功法书兑换魂石，后2格兑换还魂丹，整单每7小时刷新。打开后5分钟内可连续回复1~12兑换。',
      '',
      '【关联玩法与常用指令】',
      '· #万魂幡：查看法宝与万魂窟概况；#万魂幡状态：查看魂魄、主魂、副魂和技能消耗；#万魂幡路线：查看进阶路线和材料。',
      '· 养魂阵是独立的魂魄供养玩法：#养魂阵玩法、#布置养魂阵、#运行养魂阵、#养魂阵状态。',
      '· 万魂幡、傀儡、定仙游属于独立法宝，可通过 #虚境赠送 @玩家 法宝名 转赠；装备或祭出中的法宝需先卸下/收回。'
    ].join('\n')
  },
  async captureFromLevels (uids, gid, level) {
    const list = [...new Set((uids || []).map(String))]
    const eligible = list.filter(uid => this.getArtifact(uid, gid)?.equipped)
    if (!eligible.length) return []
    const value = this.soulValue(level)
    const base = Math.floor(value / eligible.length)
    const extra = value % eligible.length
    const order = eligible.slice().sort(() => Math.random() - 0.5)
    const result = []
    for (let i = 0; i < order.length; i++) {
      const uid = order[i]
      const share = base + (i < extra ? 1 : 0)
      const got = this.captureSoul(uid, gid, level, share / value)
      result.push({ uid, gained: got.gained, overflow: got.overflow })
    }
    return result
  },
  createShop () {
    const materials = ['阴魂砂', '鬼火草', '摄魂铁', '玄阴玉', '镇魂晶', '血煞髓', '云裳仙蕊']
    const demands = []
    for (let i = 0; i < 10; i++) {
      const type = pick(['money', 'material', 'item', 'gongfa'])
      if (type === 'money') demands.push({ name: '灵石', kind: 'money', count: randomInt(800000, 1800000), reward: '魂石', used: false })
      else if (type === 'material') demands.push({ name: pick(materials), kind: 'material', count: randomInt(1, 8), reward: '魂石', used: false })
      else if (type === 'item') demands.push({ name: pick(['修为丹', '破障丹', '聚宝丹', '玉甲丹']), kind: 'item', count: randomInt(1, 5), reward: '魂石', used: false })
      else demands.push({ name: pick(Object.keys(GONGFA_TPL).filter(n => GONGFA_TPL[n].quality <= 5)), kind: 'gongfa', count: 1, reward: '魂石', used: false })
    }
    demands.push(this.makeElderSlot(), this.makeElderSlot())
    return { refreshAt: now() + SHOP_REFRESH_MS, demands }
  },
  /** 后台推进已生成的货单；未打开过商人面板的玩家不会提前生成货单。 */
  tickShops (gid, at = now()) {
    const data = readGroup(gid)
    let changed = false
    for (const [uid, shop] of Object.entries(data.shops || {})) {
      if (!shop || Number(shop.refreshAt) > at) continue
      data.shops[uid] = this.createShop()
      changed = true
    }
    if (changed) saveGroup(gid, data)
    return changed
  },
  shop (uid, gid = 'global') {
    const data = readGroup(gid)
    const key = String(uid)
    const old = data.shops[key]
    if (old && Number(old.refreshAt) > now()) {
      /* 旧版十格货单升级为同一份十二格货单，不重置原有七小时计时。 */
      if (!Array.isArray(old.demands)) old.demands = []
      while (old.demands.length < 10) old.demands.push({ name: '魂石', kind: 'money', count: 0, reward: '魂石', used: true })
      while (old.demands.length < 12) old.demands.push(this.makeElderSlot())
      for (const slot of old.demands) if (!slot.reward) slot.reward = '魂石'
      saveGroup(gid, data)
      return old
    }
    data.shops[key] = this.createShop()
    saveGroup(gid, data)
    return data.shops[key]
  },
  makeElderSlot () {
    const name = pick(['玄阴玉', '镇魂晶', '血煞髓', '云裳仙蕊', '灵石'])
    return { name, kind: name === '灵石' ? 'money' : 'material', count: name === '灵石' ? randomInt(800000, 1800000) : randomInt(1, 5), reward: '还魂丹', used: false }
  },
  async buyShop (uid, gid, index) {
    const shop = this.shop(uid, gid)
    const slot = shop.demands[Number(index) - 1]
    if (!slot) return { ok: false, msg: '兑换编号应为1到12。' }
    if (slot.used) return { ok: false, msg: '这个兑换位已经使用，等七小时后刷新。' }
    const home = await xujing_data.getQQYUserHome(uid, null, `${gid}.json`, false)
    if (slot.kind === 'money') {
      if ((Number(home[uid]?.money) || 0) < slot.count) return { ok: false, msg: `需要${slot.count}灵石，你当前不够。` }
      home[uid].money -= slot.count
      await xujing_data.getQQYUserHome(uid, home, `${gid}.json`, true)
    } else if (!consumeItem(uid, slot.name, slot.count, null, gid)) {
      return { ok: false, msg: `你缺少${itemIcon(slot.name)}${slot.name}×${slot.count}。` }
    }
    slot.used = true
    const data = readGroup(gid)
    data.shops[String(uid)] = shop
    saveGroup(gid, data)
    addItem(uid, slot.reward || '魂石', 1, null, gid)
    return { ok: true, msg: `兑换成功！消耗${itemIcon(slot.name)}${slot.name}×${slot.count}，获得${itemIcon(slot.reward || '魂石')}${slot.reward || '魂石'}×1。` }
  },
  shopText (shop) {
    const remain = Math.max(0, Number(shop.refreshAt) - now())
    const hours = Math.floor(remain / 3600000)
    const minutes = Math.floor((remain % 3600000) / 60000)
    const seconds = Math.floor((remain % 60000) / 1000)
    const timer = remain > 0 ? `${hours}小时${minutes}分${seconds}秒` : '已刷新，可重新查看'
    const rows = (shop.demands || []).map((s, i) => {
      const status = s.used ? '✅ 已兑换' : `兑换${itemIcon(s.reward || '魂石')}${s.reward || '魂石'}×1，需 ${itemIcon(s.name)}${s.name}×${s.count}`
      return `${String(i + 1).padStart(2, ' ')}. ${status}`
    })
    return [
      '━━━ 魔窟商人/老者兑换货单 ━━━',
      `下次刷新倒计时：${timer}`,
      '',
      '━━━ 兑换列表 ━━━',
      ...rows,
      '',
      '回复数字1到12兑换；七小时后整单刷新。'
    ].join('\n')
  }
}

export const getWanhunBattleBuff = (uid, gid = 'global') => Wanhun.getBattleBuff(uid, gid)
export const getWanhunPanel = (uid, gid = 'global') => Wanhun.panel(uid, gid)
export const getWanhunSoulPower = (bag, playerLevel = 0) => Wanhun.getSoulPower(bag, playerLevel)

if (!global.__xujingWanhunTick__) {
  global.__xujingWanhunTick__ = true
  setInterval(() => {
    if (global.__xujingWanhunTickRunning__) return
    global.__xujingWanhunTickRunning__ = true
    ;(async () => {
      try {
        ensureDir()
        for (const file of fs.readdirSync(SAVE_DIR).filter(n => /^wanhun_.+\.json$/.test(n))) {
          const gid = file.replace(/^wanhun_|\.json$/g, '')
          const data = readGroup(gid)
          Wanhun.tickShops(gid)
          for (const uid of Object.keys(data.users || {})) {
            /* 逐个串行推进: 每个玩家独立读档-改档-写档,
               并发推进会让后写的档覆盖先写玩家的 pending(多人同时遇敌时后一人写完, 前一人的阴魂就没了) */
            try {
              await Wanhun.tickCave(uid, gid, text => notifyPlayer(gid, uid, text))
            } catch (err) { }
          }
        }
      } catch (err) { } finally {
        global.__xujingWanhunTickRunning__ = false
      }
    })()
  }, 15000).unref()
}

export default Wanhun
