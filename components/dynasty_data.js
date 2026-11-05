import { withGameLock } from './game_lock.js'
/* ============================================================
 * 简月王朝(凡人王朝) - 数据与核心逻辑
 * 特殊大区: 不可占领/攻打; 9 座凡间城(含皇城)只产云裳仙蕊
 * 人口: 初始20(皇城50), 每小时复利+5%(存小数/展示取整); 产出与人口无关
 * 产出: 普通城5%/皇城10% 每小时产1朵云裳仙蕊
 *   → 50% 按宗门好感加权送入一宗门宝库 / 50% 入城库存(#屠城自动洗劫库存)
 * 屠城: 需身在简月王朝 + 装备万魂幡 + 已学会血炼大阵 + 布置材料
 *   读阵30分钟, 每分钟消耗1万灵石; 灵石不足即自动停止并销毁大阵, 需重新布置
 *   读完=收魂(1人1魂)+业力(1人1点)+自动清空库存+屠城者宗门好感-30+城进6~88h废墟
 * 阻止: 他人读阵中, 身在王朝且有宗门者可 #阻止屠城 → 读阵失败, 阻止者所属宗门该城好感+10
 * ============================================================ */
import fs from 'fs'
import { Plugin_Name, Save_Path } from './plugin.js'
import { getWorld, getLoc, setLoc, getSeal } from './world_data.js'
import xujing_data from './xujing_data.js'
import { getBag, consumeBagItem, addItem, saveBag, itemIcon } from './equip_data.js'
import Wanhun from './wanhun_data.js'
import { getFake, saveFake, getNick, logPlayerEvent, sectName, withFakeLock } from './fake_data.js'
import { rollRealmSpecialReward } from './realm_data.js'

/* ---------- 常量(可在组件顶部调整) ---------- */
export const DYN_KEY = 'dynasty'
export const DYN_NAME = '简月王朝'
export const SOUTH_KEY = 'south' // 简月王朝在南疆以南, 须先身处南疆才能进入
export const MAP_ITEM = '简月舆图' // 一次性, 使用后永久解锁进入王朝(遗蜕秘境特殊彩奖励可获得)
export const BP_ITEM = '血炼阵图' // 学会后永久掌握血炼大阵(遗蜕秘境特殊彩奖励可获得)
export const FORMATION = '血炼大阵'

export const GROWTH = 0.05 // 每小时人口复利 +5%
export const GIFT_CHANCE = 0.5 // 产出后 50% 按宗门好感送入宗门宝库, 否则入库存
export const FAVOR_BLOCK = 10 // 阻止屠城 好感 +10
export const FAVOR_SIEGE = -30 // 屠城成功 好感 -30
export const FAVOR_FLOOR = 0 // 好感下限
export const READ_MIN = 30 // 读阵时长(分钟)
export const READ_COST_PER_MIN = 10000 // 血炼大阵启动中每分钟消耗1万灵石(屠城者个人灵石)
export const READ_COST_INTERVAL = 60 * 1000
export const RECOVER_MIN_H = 6 // 屠城废墟恢复最短(小时)
export const RECOVER_MAX_H = 88 // 屠城废墟恢复最长(小时)
export const DEPLOY_MATS = {
  无主幽魂: 1,
  阴魂砂: 20,
  游魂骨: 20,
  鬼火草: 5,
  幽冥木: 5,
  摄魂铁: 5,
  万魂帝晶: 1,
  万阵核心: 1
} // 布置血炼大阵消耗

/** 9 座凡间城(含皇城): 皇城产出概率10%, 普通城5%; 初始人口普通城20/皇城50 */
export const CITIES = [
  { name: '简月皇城', capital: true, initPop: 50, chance: 0.1 },
  { name: '平川城', initPop: 20, chance: 0.05 },
  { name: '永宁城', initPop: 20, chance: 0.05 },
  { name: '长乐城', initPop: 20, chance: 0.05 },
  { name: '定边城', initPop: 20, chance: 0.05 },
  { name: '临河城', initPop: 20, chance: 0.05 },
  { name: '安西城', initPop: 20, chance: 0.05 },
  { name: '南平城', initPop: 20, chance: 0.05 },
  { name: '北原城', initPop: 20, chance: 0.05 }
]
export const CITY_NAMES = CITIES.map(c => c.name)
const HOUR_MS = 3600000
const DYNASTY_DATA_VERSION = 2

/* ---------- 存档读写(每群独立: dynasty_{gid}.json) ---------- */
const SAVE_DIR = `${Save_Path}/dynasty`
function fileOf (gid) { return `${SAVE_DIR}/dynasty_${String(gid || 'global')}.json` }
function ensureDir () {
  if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true })
}

/** 所有活跃群(已有王朝存档) */
export function activeDynastyGroups () {
  try {
    if (!fs.existsSync(SAVE_DIR)) return []
    return fs.readdirSync(SAVE_DIR)
      .filter(n => /^dynasty_\d+\.json$/.test(n))
      .map(n => n.replace(/^dynasty_|\.json$/g, ''))
  } catch (err) { return [] }
}

function emptyCity (def, now) {
  return { pop: def.initPop, stock: 0, favor: {}, nextTick: now + HOUR_MS, read: null, recoverAt: 0 }
}
function emptyState (gid) {
  const now = Date.now()
  const cities = {}
  for (const c of CITIES) cities[c.name] = emptyCity(c, now)
  return { gid: String(gid || ''), version: DYNASTY_DATA_VERSION, unlocked: {}, learned: {}, cities, recentProd: [] }
}

/** 读取王朝数据(不存在则初始化; gid=群号, 每群独立) */
export function getDynasty (gid) {
  ensureDir()
  const g = String(gid || '')
  const file = fileOf(g)
  let d = null
  let dirty = false
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) { d = null }
  if (!d || typeof d !== 'object') { d = emptyState(g); dirty = true }
  d.gid = g
  if (Number(d.version) < DYNASTY_DATA_VERSION) {
    /* 旧版普通城初始5、皇城初始20; 仅迁移仍处于旧初始值的未屠城城池，
       已增长/已废墟/有库存的状态不覆盖，避免破坏玩家现有进度。 */
    for (const c of CITIES) {
      const city = d.cities && d.cities[c.name]
      const oldInit = c.capital ? 20 : 5
      if (city && !city.recoverAt && !city.read && Number(city.pop) === oldInit) {
        city.pop = c.initPop
        dirty = true
      }
    }
    d.version = DYNASTY_DATA_VERSION
    dirty = true
  }
  if (!d.unlocked || typeof d.unlocked !== 'object') { d.unlocked = {}; dirty = true }
  if (!d.learned || typeof d.learned !== 'object') { d.learned = {}; dirty = true }
  if (!d.cities || typeof d.cities !== 'object') { d.cities = {}; dirty = true }
  if (!d.recentProd || !Array.isArray(d.recentProd)) { d.recentProd = []; dirty = true }
  const now = Date.now()
  for (const c of CITIES) {
    if (!d.cities[c.name]) { d.cities[c.name] = emptyCity(c, now); dirty = true } else {
      const city = d.cities[c.name]
      if (city.pop === undefined) { city.pop = c.initPop; dirty = true }
      if (city.stock === undefined) { city.stock = 0; dirty = true }
      if (!city.favor || typeof city.favor !== 'object') { city.favor = {}; dirty = true }
      if (city.read === undefined) { city.read = null; dirty = true }
      if (city.read && (typeof city.read !== 'object' || !city.read.uid || !Number(city.read.end))) {
        city.read = null
        dirty = true
      }
      if (city.read && typeof city.read === 'object' && !city.read.nextCostAt) {
        const startedAt = Number(city.read.startedAt) || Math.max(0, Number(city.read.end) - READ_MIN * 60000)
        city.read.nextCostAt = startedAt + READ_COST_INTERVAL
        dirty = true
      }
      if (city.read && typeof city.read === 'object' && !city.read.startedAt) {
        city.read.startedAt = Math.max(0, Number(city.read.end) - READ_MIN * 60000)
        dirty = true
      }
      if (city.recoverAt === undefined) { city.recoverAt = 0; dirty = true }
      if (!city.nextTick) { city.nextTick = now + HOUR_MS; dirty = true }
    }
  }
  const known = new Set(CITY_NAMES)
  for (const name of Object.keys(d.cities)) if (!known.has(name)) { delete d.cities[name]; dirty = true }
  /* 重同步读阵锁缓存(进程重启后首次访问即恢复拦截) */
  syncReadCache(d)
  if (dirty || !fs.existsSync(file)) saveDynasty(d)
  return d
}

export function saveDynasty (d) {
  ensureDir()
  const file = fileOf(d.gid)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(d, null, '\t'))
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (e) { }
    globalThis.logger?.error?.('[简月王朝]保存失败:', err && err.message)
    return false
  }
}

/* ---------- 读阵锁内存缓存(供 api.js 读阵拦截) ---------- */
const activeReads = new Map() // key=`gid:uid` → { city, end }
const readKey = (gid, uid) => `${String(gid)}:${String(uid)}`

function withDynastyLock (gid, fn) { return withGameLock(gid, fn) }

function trackRead (gid, city, read) { activeReads.set(readKey(gid, read.uid), { city, end: read.end }) }
function untrackRead (gid, uid) { activeReads.delete(readKey(gid, uid)) }
function syncReadCache (d) {
  try {
    const prefix = `${d.gid}:`
    for (const key of activeReads.keys()) if (key.startsWith(prefix)) activeReads.delete(key)
    for (const name of CITY_NAMES) {
      const r = d.cities && d.cities[name] && d.cities[name].read
      if (r && r.uid && r.end && r.end > Date.now()) activeReads.set(readKey(d.gid, r.uid), { city: name, end: r.end })
    }
  } catch (err) { }
}

/** 查询某玩家是否在读阵(返回 { city, end } 或 null); 进程重启后按存档懒恢复 */
export function dynastyReadActive (gid, uid) {
  const key = readKey(String(gid), String(uid))
  const hit = activeReads.get(key)
  if (hit) {
    if (Number(hit.end) > Date.now()) return hit
    activeReads.delete(key)
  }
  try {
    const d = getDynasty(gid)
    for (const name of CITY_NAMES) {
      const read = d.cities && d.cities[name] && d.cities[name].read
      if (read && String(read.uid) === String(uid) && Number(read.end) > Date.now()) {
        const current = { city: name, end: read.end }
        activeReads.set(key, current)
        return current
      }
    }
  } catch (err) { }
  return null
}

/* ---------- 工具 ---------- */
function isUnlocked (d, uid) { return !!d.unlocked[String(uid)] }
function hasLearned (d, uid) { return !!d.learned[String(uid)] }
function inDynasty (gid, uid) { return getLoc(getWorld(gid), uid) === DYN_KEY }
function cityOf (d, name) { return (d.cities && d.cities[name]) || null }
/** 玩家所属宗门信息; 散修/无宗门返回 null */
function playerSectOf (gid, uid) {
  try {
    const f = getFake(gid)
    const p = f.players && f.players[String(uid)]
    if (!p || !p.sect || !f.sects || !f.sects[p.sect] || f.sects[p.sect].wipeAt) return null
    return { f, id: p.sect, name: sectName(f, p.sect), vault: ensureSectVault(f.sects[p.sect]) }
  } catch (err) { return null }
}
function ensureSectVault (sect) {
  if (!sect.vault) sect.vault = { stones: 0, mats: {}, pills: {}, equips: {}, gongfas: {} }
  if (!sect.vault.mats) sect.vault.mats = {}
  if (!sect.vault.pills) sect.vault.pills = {}
  if (!sect.vault.equips) sect.vault.equips = {}
  if (!sect.vault.gongfas) sect.vault.gongfas = {}
  return sect.vault
}
function addSectFavor (city, sid, amount) {
  if (!sid) return 0
  city.favor[String(sid)] = Math.max(FAVOR_FLOOR, (Number(city.favor[String(sid)]) || 0) + amount)
  return city.favor[String(sid)]
}
function matchCity (name) {
  if (!name) return null
  const n = String(name).trim()
  if (!n) return null
  const exact = CITY_NAMES.find(c => c === n)
  if (exact) return exact
  const cap = CITIES.find(c => c.capital)
  if (cap && (n === '皇城' || n.includes('皇城') || n.includes(cap.name))) return cap.name
  return CITY_NAMES.find(c => n.includes(c)) || null
}
async function nickOf (gid, uid) {
  try { const n = await getNick(gid, uid); return n || String(uid) } catch (err) { return String(uid) }
}
function notify (gid, text) {
  try {
    const g = globalThis.Bot && Bot.pickGroup(gid)
    if (g && g.sendMsg) g.sendMsg(text)
  } catch (err) { }
}
function notifyAt (gid, uid, text) {
  try {
    const g = globalThis.Bot && Bot.pickGroup(gid)
    if (g && g.sendMsg) {
      const at = globalThis.segment && segment.at(typeof uid === 'string' ? Number(uid) : uid)
      g.sendMsg(at ? [at, `\n${text}`] : text)
    }
  } catch (err) { }
}
/** 扣除读阵费用: 按实际逾期分钟补扣, 不足一整分钟费用则停止读阵；最多结算到读阵结束时刻 */
async function chargeReadCost (gid, read, now) {
  const next = Number(read.nextCostAt) || (now + READ_COST_INTERVAL)
  const end = Number(read.end) || now
  const billingUntil = Math.min(now, end)
  if (billingUntil < next) return { ok: true, charged: 0, due: 0 }
  const due = Math.max(1, Math.floor((billingUntil - next) / READ_COST_INTERVAL) + 1)
  try {
    const filename = `${String(gid)}.json`
    const home = await xujing_data.getQQYUserHome(read.uid, null, filename, false)
    const money = Math.max(0, Number(home[read.uid]?.money) || 0)
    const affordable = Math.floor(money / READ_COST_PER_MIN)
    const charged = Math.min(due, affordable)
    if (charged > 0) {
      home[read.uid].money = money - charged * READ_COST_PER_MIN
      await xujing_data.getQQYUserHome(read.uid, home, filename, true)
      read.nextCostAt = next + charged * READ_COST_INTERVAL
      read.charged = (Number(read.charged) || 0) + charged
    }
    return { ok: charged >= due, charged, due, insufficient: charged < due }
  } catch (err) {
    /* 存档暂时不可读时不误毁阵, 留待下一分钟重试 */
    globalThis.logger?.error?.('[简月王朝]读阵扣费失败:', err && err.message)
    return { ok: true, charged: 0, due, error: true }
  }
}
async function abortReadForNoMoney (gid, d, c, read, charged) {
  const city = d.cities[c.name]
  const uid = String(read.uid)
  city.read = null
  untrackRead(gid, uid)
  saveDynasty(d)
  const nick = await nickOf(gid, uid)
  const paid = charged > 0 ? `已扣除 ${charged * READ_COST_PER_MIN} 灵石` : '本次未扣到灵石'
  const text = `⚠️【${c.name}】的【${FORMATION}】灵石供给不足，读阵自动停止，大阵已销毁（${paid}）。需要重新布置才能再次屠城。`
  logPlayerEvent(gid, `【屠城失败】散修 ${nick} 在【${c.name}】读阵时灵石不足，${FORMATION}被毁`)
  notifyAt(gid, uid, text)
  notify(gid, `⚠️ ${nick} 在【${c.name}】读阵时灵石不足，【${FORMATION}】已自动停止并销毁；屠城未完成。`)
}
function pushProd (d, city, n, to, t) {
  if (!d.recentProd) d.recentProd = []
  d.recentProd.push({ t, city, n, to })
  if (d.recentProd.length > 60) d.recentProd = d.recentProd.slice(-60)
}
function fmtMats () {
  return Object.entries(DEPLOY_MATS).map(([m, c]) => `${itemIcon(m)}${m}×${c}`).join('、')
}
function fmtTime (t) {
  const d = new Date(t)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ---------- 进入/离开 ---------- */
/** 进入简月王朝: 需先身处南疆(王朝在南疆以南); 未解锁则消耗【简月舆图】×1 永久解锁 */
export function enterDynasty (uid, gid) {
  const w = getWorld(gid)
  const cur = getLoc(w, uid)
  if (cur === DYN_KEY) return { ok: false, msg: '你已在【简月王朝】中~' }
  if (cur !== SOUTH_KEY) return { ok: false, msg: '【简月王朝】在南疆以南，须先 #去南疆 再越过界碑进入~' }
  const seal = getSeal(w)
  if (seal && seal.region === SOUTH_KEY && Number(seal.until) > Date.now() && String(seal.owner) !== String(uid)) {
    return { ok: false, msg: '🌊 南疆已被镇海珠封锁，无法越过界碑进入简月王朝。' }
  }
  const d = getDynasty(gid)
  if (!isUnlocked(d, uid)) {
    const bag = getBag(uid, gid)
    if (!consumeBagItem(bag, MAP_ITEM, 1)) {
      return { ok: false, msg: `进入简月王朝需要${itemIcon(MAP_ITEM)}【${MAP_ITEM}】（使用一次后永久解锁，可于遗蜕秘境特殊彩奖励获得）~` }
    }
    saveBag(uid, bag, gid)
    d.unlocked[String(uid)] = true
    saveDynasty(d)
  }
  setLoc(w, uid, DYN_KEY)
  return { ok: true, msg: `🗺️ 你展开${itemIcon(MAP_ITEM)}【${MAP_ITEM}】，从南疆越过界碑，踏入凡人王朝【简月王朝】！这里没有灵力，只有凡人的烟火与城郭。` }
}
/** 离开简月王朝: 回到南疆(来处) */
export function leaveDynasty (uid, gid) {
  const w = getWorld(gid)
  if (getLoc(w, uid) !== DYN_KEY) return { ok: false, msg: '你并不在简月王朝中~' }
  const seal = getSeal(w)
  if (seal && seal.region === SOUTH_KEY && Number(seal.until) > Date.now() && String(seal.owner) !== String(uid)) {
    return { ok: false, msg: '🌊 南疆已被镇海珠封锁，无法返回南疆。' }
  }
  setLoc(w, uid, SOUTH_KEY)
  return { ok: true, msg: '🚪 你转身离开简月王朝，回到【南疆】。' }
}

/** 学会血炼大阵: 消耗【血炼阵图】×1 永久掌握 */
export function learnFormation (uid, gid) {
  const d = getDynasty(gid)
  if (hasLearned(d, uid)) return { ok: false, msg: `你已学会【${FORMATION}】，无需再学~` }
  const bag = getBag(uid, gid)
  if (!consumeBagItem(bag, BP_ITEM, 1)) {
    return { ok: false, msg: `学会【${FORMATION}】需要${itemIcon(BP_ITEM)}【${BP_ITEM}】（可于遗蜕秘境特殊彩奖励获得）~` }
  }
  saveBag(uid, bag, gid)
  d.learned[String(uid)] = true
  saveDynasty(d)
  return { ok: true, msg: `📜 你研读${itemIcon(BP_ITEM)}【${BP_ITEM}】，习得【${FORMATION}】！布置一次需消耗 ${fmtMats()}，读阵中每分钟另耗${READ_COST_PER_MIN}灵石。` }
}

/* ---------- 屠城 ---------- */
/** 布置血炼大阵开始读阵(30分钟): 校验+扣材料+设 read */
async function startSlaughterLocked (uid, gid, cityName) {
  if (!inDynasty(gid, uid)) return { ok: false, msg: '只有身在【简月王朝】才能布置血炼大阵屠城，先 #进入王朝 吧~' }
  const d = getDynasty(gid)
  const name = matchCity(cityName)
  if (!name) return { ok: false, msg: `没找到这座城（#王朝小区 查看城池）~` }
  const city = cityOf(d, name)
  const now = Date.now()
  if (city.read) return { ok: false, msg: `【${name}】已有人在读阵（可 #阻止屠城 ${name}）~` }
  if (city.recoverAt > now) return { ok: false, msg: `【${name}】正在废墟中恢复（剩约 ${Math.ceil((city.recoverAt - now) / HOUR_MS)} 小时），无法屠城~` }
  for (const c of CITIES) {
    const r = d.cities[c.name] && d.cities[c.name].read
    if (r && String(r.uid) === String(uid)) return { ok: false, msg: `你已在【${c.name}】读阵中，先 #取消屠城 再说~` }
  }
  const bag = getBag(uid, gid)
  const artifact = bag && bag.artifacts && bag.artifacts.wanhun
  if (!artifact || !artifact.equipped) return { ok: false, msg: '屠城需要装备【万魂幡】收魂，先 #装备万魂幡 ~' }
  if (!hasLearned(d, uid)) return { ok: false, msg: `你还没学会【${FORMATION}】，需要【${BP_ITEM}】#学习血炼阵~` }
  for (const [m, c] of Object.entries(DEPLOY_MATS)) {
    const have = Number((bag.items && bag.items[m] && bag.items[m].count) || 0)
    if (have < c) return { ok: false, msg: `布置【${FORMATION}】材料不足，需要 ${fmtMats()}（你缺${itemIcon(m)}${m}×${c - have}）~` }
  }
  for (const [m, c] of Object.entries(DEPLOY_MATS)) consumeBagItem(bag, m, c)
  saveBag(uid, bag, gid)
  city.read = { uid: String(uid), startedAt: now, end: now + READ_MIN * 60000, nextCostAt: now + READ_COST_INTERVAL, charged: 0 }
  trackRead(gid, name, city.read)
  saveDynasty(d)
  const nick = await nickOf(gid, uid)
  logPlayerEvent(gid, `【屠城】散修 ${nick} 在【${name}】布置【${FORMATION}】，30分钟后屠城！`)
  notify(gid, `🩸 ${nick} 在【${name}】布置【${FORMATION}】，开始读阵！\n30 分钟内他人可发 #阻止屠城 ${name} 阻止，读满即成。`)
  return { ok: true, msg: `🩸 你布下【${FORMATION}】，开始读阵攻打【${name}】！读阵中每分钟消耗${READ_COST_PER_MIN}灵石，余额不足会自动停止并销毁大阵。\n30 分钟内他人可发 #阻止屠城 ${name} 阻止；读满即成。` }
}

export function startSlaughter (uid, gid, cityName) {
  return withDynastyLock(gid, () => startSlaughterLocked(uid, gid, cityName))
}

/** 阻止屠城: 取消他人读阵, 阻止者所属宗门在该城好感+10 */
async function interruptSlaughterLocked (uid, gid, cityName) {
  if (!inDynasty(gid, uid)) return { ok: false, msg: '只有身在【简月王朝】才能阻止屠城~' }
  const blockerSect = playerSectOf(gid, uid)
  if (!blockerSect) return { ok: false, msg: '散修无宗门，无法代表宗门护城；请先加入宗门再阻止屠城~' }
  const d = getDynasty(gid)
  const name = matchCity(cityName)
  if (!name) {
    if (!cityName) {
      /* 无城名: 列出正在读阵的城 */
      const active = CITIES.filter(c => {
        const r = d.cities[c.name] && d.cities[c.name].read
        return r && String(r.uid) !== String(uid)
      })
      if (!active.length) return { ok: false, msg: '当前没有正在读阵的城（无人屠城）~' }
      return { ok: false, msg: `当前有人读阵：${active.map(c => `#阻止屠城 ${c.name}`).join('　')}` }
    }
    return { ok: false, msg: `没找到这座城（#王朝小区 查看城池）~` }
  }
  const city = cityOf(d, name)
  if (!city.read) return { ok: false, msg: `【${name}】当前无人读阵~` }
  if (String(city.read.uid) === String(uid)) return { ok: false, msg: '这是你自己的屠城，不能自己阻止~' }
  const reader = String(city.read.uid)
  untrackRead(gid, reader)
  city.read = null
  addSectFavor(city, blockerSect.id, FAVOR_BLOCK)
  saveDynasty(d)
  const nick = await nickOf(gid, uid)
  const rnick = await nickOf(gid, reader)
  logPlayerEvent(gid, `【护城】散修 ${nick} 代表【${blockerSect.name}】阻止了 ${rnick} 对【${name}】的屠城！`)
  notify(gid, `🛡️ ${nick} 代表【${blockerSect.name}】阻止了 ${rnick} 的屠城！【${name}】百姓感恩，该城对【${blockerSect.name}】好感 +${FAVOR_BLOCK}。`)
  return { ok: true, msg: `🛡️ 你代表【${blockerSect.name}】阻止了对【${name}】的屠城！该城对本宗好感 +${FAVOR_BLOCK}。` }
}

export function interruptSlaughter (uid, gid, cityName) {
  return withDynastyLock(gid, () => interruptSlaughterLocked(uid, gid, cityName))
}

/** 取消屠城(本人放弃, 不改变好感) */
function cancelSlaughterLocked (uid, gid, cityName) {
  const d = getDynasty(gid)
  const name = matchCity(cityName)
  let target = null
  if (name) {
    const city = cityOf(d, name)
    if (city && city.read && String(city.read.uid) === String(uid)) target = { name, city }
  } else {
    const mine = CITIES.find(c => {
      const r = d.cities[c.name] && d.cities[c.name].read
      return r && String(r.uid) === String(uid)
    })
    if (mine) target = { name: mine.name, city: d.cities[mine.name] }
  }
  if (!target) {
    return { ok: false, msg: name
      ? `【${name}】没有你的在读阵~`
      : '你没有在读阵中的城池（#屠城 城名 开始）~' }
  }
  untrackRead(gid, uid)
  target.city.read = null
  saveDynasty(d)
  return { ok: true, msg: `你收起了【${FORMATION}】，放弃屠城【${target.name}】（不改变好感）~` }
}

export function cancelSlaughter (uid, gid, cityName) {
  return withDynastyLock(gid, () => cancelSlaughterLocked(uid, gid, cityName))
}

/* ---------- 面板 ---------- */
/** #王朝小区: 城池/人口/库存/产出/状态 + 最近产出 */
export function cityPanel (uid, gid) {
  const d = getDynasty(gid)
  const mySect = playerSectOf(gid, uid)
  const now = Date.now()
  const lines = ['🏘️ 简月王朝 · 凡人王朝（不可占领/攻打）', '']
  for (const c of CITIES) {
    const city = cityOf(d, c.name)
    const capTxt = c.capital ? '（皇城）' : ''
    const popTxt = Math.floor(Number(city.pop) || 0)
    const fav = mySect ? Number((city.favor && city.favor[String(mySect.id)]) || 0) : 0
    const favTxt = mySect ? ` · 本宗好感 ${fav}` : ' · 散修无宗门好感'
    let st = '🏘️ 正常'
    if (city.read) {
      const left = Math.max(0, Math.ceil((city.read.end - now) / 60000))
      const paid = Number(city.read.charged) || 0
      st = `⏳ 读阵中（剩 ${left} 分钟 · 每分钟${READ_COST_PER_MIN}灵石 · 已扣${paid * READ_COST_PER_MIN}，可 #阻止屠城 ${c.name}）`
    } else if (city.recoverAt > now) {
      st = `💀 废墟（剩约 ${Math.ceil((city.recoverAt - now) / HOUR_MS)} 小时恢复）`
    }
    lines.push(`· ${c.name}${capTxt}：人口 ${popTxt} · 库存${itemIcon('云裳仙蕊')}云裳仙蕊 ${city.stock} · 产出${c.capital ? 10 : 5}%/时${favTxt}`)
    lines.push(`　${st}`)
  }
  lines.push('', '━━━ 最近产出 ━━━')
  const prods = (d.recentProd || []).slice(-8).reverse()
  if (!prods.length) lines.push('（暂无产出记录）')
  for (const p of prods) {
    const n = Number(p.n) || 0
    lines.push(`[${fmtTime(p.t)}] ${p.city}：${n >= 0 ? `${itemIcon('云裳仙蕊')}云裳仙蕊+${n}` : `${itemIcon('云裳仙蕊')}云裳仙蕊${n}`}（${p.to}）`)
  }
  const unlocked = isUnlocked(d, uid)
  const learned = hasLearned(d, uid)
  const inDyn = inDynasty(gid, uid)
  const tip = unlocked
    ? (inDyn ? '你在王朝中 · ' : '#进入王朝 踏入王朝 · ')
    : `需${itemIcon(MAP_ITEM)}【${MAP_ITEM}】解锁进入（遗蜕秘境特殊彩奖励可获得） · `
  lines.push('', `💡 ${tip}#屠城 城名 · #阻止屠城 城名 · #学习血炼阵${learned ? '（已学会）' : ''} · #虚境地图`)
  return { ok: true, text: lines.join('\n') }
}

/** #王朝好感: 某城宗门好感度明细 */
export async function favorPanel (uid, gid, cityName) {
  const d = getDynasty(gid)
  const f = getFake(gid)
  const mySect = playerSectOf(gid, uid)
  const name = matchCity(cityName)
  if (!name) return { ok: false, msg: `没找到这座城（#王朝小区 查看城池）~` }
  const city = cityOf(d, name)
  const favs = Object.entries(city.favor || {})
    .filter(([sid, v]) => Number(v) > 0 && f.sects && f.sects[sid] && !f.sects[sid].wipeAt)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
  const lines = [`🌙 【${name}】宗门好感度`]
  if (!favs.length) lines.push('（暂无宗门在此城有好感度）')
  else {
    for (const [sid, v] of favs.slice(0, 10)) lines.push(`· ${sectName(f, sid)}：${v}`)
    if (favs.length > 10) lines.push(`…共 ${favs.length} 个宗门`)
  }
  lines.push('', `本宗当前好感：${mySect ? Number((city.favor && city.favor[String(mySect.id)]) || 0) : '散修无宗门'}`)
  lines.push('', '💡 #阻止屠城 城名 提升本宗好感；本宗成员屠城成功掉好感；产出云裳仙蕊按宗门好感加权送入宗门宝库')
  return { ok: true, text: lines.join('\n') }
}

/* ---------- 产出/赠予 ---------- */
/** 好感加权抽一名宗门(权重=宗门好感值; 无好感宗门返回 null) */
function weightedFavorPick (favor, rand = Math.random) {
  const entries = Object.entries(favor || {}).filter(([, v]) => Number(v) > 0)
  if (!entries.length) return null
  const total = entries.reduce((s, [, v]) => s + Number(v), 0)
  let r = rand() * total
  for (const [u, v] of entries) {
    r -= Number(v)
    if (r <= 0) return u
  }
  return entries[entries.length - 1][0]
}

/** 单城单小时产出: 到概率 → 产1朵云裳仙蕊(50% 赠予宗门/否则入库存); rand 可注入便于测试 */
export async function hourlyProduce (gid, d, c, city, now = Date.now(), rand = Math.random) {
  if (rand() >= c.chance) return false
  if (rand() < GIFT_CHANCE) {
    const gifted = await withFakeLock(gid, async () => {
      const f = getFake(gid)
      const validFavor = Object.fromEntries(Object.entries(city.favor || {}).filter(([sid, v]) =>
        Number(v) > 0 && f.sects && f.sects[sid] && !f.sects[sid].wipeAt))
      const sid = weightedFavorPick(validFavor, rand)
      if (!sid) return false
      const vault = ensureSectVault(f.sects[sid])
      vault.mats['云裳仙蕊'] = (Number(vault.mats['云裳仙蕊']) || 0) + 1
      saveFake(f, gid)
      const sname = sectName(f, sid)
      pushProd(d, c.name, 1, `赠:${sname}宝库`, now)
      notify(gid, `🌙 【${c.name}】产出${itemIcon('云裳仙蕊')}云裳仙蕊，送入【${sname}】宗门宝库！`)
      return true
    })
    if (gifted) return true
  }
  city.stock = (Number(city.stock) || 0) + 1
  pushProd(d, c.name, 1, '入库存', now)
  return true
}

/* ---------- 屠城结算(读阵到点) ---------- */
async function completeSlaughter (gid, d, c, now, rand) {
  const city = d.cities[c.name]
  const read = city.read
  const uid = String(read.uid)
  const pop = Math.floor(Number(city.pop) || 0)
  const specialDrop = c.capital ? rollRealmSpecialReward('tian', rand) : null
  if (specialDrop) addItem(uid, specialDrop, 1, null, gid)
  const specialTxt = specialDrop ? `，额外获得${itemIcon(specialDrop)}${specialDrop}×1` : ''
  /* 收魂: 1人1魂(未装备万魂幡则没收) */
  const gained = Wanhun.captureSoul(uid, gid, 1, pop)
  const karma = await xujing_data.addPlayerKarma(gid, uid, pop)
  const karmaTxt = `，业力 +${pop}（当前${karma}）`
  const soulTxt = (gained && gained.gained > 0)
    ? `，万魂幡收魂 +${gained.gained}`
    : '，万魂幡未装备，未收到魂'
  /* 自动洗劫该城库存 */
  const plundered = Math.max(0, Math.floor(Number(city.stock) || 0))
  if (plundered > 0) addItem(uid, '云裳仙蕊', plundered, null, gid)
  city.stock = 0
  /* 屠城者所属宗门好感 -30(散修无宗门则不改宗门关系) */
  const killerSect = playerSectOf(gid, uid)
  let sectDropTxt = ''
  if (killerSect) {
    addSectFavor(city, killerSect.id, FAVOR_SIEGE)
    sectDropTxt = `，【${killerSect.name}】在此城好感 ${FAVOR_SIEGE}`
  }
  /* 进入 6~88h 随机废墟 */
  const rec = RECOVER_MIN_H + Math.floor(rand() * (RECOVER_MAX_H - RECOVER_MIN_H + 1))
  city.recoverAt = now + rec * HOUR_MS
  city.pop = 0
  city.read = null
  untrackRead(gid, uid)
  pushProd(d, c.name, -plundered, '屠城清空', now)
  const nick = await nickOf(gid, uid)
  logPlayerEvent(gid, `【屠城】散修 ${nick} 血洗【${c.name}】，收魂 ${pop} 缕，业力 +${pop}，劫走${itemIcon('云裳仙蕊')}云裳仙蕊 ${plundered} 朵！`)
  notify(gid, `🩸【${c.name}】被屠城！${nick} 收魂 ${pop} 缕${soulTxt}${karmaTxt}，劫走${itemIcon('云裳仙蕊')}云裳仙蕊 ${plundered} 朵${sectDropTxt}${specialTxt}。\n城池化为废墟，约 ${rec} 小时后恢复。`)
  return { specialDrop }
}

/* ---------- 每分钟推进(产出/人口/废墟恢复/读阵结算) ---------- */
export async function tickDynasty (gid, now = Date.now(), rand = Math.random) {
  return withDynastyLock(gid, () => tickDynastyLocked(gid, now, rand))
}

async function tickDynastyLocked (gid, now = Date.now(), rand = Math.random) {
  let d = null
  try { d = getDynasty(gid) } catch (err) { return }
  let changed = false
  for (const c of CITIES) {
    const city = d.cities[c.name]
    if (!city) continue
    /* 1. 读阵每分钟扣费; 到点先结清当分钟费用, 再判定屠城成功 */
    if (city.read) {
      const read = city.read
      const fee = await chargeReadCost(gid, read, now)
      if (fee.charged > 0) {
        /* 先把 nextCostAt 落盘，避免扣款后进程意外退出导致下一轮重复扣费 */
        saveDynasty(d)
        changed = true
      }
      if (!fee.ok) {
        await abortReadForNoMoney(gid, d, c, read, fee.charged)
        changed = true
        continue
      }
      if (now >= read.end) {
        await completeSlaughter(gid, d, c, now, rand)
        changed = true
        continue
      }
    }
    /* 2. 废墟中: 不产出不增长 */
    if (city.recoverAt > now) continue
    /* 3. 废墟恢复完成 → 重置人口 */
    if (city.recoverAt && city.recoverAt <= now) {
      city.pop = c.initPop
      city.recoverAt = 0
      city.nextTick = now + HOUR_MS
      changed = true
    }
    /* 4. 每小时: 人口复利增长 + 产出 */
    if (now >= city.nextTick) {
      city.pop = (Number(city.pop) || 0) * (1 + GROWTH)
      await hourlyProduce(gid, d, c, city, now, rand)
      city.nextTick = now + HOUR_MS
      changed = true
    }
  }
  if (changed) saveDynasty(d)
}
