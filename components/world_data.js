/* ============================================================
 * 修仙世界界域与宗门经济系统 - 数据与核心逻辑
 * 界域(中州/东海/西域/北境/南疆 等) × 若干小区(数量不固定, 可扩展)
 * 8 固定宗门永久占领小区; 大区全部小区被同一宗门占领 = 该区【一方霸主】
 * 税收按小区平分: 每个小区产生的税给占领该小区的宗门(占几小区拿几份)
 * 繁荣度(宗门单一共享值) 每30分钟结算: +税收/100 - 繁荣²/10000
 * 动态税率: 每区按区内占领宗门平均繁荣度算, 区与区繁荣差越大税率差越大(10%~50%)
 * ============================================================ */
import fs from 'fs'
import { saveOrDefer } from './deferred_save.js'
import { writeJsonAtomic } from './json_store.js'
import { recoverCorruptJson } from './save_backup.js'
import { Plugin_Name, Save_Path } from './plugin.js'
import xujing_data from './xujing_data.js'

const WORLD_DIR = `${Save_Path}/world`
const WORLD_FILE = `${WORLD_DIR}/world.json` // 旧全局档(仅首次迁移用)
const worldCache = new Map()

/** 每群独立存档: world_{gid}.json */
function worldFile (gid) { return `${WORLD_DIR}/world_${gid}.json` }
/** 所有活跃群(已有独立世界档) */
export function activeWorldGroups () {
  try {
    if (!fs.existsSync(WORLD_DIR)) return []
    return fs.readdirSync(WORLD_DIR)
      .filter(n => /^world_\d+\.json$/.test(n))
      .map(n => n.replace(/^world_|\.json$/g, ''))
  } catch (err) { return [] }
}

/* ---------- 常量 ---------- */
/** 五大大区(每区6个小区, 共30个, 小区仅供宗门占领, 玩家只在大区层活动) */
export const REGIONS = {
  center: { name: '中州', areas: ['天墉城', '白鹿原', '玄岳山', '龙阳城', '云梦泽', '中皇山'] },
  east: { name: '东海', areas: ['蓬莱岛', '方丈洲', '瀛洲屿', '海外仙境', '碧波湾', '鲛人礁'] },
  west: { name: '西域', areas: ['流沙海', '金蟾谷', '大漠孤城', '西部沙漠', '月牙泉', '风蚀台'] },
  north: { name: '北境', areas: ['冰渊', '雪龙岭', '极光台', '北部荒原', '寒星坡', '冰晶湖'] },
  south: { name: '南疆', areas: ['十万大山', '苗岭', '瘴云谷', '南海群岛', '明珠屿', '翡翠湾'] },
  /* 特殊大区: 凡人王朝(简月王朝). areas 为空数组 → 占领/税收/霸主/迁移等基于 areas 的逻辑自动跳过;
     其 9 座凡间城池由 dynasty_data 独立管理, 不进入 #天下小区/宗门占领/全区税率 面板 */
  dynasty: { name: '简月王朝', areas: [], special: true }
}
export const REGION_KEYS = Object.keys(REGIONS)

/** 8 个永久固定宗门 */
export const SECTS = ['万剑宗', '青云宗', '天机阁', '太虚门', '玄冥教', '紫霄殿', '丹霞谷', '御兽宗']

/** 大区全部小区被同一宗门占领时的称谓 */
export const BOSS_TITLE = '一方霸主'

/** 初始繁荣度 */
export const DEFAULT_PROSPERITY = 1000
/** 税收转化比例: 100灵石 = 1点繁荣 */
export const TAX_TO_PROSPER = 100
/** 繁荣度衰减分母: 衰减 = 繁荣² / 10000 */
export const DECAY_DIV = 10000
/** 结算周期(毫秒): 30分钟 */
export const SETTLE_INTERVAL = 30 * 60 * 1000
/** 强行跨越界壁: 成功率 / 耗时(分钟) */
export const FORCE_SUCCESS = 0.8
export const FORCE_MIN = 5
/** 强行跨越失败掉境界上限(0~3) */
export const FORCE_DROP_MAX = 3
/** 宗门传送阵费用(灵石) */
export const TELEPORT_COST = 2000
/** 玩家默认所在大区 */
export const DEFAULT_REGION = 'center'

/** 大区名 → key */
export function regionKeyOf (name) {
  const n = String(name || '').trim()
  for (const k of REGION_KEYS) if (REGIONS[k].name === n) return k
  return null
}
/** key → 大区名 */
export function regionNameOf (key) {
  return (REGIONS[key] && REGIONS[key].name) || key || '未知'
}

/* ---------- 世界数据读写 ---------- */
function emptyWorld () {
  return {
    sectMap: {},
    prosperity: {},
    pendingTax: {},
    rates: {},
    playerLoc: {},
    moving: {},
    lastSettle: 0,
    conquered: false // 天下大事攻打/宗门重建后=true: 不再强制重分配占领格局
  }
}
/** 一次性分配 30 小区给 8 宗门: 每宗 3~4 个(轮流), 格局永久固定 */
function allocateSects (w) {
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = arr[i]
      arr[i] = arr[j]
      arr[j] = t
    }
    return arr
  }
  const sects = shuffle([...SECTS])
  const allAreas = []
  for (const k of REGION_KEYS) for (const a of REGIONS[k].areas) allAreas.push(a)
  const areas = shuffle(allAreas)
  areas.forEach((a, i) => { w.sectMap[a] = sects[i % sects.length] })
}
function initWorld (gid) {
  const w = emptyWorld()
  w.gid = String(gid || '')
  allocateSects(w)
  for (const s of SECTS) {
    w.prosperity[s] = DEFAULT_PROSPERITY
    w.pendingTax[s] = 0
  }
  for (const k of REGION_KEYS) w.rates[k] = 25
  w.lastSettle = Date.now()
  saveWorld(w)
  return w
}
/** 读取世界数据(不存在则初始化; gid=群号, 每群独立; 空gid回退旧全局档) */
export function getWorld (gid, depth = 0) {
  const g = String(gid || '')
  const cached = worldCache.get(g)
  if (cached) return cached
  const file = g ? worldFile(g) : WORLD_FILE
  try {
    if (!fs.existsSync(file)) {
      /* 旧全局档迁移: 尚无任何独立世界档时, 旧 world.json 归第一个群(保留格局/税收/玩家位置) */
      if (g && fs.existsSync(WORLD_FILE) && !activeWorldGroups().length) {
        try { fs.renameSync(WORLD_FILE, file) } catch (err) { }
      }
      if (!fs.existsSync(file)) return initWorld(g)
    }
    const w = JSON.parse(fs.readFileSync(file, 'utf8'))
    const nw = Object.assign(emptyWorld(), w)
    nw.gid = g
    worldCache.set(g, nw)
    // 补缺字段(老档/半写档容错)
    let dirty = false
    if (!nw.prosperity || !Object.keys(nw.prosperity).length) {
      nw.prosperity = {}
      for (const s of SECTS) nw.prosperity[s] = DEFAULT_PROSPERITY
      dirty = true
    }
    if (!nw.pendingTax) { nw.pendingTax = {}; for (const s of SECTS) nw.pendingTax[s] = 0; dirty = true }
    if (!nw.rates) { nw.rates = {}; for (const k of REGION_KEYS) nw.rates[k] = 25; dirty = true }
    /* 旧档/升级迁移: 大区小区数变化(如 3→6 小区)时, 为缺失小区补齐占领(优先该区已有宗门, 避免整体重分配打乱繁荣/税收/玩家位置) */
    for (const k of REGION_KEYS) {
      const owners = []
      for (const a of REGIONS[k].areas) if (nw.sectMap && nw.sectMap[a]) owners.push(nw.sectMap[a])
      const uniq = [...new Set(owners)]
      let idx = 0
      for (const a of REGIONS[k].areas) {
        if (nw.sectMap && nw.sectMap[a]) continue
        let owner
        if (uniq.length) { owner = uniq[idx % uniq.length]; idx++ }
        else { owner = SECTS[Math.floor(Math.random() * SECTS.length)]; uniq.push(owner) }
        nw.sectMap[a] = owner
        dirty = true
      }
    }
    if (dirty) saveWorld(nw)
    return nw
  } catch (err) {
    /* 只有"内容解析不了"才算损坏(全0字节/断电半写); 读盘错误(占用/权限)原样抛出, 不许动文件 */
    if (!(err instanceof SyntaxError)) throw err
    return recoverWorld(g, file, err, depth)
  }
}

/** 世界档可用的最低结构要求(备份副本校验用): 至少带一份小区占领表 */
function looksLikeWorld (d) { return !!(d && typeof d === 'object' && d.sectMap) }

/**
 * 损坏恢复: 隔离损坏现场 → 用最近可用备份写回 → 连备份都没有才重建。
 * 重建只重置世界格局/繁荣/税率(玩家境界、灵石等在各自主档), 好过每次推进都报错卡死。
 */
function recoverWorld (g, file, err, depth) {
  const rel = g ? `world/world_${g}.json` : 'world/world.json'
  const r = recoverCorruptJson(file, rel, looksLikeWorld)
  if (r.restored && depth < 3) {
    console.log(`[虚境-世界] 世界档损坏(${err.message})，已隔离到 ${r.bak}，并从备份 ${r.dir} 恢复：${file}`)
    return getWorld(g, depth + 1) // 重新走一遍读取与补缺字段(备份字节已通过 JSON 解析)
  }
  const why = r.restored ? '恢复出的档回读异常' : (r.error ? `备份写回失败(${r.error})` : '无可用备份')
  console.log(`[虚境-世界] 世界档损坏(${err.message})且${why}，已隔离到 ${r.bak}，改用重建：${file}`)
  return initWorld(g)
}
export function saveWorld (w) {
  const gid = w && w.gid ? String(w.gid) : ''
  const file = gid ? worldFile(gid) : WORLD_FILE
  if (w && typeof w === 'object') worldCache.set(gid, w)
  try {
    /* writeJsonAtomic: 先写临时文件并 fsync 再改名, 断电不会留下全0字节的世界档 */
    return saveOrDefer(file, () => writeJsonAtomic(file, w))
  } catch (err) {
    console.log('[虚境-世界] 保存失败:', err && err.message)
    return false
  }
}

/* ---------- 霸主与税收归属 ---------- */
/** 大区霸主: 该大区全部小区都被同一宗门占领(且在世) 才是霸主; 有任何无主/他宗小区 → 无霸主(按小区分税) */
export function bossOf (w, key, alive) {
  const areas = REGIONS[key] && REGIONS[key].areas
  if (!areas || !areas.length) return null
  let owner = null
  for (const area of areas) {
    const s = w.sectMap && w.sectMap[area]
    if (!s || (alive && !alive(s))) return null // 有无主/灭门小区 → 非全占, 无霸主
    if (owner === null) owner = s
    else if (owner !== s) return null // 有他宗小区 → 非全占, 无霸主
  }
  return owner
}
/** 该大区有主小区的占领宗门列表(去重; 用于无霸主时的平均繁荣度计算与展示) */
export function collectorSects (w, key, alive) {
  const areas = REGIONS[key] && REGIONS[key].areas
  const set = new Set()
  for (const area of (areas || [])) {
    const s = w.sectMap && w.sectMap[area]
    if (s && (!alive || alive(s))) set.add(s)
  }
  return [...set]
}
/** 向某大区征收灵石(计入宗门待结算税收, 结算时转繁荣度): 按小区平分——每个小区产生的税给占领该小区的宗门(占几小区拿几份; 无主小区那份并入最后有主小区) */
export function addTax (w, key, gold, alive) {
  gold = Math.max(0, Math.floor(Number(gold) || 0))
  if (gold <= 0) return
  const areas = REGIONS[key] && REGIONS[key].areas
  if (!areas || !areas.length) return
  const n = areas.length
  const owned = areas.filter(a => {
    const s = w.sectMap && w.sectMap[a]
    return s && (!alive || alive(s))
  })
  if (!owned.length) return
  const base = Math.floor(gold / n)
  let remain = gold
  owned.forEach((area, idx) => {
    const v = idx === owned.length - 1 ? remain : base
    const s = w.sectMap[area]
    w.pendingTax[s] = (w.pendingTax[s] || 0) + v
    remain -= v
  })
}

/* ---------- 动态税率(每区按占领宗门平均繁荣度; 区与区繁荣差越大税率差越大, 差达100时打满10%~50%) ---------- */
export function recomputeRates (w, alive) {
  /* 每区代表繁荣度 = 该区占领宗门平均繁荣度(不依赖霸主; 全占区=唯一宗门=霸主繁荣度, 天然一致) */
  const regionPros = {}
  for (const k of REGION_KEYS) {
    const sects = collectorSects(w, k, alive)
    if (!sects.length) { regionPros[k] = 0; continue }
    let sum = 0
    for (const s of sects) sum += Number(w.prosperity[s]) || 0
    regionPros[k] = sum / sects.length
  }
  let pmax = -Infinity
  let pmin = Infinity
  for (const k of REGION_KEYS) {
    const p = regionPros[k]
    if (p <= 0) continue // 无占领宗门的区(全无主)不参与繁荣差比较
    if (p > pmax) pmax = p
    if (p < pmin) pmin = p
  }
  const delta = pmax - pmin
  if (delta <= 0) {
    for (const k of REGION_KEYS) w.rates[k] = 25
    return
  }
  /* 差的越多税率差的越多: 繁荣差100时达到最大偏离±25%(即10%~50%), 差越小偏离越小, 超过100封顶 */
  const spread = Math.min(25, delta / 100 * 25)
  /* 每区税率(按区平均繁荣度): 最高繁荣→低税, 最低繁荣→高税, 中间线性 */
  const regionRate = (p) => {
    const norm = (p - pmin) / delta // 0=最低繁荣, 1=最高繁荣
    const rate = 25 + spread - 2 * spread * norm // 最高繁荣→低税, 最低繁荣→高税, 中间线性
    return Math.max(10, Math.min(50, Math.round(rate * 100) / 100))
  }
  for (const k of REGION_KEYS) {
    const p = regionPros[k]
    /* 无任何占领宗门的区(全无主): 保持 25% 中性 */
    w.rates[k] = p > 0 ? regionRate(p) : 25
  }
}
/** 当前大区税率(%) */
export function getRate (w, key) {
  return Number(w.rates[key]) || 25
}
/** 当事人税率: 若当事人所属宗门是该大区一方霸主 → 税率减半(至少5%) */
export function taxFor (w, key, memberSect, alive) {
  const rate = getRate(w, key)
  if (!memberSect) return rate
  const boss = bossOf(w, key, alive)
  if (boss && String(memberSect) === String(boss)) return Math.max(5, Math.round(rate / 2))
  return rate
}

/* ---------- 30分钟结算(静默) ---------- */
/** 新繁荣 = 旧 + 税收/100 - 旧²/10000 (下限0); 清空税收; 重算税率(alive: 灭门宗门地盘视为无主) */
export function settleEconomy (w, alive) {
  /* 动态宗门列表: 小区占领 + 待结算税收 + 初始8宗 并集(宗门重建/改名后按最新名单结算) */
  const names = new Set()
  for (const s of Object.values(w.sectMap || {})) if (s) names.add(s)
  for (const s of Object.keys(w.pendingTax || {})) names.add(s)
  for (const s of SECTS) names.add(s)
  for (const s of names) {
    const cur = Number(w.prosperity[s]) || 0
    const gain = Math.floor((Number(w.pendingTax[s]) || 0) / TAX_TO_PROSPER)
    const decay = Math.floor((cur * cur) / DECAY_DIV)
    w.prosperity[s] = Math.max(0, cur + gain - decay)
    w.pendingTax[s] = 0
  }
  recomputeRates(w, alive)
  w.lastSettle = Date.now()
  saveWorld(w)
}

/* ---------- 天下大事联动: 攻打易主/宗门重建改名 ---------- */
/** 标记占领已被攻打/重建改动: 之后不再强制重分配 */
export function markConquered (w) {
  if (!w.conquered) {
    w.conquered = true
    saveWorld(w)
  }
}
/** 宗门重建改名(换皮): 小区归属/繁荣/税收全部迁移到新名, 老名字清除 */
export function renameSect (w, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return
  for (const a of Object.keys(w.sectMap || {})) {
    if (w.sectMap[a] === oldName) w.sectMap[a] = newName
  }
  if (w.prosperity && w.prosperity[oldName] !== undefined) {
    w.prosperity[newName] = w.prosperity[oldName]
    delete w.prosperity[oldName]
  }
  if (w.pendingTax && w.pendingTax[oldName] !== undefined) {
    w.pendingTax[newName] = w.pendingTax[oldName]
    delete w.pendingTax[oldName]
  }
  w.conquered = true
  saveWorld(w)
}
/** 是否到结算周期 */
export function dueSettle (w) {
  return Date.now() - (w.lastSettle || 0) >= SETTLE_INTERVAL
}

/* ---------- 玩家位置(每人独立记录) ---------- */
export function getLoc (w, uid) {
  return w.playerLoc[String(uid)] || DEFAULT_REGION
}
export function setLoc (w, uid, key) {
  w.playerLoc[String(uid)] = key
  saveWorld(w)
}

/* ---------- 界壁跨越状态 ---------- */
export function getMoving (w, uid) {
  return w.moving[String(uid)] || null
}
export function setMoving (w, uid, obj) {
  w.moving[String(uid)] = obj
  saveWorld(w)
}
export function clearMoving (w, uid) {
  delete w.moving[String(uid)]
  saveWorld(w)
}

/* ---------- 境界名(与修炼体系一致) ---------- */
const REALMS = ['炼气期', '筑基期', '金丹期', '元婴期', '化神期', '炼虚期', '合体期', '大乘期', '渡劫期', '人仙', '天仙', '金仙', '大罗金仙', '九天玄仙', '罗天上仙', '仙君', '仙帝']
const STAGES = ['初期', '中期', '后期', '巅峰']
const STAGE_COUNT = 4
const MAX_LEVEL = REALMS.length * STAGE_COUNT
export function levelNameOf (level) {
  level = Number(level) || 0
  if (level <= 0) return '无灵力'
  if (level > MAX_LEVEL) return `仙帝第${level - MAX_LEVEL}重`
  const i = Math.floor((level - 1) / STAGE_COUNT)
  const j = (level - 1) % STAGE_COUNT
  return REALMS[i] + STAGES[j]
}

/** 强行跨越失败: 随机掉落 0~max 个境界(该群 battle 档, 最低0封底), 返回掉落数 */
export async function dropRealms (gid, uid, max = FORCE_DROP_MAX) {
  const drop = Math.floor(Math.random() * (max + 1))
  if (drop <= 0) return 0
  const filename = `${gid}.json`
  const battle = await xujing_data.getQQYUserBattle(uid, null, false, filename)
  if (!battle[uid]) return 0
  battle[uid].level = Math.max(0, (Number(battle[uid].level) || 0) - drop)
  battle[uid].levelname = levelNameOf(battle[uid].level)
  await xujing_data.getQQYUserBattle(uid, battle, true, filename)
  return drop
}
