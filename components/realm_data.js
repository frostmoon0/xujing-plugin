/* ============================================================
 * 遗蜕秘境 - 数据与核心逻辑
 * 伪玩家: 使用本群 fake_data 中的真实人物; 入境期间暂停外部行为, 出境恢复
 * 刷新: 白名单群独立, 地形/难度/大区/时长随机; 探索事件按固定规则结算
 * 破界: 对应大区可攻击屏障, 不要求已入场; 屏障破碎后仅已入场者进入
 * 探索: 玩家队/伪玩家队均由系统驱动, 玩家队长只负责数字决策
 * PvP : 胜后可放过, 或按奖励池/背包/灵石分别搜刮30%/全部; 也可全搜或杀人夺宝
 * 结算: 按实际成员贡献分公共池; 并发动作使用秘境级锁
 * ============================================================ */
import fs from 'fs'
import { Plugin_Name, Save_Path } from './plugin.js'
import xujing_data from './xujing_data.js'
import command from './command.js'
import { REGION_KEYS, REGIONS, getWorld, getLoc, setLoc, regionNameOf } from './world_data.js'
import { getBuffs, calcCombatPower, guardWinRate } from './fight.js'
import { getBag, addItem, consumeItem, isBound, itemIcon, ITEM_TPL, MATERIAL_TPL, EQUIP_TPL, GONGFA_TPL, ARRAY_MATS } from './equip_data.js'
import { getFake, saveFake, personPower, sectName, sectAlive, isInSectMine, killPerson } from './fake_data.js'
// karma helper is exposed on xujing_data default export
import Wanhun from './wanhun_data.js'
import { PUPPET_CHAPTERS } from './puppet_data.js'

const REALM_DIR = `${Save_Path}/realm`
const realmFile = gid => `${REALM_DIR}/realm_${gid}.json`
const LOCK_TTL = 20
const BARRIER_ATTACK_CD = 10 * 1000
const AMBUSH_MINUTES = 2.5 // 出口围剿: 探索最后2.5分钟触发(时间整体压缩)
const AMBUSH_ROUND_MS = 30000 // 围剿每30秒一轮混战
const AMBUSH_TAKE = 0.3 // 混战胜利/溜走被抓各搜刮30%池子
const localLocks = new Map()

/** 将秘境文本中带结构标记的玩家 UID 替换为展示名，避免推送暴露 QQ 号。 */
export function replaceRealmPlayerIds (text, names = new Map()) {
  const displayName = uid => String(names.get(String(uid)) || '无名修士')
  return String(text || '')
    .replace(/【(\d+)】/g, (_, uid) => `【${displayName(uid)}】`)
    .replace(/首功：(\d+)/g, (_, uid) => `首功：${displayName(uid)}`)
    .replace(/(\d+)：/g, (_, uid) => `${displayName(uid)}：`)
}

/** 所有已有秘境存档的群(公开+专属) */
export function activeRealmGroups () {
  try {
    if (!fs.existsSync(REALM_DIR)) return []
    return fs.readdirSync(REALM_DIR).filter(n => /^realm_\d+\.json$/.test(n)).map(n => n.replace(/^realm_|\.json$/g, ''))
  } catch (err) { return [] }
}

/* ---------- 专属秘境(遗蜕古钥开启)独立存档 ---------- */
const privateRealmFile = (gid, id = 'legacy') => `${REALM_DIR}/realm_p_${gid}${id === 'legacy' ? '' : `_${id}`}.json`
function privateRealmIds (gid) {
  const g = String(gid || '')
  try {
    if (!fs.existsSync(REALM_DIR)) return []
    const prefix = `realm_p_${g}`
    return fs.readdirSync(REALM_DIR)
      .filter(n => n === `${prefix}.json` || new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d+\\.json$`).test(n))
      .map(n => n === `${prefix}.json` ? 'legacy' : n.slice(prefix.length + 1, -5))
      .sort((a, b) => (a === 'legacy' ? -1 : b === 'legacy' ? 1 : Number(a) - Number(b)))
  } catch (err) { return [] }
}
function readPrivateRealm (gid, id) {
  const g = String(gid || '')
  try {
    const file = privateRealmFile(g, id)
    if (!fs.existsSync(file)) return null
    const st = Object.assign(emptyRealm(), JSON.parse(fs.readFileSync(file, 'utf8')))
    st.gid = g
    st.private = true
    st.privateId = id
    if (!st.teams || typeof st.teams !== 'object') st.teams = {}
    return st
  } catch (err) { return null }
}
export function getPrivateRealms (gid) {
  return privateRealmIds(gid).map(id => readPrivateRealm(gid, id)).filter(Boolean)
}
export function getPrivateRealm (gid, id = '') {
  if (id) return readPrivateRealm(gid, id)
  return getPrivateRealms(gid)[0] || null
}
export function savePrivateRealm (st, gid) {
  try {
    if (!fs.existsSync(REALM_DIR)) fs.mkdirSync(REALM_DIR, { recursive: true })
    const g = gid || st.gid || ''
    fs.writeFileSync(privateRealmFile(g, st.privateId || 'legacy'), JSON.stringify(st, null, '\t'))
  } catch (err) { console.log('[遗蜕秘境]专属秘境保存失败:', err && err.message) }
}
export function activePrivateRealms () {
  try {
    if (!fs.existsSync(REALM_DIR)) return []
    return fs.readdirSync(REALM_DIR)
      .filter(n => /^realm_p_\d+(?:_\d+)?\.json$/.test(n))
      .map(n => {
        const m = n.match(/^realm_p_(\d+)(?:_(\d+))?\.json$/)
        return { gid: m[1], id: m[2] || 'legacy' }
      })
  } catch (err) { return [] }
}
function nextPrivateRealmId (gid) {
  const used = new Set(privateRealmIds(gid).filter(id => id !== 'legacy'))
  let id = Date.now()
  while (used.has(String(id)) || fs.existsSync(privateRealmFile(gid, String(id)))) id++
  return String(id)
}

/* ---------- 配置 ---------- */
const DEF_CFG = {
  enable: 'F', group: [], night_stop: 'T',
  spawn_per_cycle: 3, cycle_hours: 24,
  first_spawn_hours: [3, 18], next_spawn_hours: [2, 12],
  explore_min: [15, 60], action_cd_min: 1, max_steps: 20,
  loot_cap: 5, event_max: 4, extra_rewards: []
}
let cfgCache = { at: 0, value: null }
async function readCfg () {
  if (Date.now() - cfgCache.at <= 60000 && cfgCache.value) return cfgCache.value
  const cfg = { ...DEF_CFG }
  for (const key of Object.keys(DEF_CFG)) {
    try {
      const v = await command.getConfig('realm_cfg', key)
      if (v !== undefined && v !== null && v !== '') cfg[key] = v
    } catch (err) { }
  }
  cfg.group = Array.isArray(cfg.group) ? cfg.group.map(String) : []
  cfg.extra_rewards = Array.isArray(cfg.extra_rewards) ? cfg.extra_rewards : []
  cfgCache = { at: Date.now(), value: cfg }
  return cfg
}
export async function getRealmCfg () { return readCfg() }
export async function realmEnabled () { const c = await readCfg(); return c.enable === 'T' || c.enable === true }
export async function realmGroups () { return (await readCfg()).group }
export function realmCfgRefresh () { cfgCache = { at: 0, value: null } }

/* ---------- 秘境池 ---------- */
/** 普通奖励: 不含品质7; 彩材/舆图/阵图由本场特殊彩奖励额外替换, 每场最多10件 */
export const SHARED_REWARDS = [
  '修为丹', '破障丹', '聚宝丹', '灵犀丹', '行运丹', '同心丹', '玉甲丹', '凝露丹', '慧心丹', '摄魂丹',
  '星霜草', '青鸾草', '望舒花', '月华芝', '凤栖花',
  '月魄石', '星璇石', '流光玉', '织云石', '凤羽玉',
  // 残丹(白色材料): 仅秘境产出, 5个可 #合成妖丹 随机凝成随机品质妖丹
  '残丹'
]
/** 灵石是货币型奖励, 不进背包 */
export const SPECIAL_REWARDS = ['灵石']
/** 特殊彩奖励: 彩色/舆图/阵图归成一个奖励, 每场按难度概率命中, 命中后最多10件 */
export const COLOR_SPECIAL = ['云裳仙蕊', '造梦神玉', '简月舆图', '血炼阵图', ...ARRAY_MATS, ...PUPPET_CHAPTERS]
export const SPECIAL_MAX = 10
export const COLOR_MATS = ['云裳仙蕊', '造梦神玉']

export const TERRAINS = {
  dongtian: { name: '洞天福地', emoji: '🌿', barrier: 'ling', desc: '大能坐化的灵秀之地，灵药遍地', rewards: ['望舒花', '月华芝', '凤栖花', '流光玉', '织云石'], events: ['灵脉暴走', '守园大妖'] },
  guzhanchang: { name: '古战场·兵魂杀场', emoji: '⚔️', barrier: 'shafa', desc: '上古大战遗迹，战魂游荡', rewards: ['摄魂丹', '血煞髓', '镇魂晶'], events: ['怨魂潮', '残念Boss'] },
  yifu: { name: '大能遗府', emoji: '🏯', barrier: 'ling', desc: '仙人宅邸，丹房兵库藏真', rewards: ['破障丹', '聚宝丹', '玉甲丹', '凤羽玉', '流光玉'], events: ['守护灵苏醒', '丹炉炸炉'] },
  zongmen: { name: '上古宗门遗址', emoji: '⛩️', barrier: 'ling', desc: '仙门废墟，藏经阁遗世', rewards: ['灵犀丹', '慧心丹', '凤栖花', '织云石'], events: ['护山残阵触发', '傀儡暴动'] },
  gumu: { name: '古墓陵寝', emoji: '🪦', barrier: 'shafa', desc: '青铜古棺，陪葬无数', rewards: ['行运丹', '同心丹', '玄阴玉', '阴魂砂', '游魂骨'], events: ['尸傀潮', '主棺异动'] },
  shilian: { name: '试炼塔', emoji: '🗼', barrier: 'ling', desc: '登天塔，逐层考验', rewards: ['聚宝丹', '灵犀丹', '慧心丹', '星霜草', '青鸾草'], events: ['塔灵异变', '试炼镜像'] },
  leichi: { name: '渡劫雷池', emoji: '⚡', barrier: 'xueji', desc: '天雷滚滚，雷淬灵物', rewards: ['惊鸿丹', '摄魂丹', '镇魂晶', '血煞髓', '凤羽玉'], events: ['天雷异变', '飞升残影'] },
  xinmo: { name: '心魔幻境', emoji: '🌫️', barrier: 'tianji', desc: '虚实难辨，道心考验', rewards: ['慧心丹', '同心丹', '凝露丹', '月华芝', '望舒花'], events: ['道心反噬', '心魔具现'] },
  jinji: { name: '荒古禁地', emoji: '☠️', barrier: 'xueji', desc: '极凶之地，边缘捡漏深入搏命', rewards: ['惊鸿丹', '玉甲丹', '凤栖花', '凤羽玉'], events: ['禁地凶物', '界域震荡'] },
  taichu: { name: '太初古矿', emoji: '⛏️', barrier: 'ling', desc: '神源矿脉，可能挖出禁忌', rewards: ['月魄石', '星璇石', '流光玉', '织云石', '凤羽玉'], events: ['矿脉塌陷', '挖出禁忌'] },
  shifang: { name: '石坊赌源', emoji: '🎲', barrier: 'xueji', desc: '源石堆叠，看石下注', rewards: ['聚宝丹', '行运丹', '月魄石', '星璇石', '凤羽玉'], events: ['源石连锁', '切出凶物'] },
  longgong: { name: '海底龙宫', emoji: '🐉', barrier: 'xueji', desc: '潮汐涨落，龙宫宝库', rewards: ['灵犀丹', '惊鸿丹', '玄阴玉', '镇魂晶', '凤羽玉'], events: ['海啸', '龙宫守卫暴动'] },
  tiangong: { name: '天宫残殿', emoji: '✨', barrier: 'tianji', desc: '仙庭碎片，仙家禁制', rewards: ['慧心丹', '玉甲丹', '凤羽玉', '流光玉'], events: ['禁制连环', '仙兵共鸣'] },
  moyuan: { name: '魔渊裂缝', emoji: '🌑', barrier: 'xueji', desc: '魔气滔天，魔宝诱惑', rewards: ['摄魂丹', '血煞髓', '阴魂石', '凤羽玉'], events: ['魔潮', '魔化加剧'] },
  zhenmo: { name: '镇魔古狱', emoji: '⛓️', barrier: 'shafa', desc: '封印大凶之地', rewards: ['镇魂晶', '血煞髓', '摄魂铁', '阴魂石'], events: ['封印松动', '镇压反噬'] },
  shijian: { name: '时间夹缝', emoji: '⏳', barrier: 'tianji', desc: '时光流速异常，岁月冲刷', rewards: ['凝露丹', '慧心丹', '星霜草', '望舒花', '云裳仙蕊'], events: ['时间风暴', '岁月冲刷'] },
  xumi: { name: '须弥小世界', emoji: '🌀', barrier: 'tianji', desc: '不断崩塌的狭小空间', rewards: ['行运丹', '同心丹', '星璇石', '流光玉', '造梦神玉'], events: ['空间崩塌加速'] }
}
export const TERRAIN_KEYS = Object.keys(TERRAINS)
export const DIFFS = {
  huang: { name: '黄阶', realm: '筑基~金丹', rewardQuality: [1, 4], quantity: [1, 2], barrier: 1, events: [0, 2], special: 0.07 },
  xuan: { name: '玄阶', realm: '元婴~化神', rewardQuality: [2, 5], quantity: [1, 3], barrier: 1.5, events: [0, 3], special: 0.07 },
  di: { name: '地阶', realm: '炼虚~大乘', rewardQuality: [3, 6], quantity: [2, 4], barrier: 2.2, events: [0, 3], special: 0.1 },
  tian: { name: '天阶', realm: '渡劫~仙帝', rewardQuality: [4, 7], quantity: [3, 6], barrier: 3.2, events: [0, 4], special: 0.15 }
}
export const DIFF_KEYS = Object.keys(DIFFS)
export const BARRIERS = {
  ling: { name: '灵纹屏障', desc: '仙纹流转，需合力铭刻' },
  xueji: { name: '血祭屏障', desc: '血气缭绕，撼动方可破' },
  tianji: { name: '天机屏障', desc: '天机晦涩，力量与时机并重' },
  shafa: { name: '杀伐屏障', desc: '杀伐之气凝成坚壁' }
}
export const GENERIC_EVENTS = [
  { name: '隐藏秘藏现世', kind: 'treasure', text: '🌈 秘境深处气息骤变，隐藏秘藏现世！' },
  { name: '守护者苏醒', kind: 'guardian', text: '👹 沉睡的秘境守护者苏醒，拦住了所有去路！' },
  { name: '灵潮紊乱', kind: 'chaos', text: '🌪️ 秘境灵潮紊乱，所有队伍的行动节奏被打乱！' }
]

/* ---------- 状态与并发 ---------- */
function emptyRealm () {
  return {
    gid: null, realmId: '', phase: 'idle', region: null, terrain: null, diff: 'huang',
    exploreMin: 0, startAt: 0, endAt: 0, nextSpawn: 0, spawnCount: 0, cycleStart: 0,
    barrier: null, teams: {}, chaos: 0, eventsFired: 0, lastEventChaos: 0, firedEvents: [],
    title: '', desc: '', rewardPool: [], extraRewards: [],
    specialPending: false, specialGranted: 0,
    private: false, privateId: '', ownerUid: null, ownerPartyId: null,
    ambushAt: 0, ambushRound: 0
  }
}
export function getRealm (gid) {
  const g = String(gid || '')
  try {
    const file = realmFile(g)
    if (!fs.existsSync(file)) {
      const st = emptyRealm()
      st.gid = g
      st.cycleStart = Date.now()
      st.nextSpawn = Date.now() + randRange([6, 36]) * 3600000
      saveRealm(st, g)
      return st
    }
    const st = Object.assign(emptyRealm(), JSON.parse(fs.readFileSync(file, 'utf8')))
    st.gid = g
    if (!st.teams || typeof st.teams !== 'object') st.teams = {}
    return st
  } catch (err) {
    const st = emptyRealm(); st.gid = g; return st
  }
}
export function saveRealm (st, gid) {
  try {
    if (!fs.existsSync(REALM_DIR)) fs.mkdirSync(REALM_DIR, { recursive: true })
    const file = st && st.private ? privateRealmFile(gid || st.gid || '', st.privateId || 'legacy') : realmFile(gid || st.gid || '')
    fs.writeFileSync(file, JSON.stringify(st, null, '\t'))
  } catch (err) { console.log('[遗蜕秘境]状态保存失败:', err && err.message) }
}
function saveRealmState (st, gid) {
  if (st?.private) savePrivateRealm(st, gid)
  else saveRealm(st, gid)
}

async function sleep (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
/** 进程内串行 + Redis NX 锁, 防止同一群的两个动作互相覆盖 */
export async function withRealmLock (gid, fn) {
  const g = String(gid || '')
  const previous = localLocks.get(g) || Promise.resolve()
  let releaseLocal
  const current = new Promise(resolve => { releaseLocal = resolve })
  localLocks.set(g, current)
  await previous
  const key = `xujing:realm-lock:${g}`
  const token = `${process.pid || 'bot'}:${Date.now()}:${Math.random()}`
  let remote = false
  try {
    for (let i = 0; i < 40; i++) {
      try {
        const ok = await redis.set(key, token, { NX: true, EX: LOCK_TTL })
        if (ok) { remote = true; break }
      } catch (err) { remote = true; break } // 无 redis 时仍由进程内锁保护
      await sleep(50)
    }
    if (!remote) return null
    return await fn()
  } finally {
    if (remote) {
      try { if ((await redis.get(key)) === token) await redis.del(key) } catch (err) { }
    }
    if (localLocks.get(g) === current) localLocks.delete(g)
    releaseLocal()
  }
}
export function teamOf (st, uid) {
  const id = String(uid)
  for (const t of Object.values(st.teams || {})) if ((t.members || []).map(String).includes(id)) return t
  return null
}
/** 玩家是否在某座现世秘境(公开/专属, 屏障/探索阶段)的队伍里; 只读, 不创建空档 */
export function playerInRealm (gid, uid) {
  const id = String(uid || ''); const g = String(gid || '')
  if (!g || !id) return false
  try {
    const file = realmFile(g)
    if (fs.existsSync(file)) {
      let st = null
      try { st = Object.assign(emptyRealm(), JSON.parse(fs.readFileSync(file, 'utf8'))) } catch (err) { st = null }
      if (st && ['barrier', 'explore'].includes(st.phase)) {
        for (const t of Object.values(st.teams || {})) if ((t.members || []).map(String).includes(id)) return true
      }
    }
    for (const p of getPrivateRealms(g)) {
      if (['barrier', 'explore'].includes(p.phase)) {
        for (const t of Object.values(p.teams || {})) if ((t.members || []).map(String).includes(id)) return true
      }
    }
  } catch (err) { }
  return false
}
function randRange ([a, b]) { return a + Math.floor(Math.random() * (b - a + 1)) }
function pick (arr) { return arr[Math.floor(Math.random() * arr.length)] }
/** 一次行动后的下一次推进间隔：约2~3分钟(时间压缩), 避免所有队伍同步推进 */
export function actionDelay () {
  return Math.round((2 + Math.random() * 1) * 60000)
}
/** 探索开始后的首次行动错峰(2~6分钟随机): 破界阶段积累的队伍行动时间早已过期,
 *  统一重排一次, 避免探索第一波所有队伍同步推进, 一次性刷出大量播报 */
export function firstWaveAt (now = Date.now()) {
  return now + actionDelay() + randRange([0, 3]) * 60000
}
function isNight (now = new Date()) { const h = now.getHours(); return h >= 1 && h < 6 }
export { isNight, reconcileFakeBusy }

/* ---------- 刷新与奖励 ---------- */
export function rollRealm (random = Math.random, opts = {}) {
  const terrain = opts.terrain || TERRAIN_KEYS[Math.floor(random() * TERRAIN_KEYS.length)]
  const diff = opts.diff || DIFF_KEYS[Math.floor(random() * DIFF_KEYS.length)]
  const exploreMin = opts.exploreMin || 15 + Math.floor(random() * 46)
  const normalRegions = REGION_KEYS.filter(k => !(REGIONS[k] && REGIONS[k].special))
  const region = opts.region || normalRegions[Math.floor(random() * normalRegions.length)]
  return { terrain, diff, exploreMin, region }
}
function validRewardName (name) {
  if (name === '灵石' || name === '简月舆图' || name === '血炼阵图') return true
  if (GONGFA_TPL[name] && Number(GONGFA_TPL[name].quality) === 7) {
    /* 普通彩功法不进池(太阴月华诀仅藏宝阁洗劫); 傀儡篇解锁傀儡打造, 允许普通探索掉落 */
    if (PUPPET_CHAPTERS.includes(name)) return true
    return false
  }
  return !!(ITEM_TPL[name] || MATERIAL_TPL[name] || EQUIP_TPL[name] || GONGFA_TPL[name])
}
function itemQuality (name) {
  if (name === '灵石') return 1
  if (name === '简月舆图' || name === '血炼阵图') return 7
  return Number(ITEM_TPL[name]?.quality || MATERIAL_TPL[name]?.quality || EQUIP_TPL[name]?.quality || GONGFA_TPL[name]?.quality || 1)
}
function realmMaterialCount (diffKey) {
  return randRange(DIFFS[diffKey]?.quantity || [1, 1])
}
export function realmRewardRange (diffKey) {
  const quantity = DIFFS[diffKey]?.quantity || [1, 1]
  return { min: quantity[0], max: quantity[1] }
}
export function realmRewardInfo (st, diffKey = st?.diff, cfg = {}) {
  const range = realmRewardRange(diffKey)
  const names = realmRewardPool(st, cfg)
  return { name: names.length ? names.join('、') : '修为丹', names, count: `${range.min}~${range.max}`, min: range.min, max: range.max, quality: 1, currency: false, rare: false }
}
const REALM_EXCLUDED_REWARDS = new Set([
  '遗蜕古钥', '万魂幡残卷', '无主幽魂', '阴魂砂', '游魂骨', '鬼火草', '幽冥木',
  '摄魂铁', '阴魂石', '玄阴玉', '镇魂晶', '血煞髓', '万魂帝晶', '万阵核心',
  '还魂丹', '登仙令', '神游蛊', '灵宝盒'
])
export const REALM_REWARD_MATERIALS = [
  '星霜草', '青鸾草', '望舒花', '月华芝', '凤栖花', '云裳仙蕊',
  '月魄石', '星璇石', '流光玉', '织云石', '凤羽玉', '造梦神玉',
  '天衍阵纹', '乾坤阵晶', '太虚阵砂', '九幽阵髓'
]
function validSpecialRewardName (name) {
  if (name === '简月舆图' || name === '血炼阵图') return true
  return !!(ITEM_TPL[name] || MATERIAL_TPL[name] || GONGFA_TPL[name])
}
export function realmSpecialPool () {
  return [...new Set(COLOR_SPECIAL)].filter(validSpecialRewardName)
}
export function pickRealmSpecialReward (random = Math.random) {
  const pool = realmSpecialPool()
  return pool[Math.floor(random() * pool.length)] || '云裳仙蕊'
}
export function rollRealmSpecialReward (diffKey = 'tian', random = Math.random) {
  const chance = Number(DIFFS[diffKey]?.special) || 0
  return random() < chance ? pickRealmSpecialReward(random) : null
}

export function realmRewardPool (st, cfg = {}) {
  const configured = [
    ...SHARED_REWARDS,
    ...(TERRAINS[st?.terrain]?.rewards || []),
    ...SPECIAL_REWARDS,
    ...Object.keys(ITEM_TPL),
    ...REALM_REWARD_MATERIALS,
    ...Object.keys(EQUIP_TPL),
    ...Object.keys(GONGFA_TPL),
    ...(cfg.extra_rewards || [])
  ]
  /* 品质7装备/功法不进池；材料、丹药、装备、地图等其他品质均可按权重掉落。 */
  return [...new Set(configured)]
    .filter(validRewardName)
    .filter(name => !REALM_EXCLUDED_REWARDS.has(name))
    .filter(name => !(EQUIP_TPL[name] && Number(EQUIP_TPL[name].quality) === 7))
    .filter(name => !(GONGFA_TPL[name] && Number(GONGFA_TPL[name].quality) === 7 && !PUPPET_CHAPTERS.includes(name))) // 傀儡篇可普通探索掉落; 太阴月华诀等彩功法仅藏宝阁洗劫
}
export const REALM_QUALITY_WEIGHTS = {
  huang: { 1: 145, 2: 145, 3: 145, 4: 145, 5: 145, 6: 145, 7: 30 },
  xuan: { 1: 142, 2: 142, 3: 142, 4: 142, 5: 142, 6: 142, 7: 48 },
  di: { 1: 140, 2: 140, 3: 140, 4: 140, 5: 140, 6: 140, 7: 60 },
  tian: { 1: 950, 2: 950, 3: 950, 4: 950, 5: 950, 6: 950, 7: 600 }
}
function pickRealmReward (candidates, diffKey, random = Math.random) {
  const weights = REALM_QUALITY_WEIGHTS[diffKey] || REALM_QUALITY_WEIGHTS.tian
  const byQuality = new Map()
  for (const name of candidates) {
    const quality = itemQuality(name)
    if (!byQuality.has(quality)) byQuality.set(quality, [])
    byQuality.get(quality).push(name)
  }
  const qualityList = [...byQuality.entries()]
    .map(([quality, names]) => ({ quality, names, weight: weights[quality] || 1 }))
  const total = qualityList.reduce((sum, item) => sum + item.weight, 0)
  let cursor = random() * total
  for (const item of qualityList) {
    cursor -= item.weight
    if (cursor < 0) return item.names[Math.floor(random() * item.names.length)]
  }
  const last = qualityList[qualityList.length - 1]
  return last?.names[Math.floor(random() * last.names.length)] || '修为丹'
}
/**
 * 残丹(白色材料, 仅遗蜕秘境产出, 5个可#合成妖丹)的独立掉落率: 每件正常掉落有该概率直接为残丹。
 * 若不设固定概率, 残丹只能与几十种白色物品(丹药/白装/白功法等)均分白色档, 实测约0.6%/件,
 * 一整场秘境往往0颗, 玩家感知不到掉落。
 */
export const REALM_CANDAN_CHANCE = 0.18
/** 灵石是货币，按阶别给整笔金额；其余掉落物单件固定 1 个。 */
function realmMoneyAmount (diffKey, random = Math.random) {
  const ranges = { huang: [200, 1000], xuan: [500, 3000], di: [1000, 8000], tian: [3000, 20000] }
  const [min, max] = ranges[diffKey] || [200, 1000]
  return min + Math.floor(random() * (max - min + 1))
}
export function rollReward (st, diffKey, random = Math.random, cfg = {}) {
  const useSpecial = cfg.special === true && st?.specialPending && Number(st.specialGranted) < SPECIAL_MAX
  /* 特殊彩奖励名额优先; 未命中彩奖励的每个正常掉落件, 先按固定概率判残丹, 命中即本件为残丹 */
  const candanChance = typeof cfg.candan === 'number' ? cfg.candan : REALM_CANDAN_CHANCE
  let name = null
  if (useSpecial) name = pickRealmSpecialReward(random)
  else if (candanChance > 0 && random() < candanChance) name = '残丹'
  else name = pickRealmReward(realmRewardPool(st, cfg), diffKey, random)
  if (useSpecial) st.specialGranted = (Number(st.specialGranted) || 0) + 1
  const currency = name === '灵石'
  const count = currency ? realmMoneyAmount(diffKey, random) : 1
  return { name, count, quality: itemQuality(name), currency, rare: itemQuality(name) >= 6 }
}
/** 每个事件按阶别掉落件数抽多次，每件独立按品质权重抽取。 */
export function rollRewardList (st, diffKey, random = Math.random, cfg = {}) {
  const count = realmMaterialCount(diffKey)
  const list = []
  for (let i = 0; i < count; i++) list.push(rollReward(st, diffKey, random, cfg))
  return list
}
/** 奖励列表文案: 同名同属性奖励合并，避免秘境推送过长 */
export function fmtRewards (items) {
  const arr = Array.isArray(items) ? items : [items]
  const merged = []
  for (const item of arr) {
    if (!item) continue
    const key = `${item.name}:${JSON.stringify(item.attr || null)}`
    const old = merged.find(x => `${x.name}:${JSON.stringify(x.attr || null)}` === key)
    if (old) old.count = (Number(old.count) || 0) + (Number(item.count) || 1)
    else merged.push({ ...item, count: Number(item.count) || 1 })
  }
  return merged.map(i => `${itemIcon(i.name)}${i.name}×${i.count}`).join('、')
}
async function addMoney (gid, uid, amount) {
  amount = Math.max(0, Math.floor(Number(amount) || 0))
  if (!amount) return
  const home = await xujing_data.getQQYUserHome(uid, null, `${gid}.json`, false)
  if (!home[uid]) home[uid] = { money: 0 }
  home[uid].money = (Number(home[uid].money) || 0) + amount
  await xujing_data.getQQYUserHome(uid, home, `${gid}.json`, true)
}
function addPoolItem (team, item) {
  team.pool = team.pool || []
  const key = `${item.name}:${JSON.stringify(item.attr || null)}`
  const old = team.pool.find(x => `${x.name}:${JSON.stringify(x.attr || null)}` === key)
  if (old) old.count += item.count || 1
  else team.pool.push({ name: item.name, count: item.count || 1, attr: item.attr || null, quality: item.quality || itemQuality(item.name), currency: !!item.currency, rare: !!item.rare })
}
function credit (team, amount, actor = null) {
  const members = team.members || []
  if (!members.length) return
  if (actor && members.map(String).includes(String(actor))) team.contrib[String(actor)] = (team.contrib[String(actor)] || 0) + amount
  else for (const uid of members) team.contrib[String(uid)] = (team.contrib[String(uid)] || 0) + amount
}
/** 入公共池: 本场命中特殊彩奖励时, 前10次真实探索奖励各替换为1件特殊彩奖励; 搜刮来的赃物不消耗名额 */
function addToPool (st, team, item, actor = null) {
  addPoolItem(team, item)
  credit(team, Math.max(1, item.quality || itemQuality(item.name)), actor)
  return item
}

/** 屏障血量: 只决定门的耐久; 难度影响耐久, 不改变伪玩家战力 */
async function barrierHpFor (gid, diffMult) {
  let count = 0; let levelSum = 0
  try {
    const battle = await xujing_data.getQQYUserBattle('0', null, false, `${gid}.json`)
    for (const uid of Object.keys(battle)) { const lv = Number(battle[uid]?.level) || 0; if (lv > 0) { count++; levelSum += lv } }
  } catch (err) { }
  const avg = count ? Math.round(levelSum / count) : 0
  return Math.max(1, Math.round(100000 * (1 + count * 0.03) * (1 + avg * 0.02) * diffMult))
}
export async function spawnRealm (st, gid, cfg = DEF_CFG) {
  const r = rollRealm()
  const terrain = TERRAINS[r.terrain]; const diff = DIFFS[r.diff]; const barrier = BARRIERS[terrain.barrier]
  st.gid = String(gid); st.realmId = `${gid}:${Date.now()}:${Math.floor(Math.random() * 100000)}`
  st.region = r.region; st.terrain = r.terrain; st.diff = r.diff; st.exploreMin = r.exploreMin
  st.title = `${terrain.emoji}${terrain.name}`; st.desc = `${terrain.desc}（${barrier.name}：${barrier.desc}）`
  st.rewardPool = realmRewardPool(st, cfg); st.extraRewards = cfg.extra_rewards || []
  st.phase = 'barrier'
  st.barrier = { maxHp: await barrierHpFor(gid, diff.barrier), hp: 0, damage: {}, lastHit: {}, auto: {} }; st.barrier.hp = st.barrier.maxHp
  st.teams = {}; st.chaos = 0; st.eventsFired = 0; st.firedEvents = []; st.startAt = 0; st.endAt = 0
  /* 特殊彩奖励: 每场按难度概率决定是否命中, 命中后最多替换10次真实探索奖励 */
  st.specialPending = Math.random() * 100 < (diff.special || 0)
  st.specialGranted = 0
  /* 真实伪玩家在破界时仍属于世界, 屏障破碎后才标记进入/暂停外部行为 */
  const fakes = genFakeTeams(gid, st)
  for (const t of Object.values(fakes)) st.teams[t.id] = t
  saveRealmState(st, gid)
  return { title: st.title, region: st.region, diffName: diff.name, realm: diff.realm, barrierName: barrier.name, barrierHp: st.barrier.maxHp, exploreMin: st.exploreMin, desc: st.desc, fakeTeams: Object.keys(fakes).length }
}

/* ---------- 专属秘境(遗蜕古钥): 队长使用开启, 仅本队可入, 无破界直接探索 ---------- */
export function partyIdOf (gid, uid) {
  const party = partyInfoOf(gid, uid)
  return party ? `party:${party.id}` : `solo:${uid}`
}
export function partyInfoOf (gid, uid) {
  try {
    const f = getFake(gid)
    for (const t of Object.values(f.rogueTeams || {})) {
      if ((t.members || []).map(String).includes(String(uid))) return { id: t.id, leader: String(t.leader), members: (t.members || []).map(String), name: t.name }
    }
  } catch (err) { }
  return null
}
/** 玩家队在秘境中的队长快照与外部小队记录同步(#转让队长后刷新, 踢人/解散后保留在队快照仅刷队长)
 *  秘境内队伍的 leader/partyLeader 是入场时快照, 转让队长不落盘到此, 不同步会导致新老队长都无法正常决策 */
export function syncPlayerTeam (st, gid, team) {
  if (!team || team.kind !== 'player') return false
  const pid = String(team.partyId || '')
  if (pid.startsWith('solo:')) return false
  let changed = false
  try {
    const f = getFake(gid)
    const rt = (f.rogueTeams || {})[pid.replace(/^party:/, '')]
    if (!rt) return false
    const leader = String(rt.leader || '')
    if (leader && String(team.leader) !== leader) { team.leader = leader; changed = true }
    if (String(team.partyLeader || '') !== leader) { team.partyLeader = leader; changed = true }
    const members = (rt.members || []).map(String)
    if (members.length && (team.partyMembers || []).map(String).join('|') !== members.join('|')) { team.partyMembers = members; changed = true }
  } catch (err) { }
  return changed
}
export async function openPrivateRealm (gid, cfg, ownerUid, partyId, partyMembers) {
  const st = emptyRealm()
  const r = rollRealm()
  st.gid = String(gid); st.privateId = nextPrivateRealmId(gid); st.realmId = `p:${gid}:${st.privateId}`
  const terrain = TERRAINS[r.terrain]; const diff = DIFFS[r.diff]
  st.private = true; st.ownerUid = String(ownerUid); st.ownerPartyId = partyId
  st.region = r.region; st.terrain = r.terrain; st.diff = r.diff; st.exploreMin = r.exploreMin
  st.title = `${terrain.emoji}${terrain.name}`; st.desc = `${terrain.desc}（专属秘境·仅本队可入）`
  st.rewardPool = realmRewardPool(st, cfg); st.extraRewards = cfg.extra_rewards || []
  st.phase = 'explore'; st.startAt = Date.now(); st.endAt = Date.now() + st.exploreMin * 60000
  st.chaos = 0; st.eventsFired = 0; st.lastEventChaos = 0; st.firedEvents = []
  st.specialPending = Math.random() * 100 < (diff.special || 0); st.specialGranted = 0
  /* 拥有者先进入, 其余队员仍需各自发送 #进入秘境 */
  const partyList = (partyMembers || [ownerUid]).map(String)
  const members = [String(ownerUid)]
  const team = {
    id: `player:${partyId}`, kind: 'player', partyId, partyLeader: String(ownerUid), leader: String(ownerUid),
    partyMembers: partyList, members, name: '专属小队', sectName: '',
    pos: 0, step: 0, pool: [], contrib: {}, victory: {}, nextActionAt: Date.now() + actionDelay(),
    node: null, pendingDisposal: null, hidden: false, exposedUntil: 0, revenge: [], lives: 3, dao: 0, dead: false, startedAt: Date.now(),
    ambush: null, ambushNode: null, injured: 0
  }
  for (const uid of members) { team.contrib[uid] = 0; team.victory[uid] = 0; try { const w = getWorld(gid); if (getLoc(w, uid) !== st.region) setLoc(w, uid, st.region) } catch (err) { } }
  st.teams[team.id] = team
  savePrivateRealm(st, gid)
  return { ok: true, st, team, info: { privateId: st.privateId, title: st.title, region: st.region, diffName: diff.name, realm: diff.realm, exploreMin: st.exploreMin, fakeTeams: 0 } }
}

/* ---------- 真实伪玩家随机出行/组队 ---------- */
function isBigEvil (p) { return p.path === '魔道' && p.trait === '嗜杀' }
function wantChance (p) {
  let c = 0.03
  if (p.path === '魔道') c += 0.03
  c += ({ 嗜杀: 0.05, 好斗: 0.03, 贪玩: 0.02, 善良: -0.01, 平和: -0.01 }[p.trait] || 0)
  c += p.act === '贪玩' ? 0.02 : (p.act === '懒散' ? -0.01 : 0)
  return Math.max(0.003, Math.min(0.15, c))
}
function related (a, b) {
  const ar = a.relations || {}; const br = b.relations || {}
  const an = new Set([...(ar.friends || []), ...(ar.confidants || []), ...(ar.siblings || []), ...(ar.kin || []), ...(ar.spouse ? [ar.spouse] : []), ...(ar.master ? [ar.master] : []), ...(ar.disciples || [])])
  const bn = new Set([...(br.friends || []), ...(br.confidants || []), ...(br.siblings || []), ...(br.kin || []), ...(br.spouse ? [br.spouse] : []), ...(br.master ? [br.master] : []), ...(br.disciples || [])])
  return an.has(b.name) || bn.has(a.name)
}
function compatible (a, b) {
  if (isBigEvil(a) || isBigEvil(b)) return isBigEvil(a) && isBigEvil(b)
  return true
}
function leaderOf (persons) {
  const role = persons.find(p => p.pos === 'zongzhu' || p.pos === 'fuzong' || p.pos === 'zhishi')
  if (role) return role.name
  return persons.slice().sort((a, b) => personPower(b) - personPower(a))[0]?.name || persons[0]?.name
}
function mkFakeTeam (st, id, persons, name) {
  const regions = [...new Set(persons.map(p => p.loc).filter(Boolean))]
  const travelMin = regions.includes(st.region) ? randRange([0, 2]) : randRange([2, 10])
  return {
    id, kind: 'fake', leader: leaderOf(persons), members: persons.map(p => p.name), name, sectName: name,
    pos: 0, step: 0, pool: [], contrib: {}, victory: {},
    arrivalAt: Date.now() + travelMin * 60000, arrived: travelMin <= 0, entered: false,
    nextActionAt: Date.now() + (travelMin + 1) * 60000, lastBarrierHit: Date.now(), node: null, pendingDisposal: null,
    hidden: false, exposedUntil: 0, revenge: [], lives: 3, dao: 0, dead: false, startedAt: Date.now(),
    ambush: null, injured: 0
  }
}
/** 每人独立决定出发; 只有已经决定出发的人才可能被随机匹配, 不强制拉朋友/同门 */
export function genFakeTeams (gid, st) {
  const f = getFake(gid)
  const alive = Object.values(f.roster || {}).filter(p => p.alive && !isInSectMine(f, p.name) && !p.realmBusy)
  const willing = shuffle(alive.filter(p => Math.random() < wantChance(p)))
  const available = new Map(willing.map(p => [p.name, p]))
  const teams = {}; let seq = 0
  while (available.size) {
    const seedName = pick([...available.keys()]); const seed = available.get(seedName); available.delete(seedName)
    const group = [seed]
    const candidates = shuffle([...available.values()]).filter(p => compatible(seed, p))
      .sort((a, b) => (related(seed, b) ? -1 : 0) - (related(seed, a) ? -1 : 0))
    for (const p of candidates) {
      /* 每个已自愿出发者仍独立决定是否同行; 没有固定队人数或队数 */
      const affinity = related(seed, p) ? 0.75 : (seed.status === 'sect' && p.status === 'sect' && seed.sect === p.sect ? 0.55 : 0.2)
      if (Math.random() < affinity) { group.push(p); available.delete(p.name) }
    }
    seq++
    const sameSect = [...new Set(group.map(p => p.sect).filter(Boolean))]
    const name = sameSect.length === 1 ? sectName(f, sameSect[0]) : (group.length > 1 ? '散修结伴队' : `独行散修·${seed.name}`)
    teams[`fake${seq}`] = mkFakeTeam(st, `fake${seq}`, group, name)
  }
  return teams
}
function shuffle (arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }; return a }

/* ---------- fake 真实成员与暂停 ---------- */
function currentFakePersons (gid, team) {
  const f = getFake(gid)
  return (team.members || []).map(n => f.roster && f.roster[n]).filter(p => p && p.alive && !isInSectMine(f, p.name))
}
function markFakesBusy (gid, st) {
  try {
    const f = getFake(gid); let changed = false
    for (const t of Object.values(st.teams || {})) {
      if (t.kind !== 'fake' || t.entered === false) continue
      for (const name of t.members || []) {
        const p = f.roster && f.roster[name]
        if (p && p.alive && (!p.realmBusy || p.realmBusy.realmId !== st.realmId)) { p.realmBusy = { realmId: st.realmId, gid: String(gid) }; changed = true }
      }
    }
    if (changed) saveFake(f, gid)
  } catch (err) { }
}
function clearFakesBusy (gid, st) {
  try {
    const f = getFake(gid); let changed = false
    for (const t of Object.values(st.teams || {})) for (const name of t.members || []) {
      const p = f.roster && f.roster[name]
      if (p && p.realmBusy && p.realmBusy.realmId === st.realmId) { delete p.realmBusy; changed = true }
    }
    if (changed) saveFake(f, gid)
  } catch (err) { }
}
function reconcileFakeBusy (gid, st) {
  try {
    const f = getFake(gid); let changed = false
    const expected = new Set(st.phase === 'explore' ? Object.values(st.teams || {}).filter(t => t.kind === 'fake' && t.entered !== false && !t.dead).flatMap(t => t.members || []) : [])
    for (const p of Object.values(f.roster || {})) {
      if (!p.realmBusy || String(p.realmBusy.gid) !== String(gid)) continue
      if (!expected.has(p.name)) { delete p.realmBusy; changed = true }
    }
    if (st.phase === 'explore') {
      for (const name of expected) {
        const p = f.roster && f.roster[name]
        if (p && p.alive && (!p.realmBusy || p.realmBusy.realmId !== st.realmId)) { p.realmBusy = { realmId: st.realmId, gid: String(gid) }; changed = true }
      }
    }
    if (changed) saveFake(f, gid)
  } catch (err) { }
}
function syncFakeTeam (gid, st, team) {
  const persons = currentFakePersons(gid, team)
  team.members = persons.map(p => p.name)
  if (team.leader && !team.members.includes(team.leader)) team.leader = leaderOf(persons)
  return persons
}

/* ---------- 破界 ---------- */
/** 屏障在大区可攻击, 不要求已进入秘境; 调用方负责同大区校验和CD */
export async function attackBarrier (st, uid, gid, auto = false) {
  if (st.phase !== 'barrier' || !st.barrier) return { ok: false, msg: '' }
  if (!st.barrier.auto || typeof st.barrier.auto !== 'object') st.barrier.auto = {}
  const uidKey = String(uid)
  if (auto) {
    const rec = st.barrier.auto[uidKey]
    if (!rec) return { ok: false, msg: '' }
  } else {
    st.barrier.auto[uidKey] = { gid: String(gid), start: Date.now(), lastHit: Date.now() - BARRIER_ATTACK_CD }
  }
  const b = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
  const level = Number(b[uid]?.level) || 0; const bag = getBag(uid, gid); const buff = await getBuffs(uid, gid)
  const { power } = calcCombatPower(level, bag, buff, gid, uid)
  const oneHit = Math.max(1, Math.round(power * 0.15))
  let hits = 1
  if (auto) {
    const elapsed = Date.now() - (Number(st.barrier.auto[uidKey].lastHit) || Date.now())
    hits = Math.min(3, Math.max(0, Math.floor(elapsed / BARRIER_ATTACK_CD)))
    if (!hits) return { ok: false, waiting: true, hp: st.barrier.hp, maxHp: st.barrier.maxHp }
  }
  const dmg = oneHit * hits
  st.barrier.damage[uidKey] = (st.barrier.damage[uidKey] || 0) + dmg
  st.barrier.hp = Math.max(0, st.barrier.hp - dmg)
  st.barrier.auto[uidKey].lastHit = Date.now()
  return { ok: true, dmg, hits, hp: st.barrier.hp, maxHp: st.barrier.maxHp, broke: st.barrier.hp <= 0 }
}
export function fakeAttackBarrier (st, team, gid, at = Date.now()) {
  if (st.phase !== 'barrier' || !st.barrier) return false
  if (team.arrivalAt && at < team.arrivalAt) return false
  const elapsed = at - (Number(team.lastBarrierHit) || at)
  if (elapsed < BARRIER_ATTACK_CD) return false
  team.arrived = true
  const persons = syncFakeTeam(gid, st, team)
  if (!persons.length) { team.dead = true; return false }
  const hits = Math.min(3, Math.max(1, Math.floor(elapsed / BARRIER_ATTACK_CD)))
  const dmg = Math.max(1, Math.round(persons.reduce((sum, p) => sum + personPower(p), 0) * 0.15))
  st.barrier.damage[team.id] = (st.barrier.damage[team.id] || 0) + dmg * hits
  st.barrier.hp = Math.max(0, st.barrier.hp - dmg * hits)
  team.lastBarrierHit = at
  return st.barrier.hp <= 0
}
export function stopBarrierAuto (st, uid) {
  if (st?.barrier?.auto) delete st.barrier.auto[String(uid)]
  saveRealmState(st, st.gid)
}
export async function breakBarrier (st, gid) {
  const sorted = Object.keys(st.barrier?.damage || {}).sort((a, b) => st.barrier.damage[b] - st.barrier.damage[a])
  const hero = sorted.find(x => /^\d+$/.test(x)) || null
  st.phase = 'explore'; st.startAt = Date.now(); st.endAt = Date.now() + st.exploreMin * 60000
  /* 破界后错峰: 已到伪玩家标记入场; 所有破界阶段积累的队伍重排下一次行动,
   * 避免探索第一波全队同步推进一次性刷出大量播报 */
  const now = Date.now()
  for (const t of Object.values(st.teams || {})) {
    if (t.kind === 'fake' && (!t.arrivalAt || now >= t.arrivalAt)) { t.arrived = true; t.entered = true }
    t.nextActionAt = firstWaveAt(now)
  }
  markFakesBusy(gid, st); saveRealmState(st, gid)
  let reward = []
  if (hero) {
    reward = rollRewardList(st, st.diff, Math.random)
    for (const item of reward) await grantItem(gid, hero, item)
  }
  return { hero, dmgTop: sorted.length ? st.barrier.damage[sorted[0]] : 0, reward }
}

/* ---------- 入场/退场 ---------- */
function playerParty (gid, uid) {
  try {
    const f = getFake(gid)
    for (const t of Object.values(f.rogueTeams || {})) if ((t.members || []).map(String).includes(String(uid))) return t
  } catch (err) { }
  return null
}
export async function enterRealm (st, gid, uid) {
  if (!['barrier', 'explore'].includes(st.phase) || teamOf(st, uid)) return { ok: false, msg: '' }
  let party = playerParty(gid, uid); let partyId = party ? `party:${party.id}` : `solo:${uid}`
  /* 外部小队记录丢失时, 已入场的本队成员按本场原队进场(专属秘境 partyMembers 兜底, 避免落成散修单人) */
  if (!party) {
    const known = Object.values(st.teams || {}).find(t => t.kind === 'player' && (t.partyMembers || []).map(String).includes(String(uid)))
    if (known) { party = { id: known.partyId.replace(/^party:/, ''), leader: known.leader, members: known.partyMembers, name: known.name }; partyId = known.partyId }
  }
  /* 专属秘境: 仅拥有者队伍成员可进入, 不会有其他玩家队伍 */
  if (st.private && partyId !== st.ownerPartyId) {
    try { const f = getFake(gid); console.log(`[遗蜕秘境]专属入场被拒 uid=${uid} party=${partyId} owner=${st.ownerPartyId} rogueTeams=${Object.keys(f.rogueTeams || {}).length}`) } catch (err) { }
    return { ok: false, msg: '' }
  }
  let team = Object.values(st.teams).find(t => t.kind === 'player' && t.partyId === partyId)
  if (!team) {
    team = { id: `player:${partyId}`, kind: 'player', partyId, partyLeader: party ? String(party.leader) : String(uid), leader: party ? String(party.leader) : String(uid), partyMembers: party ? party.members.map(String) : [String(uid)], members: [], name: party?.name || '散修小队', sectName: '', pos: 0, step: 0, pool: [], contrib: {}, victory: {}, nextActionAt: Date.now() + actionDelay(), node: null, pendingDisposal: null, hidden: false, exposedUntil: 0, revenge: [], lives: 3, dao: 0, dead: false, startedAt: Date.now(), ambush: null, ambushNode: null, injured: 0 }
    st.teams[team.id] = team
  }
  team.members.push(String(uid)); if (!team.contrib[String(uid)]) team.contrib[String(uid)] = 0; if (!team.victory[String(uid)]) team.victory[String(uid)] = 0
  /* 进入前往秘境大区, 这是跨区赶路的统一入口; 不会把未入场队员带进来 */
  try { const w = getWorld(gid); if (getLoc(w, uid) !== st.region) setLoc(w, uid, st.region) } catch (err) { }
  if (st.private) savePrivateRealm(st, gid)
  else saveRealmState(st, gid)
  return { ok: true, team, msg: `${st.phase === 'barrier' ? '你已在秘境屏障前，可协助破界。' : '你已进入秘境。'}\n队伍【${team.name}】当前入场 ${team.members.length}/${team.partyMembers.length} 人。` }
}
function removeTeamMember (st, team, uid) { team.members = team.members.filter(x => String(x) !== String(uid)); delete team.contrib[String(uid)]; delete team.victory[String(uid)]; if (String(team.leader) === String(uid)) team.leader = team.members[0] || null }
export async function leaveTeam (st, gid, uid) {
  const team = teamOf(st, uid)
  if (!team || !['barrier', 'explore'].includes(st.phase)) return { ok: false, msg: '' }
  const share = st.phase === 'explore' ? await settleMember(team, uid, gid) : []
  const targetId = team.node?.data?.target
  if (targetId && st.teams[targetId]?.engagedBy === team.id) delete st.teams[targetId].engagedBy
  if (st.phase === 'barrier' && st.barrier?.auto) delete st.barrier.auto[String(uid)]
  removeTeamMember(st, team, uid)
  if (!team.members.length) delete st.teams[team.id]
  saveRealmState(st, gid)
  return { ok: true, msgs: share, barrier: st.phase === 'barrier' }
}

/* ---------- 探索节点: 固定顺序，结果由状态与选择决定 ---------- */
export const NODE_TYPES = ['treasure', 'dushi', 'fake', 'player', 'chuangguan', 'jueze', 'duojie', 'jiemi', 'beast', 'maze', 'spring', 'scroll', 'elder', 'contest']
const BEAST_POWER = { huang: 800, xuan: 2400, di: 7200, tian: 21600 }
const BEAST_NAMES = {
  dongtian: '守园妖兽', guzhanchang: '战场凶魂', yifu: '府邸灵兽', zongmen: '护山傀儡',
  gumu: '陵寝尸傀', shilian: '试炼妖兽', leichi: '雷池凶兽', xinmo: '心魔兽影',
  jinji: '禁地凶物', taichu: '矿脉凶灵', shifang: '源石凶物', longgong: '龙宫蛟卫',
  tiangong: '仙兵残灵', moyuan: '魔渊魔物', zhenmo: '镇魔古兽', shijian: '岁兽', xumi: '界隙吞兽'
}
function combatPowerFor (st, team, multiplier = 1) {
  const base = BEAST_POWER[st.diff] || BEAST_POWER.huang
  return Math.max(1, Math.round(base * multiplier * (1 + Math.max(0, Number(team.step) || 0) * 0.05)))
}
function deterministicFightResult (win) {
  const rounds = [1, 2, 3].map(round => ({
    round,
    winner: win ? 'me' : 'opp',
    myWin: win ? round : 0,
    oppWin: win ? 0 : round,
    dmg: 0
  }))
  return { myWin: win ? 3 : 0, oppWin: win ? 0 : 3, rounds, winner: win ? 'me' : 'opp' }
}
function activeTeams (st, self) { return Object.values(st.teams).filter(t => t.id !== self.id && t.entered !== false && !t.dead && !t.engagedBy && !t.node && (t.members || []).length) }
/** 遭遇目标: 优先选玩家队伍(PvP 遭遇), 没有玩家队时才选伪玩家队; 保持确定性(按 id 排序后取首个) */
function targetTeam (st, self) {
  const actives = activeTeams(st, self).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return actives.find(t => t.kind === 'player') || actives[0] || null
}
function actionActor (team) { const m = team.members || []; if (!m.length) return null; team.actorCursor = ((team.actorCursor || 0) + 1) % m.length; return m[team.actorCursor] }
function buildNode (st, team, type, teamPower = Math.max(1, Number(team.combatPower) || 1)) {
  const terrain = TERRAINS[st.terrain]
  const node = { type, terrain: st.terrain, title: '', text: '', choices: [], actor: actionActor(team), data: {} }
  if (type === 'treasure') {
    const reward = rollRewardList(st, st.diff, Math.random); node.title = '💎 发现宝物'; node.text = `你在${terrain.name}深处发现${fmtRewards(reward)}！`; node.data = { kind: 'pick', reward }; node.choices = [{ n: 1, label: '拾取（进入公共池并暴露位置）' }, { n: 2, label: '放弃（不惊动他人）' }]
  } else if (type === 'dushi') {
    node.title = '🎲 石坊赌源'; node.text = '一块品相不明的源石横在面前，切法决定固定收益。'; node.data = { kind: 'gamble' }; node.choices = [{ n: 1, label: '切中品源石（获得一份稳定奖励）' }, { n: 2, label: '切天价源石（获得一份高阶奖励并增加乱源）' }, { n: 3, label: '不切' }]
  } else if (type === 'fake') {
    const candidates = Object.values(st.teams).filter(t => t.kind === 'fake' && t.entered !== false && t.members.length && !t.dead && !t.engagedBy && !t.node && t.id !== team.id).sort((a, b) => String(a.id).localeCompare(String(b.id))); const target = candidates[0]
    if (!target) return buildNode(st, team, 'treasure')
    target.engagedBy = team.id
    node.title = '🧙 遭遇伪玩家'; node.text = `前方出现【${target.name}】的队伍！`; node.data = { kind: 'fight', target: target.id, victim: target.members.slice().sort()[0] }; node.choices = [{ n: 1, label: '出手（胜后选择杀/搜刮）' }, { n: 2, label: '买路（300灵石）' }, { n: 3, label: '绕道' }]
  } else if (type === 'player') {
    const target = targetTeam(st, team); if (!target) return buildNode(st, team, 'treasure')
    target.engagedBy = team.id
    node.title = '⚔️ 遭遇队伍'; node.text = `你撞上了【${target.name}】！`; node.data = { kind: 'pvp', target: target.id, victim: target.members.slice().sort()[0] }; node.choices = [{ n: 1, label: '强夺（PvP，胜后选择处置）' }, { n: 2, label: '避让' }, { n: 3, label: '观望' }]
  } else if (type === 'chuangguan') {
    node.title = '🚩 闯关考验'; node.text = `${terrain.name}的试炼关挡在前方，考验战力将按当前阶别固定。`; node.data = { kind: 'challenge', requiredPower: combatPowerFor(st, team, 0.9) }; node.choices = [{ n: 1, label: '迎战考验（按战力判定，成功得宝）' }, { n: 2, label: '取巧过关（安全通过，不得宝）' }, { n: 3, label: '退回' }]
  } else if (type === 'jueze') {
    node.title = '🌫️ 心魔抉择'; node.text = `眼前出现一段机缘，也藏着诱惑：一念之间道心沉浮。`; node.choices = [{ n: 1, label: '以德报怨（道心+）' }, { n: 2, label: '顺势而为' }, { n: 3, label: '趁势夺取（道心-，风险高）' }]
  } else if (type === 'duojie') {
    node.title = '⚡ 天雷夺劫'; node.text = `一道天雷凝成灵宝，悬在雷池中央！`; node.choices = [{ n: 1, label: '站入中心夺雷（高收益高暴露）' }, { n: 2, label: '外围捡漏' }, { n: 3, label: '躲开' }]
  } else if (type === 'jiemi') {
    node.title = '🔒 机关禁制'; node.text = `一道古老禁制挡在藏宝之前。`; node.choices = [{ n: 1, label: '强行破禁（失败增加乱源）' }, { n: 2, label: '寻找线索（稳妥）' }, { n: 3, label: '绕行' }]
  } else if (type === 'beast') {
    node.title = '🐾 妖兽拦路'; node.data = { kind: 'beast', enemyName: BEAST_NAMES[st.terrain] || '秘境妖兽', enemyPower: combatPowerFor(st, team) }; node.text = `${node.data.enemyName}盘踞在前方！\n我方战力：${teamPower} · 妖兽战力：${node.data.enemyPower}\n预计胜率：${guardWinRate(teamPower, node.data.enemyPower)}%（按绝对战力计算，结果不再随机）`; node.choices = [{ n: 1, label: '猎杀（按战力判定，成功得兽宝）' }, { n: 2, label: '安抚（花300灵石，安全通过）' }, { n: 3, label: '绕道' }]
  } else if (type === 'maze') {
    const correct = (Number(team.step) || 0) % 2 + 1
    node.title = '🌀 迷阵岔路'; node.text = `面前两条岔路，阵纹已经给出提示：${correct === 1 ? '左路' : '右路'}为正路。`; node.data = { kind: 'maze', correct }; node.choices = [{ n: 1, label: '走左路' }, { n: 2, label: '走右路' }, { n: 3, label: '谨慎观察（得一份奖励）' }]
  } else if (type === 'spring') {
    node.title = '💧 灵泉淬体'; node.text = `一汪灵泉映入眼帘，浸泡可稳定淬体，不会额外触发随机袭击。`; node.choices = [{ n: 1, label: '泡灵泉（战力+10%，获得奖励）' }, { n: 2, label: '不泡，离开' }]
  } else if (type === 'scroll') {
    node.title = '📜 灵材遗藏'; node.text = `石缝里露出秘境本源灵材。`; node.choices = [{ n: 1, label: '拾取灵材（收入公共池）' }, { n: 2, label: '留给后来人' }]
  } else if (type === 'elder') {
    node.title = '🧓 神秘老者'; node.text = `一位看不清面容的老者叫住你：“小友，可要一场机缘？”规则已明示：求机缘得奖励并付出代价，问路稳定获得小奖励，试探按战力判定。`; node.data = { kind: 'elder', requiredPower: combatPowerFor(st, team, 1.1) }; node.choices = [{ n: 1, label: '求机缘（获得一份奖励）' }, { n: 2, label: '问路（获得一份稳定奖励）' }, { n: 3, label: '试探（按战力判定）' }]
  } else if (type === 'contest') {
    node.title = '🏆 天材地宝'; node.text = `一株天材地宝现世，各方目光齐聚！`; node.choices = [{ n: 1, label: '出手夺宝（得宝但暴露位置）' }, { n: 2, label: '等待时机（小概率捡漏）' }, { n: 3, label: '放弃离开' }]
  }
  return node
}
export async function genNode (st, team, gid) {
  for (const other of Object.values(st.teams || {})) if (other.kind === 'fake' && !other.dead) syncFakeTeam(gid, st, other)
  if (!team.members.length) return null
  const profiles = await teamProfiles(gid, team)
  const teamPower = Math.max(1, Math.round(profiles.reduce((sum, p) => sum + (Number(p.power) || 0), 0) * (team.powerBoost || 1)))
  team.combatPower = teamPower
  const type = NODE_TYPES[(Number(team.step) || 0) % NODE_TYPES.length]
  const node = buildNode(st, team, type, teamPower)
  team.node = node
  team.lastActionAt = Date.now()
  saveRealmState(st, gid)
  return node
}

/* ---------- 统一战斗 ---------- */
async function playerProfile (gid, uid) {
  const b = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`); const level = Number(b[uid]?.level) || 0; const bag = getBag(uid, gid); const buff = await getBuffs(uid, gid); const { power } = calcCombatPower(level, bag, buff, gid, uid); return { name: String(uid), level, power, bag, buff }
}
async function teamProfiles (gid, team) {
  if (team.kind === 'fake') return currentFakePersons(gid, team).map(p => ({ name: p.name, level: Number(p.level) || 0, power: personPower(p), person: p }))
  const out = []; for (const uid of team.members || []) out.push(await playerProfile(gid, uid)); return out
}
async function teamFight (st, gid, a, b) {
  const ap = await teamProfiles(gid, a); const bp = await teamProfiles(gid, b)
  const myPower = Math.round(ap.reduce((s, p) => s + p.power, 0) * (a.powerBoost || 1))
  const oppPower = Math.round(bp.reduce((s, p) => s + p.power, 0) * (b.powerBoost || 1)); const winRate = guardWinRate(myPower, oppPower)
  const result = deterministicFightResult(winRate >= 50)
  const win = result.winner === 'me'; const loser = win ? b : a; const loserProfiles = win ? bp : ap; const victim = loserProfiles.slice().sort((x, y) => String(x.name).localeCompare(String(y.name)))[0]?.name || null
  if (win) { credit(a, 3); transferVictory(loser, a) } else { transferVictory(a, b) }
  return { win, myPower, oppPower, winRate, victim, result }
}
function transferVictory (loser, winner) { let total = 0; for (const uid of Object.keys(loser.victory || {})) { const n = Math.floor((loser.victory[uid] || 0) * 0.3); loser.victory[uid] -= n; total += n }; const m = winner.members || []; if (m.length) for (const uid of m) winner.victory[uid] = (winner.victory[uid] || 0) + Math.floor(total / m.length) }
function fightText (r) { return `⚔️ 战力 ${r.myPower} vs ${r.oppPower}（胜率${r.winRate}%）→ ${r.win ? '你方胜出！' : '你方落败！'}` }

/* ---------- 节点结算 ---------- */
async function grantReward (st, team, actor, cfg = {}) {
  const r = rollRewardList(st, st.diff, Math.random, { ...cfg, special: true })
  const got = []
  for (const item of r) got.push(addToPool(st, team, item, actor))
  return { r, got }
}
function loseLife (team, msgs) {
  team.lives = Math.max(0, (team.lives || 3) - 1)
  msgs.push(`⛔ 你受创，队命-1（剩余${team.lives}）。`)
  if (team.lives <= 0) { team.dead = true; msgs.push('队命耗尽，队伍被秘境遣返。') }
}
export async function resolveNode (st, gid, team, node, idx, cfg) {
  if (!node || !team || team.node !== node) return { valid: false, msgs: ['这个选择已经失效~'] }
  if (!node.choices.some(c => c.n === idx)) return { valid: false, msgs: [`请输入 ${node.choices.map(c => c.n).join('、')} 选择~`] }
  const msgs = []
  const actor = node.actor
  let autoDisposalDone = false
  const teamPower = Math.max(1, Number(team.combatPower) || 1)
  const requiredPower = Number(node.data?.requiredPower) || combatPowerFor(st, team, 1)
  const success = teamPower >= requiredPower

  if (node.type === 'treasure') {
    if (idx === 1) {
      const reward = st.specialPending && Number(st.specialGranted) < SPECIAL_MAX
        ? rollRewardList(st, st.diff, Math.random, { special: true })
        : (node.data.reward || [])
      const gots = []
      for (const item of reward) gots.push(addToPool(st, team, item, actor))
      expose(team)
      msgs.push(`你拾取${fmtRewards(gots)}，收入公共池并暴露位置。${gots.some(g => g && g.rare) ? '\n✨ 天降彩色机缘！' : ''}`)
    }
    else msgs.push('你放弃宝物，未惊动四周。')
  } else if (node.type === 'dushi') {
    if (idx === 3) msgs.push('你放弃赌石，悄然离开。')
    else if (idx === 1 || idx === 2) { const got = (await grantReward(st, team, actor, cfg)).got; if (idx === 2) st.chaos += 1; expose(team); msgs.push(`你切出${fmtRewards(got)}${idx === 2 ? '（高阶切法，乱源上升；位置暴露）' : '（位置暴露）'}`) }
  } else if (node.type === 'fake' || node.type === 'player') {
    if (idx === 2 && node.type === 'fake') msgs.push(await payLeader(team, gid, 300) ? '你支付300灵石买路，安全通过。' : '你的灵石不足，买路失败，只能原地绕行。')
    else if (idx === 1) {
      const target = st.teams[node.data.target]
      if (target?.kind === 'fake') syncFakeTeam(gid, st, target)
      if (!target || !target.members.length) msgs.push('对方已经离开了。')
      else {
        const r = await teamFight(st, gid, team, target)
        msgs.push(fightText(r))
        if (r.win) {
          if (team.kind === 'fake') { msgs.push(...(await autoFakeDisposal(st, gid, team, target, r.victim, cfg))); autoDisposalDone = true }
          else {
            team.node = { type: 'disposal', title: '⚖️ 处置战败者', text: `你击败了【${target.name}】的成员【${r.victim}】，选择处置：`, choices: disposalChoices(target), data: { target: target.id, victim: r.victim, disposalVersion: 2 } }
            team.pendingDisposal = { targetId: target.id, victim: r.victim }
            team.lastActionAt = Date.now(); saveRealmState(st, gid)
            return { valid: true, msgs, disposalFor: { leaderUid: team.leader, text: menuText(team.node) } }
          }
        } else if (target.kind === 'player') {
          target.node = { type: 'disposal', title: '⚖️ 处置战败者', text: `你击败了【${team.name}】的成员【${r.victim}】，选择处置：`, choices: disposalChoices(team), data: { target: team.id, victim: r.victim, disposalVersion: 2 } }
          target.pendingDisposal = { targetId: team.id, victim: r.victim }
          releaseNodeTarget(st, team, node)
          if (team.kind === 'fake') { team.node = null; team.pendingDisposal = null; team.nextActionAt = Date.now() + actionDelay(); team.lastActionAt = Date.now() }
          saveRealmState(st, gid)
          return { valid: true, msgs, disposalFor: { leaderUid: target.leader, text: menuText(target.node) } }
        } else msgs.push(...(await autoFakeDisposal(st, gid, target, team, r.victim, cfg)))
      }
    } else msgs.push(idx === 3 ? '你选择避开这次遭遇。' : '双方短暂对峙后擦肩而过。')
  } else if (node.type === 'trial') {
    const enemyPower = Number(node.data.requiredPower) || combatPowerFor(st, team, 1.15)
    const winRate = guardWinRate(teamPower, enemyPower)
    msgs.push(`⚔️ 异变战力 ${enemyPower} · 你方战力 ${teamPower} · 胜率 ${winRate}%`)
    if (idx === 1 && success) { const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`你击退异变，得到${fmtRewards(got)}。`) }
    else if (idx === 1) { loseLife(team, msgs); msgs.push('你未能击退异变。') }
    else msgs.push('你绕开异变，未与其交战。')
  } else if (node.type === 'chuangguan') {
    if (idx === 3) msgs.push('你退回上一层。')
    else if (idx === 1 && success) { const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`闯关成功，得到${fmtRewards(got)}${got.some(g => g && g.rare) ? '✨' : ''}。`) }
    else if (idx === 2) msgs.push('你取巧绕过考验，安全通过，但没有获得奖励。')
    else { loseLife(team, msgs); msgs.push('考验失败。') }
  } else if (node.type === 'jueze') {
    if (idx === 1) { team.dao = (team.dao || 0) + 2; const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`你守住本心，道心上升并得到${fmtRewards(got)}。`) }
    else if (idx === 3) { team.dao = (team.dao || 0) - 2; st.chaos += 1; const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`你选择夺取，得到${fmtRewards(got)}，但乱源上升。`) }
    else msgs.push('你选择顺势而为，平稳通过。')
  } else if (node.type === 'duojie') {
    if (idx === 1 && success) { const got = (await grantReward(st, team, actor, cfg)).got; expose(team); msgs.push(`你抢到雷池中心的${fmtRewards(got)}，位置暴露。`) }
    else if (idx === 1) { loseLife(team, msgs); msgs.push('天雷反噬，你被劈中。') }
    else if (idx === 2) { const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`你在外围捡到${fmtRewards(got)}。`) }
    else msgs.push('你躲开了天雷。')
  } else if (node.type === 'jiemi') {
    if (idx === 1 && !success) { st.chaos += 1; msgs.push('强行破禁失败，机关反噬，乱源上升。') }
    else if (idx === 3) msgs.push('你绕开禁制。')
    else { const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`机关被解开，得到${fmtRewards(got)}。`) }
  } else if (node.type === 'beast') {
    const enemyPower = Number(node.data.enemyPower) || combatPowerFor(st, team)
    const winRate = guardWinRate(teamPower, enemyPower)
    msgs.push(`⚔️ ${node.data.enemyName || '秘境妖兽'}战力 ${enemyPower} · 你方战力 ${teamPower} · 胜率 ${winRate}%`)
    if (idx === 1) { if (success) { const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`你猎杀了妖兽，得到兽宝${fmtRewards(got)}！`) } else { loseLife(team, msgs); msgs.push('你被妖兽所伤。') } }
    else if (idx === 2) msgs.push(await payLeader(team, gid, 300) ? '你安抚了妖兽，安全通过。' : '灵石不足，你只能绕道。')
    else msgs.push('你绕道而行。')
  } else if (node.type === 'maze') {
    if (idx === 3) { const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`你谨慎观察，找到了正路，得到${fmtRewards(got)}。`) }
    else if (idx === node.data.correct) { const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`你走对了路，得到${fmtRewards(got)}。`) }
    else { st.chaos += 0.5; msgs.push('你走进了死路，浪费了时间，乱源略升。') }
  } else if (node.type === 'spring') {
    if (idx === 1) { team.powerBoost = (team.powerBoost || 1) + 0.1; const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`你泡入灵泉，淬体成功，战力+10%，得到${fmtRewards(got)}。`) }
    else msgs.push('你放弃灵泉。')
  } else if (node.type === 'scroll') {
    if (idx === 1) { const got = grantScroll(st, team); msgs.push(`你拾得灵材${fmtRewards([got])}，收入公共池。`) }
    else msgs.push('你留下灵材，给后来人留一分机缘。')
  } else if (node.type === 'elder') {
    if (idx === 1) { const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`老者抚须而笑：“你有缘！”得${fmtRewards(got)}。`) }
    else if (idx === 2) { const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`老者为你指路，你安稳前行，得${fmtRewards(got)}。`) }
    else if (success) { const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`老者眼神一凝，你试探到他的深浅，得${fmtRewards(got)}。`) }
    else { loseLife(team, msgs); msgs.push('老者出手如电，你吃了个暗亏。') }
  } else if (node.type === 'contest') {
    if (idx === 1) { const got = (await grantReward(st, team, actor, cfg)).got; expose(team); st.chaos += 1; msgs.push(`你抢到了天材地宝${fmtRewards(got)}，位置暴露！`) }
    else if (idx === 2) { const got = (await grantReward(st, team, actor, cfg)).got; msgs.push(`众人乱斗，你按时机捡到${fmtRewards(got)}。`) }
    else msgs.push('你放弃了天材地宝。')
  }

  releaseNodeTarget(st, team, node)
  team.node = null
  team.pendingDisposal = null
  if (!autoDisposalDone) team.step = (team.step || 0) + 1
  team.nextActionAt = Date.now() + actionDelay()
  team.lastActionAt = Date.now()
  saveRealmState(st, gid)
  return { valid: true, msgs }
}
/** 灵材遗藏: 奖励始终使用本秘境固定灵材 */
function grantScroll (st, team) {
  const reward = rollReward(st, st.diff, Math.random, { special: true })
  addPoolItem(team, reward)
  credit(team, reward.quality)
  return reward
}
async function payLeader (team, gid, amount) { if (team.kind !== 'player') return false; const home = await xujing_data.getQQYUserHome(team.leader, null, `${gid}.json`, false); if (!home[team.leader] || (Number(home[team.leader].money) || 0) < amount) return false; home[team.leader].money -= amount; await xujing_data.getQQYUserHome(team.leader, home, `${gid}.json`, true); return true }
function expose (team) { team.hidden = false; team.exposedUntil = Date.now() + 10 * 60000 }
const DISPOSAL_PLANS = Object.freeze({
  1: Object.freeze({ poolRate: 0, bagRate: 0, moneyRate: 0, release: true }),
  2: Object.freeze({ poolRate: 0.3, bagRate: 0, moneyRate: 0 }),
  3: Object.freeze({ poolRate: 1, bagRate: 0, moneyRate: 0, expose: true }),
  4: Object.freeze({ poolRate: 0, bagRate: 0.3, moneyRate: 0 }),
  5: Object.freeze({ poolRate: 0, bagRate: 1, moneyRate: 0, expose: true }),
  6: Object.freeze({ poolRate: 0, bagRate: 0, moneyRate: 0.3 }),
  7: Object.freeze({ poolRate: 0, bagRate: 0, moneyRate: 1, expose: true }),
  8: Object.freeze({ poolRate: 0.3, bagRate: 0.3, moneyRate: 0.3 }),
  9: Object.freeze({ poolRate: 1, bagRate: 1, moneyRate: 1, expose: true }),
  10: Object.freeze({ poolRate: 1, bagRate: 1, moneyRate: 1, kill: true })
})
function disposalPlan (idx) { return DISPOSAL_PLANS[Number(idx)] || null }
function normalizeDisposalIndex (idx, version) { return Number(version) >= 2 ? idx : ({ 1: 8, 2: 9, 3: 10 }[idx] || idx) }
export function disposalChoices (target = {}) {
  return [
    { n: 1, label: '放过（不拿任何战利品）' },
    { n: 2, label: '只取奖励池份额30%' },
    { n: 3, label: '只取奖励池份额全部（位置暴露）' },
    { n: 4, label: '只取背包30%（非绑定，受搜刮上限）' },
    { n: 5, label: '只取背包全部（非绑定，位置暴露）' },
    { n: 6, label: '只取随身灵石30%' },
    { n: 7, label: '只取随身灵石全部（位置暴露）' },
    { n: 8, label: '综合搜刮30%（奖励池+背包+灵石）' },
    { n: 9, label: '全搜（全部可取物，位置暴露）' },
    { n: 10, label: target.kind === 'fake' ? '杀人夺宝（斩灭其身，业力+吸魂）' : '杀人夺宝（重伤遣返本场）' }
  ]
}
export function menuText (node) { return [node.title, node.text, ...node.choices.map(c => `${c.n}. ${c.label}`)].join('\n') }
function releaseNodeTarget (st, team, node) {
  const id = node && node.data && node.data.target
  const target = id ? st.teams[id] : null
  if (target && target.engagedBy === team.id) delete target.engagedBy
}

/* ---------- 搜刮/击杀 ---------- */
function fakeDisposalIndex (leader) { return isBigEvil(leader) ? 10 : (leader.trait === '好斗' ? 9 : 8) }
async function autoFakeDisposal (st, gid, winnerFake, loser, victim, cfg) {
  const persons = currentFakePersons(gid, winnerFake); const leader = persons.find(p => p.name === winnerFake.leader) || persons[0]; if (!leader) return ['伪玩家队已经无人可行动。']
  return (await resolveDisposal(st, gid, winnerFake, fakeDisposalIndex(leader), cfg, { targetId: loser.id, victim, disposalVersion: 2 })).msgs
}
export async function resolveDisposal (st, gid, team, idx, cfg, forced = null) {
  const pending = forced || team.pendingDisposal; const target = pending && st.teams[pending.targetId]; const victim = pending && pending.victim
  const choices = forced ? disposalChoices(target || {}) : (team.node?.choices || disposalChoices(target || {}))
  if (!target || !victim) return { valid: false, msgs: ['处置对象已经不在场~'] }
  if (!choices.some(c => c.n === idx)) return { valid: false, msgs: ['这个处置选项不存在~'] }
  /* 兼容更新前正在等待回复的旧三项处置菜单。 */
  const version = forced ? Number(forced.disposalVersion) || 2 : Number(team.node?.data?.disposalVersion || pending.disposalVersion) || 1
  const choiceIdx = normalizeDisposalIndex(idx, version)
  const plan = disposalPlan(choiceIdx)
  if (!plan) return { valid: false, msgs: ['这个处置选项不存在~'] }
  if (target.engagedBy === team.id) delete target.engagedBy
  const msgs = []
  if (!plan.release) {
    const loot = await lootPerson(st, gid, team, target, victim, plan, cfg)
    msgs.push(...loot.msgs)
  }
  if (plan.kill) {
    if (target.kind === 'fake') {
      const killed = killFakePerson(gid, st, target, victim, team)
      msgs.push(...killed.msgs)
      if (killed.level && team.kind === 'player') {
        const soul = Wanhun.captureSoul(team.leader, gid, killed.level, 1); if (soul.gained) msgs.push(`👻 万魂幡吸魂成功，收魂${soul.gained}。`)
        const karma = await xujing_data.addPlayerKarma(gid, team.leader, 2); msgs.push(`☯️ 业力+2（当前${karma}）。`)
      }
    } else {
      removeTeamMember(st, target, victim)
      if (!target.members.length) delete st.teams[target.id]
      msgs.push(`☠️ 【${victim}】被重伤遣返出秘境。`)
      if (team.kind === 'player') {
        const karma = await xujing_data.addPlayerKarma(gid, team.leader, 1)
        msgs.push(`☯️ 业力+1（当前${karma}）。`)
      } else {
        addFakeSin(gid, team.leader, 1)
      }
    }
  } else if (plan.expose) {
    expose(team)
    target.revenge = [...new Set([...(target.revenge || []), team.id])]
    msgs.push(`📢 搜刮完成，${team.name}的位置暴露10分钟。`)
  } else if (plan.release) msgs.push('🤝 你放过了对方，没有拿走任何战利品。')
  else msgs.push('搜刮完成，对方仍留在秘境中。')
  team.pendingDisposal = null; team.node = null; team.step = (team.step || 0) + 1; team.nextActionAt = Date.now() + actionDelay(); team.lastActionAt = Date.now(); saveRealmState(st, gid); return { valid: true, msgs }
}
async function lootPerson (st, gid, winner, target, victim, plan, cfg) {
  const msgs = []
  if (plan.poolRate > 0) {
    const poolShare = extractPoolShare(target, victim, plan.poolRate)
    for (const item of poolShare.items) addPoolItem(winner, item)
    const itemsText = fmtRewards(poolShare.items)
    const moneyText = poolShare.money ? `${itemIcon('灵石')}灵石×${poolShare.money}` : ''
    const poolText = [itemsText, moneyText].filter(Boolean).join('、')
    if (poolText) msgs.push(`🧳 搜刮奖励：${poolText}`)
    if (poolShare.money) addPoolItem(winner, { name: '灵石', count: poolShare.money, currency: true, quality: 1 })
  }
  if (plan.bagRate <= 0 && plan.moneyRate <= 0) return { msgs }
  if (target.kind === 'player') {
    const r = await extractPlayerInventory(gid, victim, plan.bagRate, plan.moneyRate, cfg)
    for (const x of r.items) addPoolItem(winner, x)
    if (r.money) addPoolItem(winner, { name: '灵石', count: r.money, currency: true, quality: 1 })
    const inventoryText = fmtRewards(r.items)
    if (r.items.length || r.money) msgs.push(`🎒 从【${victim}】背包搜得${inventoryText}${r.money ? `${inventoryText ? '、' : ''}${itemIcon('灵石')}灵石×${r.money}` : ''}`)
  } else {
    const r = extractFakeInventory(gid, victim, plan.bagRate, plan.moneyRate, cfg)
    for (const x of r.items) addPoolItem(winner, x)
    if (r.money) addPoolItem(winner, { name: '灵石', count: r.money, currency: true, quality: 1 })
    const inventoryText = fmtRewards(r.items)
    if (r.items.length || r.money) msgs.push(`🎒 从【${victim}】身上搜得${inventoryText}${r.money ? `${inventoryText ? '、' : ''}${itemIcon('灵石')}灵石×${r.money}` : ''}`)
  }
  return { msgs }
}
function extractPoolShare (target, victim, rate) {
  const members = target.members || []; const c = target.contrib || {}; const total = members.reduce((s, x) => s + (c[x] || 0), 0) || members.length || 1; const share = Math.max(0, (c[victim] || 0) / total); const takeRate = Math.min(1, rate * Math.max(share, 1 / members.length)); const items = []; let money = 0; const kept = []
  for (const item of target.pool || []) {
    const n = Math.min(item.count || 0, Math.max(0, Math.ceil((item.count || 0) * takeRate)))
    if (n > 0) { const x = { ...item, count: n }; if (item.currency) money += n; else items.push(x) }
    const left = (item.count || 0) - n
    if (left > 0) kept.push({ ...item, count: left })
  }
  target.pool = kept; return { items, money }
}
function inventoryLootLimit (total, rate, cfg = {}) {
  const amount = Math.max(0, Number(total) || 0)
  if (rate <= 0) return 0
  if (rate >= 1) return amount
  return Math.min(Number(cfg.loot_cap) || 5, Math.ceil(amount * rate))
}
function moneyLootAmount (total, rate) {
  const amount = Math.max(0, Number(total) || 0)
  if (rate <= 0) return 0
  return rate >= 1 ? amount : Math.floor(amount * rate)
}
async function extractPlayerInventory (gid, uid, bagRate, moneyRate, cfg) {
  const items = []
  if (bagRate > 0) {
    const bag = getBag(uid, gid)
    const equipped = new Set(Object.values(bag.equipped || {}).filter(Boolean))
    const names = Object.keys(bag.items || {}).filter(n => !equipped.has(n) && !isBound(n))
    const total = names.reduce((s, n) => s + Math.max(0, Number(bag.items[n]?.count ?? bag.items[n]) || 0), 0)
    let left = inventoryLootLimit(total, bagRate, cfg)
    for (const n of names.sort()) {
      if (left <= 0) break
      const have = Number(bag.items[n]?.count ?? bag.items[n]) || 0
      const take = Math.min(have, left)
      if (take <= 0) continue
      consumeItem(uid, n, take, null, gid)
      items.push({ name: n, count: take, quality: itemQuality(n), rare: itemQuality(n) >= 6 })
      left -= take
    }
  }
  let money = 0
  if (moneyRate > 0) {
    try {
      const home = await xujing_data.getQQYUserHome(uid, null, `${gid}.json`, false)
      if (home[uid]) {
        const have = Math.max(0, Number(home[uid].money) || 0)
        money = moneyLootAmount(have, moneyRate)
        if (money > 0) {
          home[uid].money = have - money
          await xujing_data.getQQYUserHome(uid, home, `${gid}.json`, true)
        }
      }
    } catch (err) { }
  }
  return { items, money }
}
function extractFakeInventory (gid, victim, bagRate, moneyRate, cfg) {
  const f = getFake(gid)
  const p = f.roster && f.roster[victim]
  if (!p) return { items: [], money: 0 }
  const items = []
  if (bagRate > 0) {
    if (!p.bag) p.bag = { items: {}, equipped: {} }
    const equipped = new Set(Object.values(p.bag.equipped || {}).filter(Boolean))
    const names = Object.keys(p.bag.items || {}).filter(n => !equipped.has(n) && !isBound(n))
    const total = names.reduce((s, n) => s + (Number(p.bag.items[n]?.count ?? p.bag.items[n]) || 0), 0)
    let left = inventoryLootLimit(total, bagRate, cfg)
    for (const n of names.sort()) {
      if (left <= 0) break
      const have = Number(p.bag.items[n]?.count ?? p.bag.items[n]) || 0
      const take = Math.min(have, left)
      if (take <= 0) continue
      if (typeof p.bag.items[n] === 'object') {
        p.bag.items[n].count -= take
        if (p.bag.items[n].count <= 0) delete p.bag.items[n]
      } else {
        p.bag.items[n] -= take
        if (p.bag.items[n] <= 0) delete p.bag.items[n]
      }
      items.push({ name: n, count: take, quality: itemQuality(n), rare: itemQuality(n) >= 6 })
      left -= take
    }
  }
  const haveMoney = Math.max(0, Number(p.money) || 0)
  const money = moneyLootAmount(haveMoney, moneyRate)
  if (money > 0) p.money = haveMoney - money
  if (items.length || money) saveFake(f, gid)
  return { items, money }
}
function addFakeSin (gid, name, amount) {
  try {
    const f = getFake(gid)
    const p = f.roster && f.roster[name]
    if (!p) return
    p.sin = (p.sin || 0) + amount
    p.kills = (p.kills || 0) + 1
    saveFake(f, gid)
  } catch (err) { }
}
function killFakePerson (gid, st, team, victim, killerTeam) {
  const f = getFake(gid)
  const p = f.roster && f.roster[victim]
  if (!p || !p.alive) return { msgs: ['目标已不在世。'], level: 0 }
  const level = p.level
  const killer = killerTeam.kind === 'fake' ? f.roster[killerTeam.leader] : null
  if (killer) {
    killer.kills = (killer.kills || 0) + 1
    killer.sin = (killer.sin || 0) + (p.status === 'sect' && p.sect ? 2 : 1)
  }
  killPerson(f, p, `于【${st.title}】被【${killerTeam.name}】斩杀`, Date.now())
  saveFake(f, gid)
  team.members = team.members.filter(n => n !== victim)
  if (!team.members.length) delete st.teams[team.id]
  return { msgs: [`☠️ ${victim} 已被斩杀，身死道消。`], level }
}

/* ---------- 考验与真实意外 ---------- */
export function addChaos (st, n) { st.chaos = (st.chaos || 0) + Math.max(0, Number(n) || 0) }
export function rollEvent (st, cfg) {
  if (st.phase !== 'explore' || st.eventsFired >= (cfg.event_max || 4) || st.chaos <= 0) return null
  if (Number(st.lastEventChaos) >= Number(st.chaos)) return null
  const terr = TERRAINS[st.terrain]
  const pool = (terr.events || []).map(name => ({ name, kind: 'terrain', text: `${terr.emoji}${name}！秘境发生异变！` })).concat(GENERIC_EVENTS)
  const ev = pool[st.eventsFired % pool.length]
  st.lastEventChaos = st.chaos
  st.eventsFired++
  st.firedEvents.push(ev.name)
  return ev
}
export function applyEvent (st, gid, ev) {
  const msgs = []; const pushes = []; const name = ev.name
  if (ev.kind === 'treasure') {
    for (const t of Object.values(st.teams)) if (!t.dead && t.members.length) {
      const r = rollRewardList(st, st.diff, Math.random, { special: true })
      const got = []
      for (const item of r) got.push(addToPool(st, t, item))
      msgs.push(`【${t.name}】发现秘藏${fmtRewards(got)}${got.some(g => g && g.rare) ? '✨' : ''}。`)
    }
  } else if (ev.kind === 'guardian' || ['守园大妖', '残念Boss', '傀儡暴动', '尸傀潮', '龙宫守卫暴动', '禁地凶物', '魔潮', '封印松动'].includes(name)) {
    for (const t of Object.values(st.teams)) if (!t.dead && t.members.length) {
      const teamPower = t.kind === 'fake'
        ? Math.max(1, Math.round(currentFakePersons(gid, t).reduce((sum, p) => sum + personPower(p), 0)))
        : Math.max(1, Number(t.combatPower) || 1)
      const enemyPower = combatPowerFor(st, t, 1.15)
      const eventNode = { type: 'trial', title: '👹 异变拦路', text: `${ev.text}\n异变战力：${enemyPower} · 你方战力：${teamPower} · 迎战胜率：${guardWinRate(teamPower, enemyPower)}%`, choices: [{ n: 1, label: '迎战异变' }, { n: 2, label: '绕行避开' }], actor: actionActor(t), data: { kind: 'chuangguan', requiredPower: enemyPower } }
      if (t.node) { if (!Array.isArray(t.eventQueue)) t.eventQueue = []; t.eventQueue.push(eventNode) }
      else { t.node = eventNode; t.lastActionAt = Date.now(); if (t.kind === 'player') { syncPlayerTeam(st, gid, t); pushes.push({ team: t, node: t.node }) } }
    }
  } else if (name === '灵脉暴走' || name === '主棺异动' || name === '飞升残影' || name === '挖出禁忌' || name === '仙兵共鸣') {
    for (const t of Object.values(st.teams)) if (!t.dead && t.members.length) {
      const r = rollRewardList(st, st.diff, Math.random, { special: true })
      const got = []
      for (const item of r) got.push(addToPool(st, t, item))
      msgs.push(`【${t.name}】被异变卷入，意外获得${fmtRewards(got)}${got.some(g => g && g.rare) ? '✨' : ''}。`)
    }
    st.chaos += 1
  } else if (name === '丹炉炸炉') {
    for (const t of Object.values(st.teams)) if (!t.dead && t.pool.length) {
      const lost = t.pool.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))[0]
      if (lost) {
        const index = t.pool.indexOf(lost)
        t.pool.splice(index, 1)
        msgs.push(`【${t.name}】的丹炉炸裂，损失${itemIcon(lost.name)}${lost.name}×${lost.count}。`)
      }
    }
  } else if (name === '护山残阵触发' || name === '禁制连环' || name === '源石连锁' || name === '魔化加剧') {
    for (const t of Object.values(st.teams)) t.nextActionAt = Math.max(t.nextActionAt || 0, Date.now() + 2 * 60000)
    st.chaos += 1
    msgs.push('所有队伍行动被异变拖慢。')
  } else if (name === '海啸' || name === '界域震荡') {
    for (const t of Object.values(st.teams)) { t.pos = (t.pos || 0) + 1; t.nextActionAt = Math.max(t.nextActionAt || 0, Date.now() + 60000) }
    msgs.push('潮汐/界域震荡改变了所有队伍的位置。')
  } else if (name === '矿脉塌陷' || name === '空间崩塌加速' || name === '时间风暴' || (ev.kind === 'terrain' && /塌陷|崩塌|时间风暴/.test(name))) {
    const remain = Math.max(5, Math.ceil((st.endAt - Date.now()) / 60000))
    st.endAt = Date.now() + Math.max(5, Math.floor(remain / 2)) * 60000
    msgs.push(`⏳ ${name}改变了秘境结构，探索剩余时间缩短。`)
  } else {
    st.chaos += 1
    for (const t of Object.values(st.teams)) t.nextActionAt = Math.max(t.nextActionAt || 0, Date.now() + 60000)
  }
  saveRealmState(st, gid); return { msgs, pushes }
}

/* ---------- 系统驱动 ---------- */
export async function advanceTeams (st, gid, cfg) {
  if (st.phase !== 'explore') return []
  const now = Date.now(); const pending = []
  for (const t of Object.values(st.teams)) {
    if (t.dead || !t.members.length || t.node || t.engagedBy || now < (t.nextActionAt || 0)) continue
    if (t.kind === 'fake') continue
    /* 转让队长后刷新队长快照: 节点推送给当前队长, 旧队长离开也不卡队 */
    syncPlayerTeam(st, gid, t)
    if (!t.members.includes(String(t.leader))) continue
    if (Array.isArray(t.eventQueue) && t.eventQueue.length) {
      t.node = t.eventQueue.shift()
      t.lastActionAt = now
      pending.push({ team: t, node: t.node })
      continue
    }
    const node = await genNode(st, t, gid)
    if (node) pending.push({ team: t, node })
  }
  return pending
}
export function advanceFakeArrivals (st, gid, now = Date.now()) {
  if (st.phase !== 'explore') return []
  const arrived = []
  for (const t of Object.values(st.teams || {})) {
    if (t.kind !== 'fake' || t.entered !== false || t.dead) continue
    if (t.arrivalAt && now < t.arrivalAt) continue
    t.arrived = true
    t.entered = true
    t.nextActionAt = now + 60000
    arrived.push(t)
  }
  if (arrived.length) { markFakesBusy(gid, st); saveRealmState(st, gid) }
  return arrived
}
export async function driveFakeTeams (st, gid, cfg) {
  if (st.phase !== 'explore') return { msgs: [], pushes: [] }
  const now = Date.now(); const msgs = []; const pushes = []
  for (const t of Object.values(st.teams)) {
    if (t.kind !== 'fake' || t.entered === false || t.dead || t.engagedBy || !t.members.length) continue
    syncFakeTeam(gid, st, t)
    if (!t.members.length) { t.dead = true; continue }
    if (Array.isArray(t.eventQueue) && t.eventQueue.length) {
      t.node = t.eventQueue.shift()
      t.lastActionAt = now
    }
    if (t.node) {
      if (t.node.type === 'disposal') continue
      const actor = currentFakePersons(gid, t).find(p => p.name === t.leader) || currentFakePersons(gid, t)[0]
      const idx = fakeChoice(t, t.node, actor)
      const r = await resolveNode(st, gid, t, t.node, idx, cfg)
      msgs.push(...r.msgs.map(x => `【${t.name}】${x}`))
      if (r.disposalFor) pushes.push(r.disposalFor)
      continue
    }
    if (now < (t.nextActionAt || 0)) continue
    const node = await genNode(st, t, gid)
    if (!node) continue
    const actor = currentFakePersons(gid, t).find(p => p.name === t.leader) || currentFakePersons(gid, t)[0]
    const idx = fakeChoice(t, node, actor)
    const r = await resolveNode(st, gid, t, node, idx, cfg)
    msgs.push(...r.msgs.map(x => `【${t.name}】${x}`))
    if (r.disposalFor) pushes.push(r.disposalFor)
  }
  if (msgs.length) saveRealmState(st, gid)
  return { msgs, pushes }
}
function fakeChoice (team, node, actor) {
  const evil = actor && (actor.path === '魔道' || actor.trait === '嗜杀'); const brave = actor && actor.trait === '好斗'; const greedy = evil || brave || (actor && actor.act === '贪玩')
  if (node.type === 'treasure') return greedy ? 1 : 2
  if (node.type === 'fake' || node.type === 'player') return greedy ? 1 : 3
  if (node.type === 'jueze') return evil ? 3 : (actor?.trait === '善良' ? 1 : 2)
  if (node.type === 'dushi') return 1
  if (node.type === 'chuangguan') return brave ? 1 : 2
  if (node.type === 'duojie') return brave ? 1 : 2
  if (node.type === 'jiemi') return 2
  if (node.type === 'beast') return brave ? 1 : 2
  if (node.type === 'maze') return 3
  if (node.type === 'spring' || node.type === 'scroll') return 1
  if (node.type === 'elder') return 2
  if (node.type === 'contest') return 2
  return 2
}

/** 玩家队抉择超时未回复时的系统代选: 一律选保守/不消耗资源/不触发战斗的选项, 只保留该步现状(不得新收益) */
export function autoPickForPlayer (node) {
  if (!node) return 1
  switch (node.type) {
    case 'treasure': return 2          // 放弃, 不惊动四周
    case 'dushi': return 3             // 不切
    case 'fake':
    case 'player': return 3            // 避让/绕道, 不触发 PvP
    case 'chuangguan': return 2        // 取巧过关
    case 'jueze': return 2             // 顺势而为
    case 'duojie': return 3            // 躲开
    case 'jiemi': return 3             // 绕行
    case 'beast': return 3             // 绕道
    case 'maze': return 3              // 谨慎观察
    case 'spring': return 2            // 不泡, 离开
    case 'scroll': return 2            // 留给后来人
    case 'elder': return 2             // 问路(稳定小奖励)
    case 'contest': return 3           // 放弃
    case 'trial': return 2             // 绕行避开
    case 'disposal': return Number(node.data?.disposalVersion) >= 2 ? 8 : 1 // 新菜单综合30%; 旧存档仍选旧1号
    default: return 1
  }
}

/* ---------- 贡献分账 ---------- */
export function planSplit (team, _random = Math.random) {
  const members = (team.members || []).map(String)
  const result = Object.fromEntries(members.map(uid => [uid, { uid, items: [], contrib: Number(team.contrib?.[uid]) || 0 }]))
  const normalItems = []
  for (const item of team.pool || []) {
    if (item.currency) {
      const amount = Math.max(0, Number(item.count) || 0)
      const total = members.reduce((s, uid) => s + result[uid].contrib, 0)
      let assigned = 0
      const parts = members.map(uid => {
        const raw = total > 0 ? amount * result[uid].contrib / total : amount / Math.max(1, members.length)
        const count = Math.floor(raw)
        assigned += count
        return { uid, count, frac: raw - count }
      })
      let remain = amount - assigned
      for (const part of parts.sort((a, b) => b.frac - a.frac)) {
        if (remain <= 0) break
        part.count++
        remain--
      }
      for (const part of parts) if (part.count > 0) result[part.uid].items.push({ ...item, count: part.count })
    } else {
      for (let i = 0; i < (item.count || 0); i++) normalItems.push({ ...item, count: 1 })
    }
  }
  const zero = members.filter(uid => result[uid].contrib <= 0)
  for (const uid of zero) {
    if (result[uid].items.length) continue
    const donor = members.map(x => result[x]).find(part => part.items.some(item => item.currency && item.count > 1))
    const money = donor && donor.items.find(item => item.currency && item.count > 1)
    if (money) {
      money.count--
      result[uid].items.push({ ...money, count: 1 })
    }
  }
  for (const uid of zero) if (!result[uid].items.length && normalItems.length) result[uid].items.push(normalItems.splice(0, 1)[0])
  const orderedMembers = members.slice().sort((a, b) => result[b].contrib - result[a].contrib || a.localeCompare(b))
  for (const [i, item] of normalItems.entries()) {
    const chosen = orderedMembers[i % Math.max(1, orderedMembers.length)]
    if (chosen) result[chosen].items.push(item)
  }
  return members.map(uid => result[uid])
}
function consumePool (team, item) { let remain = item.count || 1; const keep = []; for (const x of team.pool || []) { if (remain > 0 && x.name === item.name && JSON.stringify(x.attr || null) === JSON.stringify(item.attr || null)) { const n = Math.min(remain, x.count || 0); x.count -= n; remain -= n } if ((x.count || 0) > 0) keep.push(x) }; team.pool = keep }
function grantItem (gid, uid, item) { if (item.currency || item.name === '灵石') return addMoney(gid, uid, item.count); return addItem(uid, item.name, item.count || 1, item.attr || null, gid) }
function grantFakeItem (f, p, item) {
  if (item.currency || item.name === '灵石') { p.money = (Number(p.money) || 0) + (item.count || 0); return }
  if (!p.bag) p.bag = { items: {}, equipped: {} }
  p.bag.items = p.bag.items || {}
  const old = p.bag.items[item.name]
  if (old && typeof old === 'object') old.count = (Number(old.count) || 0) + (item.count || 1)
  else p.bag.items[item.name] = (Number(old) || 0) + (item.count || 1)
}
export async function settleMember (team, uid, gid) { const plan = planSplit(team); const p = plan.find(x => String(x.uid) === String(uid)); if (!p) return []; const msgs = []; for (const item of p.items) { consumePool(team, item); await grantItem(gid, uid, item); msgs.push(`${itemIcon(item.name)}${item.name}×${item.count || 1}`) }; return msgs }
export async function settleTeamNow (st, team, gid) {
  const plan = planSplit(team); const msgs = []
  if (team.kind === 'player') {
    for (const p of plan) {
      for (const item of p.items) await grantItem(gid, p.uid, item)
      msgs.push(`${p.uid}：${p.items.length ? fmtRewards(p.items) : '暂无收获'}`)
    }
  } else {
    try {
      const f = getFake(gid)
      for (const part of plan) {
        const person = f.roster && f.roster[part.uid]
        if (!person) continue
        for (const item of part.items) grantFakeItem(f, person, item)
        msgs.push(`${part.uid}：${part.items.length ? fmtRewards(part.items) : '暂无收获'}`)
      }
      saveFake(f, gid)
    } catch (err) { }
  }
  team.pool = []
  return { msgs, totalItems: plan.reduce((s, p) => s + p.items.length, 0) }
}
export function scheduleNext (st, now, cfg) { const first = cfg.first_spawn_hours || [3, 18]; const next = cfg.next_spawn_hours || [2, 12]; if (now - st.cycleStart >= (cfg.cycle_hours || 24) * 3600000 || st.spawnCount >= (cfg.spawn_per_cycle || 3)) { st.cycleStart = now; st.spawnCount = 0; st.nextSpawn = now + randRange(first) * 3600000 } else { st.spawnCount++; st.nextSpawn = now + randRange(next) * 3600000 }; return st.nextSpawn }
/* ---------- 出口围剿(公开秘境探索最后5分钟): 全队表态 → 围剿方随机混战 / 溜走方择机突围 ---------- */
/** 进入围剿: 广播由调用方发; 返回待推送表态菜单的玩家队列表(伪玩家队按性格立即表态) */
export function beginAmbush (st, gid, now) {
  st.ambushAt = now
  st.ambushRound = 0
  st.ambushChoiceEnd = now + 45000 // 表态宽限期: 45秒内回复菜单, 之后未表态才代选(时间压缩)
  const pending = []
  for (const t of Object.values(st.teams)) {
    if (t.dead || !t.members.length || t.entered === false) continue
    /* 撤退阶段不再推进探索节点 */
    if (t.node) {
      const targetId = t.node.data && t.node.data.target
      if (targetId && st.teams[targetId] && st.teams[targetId].engagedBy === t.id) delete st.teams[targetId].engagedBy
    }
    t.node = null; t.pendingDisposal = null
    if (t.kind === 'fake') { t.ambush = fakeAmbushChoice(st, t); continue }
    t.ambush = null
    t.ambushNode = { type: 'ambush', title: '⚔️ 出口围剿', text: '秘境即将关闭，各方涌向出口！你的队伍要？', choices: [{ n: 1, label: '参与围剿混战（伏击抢夺）' }, { n: 2, label: '悄悄溜走（可能被抓）' }] }
    pending.push({ team: t, node: t.ambushNode })
  }
  return pending
}
/** 伪玩家队按性格自动表态: 好斗/嗜杀/魔道/贪玩 → 围剿; 平和/善良/懒散 → 溜走 */
function fakeAmbushChoice (st, team) {
  try {
    const persons = currentFakePersons(String(st.gid || ''), team)
    const p = persons.find(x => x.name === team.leader) || persons[0]
    if (!p) return 'flee'
    if (p.path === '魔道' || p.trait === '嗜杀' || p.trait === '好斗' || p.act === '贪玩') return 'fight'
    if (p.trait === '平和' || p.trait === '善良' || p.act === '懒散') return 'flee'
    return 'fight'
  } catch (err) { return 'fight' }
}
/** 玩家超时未表态代选: 战力 ≥ 全场其它队均值 → 围剿, 否则溜走 */
async function autoPlayerAmbush (st, gid, team) {
  const my = await ambushPower(gid, team)
  let sum = 0; let cnt = 0
  for (const o of Object.values(st.teams)) {
    if (o === team || o.dead || !o.members.length) continue
    sum += await ambushPower(gid, o); cnt++
  }
  return my >= (cnt ? sum / cnt : 0) ? 'fight' : 'flee'
}
/** 队伍当前战力: 玩家=成员战力×powerBoost(受伤递减), 伪玩家=成员战力×(1-受伤) */
async function ambushPower (gid, team) {
  if (team.kind === 'fake') {
    const persons = currentFakePersons(gid, team)
    return Math.max(1, Math.round(persons.reduce((s, p) => s + personPower(p), 0) * Math.max(0.2, 1 - (team.injured || 0) * 0.12)))
  }
  const profiles = await teamProfiles(gid, team)
  return Math.max(1, Math.round(profiles.reduce((s, p) => s + (Number(p.power) || 0), 0) * (team.powerBoost || 1)))
}
/** 按比例从队伍池子取(队伍级抢夺, 与个人贡献无关) */
function takePoolShare (team, rate) {
  const items = []; let money = 0; const kept = []
  for (const item of team.pool || []) {
    /* 与 extractPoolShare 一致: 单个不可拆分物品也向上取整整件搜走, 否则搜刮只剩灵石 */
    const n = Math.min(item.count || 0, Math.max(0, Math.ceil((item.count || 0) * rate)))
    if (n > 0) { const x = { ...item, count: n }; if (item.currency) money += n; else items.push(x) }
    const left = (item.count || 0) - n
    if (left > 0) kept.push({ ...item, count: left })
  }
  team.pool = kept
  return { items, money }
}
/** 把战利品均分给若干队伍, 返回描述文本 */
function shareLoot (teams, loot) {
  const list = (teams || []).filter(t => t && !t.dead && t.members.length)
  const n = list.length || 1
  const txt = []
  const addTo = (item, count) => {
    if (count <= 0) return
    const per = Math.floor(count / n); let remain = count
    for (const t of list) { if (per > 0) addPoolItem(t, { ...item, count: per }); remain -= per }
    if (remain > 0 && list.length) addPoolItem(list[0], { ...item, count: remain })
  }
  for (const item of loot.items) addTo(item, item.count)
  const rewardText = fmtRewards(loot.items)
  if (rewardText) txt.push(rewardText)
  if (loot.money) { addTo({ name: '灵石', currency: true, quality: 1 }, loot.money); txt.push(`${itemIcon('灵石')}灵石×${loot.money}`) }
  return txt
}
/** 队伍离场: 释放他人遭遇引用, 删除队伍, 伪玩家成员回世界 */
function removeAmbushTeam (st, gid, team) {
  for (const o of Object.values(st.teams || {})) {
    const tid = o.node && o.node.data && o.node.data.target
    if (tid === team.id) releaseNodeTarget(st, o, o.node)
  }
  delete st.teams[team.id]
  if (team.kind === 'fake') {
    try {
      const f = getFake(gid); let changed = false
      for (const name of team.members || []) {
        const p = f.roster && f.roster[name]
        if (p && p.realmBusy && p.realmBusy.realmId === st.realmId) { delete p.realmBusy; changed = true }
      }
      if (changed) saveFake(f, gid)
    } catch (err) { }
  }
}
/** 随机两两配对混战一轮: 胜者抢败者30%池子; 玩家不战死只受伤, 伪玩家低概率战死否则受伤 */
async function meleeFight (st, gid, a, b) {
  const pa = await ambushPower(gid, a); const pb = await ambushPower(gid, b)
  const winRate = guardWinRate(pa, pb)
  const win = Math.random() * 100 < winRate
  const winner = win ? a : b; const loser = win ? b : a
  const msgs = [`⚔️ ${a.name} vs ${b.name}（战力 ${pa} vs ${pb}，胜率 ${winRate}%）→ ${winner.name} 胜出`]
  const loot = takePoolShare(loser, AMBUSH_TAKE)
  const got = []
  for (const item of loot.items) { addPoolItem(winner, item); got.push(item) }
  if (loot.money) { addPoolItem(winner, { name: '灵石', count: loot.money, currency: true, quality: 1 }); got.push({ name: '灵石', count: loot.money, currency: true, quality: 1 }) }
  if (got.length) msgs.push(`🏆 ${winner.name} 抢到：${fmtRewards(got)}`)
  if (loser.kind === 'fake') {
    const persons = currentFakePersons(gid, loser)
    const victim = persons[Math.floor(Math.random() * persons.length)]
    if (victim && Math.random() < 0.08) {
      const killed = killFakePerson(gid, st, loser, victim.name, winner)
      msgs.push(`☠️ ${victim.name} 战死沙场，身死道消${killed.level ? `（${killed.level}阶）` : ''}！`)
      if (!currentFakePersons(gid, loser).length) { loser.dead = true; msgs.push(`💀 ${loser.name} 全灭，退出混战`) }
    } else {
      loser.injured = (loser.injured || 0) + 1
      msgs.push(`💥 ${loser.name} 受创，战力-${Math.round((1 - Math.max(0.2, 1 - loser.injured * 0.12)) * 100)}%`)
    }
  } else {
    loser.powerBoost = Math.max(0.3, (loser.powerBoost || 1) - 0.12)
    loser.injured = (loser.injured || 0) + 1
    msgs.push(`💥 ${loser.name} 全队受创，本场战力-12%`)
  }
  return { msgs }
}
/** 混战一轮: 参与围剿的队随机两两遭遇 */
async function meleeRound (st, gid, now) {
  st.ambushRound = (st.ambushRound || 0) + 1
  const msgs = [`⚔️ 出口围剿·第 ${st.ambushRound} 轮混战`]
  const fighters = Object.values(st.teams).filter(t => t.ambush === 'fight' && !t.dead && t.members.length)
  const order = shuffle(fighters.slice())
  for (let i = 0; i + 1 < order.length; i += 2) {
    const r = await meleeFight(st, gid, order[i], order[i + 1])
    msgs.push(...r.msgs)
  }
  if (order.length % 2) msgs.push(`🌀 ${order[order.length - 1].name} 本轮无人遭遇，暂时观望`)
  if (!fighters.length) msgs.push('🌫️ 出口已无围剿者')
  return msgs
}
/** 溜走队择机突围: 对当前留守总战力判定(留守被打残后更容易溜), 成功带走战果离场, 失败被搜刮30%遣返 */
async function tryFleeRound (st, gid, now) {
  const msgs = []
  const fighters = Object.values(st.teams).filter(t => t.ambush === 'fight' && !t.dead && t.members.length)
  let guardPower = 0
  for (const f of fighters) guardPower += await ambushPower(gid, f)
  const fleers = Object.values(st.teams).filter(t => t.ambush === 'flee' && !t.dead && t.members.length)
  for (const t of fleers) {
    const my = await ambushPower(gid, t)
    const winRate = guardWinRate(my, guardPower)
    if (Math.random() * 100 < winRate) {
      const got = await settleTeamNow(st, t, gid)
      msgs.push(`🕊️ 【${t.name}】趁乱悄悄溜走，带走战果提前离场${got.msgs.length ? `（${got.msgs.join('、')}）` : ''}！`)
      removeAmbushTeam(st, gid, t)
    } else {
      const loot = takePoolShare(t, AMBUSH_TAKE)
      const gotTxt = shareLoot(fighters, loot)
      await settleTeamNow(st, t, gid)
      msgs.push(`🚨 【${t.name}】溜走时被围剿方拦截！被搜刮30%${gotTxt.length ? `（${gotTxt.join('、')}）` : ''}，带剩余战果遣返离场`)
      removeAmbushTeam(st, gid, t)
    }
  }
  return msgs
}
/** 围剿阶段每分钟推进: 未表态代选 → 混战一轮 → 溜走择机 */
export async function processAmbushRound (st, gid, now) {
  const msgs = []
  const choiceEnd = st.ambushChoiceEnd || now
  for (const t of Object.values(st.teams)) {
    if (t.kind !== 'player' || t.dead || !t.members.length || t.ambush || !t.ambushNode) continue
    if (now < choiceEnd) continue // 表态宽限期内不代选
    t.ambush = await autoPlayerAmbush(st, gid, t)
    t.ambushNode = null
    msgs.push(`⏳ 【${t.name}】超时未表态，自动选择${t.ambush === 'fight' ? '参与围剿混战' : '悄悄溜走'}`)
  }
  msgs.push(...await meleeRound(st, gid, now))
  msgs.push(...await tryFleeRound(st, gid, now))
  return msgs
}

export async function settleAll (st, gid, cfg = DEF_CFG) {
  const msgs = ['🏁 秘境关闭，开始结算……']
  let top = null; let score = 0
  for (const t of Object.values(st.teams)) {
    if (t.dead) continue
    if (t.kind === 'player') syncPlayerTeam(st, gid, t)
    const r = await settleTeamNow(st, t, gid)
    if (r.msgs.length) msgs.push(`【${t.name}】${r.msgs.join('；')}`)
    const s = Object.values(t.victory || {}).reduce((a, b) => a + (Number(b) || 0), 0)
    if (t.kind === 'player' && s > score) { score = s; top = t }
  }
  if (top && score > 0) { const r = rollRewardList(st, st.diff, Math.random, cfg); for (const item of r) await grantItem(gid, top.leader, item); msgs.push(`🌟 榜首【${top.name}】（胜利分${score}）额外获得${fmtRewards(r)}。`) }
  clearFakesBusy(gid, st)
  const wasPrivate = !!st.private
  const privateId = st.privateId || 'legacy'
  const cycleStart = st.cycleStart; const spawnCount = st.spawnCount
  const nextSt = emptyRealm(); Object.assign(st, nextSt, { gid: String(gid), cycleStart, spawnCount, phase: 'idle' })
  if (wasPrivate) { try { fs.rmSync(privateRealmFile(gid, privateId), { force: true }) } catch (err) { } }
  else { scheduleNext(st, Date.now(), cfg); saveRealmState(st, gid) }
  return { msgs }
}

/* ---------- 辅助/测试 ---------- */
export function _testEmptyRealm () { return emptyRealm() }
export const _test = { randRange, pick, buildNode, planSplit, emptyRealm, disposalPlan, normalizeDisposalIndex, fakeDisposalIndex, extractPoolShare, inventoryLootLimit, moneyLootAmount, actionDelay, firstWaveAt }
