import { VAULT_PILL_PRICES } from './vault_rules.js'
import { isTaichuEnabled } from '../taichu_equipment.js'
import { INJURY_PCT, INJURY_RECOVER, injuryState } from '../injury.js'
/* 由 sect_system.js 拆分自动生成: utils.js */
import { Plugin_Name } from '../plugin.js'
import { POS, sectVitality, sectCulture, sectName, sectIdByName } from '../fake_data.js'
import { REGIONS, regionNameOf } from '../world_data.js'
import xujing_data from '../xujing_data.js'
import { getBag, VAULT_EQUIP_CONTRIB, GONGFA_TPL } from '../equip_data.js'
import { getBuffs, calcCombatPower } from '../fight.js'
import { Wanhun } from '../wanhun_data.js'

export const SECT_FILE = `plugins/${Plugin_Name}/resources/qylp/fake_sect_names.json`


/* ---------- 平衡参数表(初值, 集中可调) ---------- */
export const CFG = {
  MAX_SECTS: 10,              // 伪玩家宗门上限(玩家创建的宗门不占名额、不受此限制)
  INIT_VAULT: 100000,         // 伪玩家宗门初始宝库
  CREATE_VAULT: 50000,        // 玩家创建宗门初始宝库
  CREATE_COST_BASE: 400000,   // 创建宗门灵石下限(税率10%时)
  CREATE_COST_SPREAD: 600000, // 税率每升1%加 15000 (10%→40万, 50%→100万)
  OFFER_MIN: 100,             // 上供最低
  OFFER_CONTRIB: 100,         // 每100灵石=1贡献(2026-08-16 比值翻10倍: 原每10灵石=1)
  ROGUE_TEAM_MAX: 4,          // 散修小队人数上限
  TAX_SHARE: 0.5,             // 税收进宝库比例
  FAKE_OUT_SHARE: 0.3,        // 伪玩家产出进宝库比例(未单独区分, 随TAX_SHARE)
  /* 设施 */
  get FACILITIES () { return {
    yanwu: { cn: '演武场', stone: 50000, mats: { '月魄石': 1, '星霜草': 1 }, fx: { desc: '修炼+8%/级 突破+2%/级 攻打战力+2%/级' } },
    hushan: { cn: '护山阵', stone: 80000, mats: { '流光玉': 1, '星璇石': 1 }, fx: { desc: '被攻打时守方战力+8%/级' } },
    lingmai: { cn: '灵脉', stone: 70000, mats: { '织云石': 1, '望舒花': 1 }, fx: { desc: '小区产出灵石+10%/级' } },
    yaoyuan: { cn: '药园', stone: 80000, mats: { '月华芝': 1, '星霜草': 1 }, fx: { desc: '每小时产出修为丹/破障丹(1级5+3→5级50+30)' } },
    ...(isTaichuEnabled() ? { tiangong: TIANGONG_FACILITY } : {})
  } },
  AREA_DEF_RATIO: 0.6,        // 护城阵 = 护山阵 60% 消耗
  AREA_DEF_BONUS: 6,          // 护城阵守方战力 +6%/级
  HUSHAN_BONUS: 8,            // 护山阵守方战力 +8%/级
  /* 真人与伪玩家统一贡献兑换价；灵石维持20贡献换100。 */
  EXCHANGE: {
    stone: { cn: '灵石', cost: 20, unit: 100 },
    ...Object.fromEntries(Object.entries(VAULT_PILL_PRICES).map(([name, cost]) => [name, { cost, unit: 1 }]))
  },
  /* 宝库装备贡献价：数值源在 vault_rules.js，装备和宗门共用。 */
  VAULT_EQUIP_CONTRIB,
  /* 宝库售丹: 市场价(与丹阁一致) × 折扣; 弟子购丹灵石直接进宝库, 不交税 */
  VAULT_PILL_PRICE: { '修为丹': 500, '破障丹': 1000, '聚宝丹': 800 },
  VAULT_PILL_DISCOUNT: 0.8,
  MAT_COMMON_COST: 5,         // 普通(紫/金)材料×1
  MAT_RED_COST: 800,          // 红材料×1 (2026-08-18 用户要求)
  MAT_COLOR_COST: 2000,       // 彩材料×1 (2026-08-18 用户要求)
  /* 晋升条件(去入宗天数: 只看贡献+修为, 实力至上) */
  PROMO: {
    zhishi: { cn: '执事', contrib: 50, level: 6, days: 0 },
    fuzong: { cn: '副宗主', contrib: 100, level: 9, days: 0 },
    zongzhu: { cn: '宗主', contrib: 200, level: 13, days: 0 },
    taishang: { cn: '太上长老', contrib: 300, level: 25, days: 0 }
  },
  /* 俸禄: 玩家主导宗门的每名弟子每小时自动发放; 伪玩家宗门不发 */
  SALARY_PER_MEMBER: 500,
  SALARY_INTERVAL: 3600000,
  /* 攻打 */
  ATK_BASE: 2000, ATK_PER: 400, PREP_MIN: 30,
  ROUND_MIN: 10, ROUND_MAX: 8, TARGET_CD: 2 * 86400000,
  /* 发起攻打冷却(分钟): 攻打结束/终止后进入冷却(玩家/散修 30 分钟; AI 伪玩家宗门 240 分钟=4小时) */
  PLAYER_ATK_CD: 30, FAKE_ATK_CD: 240,
  /* 攻打战力: 每参战人数基础战力(人多势众) + 境界/装备战力×REALM_WEAKEN(境界占100%, 个人战力全额计入, 攻打防守同源) */
  PERSON_BASE: 600, REALM_WEAKEN: 1.0,
  /* AI(伪玩家)攻打: 不限并发——每个宗门按自身 FAKE_ATK_CD(240分钟) 冷却独立行动; AI_GAP_MIN 已废弃(旧全局战争间隔) */
  AI_GAP_MIN: 60,
  /* 败方战死判定: 基础5%随境界降低，碾压/明确血仇按倍率计算，50%仅为兼容上限 */
  DEATH_BASE: 5, DEATH_CRUSH_RATE: 50, DEATH_CRUSH_RATIO: 2,
  /* 门人跨区作战传送费(灵石/人): 跨区攻打/防守调兵由宗门宝库出, 日常远行门人自费 */
  SECT_DEPLOY_COST: 2000,
  /* 迁宗(宗门总部搬迁)费用: 从宗门宝库扣 */
  MOVE_COST: 200000, MOVE_CD: 86400000,
  /* 重伤(战力扣减/恢复分钟) */
  INJURY_PCT,
  INJURY_RECOVER,
  /* 小区产出 */
  AREA_OUT_STONES: [800, 1500], AREA_OUT_MATS: [2, 4], // 材料单次产出 6~12 件(2026-08-17 上调: 原 3~9, 金紫太少)
  REFINE_MATS: 3, REFINE_KEEP: 2, REFINE_STOP: 100
}

/** 普通/稀有材料(兑换与搜刮用; 普通=紫/金常见, 稀有=红/彩) */
export const MAT_COMMON = ['星霜草', '青鸾草', '望舒花', '月华芝', '月魄石', '星璇石', '流光玉', '织云石']

export const MAT_RED = ['凤栖花', '凤羽玉']

export const MAT_COLOR = ['云裳仙蕊', '造梦神玉']

export const MAT_RARE = [...MAT_RED, ...MAT_COLOR]

/* 小区产出材料池(加权): 紫/金常见(各×4, 2026-08-17 上调: 原各×3, 金紫太少), 红稀有(凤栖花/凤羽玉各×1=产出少), 不含彩色(彩材料只靠弟子上供/战利品) */
export const MAT_POOL = ['星霜草', '星霜草', '星霜草', '星霜草', '青鸾草', '青鸾草', '青鸾草', '青鸾草', '月魄石', '月魄石', '月魄石', '月魄石', '星璇石', '星璇石', '星璇石', '星璇石', '望舒花', '望舒花', '望舒花', '望舒花', '月华芝', '月华芝', '月华芝', '月华芝', '流光玉', '流光玉', '流光玉', '流光玉', '织云石', '织云石', '织云石', '织云石', '凤栖花', '凤羽玉']


/* ---------- 工具 ---------- */
export const rand = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1))

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v))

export const dayStr = (t) => new Date(t).toISOString().slice(0, 10)

/** 战争明细日志(每场战争独立记录, 供 #战争详情 查询; 保留最新200条) */
export function atkLog (atk, txt, t = Date.now()) {
  if (!atk) return
  if (!atk.log) atk.log = []
  atk.log.push({ t, txt })
  if (atk.log.length > 200) atk.log.splice(0, atk.log.length - 200)
}

export function regionOfArea (area) {
  for (const k of Object.keys(REGIONS)) if (REGIONS[k].areas.includes(area)) return k
  return null
}

/** 宗门所在大区(优先sects.region, 否则按占领小区推定) */
export function sectRegion (f, id) {
  const s = f.sects[id]
  if (s && s.region) return s.region
  const cnt = {}
  for (const [area, owner] of Object.entries(f.areas || {})) {
    if (owner === id) { const r = regionOfArea(area); if (r) cnt[r] = (cnt[r] || 0) + 1 }
  }
  let best = 'center'
  let bn = 0
  for (const [r, n] of Object.entries(cnt)) if (n > bn) { best = r; bn = n }
  if (s) s.region = best
  return best
}

/** 是否玩家主导的宗门(玩家宗主坐镇) */
export function isPlayerLead (f, id) {
  const s = f.sects[id]
  if (s && s.owner) return true
  return Object.values(f.players || {}).some(x => x && x.sect === id && x.pos === 'zongzhu')
}

/* ---------- 战争目标显示名(小区名 + 宗门名 一起带上) ---------- */

/** 小区目标完整显示名: 【小区名】（占领宗门名）；无主/原宗已灭 → （无主） */
export function areaTxtOf (f, area) {
  const owner = f.areas && f.areas[area]
  const os = owner && f.sects && f.sects[owner]
  const dead = os && os.wipeAt && os.wipeAt <= Date.now()
  const oname = os && !dead ? sectName(f, owner) : ''
  return oname && oname !== '未知' ? `【${area}】（${oname}）` : `【${area}】（无主）`
}

/** 宗门目标完整显示名: 【宗门名】（大区·小区…）；已永久除名/灭门只剩名 → 只显示名 */
export function sectTxtOf (f, sid) {
  const name = sectName(f, sid)
  const s = f.sects && f.sects[sid]
  if (!s) return `【${name}】`
  const reg = sectRegion(f, sid)
  const regTxt = (reg && regionNameOf(reg) !== '未知') ? regionNameOf(reg) : ''
  const areas = Object.keys(f.areas || {}).filter(a => f.areas[a] === sid)
  const areasTxt = areas.length ? areas.slice(0, 2).join('、') + (areas.length > 2 ? '等' : '') : ''
  const loc = [regTxt, areasTxt].filter(Boolean).join('·')
  return loc ? `【${name}】（${loc}）` : `【${name}】`
}

/** 战争目标完整显示名(小区+宗门都带上): 按 atk.targetType 分派 */
export function warTargetTxt (f, atk) {
  if (!atk || atk.target == null) return ''
  if (atk.snapshot) return atk.targetType === 'area' ? `【${atk.snapshot.target}】（${atk.snapshot.defender}）` : `【${atk.snapshot.target}】`
  return atk.targetType === 'area' ? areaTxtOf(f, atk.target) : sectTxtOf(f, atk.target)
}

/** 用户输入的 小区名/宗门名 → 完整显示名(用于选择指定目标时的反馈) */
export function targetRawTxt (f, raw) {
  raw = String(raw || '').trim()
  if (!raw) return ''
  if (regionOfArea(raw)) return areaTxtOf(f, raw)
  const sid = sectIdByName(f, raw)
  if (sid) return sectTxtOf(f, sid)
  return `【${raw}】`
}


/* ---------- 玩家数据 ---------- */
export async function playerMoney (gid, uid) {
  const filename = `${gid}.json`
  const home = await xujing_data.getQQYUserHome(uid, null, filename, false)
  return { home, filename, money: Number(home[uid].money) || 0 }
}

export async function playerLevel (gid, uid) {
  try {
    const battle = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
    return Number((battle[uid] || {}).level) || 0
  } catch (err) { return 0 }
}

/** 玩家战力 = 玩家真实战力(calcCombatPower: (境界战力+装备战力)×功法/丹药倍率) + 伤势扣减 */
export async function playerPower (f, gid, uid) {
  try {
    const battle = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
    const level = Number((battle[uid] || {}).level) || 0
    const bag = getBag(uid, gid)
    const buff = await getBuffs(uid, gid)
    const injury = f.players?.[String(uid)]?.injury || f.injuries?.[String(uid)] || null
    return calcCombatPower(level, bag, buff, gid, uid, injury).power
  } catch (err) { return 0 }
}

/** 伤势信息: {level(有效等级), pct(扣减%), remainMin, totalMin} */
export function injuryInfo (p, now = Date.now()) {
  const info = injuryState(p?.injury, now)
  if (p?.injury && !info.level) p.injury = null
  return info
}

export function applyInjury (f, uid, level, at = Date.now(), gid = 'global', receipt = null) {
  uid = String(uid)
  const shield = Wanhun.tryShield(uid, gid, receipt)
  if (shield.used) level = Math.max(0, (Number(level) || 0) - 1)
  if (level <= 0) return { level: 0, shield: shield.used, replenished: shield.replenished }
  const p = f.players && f.players[uid]
  if (p) {
    p.injury = { level: clamp(level, 1, 3), at }
    /* 清掉可能残留的散修负伤记录(先散修受伤后入宗门的情况) */
    if (f.injuries && f.injuries[uid]) delete f.injuries[uid]
    return
  }
  /* 散修(无宗门档案): 负伤存独立表 f.injuries, 与宗门身份解耦 — 修复散修受伤后"活蹦乱跳" */
  if (!f.injuries || typeof f.injuries !== 'object') f.injuries = {}
  f.injuries[uid] = { level: clamp(level, 1, 3), at }
}

export function healPlayers (f) {
  let changed = false
  const now = Date.now()
  for (const p of Object.values(f.players || {})) {
    if (!p || !p.injury) continue
    const total = CFG.INJURY_RECOVER[p.injury.level] * 60000
    if (now - p.injury.at >= total) { p.injury = null; changed = true }
  }
  /* 散修负伤表(uid -> {level,at}) 恢复到期清除 */
  if (f.injuries && typeof f.injuries === 'object') {
    for (const uid of Object.keys(f.injuries)) {
      const inj = f.injuries[uid]
      if (!inj) { delete f.injuries[uid]; changed = true; continue }
      const total = CFG.INJURY_RECOVER[inj.level] * 60000
      if (now - inj.at >= total) { delete f.injuries[uid]; changed = true }
    }
  }
  return changed
}


/* ---------- 宝库 ---------- */
export function getVault (f, id) {
  const s = f.sects[id]
  if (!s) return null
  if (!s.vault) s.vault = { stones: 0, mats: {}, pills: {}, equips: {}, gongfas: {} }
  if (!s.vault.mats) s.vault.mats = {}
  if (!s.vault.pills) s.vault.pills = {}
  if (!s.vault.equips) s.vault.equips = {}
  if (!s.vault.gongfas) s.vault.gongfas = {}
  /* 清理历史/外部写入的非法功法，避免宗门宝库出现不可学习物品。 */
  for (const name of Object.keys(s.vault.gongfas)) {
    if (!GONGFA_TPL[name] || GONGFA_TPL[name].quality > 6 || Number(s.vault.gongfas[name]) <= 0) delete s.vault.gongfas[name]
    else s.vault.gongfas[name] = Math.floor(Number(s.vault.gongfas[name]))
  }
  return s.vault
}

export function vaultAdd (s, stones, mats, pills, equips) {
  if (!s.vault) s.vault = { stones: 0, mats: {}, pills: {}, equips: {}, gongfas: {} }
  if (!s.vault.mats) s.vault.mats = {}
  if (!s.vault.pills) s.vault.pills = {}
  if (!s.vault.equips) s.vault.equips = {}
  if (!s.vault.gongfas) s.vault.gongfas = {}
  s.vault.stones = (s.vault.stones || 0) + (Math.floor(stones) || 0)
  if (mats) { for (const [m, c] of Object.entries(mats)) s.vault.mats[m] = (s.vault.mats[m] || 0) + c }
  if (pills) { for (const [p, c] of Object.entries(pills)) s.vault.pills[p] = (s.vault.pills[p] || 0) + c }
  if (equips) { for (const [e, c] of Object.entries(equips)) s.vault.equips[e] = (s.vault.equips[e] || 0) + c }
}


/* ---------- 设施 ---------- */
/** 伪玩家宗门建造/升级/维护/护城阵费用倍数 = 玩家全价 × 0.3(曾为 ×0.1 打1折, 2026-08-17 翻3倍上调) */
export const FAKE_FAC_MULT = 0.3

/** 太初服务不享受伪玩家旧设施折扣，玩家和伪玩家同价。 */
export const TIANGONG_FACILITY = Object.freeze({
  cn: '天工坊', stone: 200000,
  mats: { '凤羽玉': 20, '造梦神玉': 5, '乾坤阵晶': 5 },
  fx: { desc: '太初装备打造、修理与修补包制作（最高5级）' }
})

export function activeFacilityKeys () { return Object.keys(CFG.FACILITIES) }

/** 已有设施在关闭玩法后保留存档，暂停效果和收费。 */
export function taichuWorkshopLevel (f, member, now = Date.now()) {
  if (!isTaichuEnabled()) return 0
  const sect = f?.sects?.[member?.sect]
  if (!sect || (sect.wipeAt && sect.wipeAt <= now) || member?.status === 'scatter') return 0
  return Math.max(0, Math.min(5, Math.floor(Number(sect.facilities?.tiangong) || 0)))
}

export function facilityCost (fac, newLevel) {
  const t = CFG.FACILITIES[fac]
  if (!t) return null
  const stones = t.stone * newLevel * newLevel
  const mats = {}
  for (const [m, c] of Object.entries(t.mats)) mats[m] = c * newLevel
  if (newLevel === 1) {
    /* 建造(0→1): 灵石×2, 材料×5 */
    const bm = {}
    for (const [m, c] of Object.entries(mats)) bm[m] = c * 5
    return { stones: stones * 2, mats: bm, build: true, cn: t.cn }
  }
  return { stones, mats, build: false, cn: t.cn }
}

/* ---------- 战后维护(仅玩家宗主宗门生效) ---------- */
/** 战后维护窗口: 3 小时; 窗口内材料维护×2, 灵石维护×5 */
export const WAR_UPKEEP_MS = 3 * 3600000
export const WAR_UPKEEP_MAT_MULT = 2
export const WAR_UPKEEP_STONE_MULT = 5

/** 记录宗门参战时间(攻打结算/撤兵时调用; 只保留最近一次) */
export function markSectWar (f, sid, now = Date.now()) {
  const s = sid && f && f.sects && f.sects[sid]
  if (!s) return false
  const t = Number(now) || Date.now()
  if (t > (Number(s.lastWarAt) || 0)) { s.lastWarAt = t; return true }
  return false
}

/** 宗门是否处于战后维护窗口(3小时) */
export function inWarUpkeep (f, sid, now = Date.now()) {
  const s = sid && f && f.sects && f.sects[sid]
  if (!s) return false
  const last = Number(s.lastWarAt) || 0
  return last > 0 && now >= last && now - last < WAR_UPKEEP_MS
}

/* ---------- 小区被打后的恢复期(无产出) ---------- */
/** 小区被打后 3 小时内不产出任何收益(灵石/材料都不产), 维护照收 */
export const AREA_RAID_REST_MS = 3 * 3600000

/** 记录小区被打时间(攻打结算/撤兵时调用, 只保留最近一次) */
export function markAreaRaid (f, area, now = Date.now()) {
  if (!area || !f) return false
  if (!f.areaRaidAt || typeof f.areaRaidAt !== 'object') f.areaRaidAt = {}
  const t = Number(now) || Date.now()
  if (t > (Number(f.areaRaidAt[area]) || 0)) { f.areaRaidAt[area] = t; return true }
  return false
}

/** 小区是否处于"被打后 3 小时恢复期"(期间无产出) */
export function areaInRaidRest (f, area, now = Date.now()) {
  if (!area || !f) return false
  const last = Number(f.areaRaidAt && f.areaRaidAt[area]) || 0
  return last > 0 && now >= last && now - last < AREA_RAID_REST_MS
}

/* ---------- 护城阵 ---------- */
export function areaDefLevel (f, area) {
  const d = f.areaDef && f.areaDef[area]
  return (d && d.level) || 0
}

/* ---------- 俸禄 / 取用宝库 ---------- */
export const posCnOf = (pos) => (POS[pos] && POS[pos].cn) || pos || '弟子'

/** 门人是否选择参战(性格驱动, 不写死):
 *  性格基础(好斗/嗜杀积极, 善良/平和温和) × 攻防偏好(好斗/嗜杀/魔修爱打不爱守, 善良/平和爱守不爱打)
 *  × 行为性格(苦修/勤勉出力, 懒散/贪玩爱躲) × 忠诚 × 宗门兴衰 × 宗门文化压力 × 连续避战被点名施压 */
export function willFight (p, isDef, f) {
  if (!p) return false
  const t = p.trait || ''
  let base = t === '好斗' || t === '嗜杀' ? 0.85 : (t === '善良' ? 0.6 : (t === '平和' ? 0.5 : 0.65))
  /* 攻防偏好 */
  const atkLover = t === '好斗' || t === '嗜杀' || p.path === '魔道'
  const defLover = t === '善良' || t === '平和'
  if (isDef) { if (atkLover) base -= 0.08; if (defLover) base += 0.1 }
  else { if (atkLover) base += 0.08; if (defLover) base -= 0.12 }
  /* 行为性格 */
  base += ({ 苦修: 0.1, 勤勉: 0.06, 普通: 0, 懒散: -0.12, 贪玩: -0.18 }[p.act] || 0)
  /* 忠诚度: 越高越愿为宗门出力 */
  base += ((Number(p.loyalty) || 50) - 50) / 100 * 0.25
  /* 宗门兴衰/文化(须有宗门) */
  if (f && p.sect && p.status === 'sect') {
    base += (sectVitality(f, p.sect) - 50) / 100 * 0.15
    try {
      const c = sectCulture(f, p.sect)
      if (c && c.style) {
        if (c.style === '尚武好战' || c.style === '凶焰滔天' || c.style === '魔气森然') base += 0.15
        else if (c.style === '祥和仁厚' || c.style === '乐善好施') base -= 0.05
      }
    } catch (err) { }
  }
  /* 连续避战: 被点名施压, 越来越难躲 */
  if ((p.absentStreak || 0) > 0) base += Math.min(p.absentStreak, 3) * 0.05
  return Math.random() < clamp(base, 0, 0.98)
}

export function uniqueIdList (arr) {
  return [...new Set((Array.isArray(arr) ? arr : []).filter(Boolean))]
}

/** 确保场次俘虏池含"抓人方"子池(byDef=被守方擒的攻方人 / byAtk=被攻方擒的守方人) */
export function ensureCapSub (atk) {
  atk.captives = atk.captives || { fakes: [], players: [] }
  if (!atk.captives.byDef) atk.captives.byDef = { fakes: [], players: [] }
  if (!atk.captives.byAtk) atk.captives.byAtk = { fakes: [], players: [] }
}
