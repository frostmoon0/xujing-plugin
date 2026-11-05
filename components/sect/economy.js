import { takeVaultEquipAttrs } from './war_loot.js'
/* 由 sect_system.js 拆分自动生成: economy.js */
import fs from 'fs'
import { getFake, saveFake, sectName, sectIdByName, addPerson, drawName, sectAlive, sectCap, areaCount, killPerson, logEvent, SECT_START_BAND, FAKE_MAX } from '../fake_data.js'
import { getWorld, saveWorld, regionNameOf, DEFAULT_REGION, getLoc, renameSect } from '../world_data.js'
import xujing_data from '../xujing_data.js'
import { addItem, getBag, saveBag, EQUIP_TPL, GONGFA_TPL, vaultEquipContrib, itemIcon, fmtItem } from '../equip_data.js'
import { CFG, MAT_COMMON, MAT_RED, MAT_COLOR, MAT_POOL, getVault, rand, pick, clamp, playerMoney, areaDefLevel, facilityCost, posCnOf, FAKE_FAC_MULT, regionOfArea, sectRegion, SECT_FILE, isPlayerLead, inWarUpkeep, WAR_UPKEEP_MAT_MULT, WAR_UPKEEP_STONE_MULT, areaInRaidRest, AREA_RAID_REST_MS } from './utils.js'

/* ---------- 宗门矿山(战俘挖矿) ---------- */
/** 矿山每小时灵石产出: 基础值按境界计算后再减半(境界1→50, 仙帝(68)→150000) */
export function mineStonesPerHr (level) {
  level = Math.min(Math.max(Number(level) || 1, 1), 68)
  return Math.floor((100 + (level - 1) / 67 * 299900) / 2)
}

/** 矿山矿物池(紫/金常见, 红稀有; 彩单独0.5%判定) */
export const MINE_MATS = ['星霜草', '青鸾草', '月魄石', '星璇石', '望舒花', '月华芝', '流光玉', '织云石', '凤栖花', '凤羽玉']

/** 矿难死亡概率: 境界越高越难死, 仙帝(68)不死 */
export function mineDeathRate (level) {
  level = Math.min(Math.max(Number(level) || 1, 1), 68)
  if (level >= 68) return 0
  return clamp(0.3 * (1 - level / 68), 0, 0.3)
}

/** 矿山动态历史：保留最近200条，供宗门矿山/天下矿山查询 */
export function addMineEvent (f, event) {
  if (!Array.isArray(f.mineEvents)) f.mineEvents = []
  f.mineEvents.push(event)
  if (f.mineEvents.length > 200) f.mineEvents.splice(0, f.mineEvents.length - 200)
}

/** 每小时: 战俘挖矿产出 */
export function mineTick (f, now = Date.now()) {
  if (!f.sectMines) return
  for (const sid of Object.keys(f.sectMines)) {
    const s = f.sects && f.sects[sid]
    const vault = s ? getVault(f, sid) : null
    const arr = f.sectMines[sid]
    if (!arr || !arr.length || !vault) continue
    const remain = []
    for (const m of arr) {
      const p = f.roster && f.roster[m.name]
      if (!p || !p.alive) {
        addMineEvent(f, { t: now, type: 'lost', sect: sid, name: m.name, at: m.at || now, duration: Math.max(0, now - (m.at || now)), stones: m.outStones || 0, mats: { ...(m.outMats || {}) }, txt: `【矿山】${m.name} 已离开矿山，累计挖矿${Math.max(0, Math.round((now - (m.at || now)) / 3600000))}小时` })
        continue
      }
      const lv = Number(p.level) || 1
      /* 产出灵石：按用户要求统一降为原来的2/3 */
      const stones = Math.floor(mineStonesPerHr(lv) * 2 / 3)
      vault.stones = (vault.stones || 0) + stones
      m.outStones = (m.outStones || 0) + stones
      /* 普通矿物：原1~3个整体按2/3折算，至少保留1个 */
      const rawMatN = 1 + Math.floor(Math.random() * 3)
      const matN = Math.max(1, Math.floor(rawMatN * 2 / 3))
      for (let i = 0; i < matN; i++) {
        const mat = pick(MINE_MATS)
        vault.mats[mat] = (vault.mats[mat] || 0) + 1
        if (!m.outMats) m.outMats = {}
        m.outMats[mat] = (m.outMats[mat] || 0) + 1
      }
      /* 彩材料：命中概率也按2/3折算，避免单次产出仍保持原期望 */
      if (Math.random() < 0.005 * 2 / 3) {
        const color = Math.random() < 0.5 ? '云裳仙蕊' : '造梦神玉'
        vault.mats[color] = (vault.mats[color] || 0) + 1
        if (!m.outMats) m.outMats = {}
        m.outMats[color] = (m.outMats[color] || 0) + 1
        m.colorHit = (m.colorHit || 0) + 1
        logEvent(f, 'flavor', `【矿彩】${s.name} 矿山矿工 ${p.name} 挖出 🌈${color}！`, now, { who: [m.name], sect: sid })
      }
      /* 矿难判定(境界越高越难死, 仙帝不死) */
      if (Math.random() < mineDeathRate(lv)) {
        const duration = Math.max(0, now - (m.at || now))
        killPerson(f, p, `【矿难】${s.name} 矿山矿工 ${m.name} 力竭而亡`, now)
        addMineEvent(f, { t: now, type: 'death', sect: sid, name: m.name, at: m.at || now, duration, stones: m.outStones || 0, mats: { ...(m.outMats || {}) }, colorHit: m.colorHit || 0, txt: `【矿难】${s.name} 的矿工 ${m.name} 挖矿${Math.max(0, Math.floor(duration / 3600000))}小时后遇难` })
        logEvent(f, 'flavor', `【矿难】${s.name} 矿山矿工 ${m.name} 不堪重负，死于矿下`, now, { who: [m.name], sect: sid })
        continue
      }
      addMineEvent(f, { t: now, type: 'work', sect: sid, name: m.name, at: m.at || now, duration: Math.max(0, now - (m.at || now)), stones, mats: { ...(m.outMats || {}) }, colorHit: m.colorHit || 0, txt: `【挖矿】${s.name} 矿工 ${m.name} 本小时产出灵石${stones}` })
      remain.push(m)
    }
    f.sectMines[sid] = remain
  }
}


export function upgradeFacility (f, id, fac) {
  const s = f.sects[id]
  if (!s) return { ok: false, msg: '宗门不存在' }
  const t = CFG.FACILITIES[fac]
  if (!t) return { ok: false, msg: '设施不存在（演武场/护山阵/灵脉）' }
  if (!s.facilities) s.facilities = { yanwu: 0, hushan: 0, lingmai: 0 }
  const cur = s.facilities[fac] || 0
  if (cur >= 5) return { ok: false, msg: `${t.cn}已满级（5级）~` }
  const c = facilityCost(fac, cur + 1)
  const vault = getVault(f, id)
  /* 缺什么一次显示全: 灵石 + 所有不足材料一次性列出 */
  const missing = []
  if ((vault.stones || 0) < c.stones * 2) missing.push(`灵石（需 ${c.stones}，且需保留 ${c.stones} 余额；当前 ${vault.stones || 0}）`)
  for (const [m, n] of Object.entries(c.mats)) {
    if ((vault.mats[m] || 0) < n) missing.push(`${itemIcon(m)}${m}（需 ${n}，当前 ${vault.mats[m] || 0}）`)
  }
  if (missing.length) return { ok: false, msg: `宝库资源不足，${t.cn}${c.build ? '建造' : '升级'}还缺：${missing.join('、')}~` }
  vault.stones -= c.stones
  for (const [m, n] of Object.entries(c.mats)) {
    vault.mats[m] -= n
    if (vault.mats[m] <= 0) delete vault.mats[m]
  }
  s.facilities[fac] = cur + 1
  logEvent(f, 'flavor', `【建造】${sectName(f, id)} ${c.build ? '建成' : '升级'}${t.cn}至 ${cur + 1} 级`)
  return { ok: true, msg: `✅ ${t.cn}已${c.build ? '建成' : '升至'} ${cur + 1} 级（${t.fx.desc}）` }
}


export function upgradeAreaDef (f, area, fake = false) {
  const cur = areaDefLevel(f, area)
  if (cur >= 5) return { ok: false, msg: '护城阵已满级（5级）~' }
  const owner = f.areas && f.areas[area]
  const s = owner ? f.sects[owner] : null
  if (!s) return { ok: false, msg: '该小区无主，无法升级护城阵~' }
  const base = facilityCost('hushan', cur + 1)
  const mult = fake ? FAKE_FAC_MULT : 1 // 伪玩家宗门自动升级护城阵按 FAKE_FAC_MULT(3折, 曾1折)
  const stones = Math.max(1, Math.round(base.stones * CFG.AREA_DEF_RATIO * mult))
  const mats = {}
  for (const [m, c] of Object.entries(base.mats)) mats[m] = Math.max(1, Math.round(c * CFG.AREA_DEF_RATIO * mult))
  const vault = getVault(f, owner)
  if ((vault.stones || 0) < stones * 2) return { ok: false, msg: `宝库灵石不足（升级护城阵需 ${stones}，且需保留 ${stones} 余额；当前 ${vault.stones || 0}）~` }
  for (const [m, n] of Object.entries(mats)) {
    if ((vault.mats[m] || 0) < n) return { ok: false, msg: `宝库材料不足（缺 ${itemIcon(m)}${m} ×${n}）~` }
  }
  vault.stones -= stones
  for (const [m, n] of Object.entries(mats)) { vault.mats[m] -= n; if (vault.mats[m] <= 0) delete vault.mats[m] }
  if (!f.areaDef[area]) f.areaDef[area] = { level: 0, maintainAt: 0 }
  f.areaDef[area].level = cur + 1
  f.areaDef[area].maintainAt = Date.now()
  logEvent(f, 'flavor', `【护城】${sectName(f, owner)} 将【${area}】护城阵升至 ${cur + 1} 级（守方战力+${CFG.AREA_DEF_BONUS * (cur + 1)}%）`)
  return { ok: true, msg: `✅ 【${area}】护城阵升至 ${cur + 1} 级（守方战力+${CFG.AREA_DEF_BONUS * (cur + 1)}%）` }
}

/** 宗门放弃小区: 宗主/副宗把本宗占领的小区拱手让出, 小区变回无主(护城阵拆除, 税收/产出立即停归本宗) */
export function abandonArea (f, gid, sid, area) {
  if (!regionOfArea(area)) return { ok: false, msg: '小区不存在（#天下小区 查看）~' }
  if (f.areas[area] !== sid) return { ok: false, msg: '本宗未占领该小区~' }
  /* 小区正被攻打时不能放弃(战事未了不可弃地) */
  const beingAtk = (f.sectAttacks || []).some(a => a.phase !== 'done' && a.targetType === 'area' && a.target === area)
  if (beingAtk) return { ok: false, msg: '该小区正被攻打，战事未了无法放弃~' }
  const name = sectName(f, sid)
  delete f.areas[area]
  if (f.areaDef) delete f.areaDef[area]
  /* 放弃后小区立刻无主可夺: 清掉该小区遗留休战期 */
  if (f.targetCd) delete f.targetCd['area:' + area]
  /* 同步世界税收归属: 不再算给本宗 */
  try { syncWorldSectMap(f, getWorld(gid)) } catch (err) { }
  logEvent(f, 'attack', `【弃地】${name} 放弃【${area}】，小区变为无主之地`, Date.now(), { region: regionOfArea(area), sect: sid })
  saveFake(f, gid)
  return { ok: true, msg: `🏯 ${name} 已放弃【${area}】，小区变为无主之地，各方可自由争夺~` }
}


/* ---------- 上供 / 兑换 ---------- */
export async function offer (gid, uid, amount) {
  const f = getFake(gid)
  const p = f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员~' }
  amount = Math.floor(Number(amount) || 0)
  if (amount < CFG.OFFER_MIN) return { ok: false, msg: `上供最低 ${CFG.OFFER_MIN} 灵石~` }
  const m = await playerMoney(gid, uid)
  if (m.money < amount) return { ok: false, msg: `你的灵石不足（现有 ${m.money}）~` }
  m.home[uid].money = m.money - amount
  await xujing_data.getQQYUserHome(uid, m.home, m.filename, true)
  const s = f.sects[p.sect]
  getVault(f, p.sect).stones = (getVault(f, p.sect).stones || 0) + amount
  /* 核心职位无需贡献点: 上供照常入宝库, 只是不给贡献 */
  const isBoss = p.pos === 'zongzhu' || p.pos === 'fuzong' || p.pos === 'taishang'
  const contrib = isBoss ? 0 : Math.floor(amount / CFG.OFFER_CONTRIB)
  p.contribution = (p.contribution || 0) + contrib
  saveFake(f, gid)
  logEvent(f, 'flavor', `【上供】🌙 玩家 ${p.name} 向 ${s.name} 上供 ${amount} 灵石${isBoss ? '（无需贡献点）' : `，得贡献 +${contrib}`}`)
  return { ok: true, msg: isBoss
    ? `✅ 你已向【${s.name}】上供 ${amount} 灵石（你无需贡献点，灵石已入宗门宝库）`
    : `✅ 你已向【${s.name}】上供 ${amount} 灵石，贡献 +${contrib}（当前 ${p.contribution}）` }
}

/** 一键上供功法: 将玩家背包中红色及以下功法全部移入宗门宝库，不计贡献。 */
export function offerAllGongfa (gid, uid) {
  const f = getFake(gid)
  const p = f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员~' }
  const bag = getBag(uid, gid)
  const vault = getVault(f, p.sect)
  const offered = {}
  let total = 0
  for (const [name, item] of Object.entries(bag.items || {})) {
    const tpl = GONGFA_TPL[name]
    if (!tpl || tpl.quality > 6) continue
    const count = Math.max(0, Math.floor(Number(item && item.count) || 0))
    if (!count) continue
    offered[name] = count
    total += count
    delete bag.items[name]
    vault.gongfas[name] = (vault.gongfas[name] || 0) + count
  }
  if (!total) return { ok: false, msg: '背包中没有可上供的功法（仅限红色及以下品质，彩色功法不可上供）~' }
  saveBag(uid, bag, gid)
  saveFake(f, gid)
  const text = Object.entries(offered).map(([name, count]) => `${itemIcon(name)}《${name}》×${count}`).join('、')
  logEvent(f, 'flavor', `【上供】🌙 玩家 ${p.name} 向 ${sectName(f, p.sect)} 上供功法：${text}`)
  return { ok: true, count: total, msg: `✅ 已将 ${text} 上供给【${sectName(f, p.sect)}】宗门宝库（红色及以下功法可供伪玩家学习，不计贡献）` }
}

export async function exchange (gid, uid, name, count) {
  const f = getFake(gid)
  const p = f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员~' }
  name = String(name || '').trim()
  count = Math.max(1, Math.floor(Number(count) || 1))
  let costPer = 0
  let item = name
  let isStone = false
  let isPill = false
  const isEquip = !!EQUIP_TPL[name]
  const pillNames = Object.keys(CFG.EXCHANGE).filter(n => n !== 'stone')
  if (name === '灵石') { costPer = CFG.EXCHANGE.stone.cost; isStone = true; item = '灵石' }
  else if (pillNames.includes(name)) { costPer = CFG.EXCHANGE[name].cost; isPill = true }
  else if (isEquip) costPer = vaultEquipContrib(name)
  else if (MAT_COMMON.includes(name)) costPer = CFG.MAT_COMMON_COST
  else if (MAT_RED.includes(name)) costPer = CFG.MAT_RED_COST
  else if (MAT_COLOR.includes(name)) costPer = CFG.MAT_COLOR_COST
  else return { ok: false, msg: '可兑换：灵石 / 修为丹 / 破障丹 / 其他丹药 / 材料 / 宝库装备（输入装备全名）' }
  const total = costPer * count
  if ((p.contribution || 0) < total) return { ok: false, msg: `贡献不足（需 ${total}，当前 ${p.contribution || 0}）~` }
  const vault = getVault(f, p.sect)
  if (isStone) {
    const need = CFG.EXCHANGE.stone.unit * count
    if ((vault.stones || 0) < need) return { ok: false, msg: `宝库灵石不足（需 ${need}）~` }
    vault.stones -= need
    const m = await playerMoney(gid, uid)
    m.home[uid].money = m.money + need
    await xujing_data.getQQYUserHome(uid, m.home, m.filename, true)
  } else if (isPill) {
    if ((vault.pills[name] || 0) < count) return { ok: false, msg: `宝库${itemIcon(name)}${name}不足（现有${vault.pills[name] || 0}）~` }
    vault.pills[name] -= count
    if (vault.pills[name] <= 0) delete vault.pills[name]
    addItem(uid, name, count, null, gid)
  } else if (isEquip) {
    if ((vault.equips[name] || 0) < count) return { ok: false, msg: `宝库装备${itemIcon(name)}【${name}】不足（现有${vault.equips[name] || 0}）~` }
    vault.equips[name] -= count
    if (vault.equips[name] <= 0) delete vault.equips[name]
    for (const group of takeVaultEquipAttrs(vault, name, count)) addItem(uid, name, group.count, group.attr, gid)
  } else {
    if ((vault.mats[name] || 0) < count) return { ok: false, msg: `宝库${itemIcon(name)}${name}不足（现有 ${vault.mats[name] || 0}）~` }
    vault.mats[name] -= count
    if (vault.mats[name] <= 0) delete vault.mats[name]
    addItem(uid, name, count, null, gid)
  }
  p.contribution -= total
  saveFake(f, gid)
  return { ok: true, msg: `✅ 你已用 ${total} 贡献兑换 ${itemIcon(item)}${item} ${isStone ? CFG.EXCHANGE.stone.unit * count : count}${isStone ? '灵石' : ''}（剩余贡献 ${p.contribution}）` }
}


/** 玩家宗门弟子: 真实玩家与伪玩家均按弟子身份领取自动俸禄。 */
export function salaryRecipients (f, sid) {
  const fakes = Object.values(f.roster || {}).filter(p =>
    p && p.alive && p.status === 'sect' && p.sect === sid && p.pos === 'dizi')
  const players = Object.entries(f.players || {})
    .filter(([, p]) => p && p.sect === sid && p.pos === 'dizi')
    .map(([uid, p]) => ({ uid: String(uid), player: p }))
  return { fakes, players }
}

/**
 * 玩家主导宗门每小时自动发放弟子俸禄。
 * 结算按宗门独立计时；宝库不足时整宗跳过，避免同一小时只发到部分弟子。
 * opts 仅供测试注入玩家存档读写，生产环境使用真实玩家数据接口。
 */
export async function payPlayerSectSalaries (f, gid, now = Date.now(), opts = {}) {
  const loadPlayer = opts.loadPlayer || playerMoney
  const savePlayer = opts.savePlayer || (async (loaded) => {
    await xujing_data.getQQYUserHome(loaded.uid, loaded.home, loaded.filename, true)
  })
  const report = { changed: false, paid: 0, skipped: 0, amount: 0 }
  for (const [sid, s] of Object.entries(f.sects || {})) {
    if (!s || !isPlayerLead(f, sid) || (s.wipeAt && s.wipeAt <= now)) continue
    const ownerKey = String(s.owner)
    /* 玩家接管/换任宗主时从接管时刻起算，不把伪玩家时期或前任宗主时期的时间追溯成工资。 */
    if (s.salaryOwner !== ownerKey) {
      s.salaryOwner = ownerKey
      s.lastSalaryAt = now
      report.changed = true
      continue
    }
    /* 旧存档首次升级时从现在开始计时，不追溯停机期间的俸禄。 */
    if (s.lastSalaryAt === undefined || !Number.isFinite(Number(s.lastSalaryAt))) {
      s.lastSalaryAt = now
      report.changed = true
      continue
    }
    const last = Number(s.lastSalaryAt) || 0
    if (now - last < CFG.SALARY_INTERVAL) continue
    const { fakes, players } = salaryRecipients(f, sid)
    const count = fakes.length + players.length
    s.lastSalaryAt = now
    report.changed = true
    if (!count) continue
    const total = count * CFG.SALARY_PER_MEMBER
    const vault = getVault(f, sid)
    if ((Number(vault.stones) || 0) < total) {
      report.skipped += count
      logEvent(f, 'flavor', `【俸禄】${s.name} 宝库不足，本小时无法向 ${count} 名弟子发放俸禄（需 ${total} 灵石）`, now, { sect: sid })
      continue
    }
    /* 先准备真实玩家存档，按存档文件合并写入，避免同群多名弟子各写一次造成覆盖。 */
    const loadedByFile = new Map()
    try {
      for (const { uid } of players) {
        const loaded = await loadPlayer(gid, uid)
        if (!loaded || !loaded.home || !loaded.home[uid]) throw new Error(`玩家存档不存在: ${uid}`)
        const key = String(loaded.filename || gid)
        let batch = loadedByFile.get(key)
        if (!batch) {
          batch = { ...loaded, uids: [] }
          loadedByFile.set(key, batch)
        }
        batch.uids.push(uid)
      }
      for (const batch of loadedByFile.values()) {
        for (const uid of batch.uids) {
          batch.home[uid].money = (Number(batch.home[uid].money) || 0) + CFG.SALARY_PER_MEMBER
        }
        await savePlayer({ ...batch, uid: batch.uids[0] })
      }
    } catch (err) {
      /* 本轮不扣宝库；写入失败时下个小时继续尝试，避免每分钟反复记录异常。 */
      s.lastSalaryAt = now
      report.skipped += count
      console.log(`[宗门系统]俸禄发放异常(${sid}):`, err && err.stack)
      continue
    }
    for (const p of fakes) p.money = (Number(p.money) || 0) + CFG.SALARY_PER_MEMBER
    vault.stones -= total
    report.paid += count
    report.amount += total
    logEvent(f, 'flavor', `【俸禄】${s.name} 向 ${count} 名弟子发放本小时俸禄，共 ${total} 灵石`, now, { sect: sid })
  }
  return report
}

/** 旧命令保留为兼容入口；俸禄已由宗门每小时自动发放，避免手动重复领取。 */
export async function claimSalary (f, gid, uid) {
  const p = f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员~' }
  const s = f.sects[p.sect]
  if (!s) return { ok: false, msg: '宗门不存在~' }
  if (p.pos !== 'dizi') return { ok: false, boss: true, msg: `${posCnOf(p.pos)}无需领取弟子俸禄；宗门宝库可由核心职位按权限取用~` }
  if (!isPlayerLead(f, p.sect)) return { ok: false, msg: `【${s.name}】是伪玩家宗门，不发放玩家弟子俸禄~` }
  return { ok: false, msg: `俸禄已由【${s.name}】每小时自动发放，每名弟子 ${CFG.SALARY_PER_MEMBER} 灵石，无需手动领取~` }
}

/* ---------- 取用宝库: 名称与数量均支持模糊输入 ---------- */
const VAULT_COUNT_MULT = { 万: 10000, 千: 1000, 亿: 100000000 }

/** 数量文本解析: 纯数字 / 万·千·亿 单位(5万=50000, 万=10000) / 全部·全(取光)。返回 { n } 或 { all:true }; 不匹配返回 null */
function parseVaultCount (t) {
  if (!t) return null
  if (t === '全部' || t === '全') return { all: true }
  if (/^[0-9]+$/.test(t)) return { n: Number(t) }
  const m = t.match(/^([0-9]*)(万|千|亿)$/)
  if (m) return { n: (m[1] ? Number(m[1]) : 1) * VAULT_COUNT_MULT[m[2]] }
  return null
}

/**
 * 乱序解析取用宝库文本: 物品名与数量可任意顺序、可带可不带空格。
 * 支持 名5 / 5名 / 名 5 / 5 名 / 名×5 / 5个名 / 名5个 / 全部 等写法;
 * 数量支持 万/千/亿 单位与 全部/全(取光)。返回 { name, count, all }; 无有效物品名返回 null。
 */
export function parseVaultTake (text) {
  const tokens = String(text || '').split(/[\s,，、]+/).filter(Boolean)
  let name = ''
  let count = 1
  let all = false
  for (const raw of tokens) {
    const t = String(raw).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    /* 纯数量(数字/万·千·亿单位/全部/全) 优先, 避免被名称拆分规则误切 */
    let q = parseVaultCount(t)
    if (q) { if (q.all) all = true; else count = q.n; continue }
    /* 前导 × 的数量(灵石 ×100 / 灵石 ×5万) */
    if (/^[x×*]/.test(t)) {
      q = parseVaultCount(t.replace(/^[x×*]+/, ''))
      if (q) { if (q.all) all = true; else count = q.n; continue }
    }
    /* 全部+名 / 名+全部(无空格) */
    let m = t.match(/^(全部|全)(.+)$/)
    if (m) { all = true; name = m[2].trim(); continue }
    m = t.match(/^(.+?)(全部|全)$/)
    if (m) { all = true; name = m[1].trim(); continue }
    /* 名x数量 */
    m = t.match(/^(.+?)[x×*](.+)$/)
    if (m) {
      const q2 = parseVaultCount(m[2])
      if (q2) { name = m[1].trim(); if (q2.all) all = true; else count = q2.n }
      else name = name ? `${name}${t}` : t
      continue
    }
    /* 数量个名 */
    m = t.match(/^([0-9]+)个(.+)$/)
    if (m) { name = m[2].trim(); count = Number(m[1]); continue }
    /* 名数量个 */
    m = t.match(/^(.+?)([0-9]+)个$/)
    if (m) { name = m[1].trim(); count = Number(m[2]); continue }
    /* 名数量单位(灵石5万) */
    m = t.match(/^(.+?)([0-9]+)(万|千|亿)$/)
    if (m) { name = m[1].trim(); count = Number(m[2]) * VAULT_COUNT_MULT[m[3]]; continue }
    /* 数量单位名(5万灵石) */
    m = t.match(/^([0-9]+)(万|千|亿)(.+)$/)
    if (m) { name = m[3].trim(); count = Number(m[1]) * VAULT_COUNT_MULT[m[2]]; continue }
    /* 名单位(灵石万=1万) */
    m = t.match(/^(.+?)(万|千|亿)$/)
    if (m) { name = m[1].trim(); count = VAULT_COUNT_MULT[m[2]]; continue }
    /* 名数量(灵石5000) */
    m = t.match(/^(.+?)([0-9]+)$/)
    if (m) { name = m[1].trim(); count = Number(m[2]); continue }
    /* 数量名(5000灵石) */
    m = t.match(/^([0-9]+)(.+)$/)
    if (m) { name = m[2].trim(); count = Number(m[1]); continue }
    /* 其余当作物品名(多词物品名拼接) */
    name = name ? `${name}${t}` : t
  }
  if (!name) return null
  return { name, count, all: !!all }
}

/**
 * 宝库物品名模糊解析(精确优先): 在 材料/丹药/装备 三仓中精确命中优先;
 * 否则做包含匹配(输入是物品名子串, 或物品名是输入子串)取唯一命中。
 * 命中唯一 → { name, have, needChoice:false }; 命中多个 → { needChoice:true, choices };
 * 无命中 → { name:null }。have 为该物品三仓合计现存数。
 */
export function resolveVaultName (vault, name) {
  if (!name) return { name: null }
  const groups = [['mats', vault.mats], ['pills', vault.pills], ['equips', vault.equips]]
  const sumOf = key => groups.reduce((sum, [, map]) => sum + ((map && map[key] > 0) ? map[key] : 0), 0)
  /* 精确命中(同名的 材料/丹药/装备 合计) */
  if (sumOf(name) > 0) return { name, have: sumOf(name), needChoice: false }
  /* 模糊包含匹配 */
  const cands = []
  for (const [, map] of groups) {
    if (!map) continue
    for (const [key, c] of Object.entries(map)) {
      if (c > 0 && (key.includes(name) || name.includes(key))) cands.push(key)
    }
  }
  const uniq = [...new Set(cands)]
  if (uniq.length === 1) return { name: uniq[0], have: sumOf(uniq[0]), needChoice: false }
  if (uniq.length > 1) return { needChoice: true, choices: uniq }
  return { name: null }
}

/** 核心职位取用宗门金库: 灵石/材料/丹药/装备(三种核心职位权力一致, 可自由取用; 名称与数量均支持模糊输入) */
export async function takeFromVault (f, gid, uid, name, count) {
  const p = f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员~' }
  if (p.pos !== 'zongzhu' && p.pos !== 'fuzong' && p.pos !== 'taishang') return { ok: false, msg: '只有宗主/副宗主/太上长老可以取用宗门金库~' }
  const sid = p.sect
  const s = f.sects[sid]
  if (!s) return { ok: false, msg: '宗门不存在~' }
  const vault = getVault(f, sid)
  name = String(name || '').trim()
  if (!name) return { ok: false, msg: '用法：#取用宝库 [灵石|物品名] [数量]（宗主/副宗/太上可自由取用）' }
  const posCn = posCnOf(p.pos)
  const all = count === 'all' || count === '全部' || count === '全'
  const want = all ? Infinity : Math.max(1, Math.floor(Number(count) || 1))

  /* 灵石(单独仓库) */
  if (name === '灵石') {
    const have = vault.stones || 0
    const n = all ? have : want
    if (n <= 0 || have < n) return { ok: false, msg: `宝库灵石不足（现有 ${have}）~` }
    vault.stones -= n
    const m = await playerMoney(gid, uid)
    m.home[uid].money = (Number(m.home[uid].money) || 0) + n
    await xujing_data.getQQYUserHome(uid, m.home, m.filename, true)
    saveFake(f, gid)
    logEvent(f, 'flavor', `【取用】🌙 ${posCn} ${p.name} 从宗门金库取用 ${n} 灵石`)
    return { ok: true, msg: `✅ 你已从宗门金库取用 ${n} 灵石（宝库剩 ${vault.stones || 0}）~` }
  }

  /* 名称模糊解析: 精确 → 唯一模糊 → 多个列出 → 无命中 */
  const hit = resolveVaultName(vault, name)
  if (hit.needChoice) return { ok: false, msg: `“${name}”可对应多个宝库物品：${hit.choices.map(n => fmtItem(n)).join('、')}，请用全名再取用~` }
  if (!hit.name) return { ok: false, msg: `宝库中没有找到“${name}”（先 #宗门宝库 看看有什么）~` }
  const real = hit.name
  const n = all ? hit.have : want
  if (n <= 0 || hit.have < n) return { ok: false, msg: `宝库${itemIcon(real)}${real}不足（现有 ${hit.have}）~` }
  /* 按仓扣减: 材料→丹药→装备 顺位, 直到扣够 */
  const inMats = (vault.mats && vault.mats[real]) || 0
  const inPills = (vault.pills && vault.pills[real]) || 0
  const inEquips = (vault.equips && vault.equips[real]) || 0
  let remain = n
  if (inMats > 0) {
    const take = Math.min(remain, inMats)
    vault.mats[real] -= take
    if (vault.mats[real] <= 0) delete vault.mats[real]
    remain -= take
  }
  if (remain > 0 && inPills > 0) {
    const take = Math.min(remain, inPills)
    vault.pills[real] -= take
    if (vault.pills[real] <= 0) delete vault.pills[real]
    remain -= take
  }
  if (remain > 0) {
    vault.equips[real] -= remain
    if (vault.equips[real] <= 0) delete vault.equips[real]
  }
  if (EQUIP_TPL[real]) {
    for (const group of takeVaultEquipAttrs(vault, real, n)) addItem(uid, real, group.count, group.attr, gid)
  } else addItem(uid, real, n, null, gid)
  saveFake(f, gid)
  logEvent(f, 'flavor', `【取用】🌙 ${posCn} ${p.name} 从宗门金库取用 ${itemIcon(real)}${real}×${n}`)
  return { ok: true, msg: `✅ 你已从宗门金库取用 ${itemIcon(real)}${real}×${n}~` }
}

/** 宗门弟子从宝库购丹: 价格 = 丹阁价 × VAULT_PILL_DISCOUNT(80%), 付的灵石直接进宝库, 不交税 */
export async function buyPillFromVault (gid, uid, name, count) {
  const f = getFake(gid)
  const p = f.players && f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员~' }
  name = String(name || '').trim()
  count = Math.max(1, Math.floor(Number(count) || 1))
  const market = CFG.VAULT_PILL_PRICE[name]
  if (!market) return { ok: false, msg: '宝库可购丹药：修为丹 / 破障丹 / 聚宝丹~' }
  const vault = getVault(f, p.sect)
  if ((vault.pills[name] || 0) < count) return { ok: false, msg: `宝库${itemIcon(name)}${name}不足（现有 ${vault.pills[name] || 0}）~` }
  const unit = Math.floor(market * CFG.VAULT_PILL_DISCOUNT)
  const total = unit * count
  const m = await playerMoney(gid, uid)
  if (m.money < total) return { ok: false, msg: `你的灵石不足（${itemIcon(name)}${name}×${count} 需 ${total}，现有 ${m.money}）~` }
  m.home[uid].money = m.money - total
  await xujing_data.getQQYUserHome(uid, m.home, m.filename, true)
  /* 灵石直接进宗门宝库(不交税) */
  vault.stones = (vault.stones || 0) + total
  vault.pills[name] -= count
  if (vault.pills[name] <= 0) delete vault.pills[name]
  addItem(uid, name, count, null, gid)
  const s = f.sects[p.sect]
  logEvent(f, 'flavor', `【购丹】🌙 弟子 ${p.name} 花 ${total} 灵石从【${s ? s.name : ''}】宝库购得 ${itemIcon(name)}${name} ×${count}（灵石入宝库，不交税）`)
  saveFake(f, gid)
  return { ok: true, msg: `✅ 你已花 ${total} 灵石从宝库购得 ${itemIcon(name)}${name} ×${count}（丹阁价 ${market}，${Math.round(CFG.VAULT_PILL_DISCOUNT * 100)}%购入，灵石已入宗门宝库）` }
}


/* ---------- 创建宗门 / 伪玩家补齐 ---------- */
export function drawNewSectName (f) {
  try {
    const pool = JSON.parse(fs.readFileSync(SECT_FILE, 'utf8'))
    const used = new Set(Object.values(f.sects || {}).map(s => s && s.name))
    const avail = pool.filter(n => !used.has(n))
    return avail.length ? pick(avail) : null
  } catch (err) { return null }
}

export function nextSectId (f) {
  let seq = (f.sectSeq || 0)
  let id
  do { seq++; id = `sect_${seq}` } while (f.sects[id])
  f.sectSeq = seq
  return id
}

export async function createPlayerSect (f, gid, uid, name, regionKey, nickname) {
  name = String(name || '').trim()
  if (!name) return { ok: false, msg: '用法：#创建宗门 [宗门名]（可加 [大区名] 自选位置）' }
  if (name.length > 6) return { ok: false, msg: '宗门名请控制在 6 字以内~' }
  if (sectIdByName(f, name)) return { ok: false, msg: '已有同名宗门~' }
  if (f.players[String(uid)]) return { ok: false, msg: '你已有宗门，无法创建~' }
  /* 玩家创建宗门不占伪玩家名额、不受 MAX_SECTS 上限限制(每人限1个已由上面"已有宗门"拦截) */
  const w = getWorld(gid)
  const region = regionKey || getLoc(w, uid) || DEFAULT_REGION
  const rate = Number(w.rates[region]) || 25
  const cost = Math.round(CFG.CREATE_COST_BASE + ((rate - 10) / 40) * CFG.CREATE_COST_SPREAD)
  const m = await playerMoney(gid, uid)
  if (m.money < cost) return { ok: false, msg: `灵石不足（创建宗门需 ${cost} 灵石，按${regionNameOf(region)}税率 ${rate}% 计算；你现有 ${m.money}）~` }
  m.home[uid].money = m.money - cost
  await xujing_data.getQQYUserHome(uid, m.home, m.filename, true)
  const id = nextSectId(f)
  const now = Date.now()
  f.sects[id] = {
    name, foundedAt: now, wipeAt: 0, rebuildAt: 0, recruit: { next: now + 3600000 },
    facilities: { yanwu: 0, hushan: 0, lingmai: 0, yaoyuan: 1 },
    vault: { stones: CFG.CREATE_VAULT, mats: {}, pills: {} },
    owner: String(uid), enemies: [], allies: [], region, createdAt: now, lastSalaryAt: now, salaryOwner: String(uid)
  }
  f.sectMap[id] = { zongzhu: null, fuzong: [], taishang: [], zhishi: [], dizi: [] }
  f.players[String(uid)] = { name: nickname || String(uid), sect: id, pos: 'zongzhu', joinAt: now, contribution: 0 }
  /* 玩家宗门繁荣度初始化(维护/小区产出依赖; 初始与江湖宗门一致) */
  w.prosperity[name] = 1000
  saveWorld(w)
  logEvent(f, 'player', `【开宗】🌙 玩家于${regionNameOf(region)}开宗立派，创立【${name}】！`, now, { major: true })
  saveFake(f, gid)
  return { ok: true, msg: `🏯 你已在${regionNameOf(region)}创立【${name}】并自任宗主！\n初始宝库 ${CFG.CREATE_VAULT} 灵石，无地盘需 #攻打 夺取（#天下小区 看地盘）` }
}

/** 宗门改名: 校验 + 改名 + 迁移世界经济归属(繁荣/税收/地图) + 敌我/结盟关系旧名替换 */
export function renameSectName (f, gid, sid, newName) {
  const s = f.sects[sid]
  if (!s) return { ok: false, msg: '宗门不存在~' }
  newName = String(newName || '').trim()
  if (!newName) return { ok: false, msg: '用法：#宗门改名 [新名字]' }
  if (newName.length > 6) return { ok: false, msg: '宗门名请控制在 6 字以内~' }
  if (newName === s.name) return { ok: false, msg: '新名字和现在的一样~' }
  const other = sectIdByName(f, newName)
  if (other && other !== sid) return { ok: false, msg: '已有同名宗门~' }
  const oldName = s.name
  s.name = newName
  /* 迁移世界经济归属(繁荣度/税收/占领地图), 老名字清除 */
  try { renameSect(getWorld(gid), oldName, newName) } catch (err) { }
  /* 敌我/结盟关系里若存的是旧名(伏击结怨/散修记仇等), 同步替换为新名 */
  for (const id of Object.keys(f.sects || {})) {
    const x = f.sects[id]
    if (Array.isArray(x.enemies)) x.enemies = x.enemies.map(v => (v === oldName ? newName : v))
    if (Array.isArray(x.allies)) x.allies = x.allies.map(v => (v === oldName ? newName : v))
  }
  logEvent(f, 'rebuild', `【改名】🏯【${oldName}】正式更名为【${newName}】！`, Date.now(), { major: true })
  saveFake(f, gid)
  return { ok: true, msg: `✅ 已更名为【${newName}】！（原【${oldName}】）` }
}

/** 迁宗: 宗门总部迁往新大区(旧区地盘保留, 跨区占地); 校验宗门战/冷却/宝库后扣灵石改 s.region */
export function relocateSect (f, gid, sid, newRegion) {
  const s = f.sects[sid]
  if (!s) return { ok: false, msg: '宗门不存在~' }
  const cur = sectRegion(f, sid)
  if (cur === newRegion) return { ok: false, msg: `宗门总部已经在${regionNameOf(newRegion)}了~` }
  const now = Date.now()
  /* 宗门战进行中(本宗在打人/总部被攻/小区被攻) → 禁止迁宗 */
  const busy = (f.sectAttacks || []).some(a => a.phase !== 'done' && (
    a.atkSect === sid ||
    (a.targetType === 'sect' && a.target === sid) ||
    (a.targetType === 'area' && f.areas && f.areas[a.target] === sid)
  ))
  if (busy) return { ok: false, msg: '宗门战进行中（本宗正在攻打或被攻打），无法迁宗~' }
  /* 冷却 24 小时 */
  if (s.moveAt && now - s.moveAt < CFG.MOVE_CD) {
    const left = Math.ceil((CFG.MOVE_CD - (now - s.moveAt)) / 3600000)
    return { ok: false, msg: `迁宗冷却中，还需 ${left} 小时才能再次迁宗~` }
  }
  /* 宝库扣灵石 */
  const cost = CFG.MOVE_COST
  const stones = (s.vault && s.vault.stones) || 0
  if (stones < cost) return { ok: false, msg: `宗门宝库灵石不足（迁宗需 ${cost} 灵石，现有 ${stones}）~` }
  s.vault.stones = stones - cost
  s.region = newRegion
  s.moveAt = now
  logEvent(f, 'rebuild', `【迁宗】🏯【${s.name}】由${regionNameOf(cur)}举宗迁往${regionNameOf(newRegion)}！（消耗 ${cost} 灵石，旧区地盘保留）`, now, { major: true })
  saveFake(f, gid)
  return { ok: true, msg: `🏯【${s.name}】已迁宗至${regionNameOf(newRegion)}！\n（旧区【${regionNameOf(cur)}】地盘保留，总部现驻${regionNameOf(newRegion)}，门人可跨区守地）\n消耗宝库 ${cost} 灵石，冷却 24 小时。` }
}

/** 伪玩家宗门补齐: 伪玩家宗门数(无玩家宗主) < MAX_SECTS 时自动创建补齐
 *  玩家创建的宗门不占名额; 灭门宗门不顶替(由 fake_data rebuildSettle 5~30分钟换皮重生) */
export function fillSects (f, now = Date.now()) {
  if (Object.values(f.roster || {}).filter(p => p?.alive).length >= FAKE_MAX) return 0
  let made = 0
  const aiCnt = Object.values(f.sects || {}).filter(s => s && !s.owner).length
  while (aiCnt + made < CFG.MAX_SECTS) {
    if (Object.values(f.roster || {}).filter(p => p?.alive).length >= FAKE_MAX) break
    const zz = drawName(f)
    if (!zz) break
    const name = drawNewSectName(f)
    if (!name) break
    const id = nextSectId(f)
    f.sects[id] = {
      name, foundedAt: now, wipeAt: 0, rebuildAt: 0, recruit: { next: now + rand([2, 6]) * 3600000 },
      facilities: { yanwu: 0, hushan: 0, lingmai: 0, yaoyuan: 1 },
      vault: { stones: CFG.INIT_VAULT, mats: {}, pills: {} },
      owner: null, enemies: [], allies: [], region: 'center', createdAt: 0
    }
    f.sectMap[id] = { zongzhu: zz, fuzong: [], taishang: [], zhishi: [], dizi: [] }
    /* 新宗主从低境界起步, 靠修炼/突破自然成长(不凭空给高境界) */
    addPerson(f, zz, id, 'zongzhu', rand(SECT_START_BAND.zongzhu))
    const dn = rand([3, 6])
    for (let i = 0; i < dn; i++) {
      const n = drawName(f)
      if (n) addPerson(f, n, id, 'dizi', 1)
    }
    logEvent(f, 'rebuild', `【开宗】散修 ${zz} 于中州开宗立派，创立【${name}】`, now, { major: true })
    made++
  }
  return made
}


/* ---------- 玩家宗门材料维护(按人数/战后翻倍) ---------- */
/** 宗门名册总人数: 伪玩家门人(含秘境中/被俘/关押; 死亡时已从 roster 删除) + 玩家门人 */
export function sectMemberCount (f, id) {
  let n = 0
  for (const p of Object.values(f.roster || {})) {
    if (p && p.sect === id && p.status === 'sect') n++
  }
  for (const p of Object.values(f.players || {})) {
    if (p && p.sect === id) n++
  }
  return n
}

/** 玩家宗门每占领小区每次结算(30分钟)的材料维护件数: 按名册人数占满员比例 —— 1 人 1 件、满员(sectCap=20+演武场×10) 9 件封顶; 战后 3 小时 ×2 */
export function sectMatUpkeepPieces (f, id, now = Date.now()) {
  const cap = Math.max(1, Number(sectCap(f, id)) || 1)
  const n = Math.max(1, sectMemberCount(f, id))
  const base = Math.max(1, Math.min(9, Math.ceil(n * 9 / cap)))
  return inWarUpkeep(f, id, now) ? base * WAR_UPKEEP_MAT_MULT : base
}

/** 从宗门宝库按库存从多到少扣基础材料; 库存不够扣到 0(不降级不惩罚), 返回实际扣除件数 */
export function deductVaultMatsByStock (f, id, pieces) {
  const vault = getVault(f, id)
  if (!vault || !(Number(pieces) > 0)) return 0
  let left = Math.floor(Number(pieces))
  let taken = 0
  while (left > 0) {
    const avail = MAT_COMMON.filter(m => (vault.mats[m] || 0) > 0)
    if (!avail.length) break
    avail.sort((a, b) => (vault.mats[b] || 0) - (vault.mats[a] || 0))
    for (const m of avail) {
      if (left <= 0) break
      vault.mats[m] = (vault.mats[m] || 0) - 1
      if (vault.mats[m] <= 0) delete vault.mats[m]
      left--
      taken++
    }
  }
  return taken
}

/* ---------- 小区产出 / 自动炼丹 / 税收分成 ---------- */
export function hourlyAreaOutput (f, now, w, { raidedOnly = false } = {}) {
  let changed = false
  for (const [area, owner] of Object.entries(f.areas || {})) {
    if (!owner) continue
    const s = f.sects[owner]
    if (!s || (s.wipeAt && s.wipeAt <= now)) continue
    /* 小区被打后 3 小时内没有任何收益(灵石/材料都不产) */
    const raided = areaInRaidRest(f, area, now)
    if (raided) continue
    const raidAt = Number(f.areaRaidAt && f.areaRaidAt[area]) || 0
    if (raidAt > 0) {
      /* 恢复期结束后重新计满30分钟; 后续按本小区上次产出独立计时。
       * 旧档没有独立时间时沿用最近产出记录, 避免更新后重复发放。 */
      const previous = f.areaOutputAt && f.areaOutputAt[area]
      const history = previous ? null : (f.areaOut || []).findLast(out => out.area === area)
      const since = Math.max(raidAt + AREA_RAID_REST_MS, Number(previous) || Number(history && history.t) || 0)
      if (now - since < 30 * 60000) continue
    } else if (raidedOnly) continue
    const prosperity = Number(w.prosperity && w.prosperity[s.name]) || 1000
    const coef = clamp(prosperity / 1000, 0.5, 3)
    let stones = Math.round(rand(CFG.AREA_OUT_STONES) * coef * 3)
    const lingmai = (s.facilities && s.facilities.lingmai) || 0
    stones = Math.round(stones * (1 + 0.1 * lingmai))
    getVault(f, owner).stones = (getVault(f, owner).stones || 0) + stones
    const mats = {}
    const n = rand(CFG.AREA_OUT_MATS) * 3
    /* 红材料(凤栖花/凤羽玉)再减少一倍: 抽中仅50%实际产出(2026-08-17) */
    for (let i = 0; i < n; i++) {
      const m = pick(MAT_POOL)
      if ((m === '凤栖花' || m === '凤羽玉') && Math.random() < 0.5) continue
      mats[m] = (mats[m] || 0) + 1
    }
    for (const [m, c] of Object.entries(mats)) getVault(f, owner).mats[m] = (getVault(f, owner).mats[m] || 0) + c
    f.areaOut.push({ t: now, area, stones, mats, owner: s.name, def: areaDefLevel(f, area) })
    if (f.areaOut.length > 400) f.areaOut = f.areaOut.slice(-400)
    if (raidAt > 0) {
      if (!f.areaOutputAt || typeof f.areaOutputAt !== 'object') f.areaOutputAt = {}
      f.areaOutputAt[area] = now
    }
    changed = true
  }
  return changed
}

/* 宗门炼丹丹方(与玩家配方台一致): 只炼增益丹——修为丹/破障丹由药园产出, 宗门不炼 */
const SECT_REFINE_RECIPES = {
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
/* 宗门炼装配方(与玩家一致): 红装=5种非彩色矿物各1; 彩装=6造梦神玉 */
const SECT_RED_ORE = ['月魄石', '星璇石', '流光玉', '织云石', '凤羽玉']
const SECT_COLOR_ORE = '造梦神玉'
/** 宝库中指定品质的装备件数 */
function vaultEquipCount (vault, quality) {
  let n = 0
  for (const [name, cnt] of Object.entries(vault.equips || {})) {
    const t = EQUIP_TPL[name]
    if (t && (!quality || t.quality === quality)) n += cnt
  }
  return n
}

/** 宗门自动生产(每30分钟): 材料 → 增益丹(九类合计动态上限约100) + 红装(上限10件) + 彩装(上限2件) 入宝库;
 *  修为丹/破障丹由药园产出, 不参与炼丹库存上限; 升级设施/护城阵所需材料一律保留(×2)不被消耗 */
export function autoRefine (f) {
  for (const id of Object.keys(f.sects)) {
    const s = f.sects[id]
    const vault = getVault(f, id)
    /* 保留升级设施/护城阵所需的材料 ×2 —— 只有超出保留量的材料才允许炼丹/炼装(不会被升级吃掉) */
    const keep = {}
    const mergeKeep = (mats) => {
      for (const [m, c] of Object.entries(mats || {})) keep[m] = Math.max(keep[m] || 0, Math.ceil(c))
    }
    for (const fac of Object.keys(CFG.FACILITIES)) {
      const cur = (s.facilities && s.facilities[fac]) || 0
      if (cur >= 5) continue
      const c = facilityCost(fac, cur + 1)
      if (c && c.mats) mergeKeep(c.mats)
    }
    /* 护城阵: 该宗门占领小区的下一级(玩家全价比例) */
    for (const [area, owner] of Object.entries(f.areas || {})) {
      if (owner !== id) continue
      const lv = areaDefLevel(f, area)
      if (lv >= 5) continue
      const base = facilityCost('hushan', lv + 1)
      if (!base || !base.mats) continue
      const m2 = {}
      for (const [m, c] of Object.entries(base.mats)) m2[m] = Math.max(1, Math.round(c * CFG.AREA_DEF_RATIO))
      mergeKeep(m2)
    }
    const members = Math.max(1, sectAlive(f, id).length)
    /* 只统计炼丹产出的增益丹；药园的修为丹/破障丹完全独立，不占这个库存额度 */
    const pillCap = Math.max(100, members * 5)
    const redCap = Math.min(10, Math.max(2, Math.ceil(members / 8)))
    const colorCap = Math.min(2, Math.max(1, Math.ceil(members / 30)))
    /* 只为下一次设施/护城升级保留一份缓冲，富余材料允许继续生产 */
    const have = (m) => Math.max(0, (vault.mats[m] || 0) - (keep[m] || 0))
    const takeMats = (mats) => {
      for (const [m, c] of Object.entries(mats)) {
        if (have(m) < c) return false
      }
      for (const [m, c] of Object.entries(mats)) { vault.mats[m] -= c; if (vault.mats[m] <= 0) delete vault.mats[m] }
      return true
    }
    /* 增益丹共享动态总库存上限，按当前库存从少到多优先炼制 */
    const recipes = Object.entries(SECT_REFINE_RECIPES).sort((a, b) => (vault.pills[a[0]] || 0) - (vault.pills[b[0]] || 0))
    const refinePillTotal = () => recipes.reduce((sum, [pill]) => sum + (vault.pills[pill] || 0), 0)
    for (const [pill, mats] of recipes) {
      if (refinePillTotal() >= pillCap) break
      if (mats.some(([m, c]) => have(m) < c)) continue
      if (takeMats(Object.fromEntries(mats))) vault.pills[pill] = (vault.pills[pill] || 0) + 1
    }
    /* 2. 炼红装(5种非彩色矿物各1 → 随机红装入宝库，按成员槽位目标且保留硬上限) */
    const reds = Object.keys(EQUIP_TPL).filter(k => EQUIP_TPL[k].quality === 6)
    if (reds.length && vaultEquipCount(vault, 6) < redCap) {
      const mats = {}
      for (const m of SECT_RED_ORE) mats[m] = 1
      if (takeMats(mats)) {
        const r = pick(reds)
        if (!vault.equips) vault.equips = {}
        vault.equips[r] = (vault.equips[r] || 0) + 1
      }
    }
    /* 3. 炼彩装(6造梦神玉 → 随机彩装入宝库, 上限2件; 彩矿稀有, 炼出即镇宗之宝) */
    const colors = Object.keys(EQUIP_TPL).filter(k => EQUIP_TPL[k].quality === 7)
    if (colors.length && vaultEquipCount(vault, 7) < colorCap && have(SECT_COLOR_ORE) >= 6) {
      if (takeMats({ [SECT_COLOR_ORE]: 6 })) {
        const c = pick(colors)
        if (!vault.equips) vault.equips = {}
        vault.equips[c] = (vault.equips[c] || 0) + 1
      }
    }
  }
}

/** 药园每小时产出: 修为丹/破障丹各自库存上限=max(20,在宗伪玩家数×3)，满仓暂停；这两类丹药不由材料炼制 */
export function yaoyuanOutput (f, now = Date.now()) {
  for (const [id, s] of Object.entries(f.sects || {})) {
    if (!s || s.wipeAt) continue
    const lv = (s.facilities && s.facilities.yaoyuan) || 0
    if (lv <= 0) continue
    const vault = getVault(f, id)
    const members = sectAlive(f, id).length
    const pillCap = Math.max(20, members * 3)
    const xi = Math.min(Math.round(5 + (lv - 1) * 11.25), Math.max(0, pillCap - (vault.pills['修为丹'] || 0)))
    const po = Math.min(Math.round(3 + (lv - 1) * 6.75), Math.max(0, pillCap - (vault.pills['破障丹'] || 0)))
    if (xi <= 0 && po <= 0) continue
    vault.pills['修为丹'] = (vault.pills['修为丹'] || 0) + xi
    vault.pills['破障丹'] = (vault.pills['破障丹'] || 0) + po
    logEvent(f, 'flavor', `【药园】${s.name} 药园成熟，收获 ${itemIcon('修为丹')}修为丹×${xi}、${itemIcon('破障丹')}破障丹×${po}`, now)
  }
}

/** 同步税收归属(w.sectMap)与玩家宗门占领(f.areas):
 *  小区易主/宗门覆灭重建后 w.sectMap 仍指向旧宗门名 → 税收/繁荣/税率全算到旧宗门头上。
 *  以 f.areas 为唯一事实来源, 把 w.sectMap 对齐为当前占领宗门名(无主/失效则清除)。 */
export function syncWorldSectMap (f, w) {
  if (!w || !w.sectMap) return false
  let changed = false
  /* 1. 清除 w.sectMap 中已不在 f.areas 的小区(无主/失效) */
  for (const area of Object.keys(w.sectMap)) {
    if (!f.areas || !(area in f.areas)) { delete w.sectMap[area]; changed = true }
  }
  /* 2. f.areas 中每个小区 → 对齐为当前占领宗门名 */
  for (const [area, owner] of Object.entries(f.areas || {})) {
    if (!owner) {
      if (w.sectMap[area]) { delete w.sectMap[area]; changed = true }
      continue
    }
    const name = sectName(f, owner)
    if (!name || name === '未知') {
      if (w.sectMap[area]) { delete w.sectMap[area]; changed = true }
      continue
    }
    if (w.sectMap[area] !== name) { w.sectMap[area] = name; changed = true }
  }
  if (changed) saveWorld(w)
  return changed
}

export function taxShareToVault (f, w) {
  for (const id of Object.keys(f.sects)) {
    const s = f.sects[id]
    if (!s || !s.name) continue
    /* 税收灵石只归玩家主导的宗门(玩家宗主受益); 伪玩家宗门只吃繁荣度, 不拿灵石 */
    if (!s.owner) continue
    const pend = Number(w.pendingTax && w.pendingTax[s.name]) || 0
    if (pend <= 0) continue
    const share = Math.floor(pend * CFG.TAX_SHARE)
    if (share <= 0) continue
    getVault(f, id).stones = (getVault(f, id).stones || 0) + share
    w.pendingTax[s.name] = pend - share
  }
}


/* ---------- 设施维护费 / 伪玩家自动建设 ---------- */
/** 单设施每小时维护费 = 建造灵石(0→1) / 2400 × 等级 (10天=建造成本10%); 伪玩家宗门×0.3(曾×0.1) */
export function facilityMaintPerHr (f, id, fac, lv) {
  if (!lv) return 0
  const build = facilityCost(fac, 1).stones
  const v = Math.round(build / 2400 * lv)
  const isFake = !f.sects[id].owner
  /* 维护费(2026-08-18 用户要求): 玩家宗主宗门基础值×15; 伪玩家宗主宗门基础值×10(不再用30%折扣) */
  const base = isFake ? Math.max(1, Math.round(v * 10)) : v * 15
  /* 战后 3 小时: 玩家宗主宗门灵石维护×5(伪玩家宗门不收战后翻倍) */
  return (isPlayerLead(f, id) && inWarUpkeep(f, id)) ? base * WAR_UPKEEP_STONE_MULT : base
}

/** 每小时: 扣设施维护费; 宝库不足则设施掉级(降最高级)直到够付或全0 */
export function maintFacilities (f, now = Date.now()) {
  const FAC = ['yanwu', 'hushan', 'lingmai', 'yaoyuan']
  for (const id of Object.keys(f.sects)) {
    const s = f.sects[id]
    if (!s) continue
    /* 宗门材料维护: 玩家宗主宗门每小时按名册人数扣 1~9 件基础材料(战后3小时×2), 与占领几个小区无关; 伪玩家宗门不收 */
    if (isPlayerLead(f, id)) {
      const pieces = sectMatUpkeepPieces(f, id, now)
      if (pieces > 0) deductVaultMatsByStock(f, id, pieces)
    }
    if (!s.facilities) continue
    const perHr = (fac) => facilityMaintPerHr(f, id, fac, s.facilities[fac] || 0)
    let total = FAC.reduce((a, fac) => a + perHr(fac), 0)
    if (total <= 0) continue
    const vault = getVault(f, id)
    let pool = vault.stones || 0
    if (pool >= total) {
      vault.stones = pool - total
      continue
    }
    /* 宝库不足: 掉级到够付 */
    const down = []
    let guard = 0
    while (pool < total && guard++ < 20) {
      const fac = FAC.filter(x => (s.facilities[x] || 0) > 0).sort((a, b) => (s.facilities[b] || 0) - (s.facilities[a] || 0))[0]
      if (!fac) break
      s.facilities[fac] = (s.facilities[fac] || 0) - 1
      total = FAC.reduce((a, x) => a + perHr(x), 0)
      down.push(fac)
    }
    vault.stones = Math.max(0, pool - total)
    if (down.length) logEvent(f, 'flavor', `【设施】${s.name} 宝库灵石不足，设施维护失败：${down.map(x => CFG.FACILITIES[x].cn).join('、')} 降级！`, now)
  }
}

/** 伪玩家宗门自动建造/升级设施(费用 FAKE_FAC_MULT=30%, 曾10%); 每次尝试(资源够就建), 优先补0级(演武场→护山阵→灵脉), 再升最低级(上限8级) */
export function fakeBuildFacilities (f, now = Date.now()) {
  const FAC = ['yanwu', 'hushan', 'lingmai', 'yaoyuan']
  for (const id of Object.keys(f.sects)) {
    const s = f.sects[id]
    if (!s || s.owner) continue // 只伪玩家宗门(无玩家宗主)
    if (!s.facilities) s.facilities = { yanwu: 0, hushan: 0, lingmai: 0, yaoyuan: 1 }
    /* 优先补0级设施(演武场→护山阵→灵脉), 再升已有最低级(上限8级) */
    const toBuild = FAC.find(x => (s.facilities[x] || 0) === 0)
    const fac = toBuild || FAC.filter(x => (s.facilities[x] || 0) < (x === 'yaoyuan' || x === 'yanwu' ? 5 : 8)).sort((a, b) => (s.facilities[a] || 0) - (s.facilities[b] || 0))[0]
    if (!fac) continue
    const c = facilityCost(fac, (s.facilities[fac] || 0) + 1)
    const stones = Math.max(1, Math.round(c.stones * FAKE_FAC_MULT))
    const mats = {}
    for (const [m, n] of Object.entries(c.mats)) mats[m] = Math.max(1, Math.round(n * FAKE_FAC_MULT))
    const vault = getVault(f, id)
    if ((vault.stones || 0) < stones) continue
    if (Object.entries(mats).some(([m, n]) => (vault.mats[m] || 0) < n)) continue
    vault.stones -= stones
    for (const [m, n] of Object.entries(mats)) { vault.mats[m] = (vault.mats[m] || 0) - n; if (vault.mats[m] <= 0) delete vault.mats[m] }
    s.facilities[fac] = (s.facilities[fac] || 0) + 1
    logEvent(f, 'flavor', `【建造】${s.name} ${c.build ? '建成' : '升级'}${CFG.FACILITIES[fac].cn}至 ${s.facilities[fac]} 级`, now)
    /* 伪玩家宗门同步升级所占领小区的护城阵(1折价, 资源够就升, 上限5级) */
    for (const [area, owner] of Object.entries(f.areas || {})) {
      if (owner !== id) continue
      if (areaDefLevel(f, area) >= 5) continue
      try { upgradeAreaDef(f, area, true) } catch (err) { }
    }
  }
}

