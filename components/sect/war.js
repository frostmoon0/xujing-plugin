import { wearPlayerTaichu, wearNpcTaichu } from '../taichu_combat.js'
import { hasBloodFeud, defeatDeathRate } from './survival.js'
import { assessSectDevelopment, commonTerritoryThreat, warIncludesSect } from './ai_strategy.js'
import { hasTruce, normalizeDiplomacy, setDiplomacyRelation, forgetSectDiplomacy } from './diplomacy_state.js'
import { withImmediateSaveContext } from '../deferred_save.js'
import { payWarPlayer, queueWarEffect, flushWarEffects } from './war_journal.js'
import { hasWarCaptives, warReceipt, warRoll, warActorAvailable, warActorOwner, defenderOf, initWarState, reconcileWarActors, recordWarExit, creditWarRound, syncWarClock } from './war_state.js'
import { planWarDeployment, commitWarDeployment, releaseWarFake, applyWarWithdrawals, withHomeReserve } from './war_roster.js'
/* 由 sect_system.js 拆分自动生成: war.js */
import { sectName, sectIdByName, sectAlive, sectPower, personPower, logEvent, saveFake, removeFromSectMap, killPerson, evMeta, createVendetta, fakeCombatPill, areaCount, getNick, sectVitality, isInSectJail, isInRaidJail, isInSectMine } from '../fake_data.js'
import { getWorld, saveWorld, regionNameOf, REGIONS, DEFAULT_REGION, getLoc } from '../world_data.js'
import { textToImg } from '../common-lib/reply-img.js'
import xujing_data from '../xujing_data.js'
import { CFG, getVault, atkLog, rand, pick, clamp, playerPower, playerMoney, regionOfArea, sectRegion, isPlayerLead, areaDefLevel, willFight, injuryInfo, applyInjury, ensureCapSub, posCnOf, areaTxtOf, sectTxtOf, warTargetTxt, targetRawTxt, markSectWar, markAreaRaid } from './utils.js'
import { syncWorldSectMap } from './economy.js'
import { shareCaptivesByOutput, winnerOfCoalition, aiAllyAssist, recordCoalition, recomputeCoalition, coalitionShares } from './diplomacy.js'
import { liberateDestroyedCaptor, unmarkPlayerCaptive, disposeFakeCaptives, autoDisposePlayerCaptives, capturePlayerNow, rescueCaptivesOf } from './captive.js'
import { Wanhun } from '../wanhun_data.js'
import { npcCanParticipate } from '../npc_action.js'

function wearWarParticipants (f, gid, atk) {
  for (const actor of Object.values(atk.actors || {})) {
    if (!(actor.rounds > 0)) continue
    const receipt = `sect-war:${warReceipt(atk)}`
    if (actor.kind === 'player') wearPlayerTaichu(gid, actor.id, receipt, 8)
    else wearNpcTaichu(f.roster?.[actor.id], receipt, 8)
  }
}

function checkpointWar (f, gid) {
  const ok = withImmediateSaveContext(() => saveFake(f, gid))
  if (ok === false) throw new Error('战争检查点保存失败，暂停结算')
  return ok
}

/** 回滚内存时保留战役对象引用，当前群推进器仍可安全处理后续战事。 */
function restoreWarFrame (f, snapshot) {
  const refs = new Map((f.sectAttacks || []).map(a => [String(a.id), a]))
  for (const key of Object.keys(f)) delete f[key]
  Object.assign(f, snapshot)
  f.sectAttacks = (snapshot.sectAttacks || []).map(saved => {
    const ref = refs.get(String(saved.id))
    if (!ref) return saved
    for (const key of Object.keys(ref)) delete ref[key]
    Object.assign(ref, saved)
    return ref
  })
}

/* 被俘/关押/送矿中的成员不能报名参战；战力计算前也会再次清理旧名单。 */
function playerInSectJail (f, uid) {
  const suid = String(uid)
  return Object.values(f.sectJails || {}).some(arr => (arr || []).some(x => x && String(x.uid) === suid))
}

function playerInCaptivePool (f, uid) {
  const suid = String(uid)
  return (f.sectAttacks || []).some(a => {
    const c = a.captives || {}
    const pools = [c, c.byAtk, c.byDef, ...Object.values(c.byShare || {})]
    return pools.some(pool => (pool && pool.players || []).some(x => String(x) === suid))
  })
}

function canPlayerFight (f, uid) {
  const suid = String(uid || '')
  return !!suid && !playerInCaptivePool(f, suid) && !playerInSectJail(f, suid)
}

/** 玩家是否正参加本群某场宗门攻防战(在攻军/守军名单中, 战争未结束)——用于统一 Proxy 战争期行动拦截 */
export function isSectWarParticipant (f, uid) {
  const suid = String(uid)
  return (f.sectAttacks || []).some(a => a.phase !== 'done' &&
    (((Array.isArray(a.atkPlayers) && a.atkPlayers.includes(suid)) ||
      (Array.isArray(a.defPlayers) && a.defPlayers.includes(suid)))))
}

function canFakeFight (f, name) {
  const p = f.roster && f.roster[name]
  return npcCanParticipate(f, p)
}

function recordWanhunKill (atk, p, side = null) {
  if (!atk || !p || !p.name) return
  if (!Array.isArray(atk.wanhunKills)) atk.wanhunKills = []
  if (atk.wanhunKills.some(x => String(x.name) === String(p.name))) return
  atk.wanhunKills.push({ name: p.name, level: Number(p.level) || 0, side })
}

function recordWanhunParticipant (atk, side, uid) {
  if (!atk || !uid || !['atk', 'def'].includes(side)) return
  if (!atk.wanhunParticipants) atk.wanhunParticipants = { atk: [], def: [] }
  const list = atk.wanhunParticipants[side]
  if (!list.map(String).includes(String(uid))) list.push(String(uid))
}

function rememberWanhunParticipants (atk) {
  for (const uid of (atk && atk.atkPlayers) || []) recordWanhunParticipant(atk, 'atk', uid)
  for (const uid of (atk && atk.defPlayers) || []) recordWanhunParticipant(atk, 'def', uid)
}

async function settleWanhunSouls (f, gid, atk, winningSide) {
  if (!atk || atk.wanhunSoulSettled) return
  const kills = (Array.isArray(atk.wanhunKills) ? atk.wanhunKills : [])
    .filter(kill => !kill.side || kill.side !== winningSide)
  const participants = atk.wanhunParticipants && atk.wanhunParticipants[winningSide]
    ? atk.wanhunParticipants[winningSide]
    : (winningSide === 'atk' ? atk.atkPlayers : atk.defPlayers)
  const eligible = atk.soulRecipients ||= [...new Set((participants || []).map(String))].filter(uid => Wanhun.getArtifact(uid, gid)?.equipped)
  checkpointWar(f, gid)
  if (!kills.length || !eligible.length) return
  let totalGained = 0
  const details = []
  for (const kill of kills) {
    const results = await Wanhun.captureFromLevels(eligible, gid, kill.level, `${warReceipt(atk)}:soul:${kill.name}`)
    const gained = results.reduce((sum, item) => sum + (item.gained || 0), 0)
    totalGained += gained
    if (gained > 0) details.push(`${kill.name}贡献${gained}魂`)
  }
  atk.wanhunSoulSettled = true
  if (totalGained > 0) {
    atk.wanhunSouls = totalGained
    atkLog(atk, `【收魂】获胜方装备万魂幡的玩家均分 ${totalGained} 魂（${details.join('、')}）`, Date.now())
  }
}

function pruneFightParticipants (f, atk) {
  initWarState(f, atk)
  reconcileWarActors(f, atk)
  if (Array.isArray(atk.atkFakes)) atk.atkFakes = atk.atkFakes.filter(n => canFakeFight(f, n))
  if (Array.isArray(atk.defFakes)) atk.defFakes = atk.defFakes.filter(n => canFakeFight(f, n))
  if (Array.isArray(atk.atkPlayers)) atk.atkPlayers = atk.atkPlayers.filter(uid => canPlayerFight(f, uid))
  if (Array.isArray(atk.defPlayers)) atk.defPlayers = atk.defPlayers.filter(uid => canPlayerFight(f, uid))
}

/* ---------- 攻打系统 ---------- */
export const ATK_KINDS = [
  { key: '正面强攻', bonus: 0, wt: 40 },
  { key: '夜袭', bonus: 0.1, wt: 18 },
  { key: '两宗合围', bonus: 0.2, wt: 15 },
  { key: '斩首行动', bonus: 0, wt: 12 },
  { key: '约战定胜负', bonus: -0.05, wt: 15 }
]

export function pickKind () {
  const total = ATK_KINDS.reduce((a, k) => a + k.wt, 0)
  let r = Math.random() * total
  for (const k of ATK_KINDS) { r -= k.wt; if (r <= 0) return k }
  return ATK_KINDS[0]
}

export function randomMember (f, id) {
  const tai = new Set((f.sectMap[id] && f.sectMap[id].taishang) || [])
  const arr = sectAlive(f, id).filter(p => !tai.has(p.name))
  return arr.length ? pick(arr) : null
}

/** 攻方潜在战力(决定守/不守评估用): 在目标大区的门人 + 参战玩家 */
export async function potentialAtkPower (f, gid, atk) {
  const tRegion = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, atk.target)
  let pw = 0
  if (atk.atkSect) {
    for (const p of sectAlive(f, atk.atkSect)) {
      if (!canFakeFight(f, p.name) || !warActorAvailable(f, 'fake', p.name, atk)) continue
      if (!tRegion || (p.loc || DEFAULT_REGION) === tRegion) pw += personPower(p)
    }
  }
  for (const uid of (atk.atkPlayers || []).filter(uid => canPlayerFight(f, uid))) pw += await playerPower(f, gid, uid)
  return Math.round(pw)
}

/** 守方潜在战力(决定守/不守评估用): 在目标大区的门人 + 参战玩家 */
export async function potentialDefPower (f, gid, atk) {
  const defSect = defenderOf(f, atk)
  if (!defSect) return 0
  const tRegion = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, atk.target)
  let pw = 0
  for (const p of sectAlive(f, defSect)) {
    if (!canFakeFight(f, p.name) || !warActorAvailable(f, 'fake', p.name, atk)) continue
    if (!tRegion || (p.loc || DEFAULT_REGION) === tRegion) pw += personPower(p)
  }
  for (const uid of (atk.defPlayers || []).filter(uid => canPlayerFight(f, uid))) pw += await playerPower(f, gid, uid)
  return Math.round(pw)
}

/** 守方响应守城: 宗主决定守后, 在目标大区且选择参战的门人(除太上)加入守军defFakes;
 *  若在外门人响应守城(跨区), 传送费由宗门宝库出资(受预算限制) */
export function defendRespond (f, atk) {
  const sid = defenderOf(f, atk)
  if (!sid || !f.sects[sid]) return
  initWarState(f, atk)
  const region = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, sid)
  const tai = new Set(f.sectMap[sid]?.taishang || [])
  const candidates = sectAlive(f, sid).filter(p => canFakeFight(f, p.name) && (!tai.has(p.name) || (p.loc || DEFAULT_REGION) === region) && !(atk.defFakes || []).includes(p.name) && warActorAvailable(f, 'fake', p.name, atk))
  let willing = candidates.filter(p => atk.targetType === 'sect' || willFight(p, true, f))
  if (atk.targetType === 'area') willing = withHomeReserve(f, sid, willing, atk)
  const plan = planWarDeployment(f, f.gid, sid, region, willing, 0, atk)
  commitWarDeployment(f, sid, atk, 'def', plan)
  for (const unit of plan.units) { try { fakeCombatPill(f, f.roster[unit.name]) } catch (err) {} }
  initWarState(f, atk)
  atkLog(atk, `【守城】${atk.defFakes.length} 名门人到位，跨区费用 ${plan.cost} 灵石`, Date.now())
}

export function aiReinforce (f, atk, now) {
  const sid = defenderOf(f, atk)
  if (!sid || !f.sects[sid] || f.sects[sid].owner || !atk.defended || atk.retreating === 'def') return false
  const region = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, sid)
  const tai = new Set(f.sectMap[sid]?.taishang || [])
  const remaining = sectAlive(f, sid).filter(p => canFakeFight(f, p.name) && !tai.has(p.name) && !(atk.defFakes || []).includes(p.name) && warActorAvailable(f, 'fake', p.name, atk))
  if (atk.by !== 'player' && Math.random() > 0.5) return false
  const reinforcements = atk.targetType === 'area' ? withHomeReserve(f, sid, remaining, atk) : remaining
  const plan = planWarDeployment(f, f.gid, sid, region, reinforcements, atk.by === 'player' ? 0 : Math.max(1, Math.floor(remaining.length / 2)), atk)
  if (!plan.units.length) return false
  commitWarDeployment(f, sid, atk, 'def', plan)
  initWarState(f, atk)
  atkLog(atk, `【驰援】守方增援 ${plan.units.length} 人，费用 ${plan.cost} 灵石`, now)
  return true
}

export function deploymentPower (f, sid, members, playerPowers = [], { defense = false, targetType = 'sect', target = null, bonus = 0 } = {}) {
  const sect = f.sects?.[sid]
  let pw = (members.length + playerPowers.length) * CFG.PERSON_BASE
  pw += (members.reduce((n, p) => n + personPower(p), 0) + playerPowers.reduce((n, p) => n + p, 0)) * CFG.REALM_WEAKEN
  if (defense && sect) {
    if (!sect.owner) pw *= 1.2
    pw *= targetType === 'area'
      ? 1 + CFG.AREA_DEF_BONUS / 100 * areaDefLevel(f, target)
      : 1 + CFG.HUSHAN_BONUS / 100 * (sect.facilities?.hushan || 0)
  } else if (!defense) pw *= (1 + bonus) * (1 + 0.02 * (sect?.facilities?.yanwu || 0))
  return Math.max(0, Math.round(pw))
}

export async function computeAtkPower (f, gid, atk) {
  pruneFightParticipants(f, atk)
  const atkCnt = (atk.atkPlayers || []).length
  if (!atk.atkSect) {
    /* 散修: 只有参战玩家, 按人数 + 弱化境界 */
    let pw = atkCnt * CFG.PERSON_BASE
    for (const uid of (atk.atkPlayers || []).filter(uid => canPlayerFight(f, uid))) pw += (await playerPower(f, gid, uid)) * CFG.REALM_WEAKEN
    return Math.max(0, Math.round(pw * (1 + (atk.bonus || 0))))
  }
  const s = f.sects[atk.atkSect]
  const tRegion = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, atk.target)
  /* 攻方门人 = 参加攻打的(atkFakes, 且须在目标大区); 旧档无名单回退为目标大区全员 */
  let members
  if (atk.atkFakes) members = atk.atkFakes.map(n => f.roster[n]).filter(p => canFakeFight(f, p && p.name) && (!tRegion || (p.loc || DEFAULT_REGION) === tRegion))
  else members = sectAlive(f, atk.atkSect).filter(p => canFakeFight(f, p.name) && (!tRegion || (p.loc || DEFAULT_REGION) === tRegion))
  const players = []
  for (const uid of (atk.atkPlayers || []).filter(uid => canPlayerFight(f, uid))) players.push(await playerPower(f, gid, uid))
  const bonus = atk.kind === '两宗合围' && !members.some(p => p.sect && p.sect !== atk.atkSect) && !(atk.atkPlayers || []).some(uid => f.players?.[uid]?.sect && f.players[uid].sect !== atk.atkSect) ? 0 : (atk.bonus || 0)
  return deploymentPower(f, atk.atkSect, members, players, { bonus })
}

/** 守方战力 = 参战人数×PERSON_BASE + 境界弱化 + 护山阵/护城阵 + 太上出关(不在目标大区的不算) */
export async function computeDefPower (f, gid, atk) {
  pruneFightParticipants(f, atk)
  const defSect = defenderOf(f, atk)
  if (!defSect) return 0
  const ds = f.sects[defSect]
  if (!ds) return 0
  const tRegion = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, atk.target)
  /* 守方门人 = 参加防守的(defFakes, 且须在目标大区); 旧档无名单回退为目标大区全员 */
  let members
  if (atk.defFakes) members = atk.defFakes.map(n => f.roster[n]).filter(p => canFakeFight(f, p && p.name) && (!tRegion || (p.loc || DEFAULT_REGION) === tRegion))
  else members = sectAlive(f, defSect).filter(p => canFakeFight(f, p.name) && (!tRegion || (p.loc || DEFAULT_REGION) === tRegion))
  const players = []
  for (const uid of (atk.defPlayers || []).filter(uid => canPlayerFight(f, uid))) players.push(await playerPower(f, gid, uid))
  return deploymentPower(f, defSect, members, players, { defense: true, targetType: atk.targetType, target: atk.target })
}

/** 系统评估攻方胜率(%) = 攻方战力/(攻+守), 与战斗结算同源; 返回 {atk, def, pct(0~100或null)} */
export async function estimateWinRate (f, gid, atk) {
  try {
    if (atk.phase === 'done' && atk.settlement?.powers) {
      const { atk: pA, def: pD } = atk.settlement.powers
      return { atk: pA, def: pD, pct: pA + pD > 0 ? Math.round(pA / (pA + pD) * 100) : null }
    }
    const view = structuredClone(atk)
    const pA = await computeAtkPower(f, gid, view)
    const pD = await computeDefPower(f, gid, view)
    const total = pA + pD
    if (total <= 0) return { atk: 0, def: 0, pct: null }
    return { atk: pA, def: pD, pct: Math.round(pA / total * 100) }
  } catch (err) {
    return { atk: 0, def: 0, pct: null }
  }
}

/** 开战保底: 攻方至少1名出征门人; 派不出就取消宣战并退还发起费, 不允许0人攻打 */
function ensureMinimumAttackers (f, atk, sid, region) {
  const tai = new Set(f.sectMap[sid]?.taishang || [])
  const people = sectAlive(f, sid).filter(p => canFakeFight(f, p.name) && !tai.has(p.name))
  const plan = planWarDeployment(f, f.gid, sid, region, people, 1, atk)
  if (!plan.units.length) return { ok: false, reason: '无可用出征门人，或预算/封海限制无法调派' }
  commitWarDeployment(f, sid, atk, 'atk', plan)
  initWarState(f, atk)
  return { ok: true }
}

/** 霸主竞争仅使用AI盟友实际同意的可派门人，不替真人报名。 */
export function planAiCoalition (f, gid, sid, target, region, now = Date.now()) {
  if (!target || commonTerritoryThreat(f, sid) !== target) return []
  const plans = []
  for (const ally of f.sects[sid]?.allies || []) {
    const s = f.sects[ally]
    if (!s || s.owner || s.wipeAt || (s.allies || []).includes(target) || hasTruce(f, ally, target, now)) continue
    if ((s.atkCdUntil || 0) > now) continue
    const draft = { ...s }
    if (!assessSectDevelopment({ ...f, sects: { ...f.sects, [ally]: draft } }, ally, now).ready) continue
    const tai = new Set(f.sectMap[ally]?.taishang || [])
    const available = sectAlive(f, ally).filter(p => !tai.has(p.name) && canFakeFight(f, p.name) && warActorAvailable(f, 'fake', p.name) && willFight(p, false, f))
    const reserve = CFG.ATK_BASE + sectAlive(f, ally).length * CFG.ATK_PER
    const budget = Math.max(0, (getVault(f, ally).stones || 0) - reserve)
    const plan = planWarDeployment(f, gid, ally, region, withHomeReserve(f, ally, available), 0, null, budget)
    if (plan.units.length) plans.push({ sid: ally, plan })
  }
  return plans
}

function coalitionPlanValid (f, gid, sid, target, region, support, now) {
  if (!support || commonTerritoryThreat(f, sid) !== target || !(f.sects[sid]?.allies || []).includes(support.sid)) return false
  const s = f.sects[support.sid]
  if (!s || s.owner || s.wipeAt || (s.allies || []).includes(target) || hasTruce(f, support.sid, target, now)) return false
  if ((s.atkCdUntil || 0) > now || (f.sectAttacks || []).some(w => w.phase !== 'done' && warIncludesSect(f, w, support.sid))) return false
  const people = support.plan.units.map(u => f.roster[u.name]).filter(p => p && p.sect === support.sid)
  const reserve = CFG.ATK_BASE + sectAlive(f, support.sid).length * CFG.ATK_PER
  const fresh = planWarDeployment(f, gid, support.sid, region, withHomeReserve(f, support.sid, people), 0, null, Math.max(0, getVault(f, support.sid).stones - reserve))
  return fresh.units.length === support.plan.units.length && fresh.cost === support.plan.cost
}

export async function startSectAttack (f, gid, atkSect, rawTarget, by = 'player', options = {}) {
  const now = Date.now(); const atkS = f.sects[atkSect]
  normalizeDiplomacy(f, now)
  if (!atkS) return { ok: false, msg: '宗门不存在' }
  rawTarget = String(rawTarget || '').trim()
  const targetType = regionOfArea(rawTarget) ? 'area' : 'sect'
  const target = targetType === 'area' ? rawTarget : sectIdByName(f, rawTarget)
  if (!target) return { ok: false, msg: '目标不存在：请输入小区名或宗门名' }
  const defSect = targetType === 'sect' ? target : (f.areas[target] || null)
  if (hasTruce(f, atkSect, defSect, now)) return { ok: false, msg: '双方仍在议和停战期，不能攻打总部或小区' }
  if (defSect === atkSect) return { ok: false, msg: '不能攻打自家地盘/宗门' }
  if (defSect && (atkS.allies || []).includes(defSect)) return { ok: false, msg: '对方是盟友，请先解除结盟' }
  if (targetType === 'sect' && (!f.sects[defSect] || f.sects[defSect].wipeAt || !sectAlive(f, defSect).length)) return { ok: false, msg: '目标宗门已灭门/名存实亡，无法攻打' }
  if ((f.targetCd?.[`${targetType}:${target}`] || 0) > now) return { ok: false, msg: '目标仍在休战期' }
  const active = (f.sectAttacks || []).filter(a => a.phase !== 'done')
  if (active.some(a => a.targetType === targetType && a.target === target)) return { ok: false, msg: '该目标已有一场攻打在进行中' }
  if (active.some(a => a.atkSect === atkSect)) return { ok: false, msg: '本宗已有一场攻打在进行中' }
  if (active.some(a => defenderOf(f, a) === atkSect)) return { ok: false, msg: '本宗正被攻打，请先防守' }
  if ((atkS.atkCdUntil || 0) > now) return { ok: false, msg: '本宗发起攻打冷却中' }
  const region = targetType === 'area' ? regionOfArea(target) : sectRegion(f, target)
  const tai = new Set(f.sectMap[atkSect]?.taishang || [])
  const candidates = sectAlive(f, atkSect).filter(p => canFakeFight(f, p.name) && !tai.has(p.name) && warActorAvailable(f, 'fake', p.name))
  const memberCount = sectAlive(f, atkSect).length + Object.values(f.players || {}).filter(p => p?.sect === atkSect).length
  const cost = CFG.ATK_BASE + memberCount * CFG.ATK_PER
  const vault = getVault(f, atkSect)
  if ((vault.stones || 0) < cost) return { ok: false, msg: `宝库灵石不足（发起需 ${cost}）` }
  const count = Math.max(0, Math.trunc(Number(options.count) || 0))
  let willing = count ? candidates : candidates.filter(p => willFight(p, false, f))
  if (!willing.length) willing = candidates
  if (by === 'ai') willing = withHomeReserve(f, atkSect, willing)
  const plan = planWarDeployment(f, gid, atkSect, region, willing, count, null, vault.stones - cost)
  if (!plan.units.length) return { ok: false, msg: '无法发起攻打：没有可派门人，或预算/封海限制无法调派；未扣费、未宣战' }
  const kind = ATK_KINDS.find(k => k.key === options.tactic) || pickKind()
  const supportPlans = by === 'ai' ? (options.coalitionPlans || []) : []
  if (new Set(supportPlans.map(x => x.sid)).size !== supportPlans.length || supportPlans.some(x => !coalitionPlanValid(f, gid, atkSect, defSect, region, x, now))) return { ok: false, msg: '盟友兵力或储备已变化，暂缓联合出兵；未扣费' }
  if (by === 'ai' && defSect) {
    const attackPower = deploymentPower(f, atkSect, [...plan.units, ...supportPlans.flatMap(x => x.plan.units)].map(u => f.roster[u.name]), [], { bonus: kind.key === '两宗合围' ? 0 : kind.bonus })
    const defensePower = await aiTargetDefensePower(f, gid, defSect, region, targetType, target)
    if (attackPower < defensePower * aiTargetMinAttackRatio(f, atkSect, defSect)) return { ok: false, msg: '实际可派兵力不足，暂缓出征；未扣费、未宣战' }
  }
  if (supportPlans.some(x => !coalitionPlanValid(f, gid, atkSect, defSect, region, x, Date.now()))) return { ok: false, msg: '盟友状态已变化；未扣费' }
  const checkedPlan = planWarDeployment(f, gid, atkSect, region, plan.units.map(u => f.roster[u.name]).filter(Boolean), count, null, vault.stones - cost)
  if (checkedPlan.units.length !== plan.units.length || checkedPlan.cost !== plan.cost || hasTruce(f, atkSect, defSect) || (targetType === 'area' ? (f.areas[target] || null) !== defSect : !f.sects[defSect])) return { ok: false, msg: '兵力、预算或目标状态已变化，请重新选择；未扣费' }
  const atk = {
    id: (f.sectSeq = (f.sectSeq || 0) + 1), version: 2, atkSect, target, targetType, defSect, by,
    kind: kind.key, bonus: kind.key === '两宗合围' ? 0 : kind.bonus, start: now, clockAt: now, prepEnd: now + CFG.PREP_MIN * 60000,
    atkPlayers: [], defPlayers: [], atkFakes: [], defFakes: [], defended: false, defenderDecided: false, defAuto: false,
    moraleA: 100, moraleD: 100, round: 0, nextRound: 0, phase: 'prep', result: null,
    captives: { fakes: [], players: [] }, endAt: 0, cost,
    wanhunParticipants: { atk: [], def: [] }, wanhunKills: [], wanhunSoulSettled: false,
    warNoticeAt: by === 'ai' ? now + rand([1, 20]) * 60000 : 0, warNotified: false
  }
  // 至此才提交：失败的宣战不触发守方调兵、敌对关系或丹药消耗。
  vault.stones -= cost
  commitWarDeployment(f, atkSect, atk, 'atk', plan)
  for (const support of supportPlans) {
    commitWarDeployment(f, support.sid, atk, 'atk', support.plan)
    setDiplomacyRelation(f, support.sid, defSect, 'hostile', now, '联合出兵')
    f.sects[support.sid].atkCdUntil = now + CFG.FAKE_ATK_CD * 60000
  }
  if (defSect) {
    setDiplomacyRelation(f, atkSect, defSect, 'hostile', now, '攻打')
  }
  initWarState(f, atk, now)
  f.sectAttacks.push(atk)
  for (const unit of plan.units) { try { fakeCombatPill(f, f.roster[unit.name]) } catch (err) {} }
  if (defSect && !isPlayerLead(f, defSect)) {
    atk.defAuto = await aiWantDefend(f, gid, atk)
    atk.defended = atk.defAuto; atk.defenderDecided = true
    if (atk.defended) defendRespond(f, atk)
  }
  await recordCoalition(f, gid, atk, atkSect)
  for (const support of supportPlans) {
    await recordCoalition(f, gid, atk, support.sid)
    atkLog(atk, `【联合出兵】${sectName(f, support.sid)} 派出 ${support.plan.units.length} 人，调兵费 ${support.plan.cost} 灵石`, now)
  }
  atkLog(atk, `【宣战】${sectName(f, atkSect)} 向${warTargetTxt(f, atk)}宣战；出征 ${plan.units.length} 人，发起费 ${cost}、调兵费 ${plan.cost}`, now)
  logEvent(f, 'attack', `【宣战】${sectName(f, atkSect)} 向${warTargetTxt(f, atk)}宣战（战场 #${atk.id}）`, now)
  saveFake(f, gid)
  return { ok: true, msg: `⚔️ 战场 #${atk.id}：${sectName(f, atkSect)} 已对${warTargetTxt(f, atk)}发起攻打，${CFG.PREP_MIN}分钟准备期。\n实派 ${plan.units.length} 名门人，发起费 ${cost}、调兵费 ${plan.cost} 灵石。${targetType === 'sect' ? '\n宗门本体攻破即灭门！' : ''}`, atk }
}

export function atkNameOf (f, atk) {
  if (atk.atkSect) return atk.snapshot?.attacker || sectName(f, atk.atkSect)
  return atk.rogueName || '散修'
}

/** 攻方对外显示名: 玩家小队显示"玩家小队【队名】(N人)", 宗门显示宗门名 */
export function atkDisplayName (f, atk) {
  if (atk.rogue) return `玩家小队【${atk.teamName || atk.rogueName || '散修'}】(${(atk.atkPlayers || []).length}人)`
  return atkNameOf(f, atk)
}

/** 散修战利品平分给全体参战队员 */
export async function rogueLootTo (f, gid, atk, amount) {
  const list = (atk.atkPlayers || []).filter(Boolean)
  if (!list.length) return
  const share = Math.floor((amount || 0) / list.length)
  if (share <= 0) return
  for (const u of list) {
    try {
      const rm = await playerMoney(gid, u)
      rm.home[u].money = (Number(rm.home[u].money) || 0) + share
      await xujing_data.getQQYUserHome(u, rm.home, rm.filename, true)
    } catch (err) { }
  }
}

/** 玩家小队攻打宗门: 必须组队且由队长发起, 有无宗门均可, 免费出征, 打赢洗劫宝库30%按人头平分 */
export async function startRogueAttack (f, gid, uid, rawTarget, nick = '散修') {
  const now = Date.now()
  rawTarget = String(rawTarget || '').trim()
  const sid = sectIdByName(f, rawTarget)
  if (!sid) return { ok: false, msg: '目标不存在：请输入 宗门名（#天下宗门 查看）' }
  /* 宗门目标: 已灭门/无在世门人(废墟) → 拒绝发起, 避免打空壳 */
  const ts2 = f.sects[sid]
  if (ts2 && ((ts2.wipeAt && ts2.wipeAt <= now) || sectAlive(f, sid).length === 0)) {
    return { ok: false, msg: `【${sectName(f, sid)}】已灭门/名存实亡（废墟待重建），无法攻打` }
  }
  /* 宗门身份不影响组队: 宗门玩家也可参加玩家小队，并以小队身份出征 */
  if (f.players[String(uid)] && f.players[String(uid)].realmBusy) return { ok: false, msg: '你当前正在其他行动中，暂时不能组队' }
  const t = rogueTeamOf(f, uid)
  if (!t || t.leader !== String(uid)) return { ok: false, msg: '玩家小队攻打宗门须由队长发起：#创建队伍 → #邀请入队 → 队长 #攻打 宗门名' }
  if (t.members.some(u => hasTruce(f, f.players?.[String(u)]?.sect, sid, now))) return { ok: false, msg: '队伍成员所属宗门与目标仍在议和停战期' }
  if (t.members.length < 2) return { ok: false, msg: '攻打宗门至少需要2名队员，当前1人' }
  if (t.members.some(u => f.players[String(u)] && f.players[String(u)].sect === sid)) return { ok: false, msg: '队伍中有人属于该宗门，不能攻打自己的宗门' }
  if (t.members.some(u => !warActorAvailable(f, 'player', u))) return { ok: false, msg: '队伍中有人正在其它战场参战' }
  const { isPlayerActionLocked } = await import('../action_lock.js')
  for (const member of t.members) if (await isPlayerActionLocked(gid, member)) return { ok: false, msg: `队员 ${member} 当前脱不开身，不能参战` }
  if (t.members.some(u => !canPlayerFight(f, u))) return { ok: false, msg: '队伍中有人被俘或被关押，暂时不能发起小队攻打' }
  const cdUntil = f.targetCd[`sect:${sid}`] || 0
  if (cdUntil > now) return { ok: false, msg: `目标仍在休战期（${Math.ceil((cdUntil - now) / 3600000)} 小时后可再攻打）` }
  const busy = (f.sectAttacks || []).some(a => a.phase !== 'done' && a.target === sid && a.targetType === 'sect')
  if (busy) return { ok: false, msg: '该目标已有一场攻打在进行中' }
  /* 玩家小队一次只能发起一次宗门攻打(在途1起) */
  const myBusy = (f.sectAttacks || []).some(a => a.phase !== 'done' && a.by === 'rogue' && String(a.rogue) === String(uid))
  if (myBusy) return { ok: false, msg: '本小队已有一场攻打在进行中，待其结束或终止后才能再发起' }
  /* 玩家小队发起攻打冷却(统一30分钟) */
  const atkCdUntil = t.atkCdUntil || 0
  if (atkCdUntil > now) return { ok: false, msg: `玩家小队发起攻打冷却中（剩 ${Math.ceil((atkCdUntil - now) / 60000)} 分钟）` }
  const w = getWorld(gid)
  const sReg = sectRegion(f, sid)
  const myLoc = getLoc(w, uid)
  if (myLoc !== sReg) return { ok: false, msg: `你位于【${regionNameOf(myLoc)}】，目标${sectTxtOf(f, sid)}，请先过去` }
  /* 全体队员须与目标同大区 */
  const far = t.members.filter(u => getLoc(w, u) !== sReg)
  if (far.length) return { ok: false, msg: `以下队友不在【${regionNameOf(sReg)}】：${far.join('、')}，请先同行再攻打` }
  const kind = pickKind()
  const atk = {
    id: (f.sectSeq = (f.sectSeq || 0) + 1), atkSect: null, rogue: String(uid), rogueName: nick, teamName: t.name,
    target: sid, targetType: 'sect', by: 'rogue',
    kind: kind.key, bonus: kind.key === '两宗合围' ? 0 : kind.bonus, start: now, prepEnd: now + CFG.PREP_MIN * 60000,
    atkPlayers: t.members.slice(), defPlayers: [], atkFakes: [], defFakes: [], defended: false, defenderDecided: false, defAuto: false,
    wanhunParticipants: { atk: t.members.map(String), def: [] }, wanhunKills: [], wanhunSoulSettled: false,
    rogueAuto: false, // 守方已按新逻辑自动判定(旧档在途攻打无此标记 → 兼容补评估)
    moraleA: 100, moraleD: 100, round: 0, nextRound: 0,
    phase: 'prep', result: null, captives: { fakes: [], players: [] }, endAt: 0, cost: 0
  }
  atk.version = 2; atk.clockAt = now; atk.teamId = t.id
  initWarState(f, atk, now)
  f.sectAttacks.push(atk)
  atkLog(atk, `【宣战】玩家小队【${t.name}】(${t.members.length}人) 向${sectTxtOf(f, sid)}宣战（${kind.key}）`, now)
  /* 伪玩家宗主: 系统自动决定(孙子兵法·动态防守决策) */
  if (!isPlayerLead(f, sid)) {
    atk.defAuto = await aiWantDefend(f, gid, atk)
    atk.defended = atk.defAuto
    atk.defenderDecided = true
    atk.rogueAuto = true
    if (atk.defended) { defendRespond(f, atk); atkLog(atk, `【应战】守方决定坚守，${atk.defFakes.length} 名门人响应守城`, now) }
    else atkLog(atk, '【弃守】守方决定弃守（将速战速决）', now)
  }
  logEvent(f, 'attack', `【宣战】玩家小队【${t.name}】(${t.members.length}人) 向${sectTxtOf(f, sid)}宣战并兵临城下（${kind.key}）`, now)
  saveFake(f, gid)
  return { ok: true, msg: `⚔️ 玩家小队【${t.name}】(${t.members.length}人) 已对${sectTxtOf(f, sid)}发起攻打（${kind.key}，${CFG.PREP_MIN}分钟准备期，免费出征）\n打赢将洗劫对方宝库30%灵石，按人头平分！`, atk }
}

/** 管理员一键重置小区休战期: 清除所有小区目标冷却(area: 前缀), 宗门目标冷却不受影响 */
export function resetAreaTruce (f, gid) {
  let n = 0
  const tcd = f.targetCd || {}
  for (const k of Object.keys(tcd)) {
    if (k.startsWith('area:')) { delete tcd[k]; n++ }
  }
  if (n > 0) saveFake(f, gid)
  return { ok: true, n }
}

/* ---------- 散修组队系统 ---------- */
/** 找玩家所在散修队伍(无则null) */
export function rogueTeamOf (f, uid) {
  uid = String(uid)
  for (const t of Object.values(f.rogueTeams || {})) {
    if (!t || !Array.isArray(t.members)) continue
    t.members = [...new Set(t.members.map(String).filter(Boolean))]
    t.leader = String(t.leader || t.members[0] || '')
    t.leaderName = String(t.leaderName || '散修')
    t.name = String(t.name || '玩家小队')
    if (t.members.includes(uid)) return t
  }
  return null
}

function rogueApplyList (f, leaderUid) {
  const value = (f.rogueApplies || {})[String(leaderUid)]
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}
function removeRogueApply (f, applicantUid) {
  const uid = String(applicantUid)
  for (const [leader, value] of Object.entries(f.rogueApplies || {})) {
    const list = rogueApplyList(f, leader).filter(x => String(x?.uid) !== uid)
    if (list.length) f.rogueApplies[leader] = list
    else delete f.rogueApplies[leader]
  }
}

/** 创建小队(有无宗门均可, 最多4人) */
export function createRogueTeam (f, gid, uid, name, nick) {
  uid = String(uid)
  if (rogueTeamOf(f, uid)) return { ok: false, msg: '你已在队伍中，请先 #退出队伍' }
  name = String(name || '').trim().slice(0, 8)
  const id = 'rt' + ((f.rogueSeq = (f.rogueSeq || 0) + 1))
  f.rogueTeams = f.rogueTeams || {}
  f.rogueTeams[id] = { id, leader: uid, leaderName: nick || '散修', name: name || '玩家小队', members: [uid], createdAt: Date.now() }
  saveFake(f, gid)
  return { ok: true, msg: `🎯 玩家小队【${f.rogueTeams[id].name}】已成立，你是队长！\n· 队长 #邀请入队 @玩家（对方 #同意进队）\n· 满2人后队长可 #攻打 宗门名，组队攻打其他宗门` }
}

/** 队长邀请散修入队 */
export function inviteRogue (f, gid, uid, targetUid, targetNick) {
  uid = String(uid); targetUid = String(targetUid)
  const t = rogueTeamOf(f, uid)
  if (!t || t.leader !== uid) return { ok: false, msg: '只有队长可以邀请（先 #创建队伍）' }
  if (t.members.includes(targetUid)) return { ok: false, msg: '对方已在队伍中' }
  /* 有无宗门均可加入玩家小队 */
  if (rogueTeamOf(f, targetUid)) return { ok: false, msg: '对方已在其他队伍' }
  if (t.members.length >= CFG.ROGUE_TEAM_MAX) return { ok: false, msg: `队伍已满（最多 ${CFG.ROGUE_TEAM_MAX} 人）` }
  f.rogueInvites = f.rogueInvites || {}
  f.rogueInvites[targetUid] = { team: t.id, at: Date.now() }
  delete (f.rogueApplies || {})[targetUid]
  removeRogueApply(f, targetUid)
  saveFake(f, gid)
  return { ok: true, msg: `已邀请 ${targetNick || targetUid} 加入【${t.name}】，等待对方 #同意进队` }
}

/** 被邀请者同意/拒绝入队 */
export function agreeRogue (f, gid, uid, accept) {
  uid = String(uid)
  const inv = (f.rogueInvites || {})[uid]
  if (!inv) return { ok: false, msg: '当前没有待处理的入队邀请' }
  const t = f.rogueTeams[inv.team]
  delete f.rogueInvites[uid]
  if (!t) return { ok: false, msg: '邀请你的队伍已解散' }
  /* 有无宗门均可同意加入玩家小队 */
  if (rogueTeamOf(f, uid)) return { ok: false, msg: '你已在其他队伍中' }
  if (!accept) { saveFake(f, gid); return { ok: true, msg: '你已拒绝入队邀请' } }
  if (t.members.length >= CFG.ROGUE_TEAM_MAX) {
    f.rogueInvites[uid] = inv
    saveFake(f, gid)
    return { ok: false, msg: `队伍已满（最多 ${CFG.ROGUE_TEAM_MAX} 人），邀请暂时保留` }
  }
  t.members.push(uid)
  removeRogueApply(f, uid)
  saveFake(f, gid)
  return { ok: true, msg: `✅ 你已加入玩家小队【${t.name}】（队长 ${t.leaderName}）！` }
}

/** 散修申请进队(队长待确认) */
export function applyRogue (f, gid, uid, leaderUid, nick) {
  uid = String(uid); leaderUid = String(leaderUid)
  /* 有无宗门均可申请加入玩家小队 */
  if (rogueTeamOf(f, uid)) return { ok: false, msg: '你已在队伍中' }
  const t = rogueTeamOf(f, leaderUid)
  if (!t || t.leader !== leaderUid) return { ok: false, msg: '对方不是散修队长' }
  if (t.members.includes(uid)) return { ok: false, msg: '你已在队伍中' }
  if (t.members.length >= CFG.ROGUE_TEAM_MAX) return { ok: false, msg: `队伍已满（最多 ${CFG.ROGUE_TEAM_MAX} 人）` }
  f.rogueApplies = f.rogueApplies || {}
  const applies = rogueApplyList(f, leaderUid)
  if (applies.some(x => String(x?.uid) === uid)) return { ok: false, msg: '你已经提交过入队申请，请等待队长处理' }
  applies.push({ uid, nick: nick || uid, at: Date.now() })
  f.rogueApplies[leaderUid] = applies
  saveFake(f, gid)
  return { ok: true, msg: `已向队长 ${t.leaderName} 提交入队申请，等待对方 #同意申请` }
}

/** 队长同意/拒绝申请 */
export function respondApply (f, gid, uid, accept) {
  uid = String(uid)
  const applies = rogueApplyList(f, uid)
  if (!applies.length) return { ok: false, msg: '当前没有待处理的入队申请' }
  const t = rogueTeamOf(f, uid)
  if (!t || t.leader !== uid) return { ok: false, msg: '你不是队长' }
  const ap = applies.slice().sort((a, b) => (Number(a?.at) || 0) - (Number(b?.at) || 0))[0]
  const rest = applies.filter(x => x !== ap)
  if (rest.length) f.rogueApplies[uid] = rest
  else delete f.rogueApplies[uid]
  if (!ap?.uid) { saveFake(f, gid); return { ok: false, msg: '入队申请信息已失效' } }
  if (rogueTeamOf(f, ap.uid)) { saveFake(f, gid); return { ok: false, msg: '申请人已在其他队伍' } }
  if (!accept) { saveFake(f, gid); return { ok: true, msg: `你已拒绝 ${ap.nick || ap.uid} 的入队申请` } }
  if (t.members.length >= CFG.ROGUE_TEAM_MAX) {
    f.rogueApplies[uid] = applies
    saveFake(f, gid)
    return { ok: false, msg: `队伍已满（最多 ${CFG.ROGUE_TEAM_MAX} 人），申请暂时保留` }
  }
  t.members.push(String(ap.uid))
  removeRogueApply(f, ap.uid)
  saveFake(f, gid)
  return { ok: true, msg: `✅ ${ap.nick || ap.uid} 已加入【${t.name}】！` }
}

/** 队长踢人 */
export function kickRogue (f, gid, uid, targetUid) {
  uid = String(uid); targetUid = String(targetUid)
  const t = rogueTeamOf(f, uid)
  if (!t || t.leader !== uid) return { ok: false, msg: '只有队长可以踢人' }
  if (targetUid === uid) return { ok: false, msg: '不能踢自己（想走用 #转让队长 或 #解散队伍）' }
  if (!t.members.includes(targetUid)) return { ok: false, msg: '对方不在队伍中' }
  t.members = t.members.filter(u => u !== targetUid)
  saveFake(f, gid)
  return { ok: true, msg: '你已将其踢出队伍' }
}

/** 转让队长 */
export function transferRogue (f, gid, uid, targetUid, targetNick) {
  uid = String(uid); targetUid = String(targetUid)
  const t = rogueTeamOf(f, uid)
  if (!t || t.leader !== uid) return { ok: false, msg: '只有队长可以转让' }
  if (targetUid === uid) return { ok: false, msg: '你已经是队长了' }
  if (!t.members.includes(targetUid)) return { ok: false, msg: '对方不在队伍中' }
  t.leader = targetUid
  t.leaderName = targetNick || '散修'
  saveFake(f, gid)
  return { ok: true, msg: `✅ 队长已转让给 ${t.leaderName}` }
}

/** 退出队伍(队长退出=解散) */
export function quitRogue (f, gid, uid) {
  uid = String(uid)
  const t = rogueTeamOf(f, uid)
  if (!t) return { ok: false, msg: '你不在任何队伍中' }
  if (t.leader === uid) {
    delete f.rogueTeams[t.id]
    saveFake(f, gid)
    return { ok: true, msg: '你已解散玩家小队' }
  }
  t.members = t.members.filter(u => u !== uid)
  saveFake(f, gid)
  return { ok: true, msg: '你已退出队伍' }
}

/** 队长解散队伍 */
export function disbandRogue (f, gid, uid) {
  uid = String(uid)
  const t = rogueTeamOf(f, uid)
  if (!t || t.leader !== uid) return { ok: false, msg: '只有队长可以解散队伍' }
  delete f.rogueTeams[t.id]
  saveFake(f, gid)
  return { ok: true, msg: '玩家小队已解散' }
}

/** 玩家宗主回应 #守/#不守: 无目标且多处被攻 → 列出可选(带 小区+宗门名 与 人数), 指定目标后 #守 [目标]/#不守 [目标] */
export function respondDefend (f, gid, uid, doDefend, rawTarget = null) {
  const p = f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员' }
  const s = f.sects[p.sect]
  const canDecide = (s && s.owner === String(uid) && p.pos === 'zongzhu') || p.pos === 'fuzong' || p.pos === 'taishang'
  if (!s || !canDecide) return { ok: false, msg: '只有被攻宗门的宗主/副宗主/太上长老可以回应' }
  const pending = (f.sectAttacks || []).filter(a => a.phase === 'prep' && !a.defenderDecided &&
    defenderOf(f, a) === p.sect)
  if (!pending.length) return { ok: false, msg: '当前没有待回应的攻打' }
  let atk = null
  if (rawTarget) {
    atk = pending.find(a => atkMatch(f, a, rawTarget))
    if (!atk) return { ok: false, msg: `当前没有正在攻打${targetRawTxt(f, rawTarget)}的待回应战事` }
  } else if (pending.length > 1) {
    /* 多处被攻: 列出可选, 让宗主指定每处守/弃守 */
    const lines = pending.map(a => {
      const n = (a.defFakes || []).length + (a.defPlayers || []).length
      return `　· ${warTargetTxt(f, a)} · 参战 ${n} 人`
    })
    const first = pending[0]
    return { ok: false, needChoice: true, msg: `⚔️ 本宗正被 ${pending.length} 处攻打：\n${lines.join('\n')}\n请指定：#守 [目标名] 坚守 或 #不守 [目标名] 弃守（如 #守 ${first.targetType === 'area' ? first.target : sectName(f, first.target)}）` }
  } else {
    atk = pending[0]
  }
  atk.defended = doDefend
  atk.defenderDecided = true
  const posCnD = posCnOf(p.pos)
  /* 决定坚守: 在目标大区的守方门人响应守城(defFakes), 才算守方战力 */
  if (doDefend) { defendRespond(f, atk); atkLog(atk, `【迎战】🌙 ${posCnD} ${p.name} 决定坚守${warTargetTxt(f, atk)}，${atk.defFakes.length} 名门人响应守城`) }
  else atkLog(atk, `【弃守】🌙 ${posCnD} ${p.name} 决定弃守${warTargetTxt(f, atk)}（将速战速决）`)
  saveFake(f, gid)
  logEvent(f, 'attack', `【迎战】🌙 ${sectName(f, p.sect)}${posCnD} ${p.name} 决定${doDefend ? '坚守' : '弃守'}${warTargetTxt(f, atk)}！`)
  return { ok: true, msg: doDefend ? `🏯 你已决定坚守${warTargetTxt(f, atk)}！全宗列阵迎战（可发 #参战 加入；开战后可 #驰援 中途调回在外门人回防）` : `🕊️ 你已决定弃守${warTargetTxt(f, atk)}，对方将速战速决` }
}

/** attack 是否以 小区名/宗门名 为目标 */
export function atkMatch (f, a, raw) {
  if (String(a.id) === String(raw).replace(/^[#＃]/, '')) return true
  if (a.snapshot?.target === raw) return true
  const r = regionOfArea(raw)
  if (r) return a.targetType === 'area' && a.target === raw
  const sid = sectIdByName(f, raw)
  return a.targetType === 'sect' && a.target === sid
}

/** 本宗是否为该 attack 的防守方 */
export function isDefOf (f, a, sectId) {
  return defenderOf(f, a) === sectId
}

/** 散修(无宗门档案)退出小队攻打: 从该场战争的 atkPlayers 中移除; 多处可指定目标 */
export function quitRogueParticipation (f, gid, uid, rawTarget = null) {
  const suid = String(uid)
  const atks = (f.sectAttacks || []).filter(a => a.phase !== 'done' && a.by === 'rogue' && (a.atkPlayers || []).includes(suid))
  if (!atks.length) return { ok: false, msg: '你当前没有可退出的参战' }
  let atk = null
  if (rawTarget) {
    atk = atks.find(a => atkMatch(f, a, rawTarget))
    if (!atk) return { ok: false, msg: `没有正在攻打${targetRawTxt(f, rawTarget)}的战事` }
  } else if (atks.length > 1) {
    const lines = atks.map(a => `　· 进攻${warTargetTxt(f, a)} · 参战 ${(a.atkPlayers || []).length} 人`)
    const first = atks[0]
    return { ok: false, needChoice: true, msg: `⚔️ 你正在 ${atks.length} 处小队攻打中：\n${lines.join('\n')}\n请指定：#退战 [目标名]（如 #退战 ${first.targetType === 'area' ? first.target : sectName(f, first.target)}）` }
  } else {
    atk = atks[0]
  }
  const list = atk.atkPlayers || []
  if (atk.phase === 'fight') {
    atk.withdrawals ||= []
    if (!atk.withdrawals.some(x => x.kind === 'player' && x.id === suid)) atk.withdrawals.push({ kind: 'player', id: suid, side: 'atk' })
    saveFake(f, gid)
    return { ok: true, msg: '已申请退战，本轮仍承担伤亡，回合结束后离场' }
  }
  recordWarExit(atk, 'player', suid, '主动退战')
  list.splice(list.indexOf(suid), 1)
  if (atk.wanhunParticipants && atk.wanhunParticipants.atk) {
    atk.wanhunParticipants.atk = atk.wanhunParticipants.atk.filter(x => String(x) !== suid)
  }
  const p = f.players && f.players[suid]
  atkLog(atk, `【退出攻打】${p ? p.name : suid} 退出战斗${warTargetTxt(f, atk)}`)
  saveFake(f, gid)
  return { ok: true, msg: `你已退出攻打${warTargetTxt(f, atk)}` }
}

/** 小队成员离场后可自行重新参战；队长不能替队外真人报名。 */
export function joinRogueParticipation (f, gid, uid, rawTarget) {
  uid = String(uid)
  const team = rogueTeamOf(f, uid)
  const atk = (f.sectAttacks || []).find(a => ['prep', 'fight'].includes(a.phase) && a.by === 'rogue' && atkMatch(f, a, rawTarget))
  if (!team || !atk || String(team.leader) !== String(atk.rogue) || !team.members.map(String).includes(uid)) return { ok: false, msg: '只有该小队现有队员可以报名本场攻打' }
  if (f.players?.[uid]?.sect === defenderOf(f, atk)) return { ok: false, msg: '不能随队攻打自己的宗门' }
  if (!warActorAvailable(f, 'player', uid, atk) || !canPlayerFight(f, uid)) return { ok: false, msg: '你正被另一场战事或关押占用' }
  if (getLoc(getWorld(gid), uid) !== sectRegion(f, atk.target)) return { ok: false, msg: '请先前往目标所在大区' }
  if (atk.atkPlayers.includes(uid)) return { ok: false, msg: '你已经在本场战斗中' }
  if (hasTruce(f, f.players?.[String(uid)]?.sect, defenderOf(f, atk))) return { ok: false, msg: '你所属宗门与目标仍在议和停战期' }
  atk.atkPlayers.push(uid); initWarState(f, atk); recordWanhunParticipant(atk, 'atk', uid)
  atkLog(atk, `【加入攻打】小队成员 ${f.players?.[uid]?.name || uid} 自行返回战场`)
  saveFake(f, gid)
  return { ok: true, msg: `已加入小队战役 #${atk.id}，之前取得的贡献继续保留。` }
}

/** 自动分边(#参战/#退战): 本宗有在途攻打 → atk; 正在被攻 → def; 两者都有 → 'both'; 都无 → 'none'
 *  quit=true 时优先按用户当前所在的参战名单判定; rawTarget 指定时按该目标判定 */
export function resolveJoinSide (f, uid, quit = false, rawTarget = null) {
  const p = f.players && f.players[String(uid)]
  if (!p) return 'none'
  const atks = (f.sectAttacks || []).filter(a => a.phase !== 'done')
  if (rawTarget) {
    const atkW = atks.find(a => (a.atkSect === p.sect || a.coalition?.[p.sect]) && atkMatch(f, a, rawTarget))
    const defW = atks.find(a => isDefOf(f, a, p.sect) && atkMatch(f, a, rawTarget))
    if (quit) {
      if (atkW && (atkW.atkPlayers || []).includes(String(uid))) return 'atk'
      if (defW && (defW.defPlayers || []).includes(String(uid))) return 'def'
    }
    if (atkW && !defW) return 'atk'
    if (defW && !atkW) return 'def'
    return 'none'
  }
  const hasAtk = atks.some(a => a.atkSect === p.sect || a.coalition?.[p.sect])
  const hasDef = atks.some(a => isDefOf(f, a, p.sect))
  if (hasAtk && hasDef) return 'both'
  if (hasAtk) return 'atk'
  if (hasDef) return 'def'
  return 'none'
}

/** 加入/退出 攻打或防守 (side=atk|def|auto; rawTarget=指定目标, 供 #守/#参战 [目标]/#退战 [目标] 选择执行;
 *  #参战/#退战 走 auto 自动分边; 未指定且有多处同侧战事 → 列出可选(带 小区+宗门名 与 人数), 让玩家指定打/守哪一处) */
export function joinSectFight (f, gid, uid, side, quit = false, rawTarget = null) {
  const p = f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员' }
  const fromAuto = side === 'auto'
  if (side === 'auto') side = resolveJoinSide(f, uid, quit, rawTarget)
  if (side === 'none') return { ok: false, msg: rawTarget
    ? `本宗没有在${targetRawTxt(f, rawTarget)}参战（本宗当前也没有进行中的攻打或被攻打）`
    : (quit ? '你当前没有可退出的参战' : '本宗当前没有进行中的攻打或被攻打') }
  const atks = (f.sectAttacks || []).filter(a => a.phase !== 'done')
  if (side === 'both') {
    /* 本宗既有攻打又有被攻打且未指定目标 → 合并列出可选 */
    const related = atks.filter(a => a.atkSect === p.sect || isDefOf(f, a, p.sect))
    if (!related.length) return { ok: false, msg: '本宗当前没有进行中的攻打或被攻打' }
    const cmd = quit ? '退战' : '参战'
    const lines = related.map(a => {
      const isDef = isDefOf(f, a, p.sect)
      const n = isDef
        ? (a.defFakes || []).length + (a.defPlayers || []).length
        : (a.atkFakes || []).length + (a.atkPlayers || []).length
      return `　· ${isDef ? '防守' : '进攻'}${warTargetTxt(f, a)} · 参战 ${n} 人`
    })
    const first = related[0]
    return { ok: false, needChoice: true, msg: `⚔️ 本宗既有攻打又有被攻打：\n${lines.join('\n')}\n请指定：#${cmd} [目标名]（如 #${cmd} ${first.targetType === 'area' ? first.target : sectName(f, first.target)}）` }
  }
  let atk = null
  if (side === 'atk') {
    atk = rawTarget
      ? atks.find(a => (a.atkSect === p.sect || a.coalition?.[p.sect]) && atkMatch(f, a, rawTarget))
      : atks.find(a => a.atkSect === p.sect || a.coalition?.[p.sect])
  } else {
    atk = rawTarget
      ? atks.find(a => isDefOf(f, a, p.sect) && atkMatch(f, a, rawTarget))
      : atks.find(a => isDefOf(f, a, p.sect))
  }
  /* 多处同侧战事且未指定目标 → 先列出可选(带 小区+宗门名 与 人数), 让玩家指定打/守哪一处 */
  if (!rawTarget) {
    const related = side === 'atk'
      ? atks.filter(a => a.atkSect === p.sect || a.coalition?.[p.sect])
      : atks.filter(a => isDefOf(f, a, p.sect))
    if (related.length > 1) {
      const cmd = quit
        ? (fromAuto ? '退战' : (side === 'atk' ? '退出攻打' : '退出防守'))
        : (fromAuto ? '参战' : (side === 'atk' ? '参与攻打' : '宗门防守'))
      const lines = related.map(a => {
        const n = side === 'atk'
          ? (a.atkFakes || []).length + (a.atkPlayers || []).length
          : (a.defFakes || []).length + (a.defPlayers || []).length
        return `　· ${warTargetTxt(f, a)} · 参战 ${n} 人`
      })
      const first = related[0]
      return { ok: false, needChoice: true, msg: `⚔️ 本宗有 ${related.length} 处在途战事：\n${lines.join('\n')}\n请指定：#${cmd} [目标名]（如 #${cmd} ${first.targetType === 'area' ? first.target : sectName(f, first.target)}）` }
    }
  }
  if (!atk) {
    return { ok: false, msg: rawTarget
      ? (side === 'atk' ? `本宗没有正在攻打${targetRawTxt(f, rawTarget)}` : `本宗没有被攻打${targetRawTxt(f, rawTarget)}`)
      : (side === 'atk' ? '本宗当前没有进行中的攻打' : '本宗当前没有被攻打') }
  }
  if (!quit && atk.actors?.[`player:${uid}`] && atk.actors[`player:${uid}`].side !== side) return { ok: false, msg: '同一场战争不能改换阵营' }
  if (!quit && !warActorAvailable(f, 'player', uid, atk)) return { ok: false, msg: '你已在另一处战场，请先完成退战' }
  if (!quit && !canPlayerFight(f, uid)) return { ok: false, msg: '你当前被俘或被关押，无法加入攻防' }
  /* 位置校验: 参与攻打/防守须与目标同大区 */
  if (!quit) {
    const w = getWorld(gid)
    const myLoc = getLoc(w, uid)
    const tLoc = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, atk.target)
    if (tLoc && myLoc !== tLoc) return { ok: false, msg: `你位于【${regionNameOf(myLoc)}】，目标${warTargetTxt(f, atk)}在【${regionNameOf(tLoc)}】，请先过去` }
  }
  const list = side === 'atk' ? atk.atkPlayers : atk.defPlayers
  if (quit) {
    if (!list.includes(String(uid))) return { ok: false, msg: side === 'atk' ? '你不在攻打队伍中' : '你不在防守队伍中' }
    if (atk.phase === 'fight') {
      atk.withdrawals ||= []
      if (!atk.withdrawals.some(x => x.kind === 'player' && x.id === String(uid))) atk.withdrawals.push({ kind: 'player', id: String(uid), side })
      saveFake(f, gid)
      return { ok: true, msg: '已申请退战，本轮仍承担伤亡，回合结束后离场' }
    }
    recordWarExit(atk, 'player', uid, '主动退战')
    list.splice(list.indexOf(String(uid)), 1)
    if (atk.phase === 'prep' && atk.wanhunParticipants) {
      const snapshot = atk.wanhunParticipants[side] || []
      atk.wanhunParticipants[side] = snapshot.filter(x => String(x) !== String(uid))
    }
    atkLog(atk, (side === 'atk' ? '【退出攻打】' : '【退出防守】') + `玩家 ${p.name} 退出战斗${warTargetTxt(f, atk)}`)
    saveFake(f, gid)
    return { ok: true, msg: side === 'atk' ? `你已退出攻打${warTargetTxt(f, atk)}` : `你已退出防守${warTargetTxt(f, atk)}` }
  }
  if (list.includes(String(uid))) return { ok: false, msg: side === 'atk' ? `你已在攻打${warTargetTxt(f, atk)}的队伍中` : `你已在防守${warTargetTxt(f, atk)}的队伍中` }
  if (side === 'atk' && hasTruce(f, p.sect, defenderOf(f, atk))) return { ok: false, msg: '本宗与目标仍在议和停战期' }
  list.push(String(uid))
  initWarState(f, atk)
  recordWanhunParticipant(atk, side, uid)
  atkLog(atk, (side === 'atk' ? '【加入攻打】' : '【加入防守】') + `玩家 ${p.name} ${side === 'atk' ? '随军出征' : '应召守城'}${warTargetTxt(f, atk)}`)
  /* 参战记录进天下小事(#查人个人事迹可见) */
  logEvent(f, 'flavor', side === 'atk'
    ? `【出征】🌙 玩家 ${p.name} 随军攻打${warTargetTxt(f, atk)}`
    : `【守城】🌙 玩家 ${p.name} 应召守护${warTargetTxt(f, atk)}`)
  saveFake(f, gid)
  return { ok: true, msg: side === 'atk' ? `⚔️ 你已加入攻打${warTargetTxt(f, atk)}的队伍！` : `🛡️ 你已加入防守${warTargetTxt(f, atk)}！` }
}

/** 玩家宗主中途驰援/增援: 战斗(fight)中, 宗主/副宗/太上可下令调回在外门人——
 *  被攻打时驰援回防(defFakes), 本宗攻打时增援前线(atkFakes); 宝库出资传送费
 *  多个战事同时进行时, 无参列出可选; #驰援 [目标名] [人数] 指定驰援哪一处、派多少人 — 玩家宗门对等伪玩家 aiReinforce 中途喊人 */
/** 统一调兵入口: delta>0 增兵(复用 sectReinforce), delta<0 减兵(只撤伪玩家门人, 不退传送费);
 *  准备期撤空攻军取消、守军弃守；开战后本轮结算才撤离。 */
export async function sectForceAdjust (f, gid, uid, rawTarget = null, delta = 1) {
  const d = Math.trunc(Number(delta) || 0)
  if (!d) return { ok: false, msg: '请指定调兵人数' }
  if (d > 0) return sectReinforce(f, gid, uid, rawTarget, d)
  const p = f.players && f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员' }
  const s = f.sects[p.sect]
  if (!s || !s.owner) return { ok: false, msg: '只有玩家主导的宗门可以下令调兵' }
  const canDecide = (s.owner === String(uid) && p.pos === 'zongzhu') || p.pos === 'fuzong' || p.pos === 'taishang'
  if (!canDecide) return { ok: false, msg: '只有宗主/副宗主/太上长老可以下令调兵' }
  const base = (f.sectAttacks || []).filter(a => a.phase === 'prep' || a.phase === 'fight')
  const atks = base.filter(a => isDefOf(f, a, p.sect) || a.atkSect === p.sect || a.coalition?.[p.sect])
  if (!atks.length) return { ok: false, msg: '本宗当前没有正在进行的战事' }
  let atk = null
  if (rawTarget) {
    atk = atks.find(a => atkMatch(f, a, rawTarget))
    if (!atk) return { ok: false, msg: `没有正在攻打${targetRawTxt(f, rawTarget)}的战事` }
  } else if (atks.length > 1) {
    const lines = atks.map(a => {
      const isDef = isDefOf(f, a, p.sect)
      const n = isDef ? (a.defFakes || []).length + (a.defPlayers || []).length : (a.atkFakes || []).length + (a.atkPlayers || []).length
      return `　· ${isDef ? '防守' : '进攻'}${warTargetTxt(f, a)} · 参战 ${n} 人`
    })
    const first = atks[0]
    return { ok: false, needChoice: true, msg: `⚔️ 本宗当前有 ${atks.length} 处在途战事：\n${lines.join('\n')}\n请指定：#减兵 [目标名] [人数]（如 #减兵 ${first.targetType === 'area' ? first.target : sectName(f, first.target)} 1）` }
  } else atk = atks[0]
  const isDef = isDefOf(f, atk, p.sect)
  const sideSect = p.sect
  initWarState(f, atk)
  const list = isDef ? (atk.defFakes || (atk.defFakes = [])) : (atk.atkFakes || (atk.atkFakes = []))
  if (!list.length) return { ok: false, msg: `${isDef ? '守军' : '攻军'}没有可撤的伪玩家门人` }
  const removeN = Math.min(Math.abs(d), list.length)
  const removeNames = list.filter(n => f.roster[n]?.sect === p.sect).sort((a, b) => personPower(f.roster[a] || {}) - personPower(f.roster[b] || {})).slice(0, removeN)
  if (!removeNames.length) return { ok: false, msg: '你只能调回本宗门人' }
  const side = isDef ? 'def' : 'atk'
  if (atk.phase === 'fight') {
    atk.withdrawals ||= []
    for (const id of removeNames) if (!atk.withdrawals.some(x => x.kind === 'fake' && x.id === id)) atk.withdrawals.push({ kind: 'fake', id, side })
  } else {
    for (const n of removeNames) { list.splice(list.indexOf(n), 1); releaseWarFake(f, atk, n) }
  }
  if (isDef && atk.phase === 'prep' && !(atk.defFakes.length + atk.defPlayers.length)) { atk.defended = false; atk.defenderDecided = true }
  atkLog(atk, `【减兵】${removeNames.join('、')}${atk.phase === 'fight' ? '将在本轮交战后撤离' : '撤离战场'}（不退调兵费）`)
  if (!isDef && atk.phase === 'prep' && !(atk.atkFakes.length + atk.atkPlayers.length)) return abortSectAttack(f, gid, atk, Date.now(), '攻军撤空', 'atk', true)
  saveFake(f, gid)
  return { ok: true, msg: `已安排 ${removeNames.length} 人撤离${atk.phase === 'fight' ? '，本轮仍承担伤亡，回合结束后生效' : ''}。守军撤空视为弃守，攻军撤空视为败退。` }

}

export function sectReinforce (f, gid, uid, rawTarget = null, count = 0) {
  count = Math.max(0, Math.floor(Number(count) || 0))
  const p = f.players && f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员' }
  const s = f.sects[p.sect]
  if (!s || !s.owner) return { ok: false, msg: '只有玩家主导的宗门可以下令驰援' }
  const canDecide = (s.owner === String(uid) && p.pos === 'zongzhu') || p.pos === 'fuzong' || p.pos === 'taishang'
  if (!canDecide) return { ok: false, msg: '只有宗主/副宗主/太上长老可以下令驰援' }
  /* 本宗相关的在途战事(准备期/开战期都可驰援, 不再要求"已开战且守方已应战"):
   *  被攻打时准备期就能调回在外门人回防 — 防守(isDefOf) + 进攻(atkSect=本宗) */
  const base = (f.sectAttacks || []).filter(a => a.phase === 'prep' || a.phase === 'fight')
  const defAtks = base.filter(a => isDefOf(f, a, p.sect))
  const atkAtks = base.filter(a => a.atkSect === p.sect)
  const atks = [...defAtks, ...atkAtks]
  if (!atks.length) return { ok: false, msg: '本宗当前没有正在进行的战事，无需驰援' }
  const isDefOfAtk = (a) => isDefOf(f, a, p.sect)
  let atk = null
  if (rawTarget) {
    atk = atks.find(a => atkMatch(f, a, rawTarget))
    if (!atk) return { ok: false, msg: `没有正在攻打${targetRawTxt(f, rawTarget)}的战事` }
  } else if (atks.length > 1) {
    /* 多处战事: 列出可选(带 小区+宗门名 与 人数), 让玩家指定驰援/增援哪一处 */
    const lines = atks.map(a => {
      const side = isDefOfAtk(a) ? '防守' : '进攻'
      const n = side === '防守'
        ? (a.defFakes || []).length + (a.defPlayers || []).length
        : (a.atkFakes || []).length + (a.atkPlayers || []).length
      return `　· ${side}${warTargetTxt(f, a)} · 参战 ${n} 人`
    })
    const first = atks[0]
    return { ok: false, needChoice: true, msg: `⚔️ 本宗当前有 ${atks.length} 处在途战事：\n${lines.join('\n')}\n请指定：#驰援 [目标名] [人数]（如 #驰援 ${first.targetType === 'area' ? first.target : sectName(f, first.target)} 3）` }
  } else {
    atk = atks[0]
  }
  const isDef = isDefOfAtk(atk)
  const sectId = isDef ? (defenderOf(f, atk)) : atk.atkSect
  if (!sectId) return { ok: false, msg: '战事异常' }
  const tRegion = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, atk.target)
  const taiSet = new Set((f.sectMap[sectId] && f.sectMap[sectId].taishang) || [])
  const inFight = new Set(isDef ? (atk.defFakes || []) : (atk.atkFakes || []))
  const allAlive = sectAlive(f, sectId)
  const local = allAlive.filter(p => canFakeFight(f, p.name) && (p.loc || DEFAULT_REGION) === tRegion && !taiSet.has(p.name) && !inFight.has(p.name) && warActorAvailable(f, 'fake', p.name, atk))
  const away = allAlive.filter(p => canFakeFight(f, p.name) && (p.loc || DEFAULT_REGION) !== tRegion && !taiSet.has(p.name) && !inFight.has(p.name) && warActorAvailable(f, 'fake', p.name, atk))
  const remain = [...local.sort((a, b) => personPower(b) - personPower(a)), ...away.sort((a, b) => personPower(b) - personPower(a))]
  if (!remain.length) {
    /* 区分"无人可调"与"人已在场": 门人都驻守目标大区/已参战时不笼统报"无兵可调" */
    const alive = allAlive
    const onField = alive.filter(p => (p.loc || DEFAULT_REGION) === tRegion || taiSet.has(p.name) || inFight.has(p.name)).length
    return { ok: false, msg: alive.length && onField === alive.length
      ? `本宗门人已全部驻守【${regionNameOf(tRegion)}】或已参战，无兵可调`
      : '本宗在外门人已全部就位，无兵可调' }
  }
  const plan = planWarDeployment(f, gid, sectId, tRegion, remain, count, atk)
  if (!plan.units.length) return { ok: false, msg: count > 0 ? `指定的 ${count} 人无法全部调派（可调门人 ${remain.length} 人，宝库可支付 ${Math.floor(getVault(f, sectId).stones / CFG.SECT_DEPLOY_COST)} 人传送费）；还需通过封海检查` : '暂无可调兵力（跨区需预算且不能穿过封海）' }
  commitWarDeployment(f, sectId, atk, isDef ? 'def' : 'atk', plan)
  initWarState(f, atk)
  const pulled = plan.units.map(x => x.name)
  const toDeploy = pulled.length
  const deployCost = plan.cost
  for (const name of pulled) { try { fakeCombatPill(f, f.roster[name]) } catch (err) {} }
  saveFake(f, gid)
  logEvent(f, 'attack', `【驰援】🌙 ${sectName(f, sectId)} 宗主下令，${deployCost > 0 ? `出资 ${deployCost} 灵石，` : ''}再调 ${toDeploy} 名弟子${isDef ? '驰援回防' : '增援攻打'}${warTargetTxt(f, atk)}！`, Date.now(), { major: true })
  atkLog(atk, `【驰援】宗主下令再调 ${toDeploy} 名弟子${isDef ? '驰援前线' : '增援攻打'}（${pulled.join('、')}）`, Date.now())
  const countNote = count > 0 ? (toDeploy < count ? `（你指定 ${count} 人，仅能调派 ${toDeploy} 人）` : `（按你指定 ${count} 人）`) : ''
  return { ok: true, msg: `⚔️ 你下令${isDef ? '驰援回防' : '增援攻打'}${warTargetTxt(f, atk)}！${deployCost > 0 ? `出资 ${deployCost} 灵石，` : ''}${pulled.join('、')} 火速奔赴前线（现有${isDef ? '守军' : '攻军'} ${(isDef ? atk.defFakes : atk.atkFakes).length} 人）${countNote}` }
}

/** 玩家宗主集结仆从: 收服的仆从(真实伪玩家)参与本宗攻打(增援)或守城(回防), 类似 #驰援 但用个人仆从
 *  只限在世且归顺于本玩家的仆从; 仆从参战计入战力, 可能战死/被俘/受伤; 多处战事可指定, count 限定集结人数 */
export async function sectServantRally (f, gid, uid, rawTarget = null, count = 0) {
  count = Math.max(0, Math.floor(Number(count) || 0))
  const p = f.players && f.players[String(uid)]
  if (!p) return { ok: false, msg: '你不是宗门成员' }
  const s = f.sects[p.sect]
  if (!s || !s.owner) return { ok: false, msg: '只有玩家主导的宗门可以集结仆从' }
  const canDecide = (s.owner === String(uid) && p.pos === 'zongzhu') || p.pos === 'fuzong' || p.pos === 'taishang'
  if (!canDecide) return { ok: false, msg: '只有宗主/副宗主/太上长老可以集结仆从' }
  /* 读玩家仆从列表；世界存档 servantOf 是事实来源，Redis 丢失/旧TTL过期时自动重建 */
  let servants = []
  const servantKey = `xujing:ambush-servant:${gid}:${uid}`
  try {
    const raw = await redis.get(servantKey)
    try { if (raw) servants = JSON.parse(raw) } catch (err) { servants = [] }
    if (!Array.isArray(servants)) servants = []
    const byName = new Map(servants.map(x => [x.name, x]))
    for (const sp of Object.values(f.roster || {})) {
      if (sp && sp.alive && sp.servantOf === String(uid) && !byName.has(sp.name)) byName.set(sp.name, { name: sp.name, since: sp.servantSince || Date.now() })
    }
    servants = [...byName.values()]
  } catch (err) { servants = [] }
  const aliveServ = servants.filter(x => {
    const sp = f.roster[x.name]
    return canFakeFight(f, x.name) && sp.servantOf === String(uid)
  })
  /* 永久保存所有权名单；矿工只从本次可集结列表排除，不从仆从所有权中删除 */
  const ownedServ = servants.filter(x => {
    const sp = f.roster[x.name]
    return sp && sp.alive && sp.servantOf === String(uid)
  })
  try { await redis.set(servantKey, JSON.stringify(ownedServ)) } catch (err) { }
  if (!aliveServ.length) {
    if (ownedServ.length) return { ok: false, msg: `你的 ${ownedServ.length} 名仆从目前均被押在矿山服役，暂时无法集结` }
    if (servants.length) return { ok: false, msg: `你的 ${servants.length} 名仆从均已不在世或已失联（世界数据曾重置），无法集结，已为你清理名单。重新 #伏击 收服新仆从即可` }
    return { ok: false, msg: '你还没有可集结的仆从（伏击打赢 #伏击处置 收服，见 #仆从玩法）' }
  }
  /* 本宗相关的在途战事(准备期/开战期都可集结): 防守(isDefOf) + 进攻(atkSect=本宗) */
  const base = (f.sectAttacks || []).filter(a => a.phase === 'prep' || a.phase === 'fight')
  const defAtks = base.filter(a => isDefOf(f, a, p.sect))
  const atkAtks = base.filter(a => a.atkSect === p.sect || a.coalition?.[p.sect])
  const atks = [...defAtks, ...atkAtks]
  if (!atks.length) return { ok: false, msg: '本宗当前没有正在进行的战事，无需集结仆从' }
  const isDefOfAtk = (a) => isDefOf(f, a, p.sect)
  let atk = null
  if (rawTarget) {
    atk = atks.find(a => atkMatch(f, a, rawTarget))
    if (!atk) return { ok: false, msg: `没有正在攻打${targetRawTxt(f, rawTarget)}的战事` }
  } else if (atks.length > 1) {
    /* 多处战事: 列出可选(带 小区+宗门名 与 人数), 让玩家指定集结哪一处 */
    const lines = atks.map(a => {
      const side = isDefOfAtk(a) ? '防守' : '进攻'
      const n = side === '防守'
        ? (a.defFakes || []).length + (a.defPlayers || []).length
        : (a.atkFakes || []).length + (a.atkPlayers || []).length
      return `　· ${side}${warTargetTxt(f, a)} · 参战 ${n} 人`
    })
    const first = atks[0]
    return { ok: false, needChoice: true, msg: `⚔️ 本宗当前有 ${atks.length} 处在途战事：\n${lines.join('\n')}\n请指定：#集结仆从 [目标名] [人数]（如 #集结仆从 ${first.targetType === 'area' ? first.target : sectName(f, first.target)} 3）` }
  } else {
    atk = atks[0]
  }
  const isDef = isDefOfAtk(atk)
  const sectId = p.sect
  if (!sectId) return { ok: false, msg: '战事异常' }
  const tRegion = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, atk.target)
  const inFight = new Set(isDef ? (atk.defFakes || []) : (atk.atkFakes || []))
  const canRally = aliveServ.filter(x => !inFight.has(x.name) && warActorAvailable(f, 'fake', x.name, atk))
  const plan = planWarDeployment(f, gid, sectId, tRegion, canRally.map(x => f.roster[x.name]), count, atk)
  if (!plan.units.length) return { ok: false, msg: '暂无可集结仆从（已参战、封海或调兵费用不足）' }
  commitWarDeployment(f, sectId, atk, isDef ? 'def' : 'atk', plan)
  initWarState(f, atk)
  const pulled = plan.units.map(x => x.name)
  for (const name of pulled) { try { fakeCombatPill(f, f.roster[name]) } catch (err) {} }
  saveFake(f, gid)
  logEvent(f, 'attack', `【仆从集结】🌙 ${sectName(f, p.sect)} 宗主集结 ${pulled.length} 名仆从${isDef ? '回防' : '增援'}${warTargetTxt(f, atk)}！`, Date.now(), { major: true })
  atkLog(atk, `【仆从集结】宗主集结 ${pulled.length} 名仆从${isDef ? '驰援前线' : '增援攻打'}（${pulled.join('、')}）`, Date.now())
  const countNote = count > 0 ? (pulled.length < count ? `（你指定 ${count} 人，仅能集结 ${pulled.length} 人）` : `（按你指定 ${count} 人）`) : ''
  return { ok: true, msg: `⚔️ 你集结了 ${pulled.length} 名仆从${isDef ? '回防' : '增援'}${warTargetTxt(f, atk)}！${countNote}（${pulled.join('、')} 火速奔赴前线）` }
}

/** 拉锯一轮, 返回 'win'/'lose'/null(未结束) */
export async function resolveRound (f, gid, atk, now) {
  if (atk.roundJob?.done && atk.roundJob.result) return atk.roundJob.result
  initWarState(f, atk, now)
  if (!atk.roundJob || atk.roundJob.done) atk.roundJob = { number: (Number(atk.round) || 0) + 1, at: now, done: false }
  now = atk.roundJob.at
  checkpointWar(f, gid)
  const before = structuredClone(f)
  try {
    const result = await resolveRoundUnlocked(f, gid, atk, now)
    atk.roundJob.done = true; atk.roundJob.result = result
    checkpointWar(f, gid)
    return result
  } catch (err) {
    restoreWarFrame(f, before)
    throw err
  }
}

async function resolveRoundUnlocked (f, gid, atk, now) {
  initWarState(f, atk, now)
  pruneFightParticipants(f, atk)
  if (!(atk.atkFakes.length + atk.atkPlayers.length)) return 'lose'
  if (!(atk.defFakes.length + atk.defPlayers.length)) return 'win'
  atk.round++
  await creditWarRound(f, atk, p => CFG.PERSON_BASE + personPower(p), async uid => CFG.PERSON_BASE + await playerPower(f, gid, uid), now)
  const pA = await computeAtkPower(f, gid, atk)
  const pD = await computeDefPower(f, gid, atk)
  wearWarParticipants(f, gid, atk)
  const total = pA + pD
  const pWin = total > 0 ? pA / total : 0.5
  /* 战力悬殊碾压: 先至少交战3轮，再允许强方一轮击溃；避免AI宗门刚开战就立即结束 */
  const crush = atk.round >= 3 && ((pA >= pD * CFG.DEATH_CRUSH_RATIO && pD > 0) || (pD >= pA * CFG.DEATH_CRUSH_RATIO && pA > 0))
  if (crush) {
    atk.roundWinner = pA > pD ? 'atk' : 'def'
    await resolveRoundCasualties(f, gid, atk, now, pA, pD)
    const whoTxt = atk.targetType === 'sect' ? sectName(f, atk.target) : atk.target
    const atkName = atkNameOf(f, atk)
    const big = pA > pD ? atkName : whoTxt
    const small = pA > pD ? whoTxt : atkName
    const winner = pA > pD ? '攻方' : '守方'
    atkLog(atk, `【碾压】${big} 战力碾压 ${small}（${pA} vs ${pD}），摧枯拉朽，${winner}大获全胜`, now)
    applyWarWithdrawals(f, atk, now)
    if (atk.retreating) return atk.retreating === 'atk' ? 'lose' : 'win'
    if (!(atk.atkFakes.length + atk.atkPlayers.length)) return 'lose'
    if (!(atk.defFakes.length + atk.defPlayers.length)) return 'win'
    return pA > pD ? 'win' : 'lose'
  }
  const r = warRoll(atk, `round:${atk.round}:winner`)
  atk.roundWinner = r < pWin ? 'atk' : 'def'
  if (r < pWin) atk.moraleD -= 15 + Math.floor(warRoll(atk, `round:${atk.round}:morale`) * 16)
  else atk.moraleA -= 15 + Math.floor(warRoll(atk, `round:${atk.round}:morale`) * 16)
  /* 每轮减员结算(战场绞肉机): 输的一方从弱到强掉人——被抓/受伤/溃逃/战死, 玩家同样被压制 */
  await resolveRoundCasualties(f, gid, atk, now, pA, pD)
  const whoTxt = atk.targetType === 'sect' ? sectName(f, atk.target) : atk.target
  logEvent(f, 'attack', `【拉锯】${atkNameOf(f, atk)} 攻打【${whoTxt}】血战第 ${atk.round} 轮（攻方士气 ${Math.max(0, Math.round(atk.moraleA))} / 守方 ${Math.max(0, Math.round(atk.moraleD))}）`)
  const aN = (atk.atkFakes || []).length + (atk.atkPlayers || []).length
  const dN = (atk.defFakes || []).length + (atk.defPlayers || []).length
  atkLog(atk, `【第${atk.round}轮】攻方 ${aN} 人（士气${Math.max(0, Math.round(atk.moraleA))}）vs 守方 ${dN} 人（士气${Math.max(0, Math.round(atk.moraleD))}）`, now)
  /* 参战人数打光 → 直接判负(不等士气归零) */
  applyWarWithdrawals(f, atk, now)
  if (!(atk.atkFakes.length + atk.atkPlayers.length)) return 'lose'
  if (!(atk.defFakes.length + atk.defPlayers.length)) return 'win'
  if (atk.retreating) return atk.retreating === 'atk' ? 'lose' : 'win'
  if (!aN) return 'lose'
  if (!dN) return 'win'
  if (atk.moraleA <= 0) return 'lose'
  if (atk.moraleD <= 0) return 'win'
  if (atk.round >= CFG.ROUND_MAX) return atk.moraleA >= atk.moraleD ? 'win' : 'lose'
  return null
}


/** 拉锯战每轮减员: 每轮输的一方从弱到强逐人判定退出——被抓/溃逃为主, 战死极低(玩家本就死不了, 伪玩家也不该轻易死)
 *  退出概率 = 基础损失率(轮次越往后越惨烈 + 士气越低越溃) + 战力被压制幅度(菜的先退)
 *  玩家同样被压制(被抓/受伤退出/溃逃, 不战死; 受伤有重伤debuff); 伪玩家不受伤退出、极少战死
 *  退出者移出参战名单 → 战力随之下降(恶性循环) */
export async function resolveRoundCasualties (f, gid, atk, now, pA, pD) {
  const total = pA + pD
  const pWin = total > 0 ? pA / total : 0.5
  const atkWon = atk.roundWinner ? atk.roundWinner === 'atk' : Math.random() < pWin
  const defSect = defenderOf(f, atk)
  const sides = [
    { isAtk: true, fakes: atk.atkFakes || [], players: atk.atkPlayers || [], morale: atk.moraleA, sectId: atk.atkSect, tag: '攻方' },
    { isAtk: false, fakes: atk.defFakes || [], players: atk.defPlayers || [], morale: atk.moraleD, sectId: defSect, tag: '守方' }
  ]
  for (const sd of sides) {
    if (!sd.fakes.length && !sd.players.length) continue
    const lost = sd.isAtk ? !atkWon : atkWon
    /* 败方: 5% + 轮次最多+8% + 士气越低最多+10% → 绞肉机; 胜方: 1.5% 极低(仅反扑受伤/溃逃, 不被抓不战死) */
    const rate = lost
      ? Math.min(0.45, 0.05 + (atk.round / CFG.ROUND_MAX) * 0.08 + Math.max(0, 100 - sd.morale) / 100 * 0.1)
      : 0.015
    /* 敌方平均战力(压制基准) */
    const enemy = sd.isAtk ? { fakes: atk.defFakes || [], players: atk.defPlayers || [] } : { fakes: atk.atkFakes || [], players: atk.atkPlayers || [] }
    const enemyCnt = Math.max(1, enemy.fakes.length + enemy.players.length)
    const enemyAvg = (sd.isAtk ? pD : pA) / enemyCnt
    /* 收集参战者(门人+玩家)按战力从弱到强: 菜的先判定 */
    const list = []
    for (const n of sd.fakes) {
      const p = f.roster[n]
      if (p && p.alive) list.push({ kind: 'fake', name: n, p, power: personPower(p) })
    }
    for (const uid of sd.players) {
      const pw = await playerPower(f, gid, uid)
      list.push({ kind: 'player', uid: String(uid), power: pw })
    }
    list.sort((a, b) => a.power - b.power)
    for (const it of list) {
      /* AI宗门守方先死守；战局明显不利时，低忠诚门人才会临阵逃跑 */
      if (it.kind === 'fake' && !sd.isAtk && atkWon && pA > pD) {
        const loyalty = Number(it.p.loyalty) || 60
        const fleeRate = loyalty < 50 ? Math.min(0.8, (50 - loyalty) / 50 * 0.8) : 0
        if (fleeRate > 0 && warRoll(atk, `round:${atk.round}:flee:${it.name}`) < fleeRate) {
          const idx = sd.fakes.indexOf(it.name)
          if (idx >= 0) sd.fakes.splice(idx, 1)
          const home = sd.sectId ? sectRegion(f, sd.sectId) : null
          releaseWarFake(f, atk, it.name, '溃逃', now)
          logEvent(f, 'attack', `【逃跑】${sectName(f, sd.sectId)} 门人 ${it.name} 见攻方占优，因忠诚不足临阵脱逃`, now, { who: [it.name], sect: sd.sectId })
          atkLog(atk, `【逃跑】${it.name} 忠诚不足，见势不妙逃离战场`, now)
          continue
        }
      }
      const weakness = enemyAvg > 0 ? Math.max(0, (enemyAvg - it.power) / enemyAvg) : 0
      const pExit = Math.min(0.6, Math.max(0.02, rate + weakness * 0.3))
      if (warRoll(atk, `round:${atk.round}:exit:${it.name || it.uid}`) >= pExit) continue
      if (it.kind === 'fake') {
        const p = it.p
        const idx = sd.fakes.indexOf(it.name)
        if (idx < 0) continue
        const sTag = sd.sectId ? sectName(f, sd.sectId) : '散修'
        /* 战死: 遵循"境界越高越难死"(与 settleDefeatDeaths 同公式 1级≈5%→68级≈0.5%), 玩家死不了, 伪玩家也不该轻易死 */
        let deathRate = CFG.DEATH_BASE * (1 - 0.9 * (Number(p.level) || 0) / 68)
        deathRate = Math.max(0.5, deathRate)
        if (warRoll(atk, `round:${atk.round}:death:${it.name}`) * 100 < deathRate) {
          sd.fakes.splice(idx, 1)
          killPerson(f, p, '战场战死', now)
          recordWanhunKill(atk, p, sd.isAtk ? 'atk' : 'def')
          logEvent(f, 'attack', `【战死】${sTag}门人 ${it.name} 战死沙场`, now, { who: [it.name], sect: sd.sectId })
          atkLog(atk, `【战死】${it.name} 战死沙场`, now)
          continue
        }
        /* 未战死 → 被抓 / 受伤退出(伪玩家同样会受伤) / 溃逃 */
        const roll = warRoll(atk, `round:${atk.round}:fate:${it.name || it.uid}`)
        if (roll < 0.35) {
          ensureCapSub(atk)
          const capBy = sd.isAtk ? atk.captives.byDef : atk.captives.byAtk
          atk.captives.fakes.push(it.name)
          capBy.fakes.push(it.name)
          sd.fakes.splice(idx, 1)
          logEvent(f, 'captive', `【被俘】${sTag}门人 ${it.name} 战场被擒`, now, { who: [it.name], sect: sd.sectId })
          atkLog(atk, `【被俘】${it.name} 战场被擒`, now)
        } else if (roll < 0.75) {
          sd.fakes.splice(idx, 1)
          /* 重伤退出=真实重伤(负伤期间战力下降, 恢复期结束才复原 — 不再"重伤了还活蹦乱跳") */
          if (p && !(p.injury && p.injury.level)) p.injury = { level: 2 + Math.floor(warRoll(atk, `round:${atk.round}:injury:${it.name}`) * 2), at: now }
          logEvent(f, 'captive', `【负伤】${sTag}门人 ${it.name} 重伤退出战场`, now, { who: [it.name], sect: sd.sectId })
          atkLog(atk, `【负伤】${it.name} 重伤退出战场`, now)
        } else {
          sd.fakes.splice(idx, 1)
          const home = sd.sectId ? sectRegion(f, sd.sectId) : null
          releaseWarFake(f, atk, it.name, '溃逃', now)
          logEvent(f, 'attack', `【溃逃】${sTag}门人 ${it.name} 溃散而逃`, now, { who: [it.name], sect: sd.sectId })
          atkLog(atk, `【溃逃】${it.name} 溃散而逃`, now)
        }
      } else {
        const idx = sd.players.indexOf(it.uid)
        if (idx < 0) continue
        const nick = await getNick(gid, it.uid)
        const roll = warRoll(atk, `round:${atk.round}:fate:${it.name || it.uid}`)
        if (roll < 0.4) {
          /* 被擒瞬间即标记被俘(禁动作)+通知, 处置等结算 */
          const opp = sd.isAtk
            ? (defSect ? sectName(f, defSect) : '守军')
            : (atk.atkSect ? sectName(f, atk.atkSect) : (atk.rogueName || '散修'))
          await capturePlayerNow(f, gid, atk, it.uid, now, opp, sd.isAtk ? 'def' : 'atk')
          sd.players.splice(idx, 1)
          logEvent(f, 'captive', `【被俘】玩家 ${nick} 战场被擒`, now, { who: [nick] })
          atkLog(atk, `【被俘】玩家 ${nick} 战场被擒`, now)
        } else if (roll < 0.75) {
          applyInjury(f, it.uid, 1 + Math.floor(warRoll(atk, `round:${atk.round}:injury:${it.uid}`) * 2), now, gid, `${warReceipt(atk)}:injury:${atk.phase}:${atk.round}:${it.uid}`)
          sd.players.splice(idx, 1)
          logEvent(f, 'captive', `【负伤】玩家 ${nick} 重伤退出战场`, now, { who: [nick] })
          atkLog(atk, `【负伤】玩家 ${nick} 重伤退出战场`, now)
        } else {
          sd.players.splice(idx, 1)
          logEvent(f, 'attack', `【溃逃】玩家 ${nick} 溃散而逃`, now, { who: [nick] })
          atkLog(atk, `【溃逃】玩家 ${nick} 溃散而逃`, now)
        }
      }
    }
  }
}

/**
 * 败方战死判定(每场结算统一判定, 不再每轮死人):
 *  - 基础死亡率 DEATH_BASE(5%), 境界越高越难死(68级≈0.5%)
 *  - 碾压按基础率×2.5，明确血仇×3；普通争执不触发50%处决式战死
 *  - 城破(isCityFall)未死者 → 远遁(逃跑, 仍在宗门, 只记事件)
 * @param excludeFakes 已被俘虏的成员(打宗门时排除, 由胜方处置)
 */
export function settleDefeatDeaths (f, atk, loseSect, winSect, isCityFall, crush, now = Date.now(), excludeFakes = []) {
  const excluded = new Set(excludeFakes)
  const winMembers = winSect ? sectAlive(f, winSect) : []
  /* 战死只从参战名单判定: 攻方败=atkFakes, 守方败(城破)=defFakes; 没参战的门人走俘虏由胜方处置, 不再被"隔空战死" */
  const fought = isCityFall ? (atk.defFakes || []) : (atk.atkFakes || [])
  const loseMembers = fought.map(n => f.roster[n]).filter(p => p && p.alive && p.sect === loseSect && !excluded.has(p.name))
  if (!loseMembers.length) return
  const dead = []
  const fled = []
  const loseName = sectName(f, loseSect)
  for (const p of loseMembers) {
    const bloodFeud = winMembers.some(w => hasBloodFeud(p, w) || hasBloodFeud(w, p))
    const rate = defeatDeathRate(p.level, { crush, bloodFeud, base: CFG.DEATH_BASE, ceiling: CFG.DEATH_CRUSH_RATE })
    if (warRoll(atk, `death:${p.name}`) * 100 < rate) dead.push(p)
    else if (isCityFall) fled.push(p)
  }
  for (const p of dead) {
    killPerson(f, p, `【战死】${loseName} ${p.name} 在城破之际力战而死`, now)
    recordWanhunKill(atk, p, isCityFall ? 'def' : 'atk')
  }
  if (dead.length) atkLog(atk, `【战死】${loseName} ${dead.map(p => p.name).join('、')} 力战而亡`, now)
  if (isCityFall && fled.length) logEvent(f, 'attack', `【远遁】${loseName} 城破，${fled.length} 名修士四散远遁而去`, now, { who: fled.map(p => p.name) })
  if (isCityFall && fled.length) atkLog(atk, `【远遁】${loseName} ${fled.map(p => p.name).join('、')} 城破远遁`, now)
}


/** 两人是否有羁绊(道侣/师徒/知己/挚友/手足/亲族) */
export function relLinked (f, a, b) {
  const ra = (a && a.relations) || {}
  const rb = (b && b.relations) || {}
  return ra.spouse === b.name || rb.spouse === a.name ||
    ra.master === b.name || rb.master === a.name ||
    (ra.disciples || []).includes(b.name) || (rb.disciples || []).includes(a.name) ||
    (ra.confidants || []).includes(b.name) || (rb.confidants || []).includes(a.name) ||
    (ra.friends || []).includes(b.name) || (rb.friends || []).includes(a.name) ||
    (ra.siblings || []).includes(b.name) || (rb.siblings || []).includes(a.name) ||
    (ra.kin || []).includes(b.name) || (rb.kin || []).includes(a.name)
}

/** 同门对连续避战者的不满(按性格/关系/宗门文化动态, 不写死):
 *  嗜杀/魔道→记恨(单方面结仇); 好斗→当面训斥; 善良/平和→暗地议论;
 *  有羁绊者护着(降低触发); 好战宗门更严厉; 败方怨气重、胜方较宽容; 严重避战(≥3)→忠诚下降 */
export function sectDislikeAbsent (f, sid, p, streak, role, won, harsh, now) {
  const sname = sectName(f, sid)
  const members = sectAlive(f, sid).filter(m => m.name !== p.name)
  if (!members.length) return
  const angry = members.filter(m => m.trait === '好斗' || m.trait === '嗜杀' || m.path === '魔道')
  const soft = members.filter(m => m.trait === '善良' || m.trait === '平和')
  const severe = streak >= 3
  const defender = members.find(m => relLinked(f, p, m))
  /* 触发概率: 缺席越多越压不住; 好战宗更严; 败方怨气重; 有人护着更软 */
  let pTrigger = 0.25 + Math.max(0, streak - 1) * 0.25 + (harsh ? 0.2 : 0) + (won ? -0.1 : 0.2)
  if (defender) pTrigger -= 0.15
  pTrigger = clamp(pTrigger, 0.02, 0.9)
  if (Math.random() > pTrigger) return
  const speaker = angry.length ? pick(angry) : (soft.length ? pick(soft) : pick(members))
  const sTrait = speaker.trait || ''
  if (sTrait === '嗜杀' || speaker.path === '魔道' || severe) {
    if (!speaker.relations.enemies) speaker.relations.enemies = []
    if (!speaker.relations.enemies.includes(p.name)) speaker.relations.enemies.push(p.name)
    logEvent(f, 'flavor', `【记恨】${sname} ${speaker.name} 对 ${p.name} ${streak} 次避战${role}心生记恨`, now, { who: [p.name, speaker.name], sect: sid })
  } else if (sTrait === '好斗' || severe) {
    logEvent(f, 'flavor', `【训斥】${sname} ${speaker.name} 当面斥责 ${p.name}：宗门有难竟${streak}次缩头避战！`, now, { who: [p.name, speaker.name], sect: sid })
  } else {
    logEvent(f, 'flavor', `【议论】${sname} ${speaker.name} 对 ${p.name} 屡次不参与${role}颇有微词`, now, { who: [p.name, speaker.name], sect: sid })
  }
  if (severe) p.loyalty = Math.max(0, (Number(p.loyalty) || 50) - (harsh ? 8 : 4))
  /* 被记恨者也会记恨回去(双向结怨) */
  if (sTrait === '嗜杀' || speaker.path === '魔道') {
    if (!p.relations.enemies) p.relations.enemies = []
    if (!p.relations.enemies.includes(speaker.name)) p.relations.enemies.push(speaker.name)
  }
}

/** 战争结算后参战表现结算: 参战者记战绩并清零避战, 避战者记缺席;
 *  避战者只在"在目标大区且非太上"才算(真被召集才记缺席); 连续避战且宗门里有人上了战场 → 同门不满 */
export function settleSectAttendance (f, atk, now) {
  if (atk.attendanceSettled) return
  for (const actor of Object.values(atk.actors || {})) {
    if (actor.kind !== 'fake' || !actor.rounds) continue
    const p = f.roster[actor.id]
    if (p?.alive) { p.absentStreak = 0; p.fightCount = (p.fightCount || 0) + 1; p.lastFightAt = now }
  }
  atk.attendanceSettled = true
}

export async function payWarRewards (f, gid, atk, now = Date.now()) {
  if (atk.rewardsPaid) return
  initWarState(f, atk, now)
  const actors = Object.values(atk.actors).filter(a => a.contribution > 0)
  const max = Math.max(1, ...actors.map(a => a.contribution))
  atk.rewardPlan ||= actors.map(a => ({ ...a, reward: Math.max(0, Math.round(2000 * a.contribution / max)) }))
  atk.rewardReceipts ||= {}
  checkpointWar(f, gid)
  for (const actor of atk.rewardPlan) {
    const key = `${actor.kind}:${actor.id}`
    if (atk.rewardReceipts[key]) continue
    if (actor.kind === 'player') {
      await payWarPlayer(gid, actor.id, actor.reward, `${warReceipt(atk)}:reward:${actor.id}`)
    } else {
      const person = f.roster[actor.id]
      // 阵亡人物不在世，不给同名新人物发历史奖励。
      if (person?.alive && !atk.wanhunKills?.some(k => k.name === actor.id)) person.money = (Number(person.money) || 0) + actor.reward
      else actor.reward = 0
    }
    atk.rewardReceipts[key] = true
    checkpointWar(f, gid)
  }
  atk.rewards = atk.rewardPlan.map(a => ({ kind: a.kind, uid: a.kind === 'player' ? a.id : undefined, name: a.name, reward: a.reward, contribution: a.contribution }))
  atk.rewardsPaid = true
  checkpointWar(f, gid)
}

const settlingWars = new Map()
export async function finishSectAttack (f, gid, atk, win, now = Date.now()) {
  const key = `${gid}:${atk.id}`
  if (atk.settlement?.done || (atk.phase === 'done' && !atk.settlement)) return
  if (settlingWars.has(key)) return settlingWars.get(key)
  const task = finishSectAttackUnlocked(f, gid, atk, win, now)
  settlingWars.set(key, task)
  try { return await task } finally { settlingWars.delete(key) }
}

async function finishSectAttackUnlocked (f, gid, atk, win, now = Date.now()) {
  initWarState(f, atk, now)
  atk.settlement ||= { id: `${warReceipt(atk)}`, win, at: now, effects: {} }
  win = atk.settlement.win; now = atk.settlement.at
  atk.phase = 'settling'
  checkpointWar(f, gid)
  rememberWanhunParticipants(atk)
  atk.capturedUids = [...(atk.captives.players || [])]
  const atkName = atkDisplayName(f, atk)
  const defSect = defenderOf(f, atk)
  /* 战后维护: 攻/守双方记录参战时间, 3 小时内材料维护×2、灵石维护×5(仅玩家宗主宗门生效) */
  markSectWar(f, atk.atkSect, now)
  markSectWar(f, defSect, now)
  /* 小区被打: 目标小区 3 小时内不产出任何收益 */
  if (atk.targetType === 'area') markAreaRaid(f, atk.target, now)
  const defName = defSect ? sectName(f, defSect) : '无主之地'
  /* 完整目标显示(小区+宗门名): 须在易主/灭门前算, 反映战前归属 */
  const targetTxt = warTargetTxt(f, atk)
  /* 有人守(拉锯/开战)才算真战斗; 弃守速战无伤亡 */
  const wasFought = !!atk.defended
  if (wasFought) wearWarParticipants(f, gid, atk)
  /* 战力(须在易主前算, 否则护城阵/占领者会变) */
  let atkPower = 0
  let defPower = 0
  try {
    atkPower = await computeAtkPower(f, gid, atk)
    defPower = defSect ? await computeDefPower(f, gid, atk) : 0
  } catch (err) { }
  atk.settlement.powers ||= { atk: atkPower, def: defPower }
  atkPower = atk.settlement.powers.atk; defPower = atk.settlement.powers.def
  const winPower = win ? atkPower : defPower
  const losePower = win ? defPower : atkPower
  const crush = losePower > 0 && winPower >= losePower * CFG.DEATH_CRUSH_RATIO
  atk.phase = 'settling'
  atk.endAt = now
  atk.result = win ? 'win' : 'lose'
  /* 战后论功行赏: 先算好(供结算图/播报显示), 给所有参战者按输出发灵石 0~2000/人 */
  await payWarRewards(f, gid, atk, now)
  if (!atk.settlement.outcomeDone) {
  const outcomeBefore = structuredClone(f)
  try {
  if (win) {
    /* 结算前重算联盟贡献, 地盘/战利品归贡献最高者(战力优先, 人数次之); 无盟友则归发起方 */
    let winSect = atk.atkSect
    try {
      await recomputeCoalition(f, gid, atk)
      winSect = winnerOfCoalition(atk)
    } catch (err) { }
    if (atk.targetType === 'area') {
      f.areas[atk.target] = winSect
      /* 守小区失败: 守方门人也被俘(碾压时抓得多); 只有参战守方玩家被俘(未参战者人不在战场, 不抓); 未抓者轻伤 */
      if (defSect) {
        const defPs = new Set(atk.defPlayers || [])
        for (const n of atk.defFakes || []) {
          const p = f.roster[n]
          if (!p || !p.alive) continue
          if (warRoll(atk, `capture:fake:${n}`) < (crush ? 0.6 : 0.25)) { ensureCapSub(atk); atk.captives.fakes.push(n); atk.captives.byAtk.fakes.push(n) }
        }
        for (const uid of Object.keys(f.players || {})) {
          const pp = f.players[uid]
          if (!pp || pp.sect !== defSect || atk.captives.players.includes(uid)) continue
          if (defPs.has(uid)) {
            await capturePlayerNow(f, gid, atk, uid, now, winSect ? sectName(f, winSect) : '敌军', 'atk')
            logEvent(f, 'captive', `【被俘】玩家 ${pp.name} 战败被俘`, now, { who: [pp.name], sect: defSect })
          }
        }
        const hurt = []
        for (const uid of Object.keys(f.players || {})) {
          const pp = f.players[uid]
          if (pp && pp.sect === defSect && defPs.has(uid) && !atk.captives.players.includes(uid)) { applyInjury(f, uid, 1 + Math.floor(warRoll(atk, `injury-level:${uid}`) * 2), now, gid, `${warReceipt(atk)}:injury:${atk.phase}:${atk.round}:${uid}`); hurt.push(pp.name) }
        }
        if (hurt.length) atkLog(atk, `【受伤】${hurt.join('、')} 负伤（轻伤）`, now)
        for (const n of atk.captives.fakes || []) {
          const cp = f.roster[n]
          if (cp) logEvent(f, 'captive', `【被俘】${sectName(f, defSect)} 门人 ${n} 战败被俘`, now, { who: [n], sect: defSect })
        }
        if ((atk.captives.fakes || []).length || (atk.captives.players || []).length) {
          atkLog(atk, `【俘虏】${atk.captives.fakes.length} 名门人 + ${atk.captives.players.length} 名玩家被俘`, now)
        }
      }
      /* 城破死亡结算(排除已俘者): 有人守才判; 守方未死者远遁 */
      if (defSect && wasFought) settleDefeatDeaths(f, atk, defSect, winSect, true, crush, now, atk.captives.fakes)
      /* 俘虏按输出分配给联盟各宗门: 玩家宗主宗门保留(#处置俘虏), AI 宗门自动处置自己份额; 散修打赢(无联盟可分)自动处置 */
      atk.captives.byShare = shareCaptivesByOutput(atk)
      let autoDone = false
      for (const [sid, sh] of Object.entries(atk.captives.byShare || {})) {
        if (!sh.fakes.length && !sh.players.length) continue
        const s = f.sects[sid]
        if (s && s.owner) continue
        if (sh.players.length) queueWarEffect(atk, `players:${sid}`, 'players', { sid, list: sh.players })
        if (sh.fakes.length) queueWarEffect(atk, `fakes:${sid}`, 'fakes', { sid, list: sh.fakes })
        autoDone = true
      }
      if (!autoDone && (!winSect || !f.sects[winSect] || !f.sects[winSect].owner)) {
        queueWarEffect(atk, `players:${winSect}`, 'players', { sid: winSect })
        queueWarEffect(atk, `fakes:${winSect}`, 'fakes', { sid: winSect })
      }
    } else {
      for (const [area, owner] of Object.entries(f.areas)) {
        if (owner !== defSect) continue
        if (winSect) f.areas[area] = winSect
        else { delete f.areas[area]; if (f.areaDef) delete f.areaDef[area] }
      }
      /* 俘虏: 参战守方门人被俘(碾压时抓得更多; 没参战的与战场无关, 不抓); 玩家照旧 */
      const defPs = new Set(atk.defPlayers || [])
      for (const n of atk.defFakes || []) {
        const p = f.roster[n]
        if (!p || !p.alive) continue
        if (warRoll(atk, `capture:fake:${n}`) < (crush ? 0.6 : 0.25)) { ensureCapSub(atk); atk.captives.fakes.push(n); atk.captives.byAtk.fakes.push(n) }
      }
      for (const uid of Object.keys(f.players || {})) {
        const pp = f.players[uid]
        if (pp && pp.sect === defSect && defPs.has(uid) && !atk.captives.players.includes(uid) && defPs.has(uid)) {
          await capturePlayerNow(f, gid, atk, uid, now, winSect ? sectName(f, winSect) : '敌军', 'atk')
        }
      }
      /* 未被俘的对方玩家成员也受打击(轻伤) */
      const hurt = []
      for (const uid of Object.keys(f.players || {})) {
        const pp = f.players[uid]
        if (pp && pp.sect === defSect && defPs.has(uid) && !atk.captives.players.includes(uid)) { applyInjury(f, uid, 1 + Math.floor(warRoll(atk, `injury-level:${uid}`) * 2), now, gid, `${warReceipt(atk)}:injury:${atk.phase}:${atk.round}:${uid}`); hurt.push(pp.name) }
      }
      if (hurt.length) atkLog(atk, `【受伤】${hurt.join('、')} 负伤（轻伤）`, now)
      if ((atk.captives.fakes || []).length || (atk.captives.players || []).length) {
        atkLog(atk, `【俘虏】${atk.captives.fakes.length} 名门人 + ${atk.captives.players.length} 名玩家被俘`, now)
      }
      /* 记录被抓(天下小事/个人事迹/守方宗门事迹) */
      for (const n of atk.captives.fakes || []) {
        const cp = f.roster[n]
        if (cp) logEvent(f, 'captive', `【被俘】${sectName(f, defSect)} 门人 ${n} 战败被俘`, now, { who: [n], sect: defSect })
      }
      for (const uid of atk.captives.players || []) {
        const cp = f.players[uid]
        if (cp) logEvent(f, 'captive', `【被俘】玩家 ${cp.name} 战败被俘`, now, { who: [cp.name], sect: defSect })
      }
      /* 城破死亡结算(未被俘者): 有人守才判; 未死者远遁 */
      if (defSect && wasFought) settleDefeatDeaths(f, atk, defSect, winSect, true, crush, now, atk.captives.fakes)
      /* 俘虏按输出分配给联盟各宗门: 玩家宗主宗门保留(#处置俘虏), AI 宗门自动处置自己份额; 散修打赢(无联盟可分)自动处置 */
      atk.captives.byShare = shareCaptivesByOutput(atk)
      let autoDone = false
      for (const [sid, sh] of Object.entries(atk.captives.byShare || {})) {
        if (!sh.fakes.length && !sh.players.length) continue
        const s = f.sects[sid]
        if (s && s.owner) continue
        if (sh.players.length) queueWarEffect(atk, `players:${sid}`, 'players', { sid, list: sh.players })
        if (sh.fakes.length) queueWarEffect(atk, `fakes:${sid}`, 'fakes', { sid, list: sh.fakes })
        autoDone = true
      }
      if (!autoDone && (!winSect || !f.sects[winSect] || !f.sects[winSect].owner)) {
        queueWarEffect(atk, `players:${winSect}`, 'players', { sid: winSect })
        queueWarEffect(atk, `fakes:${winSect}`, 'fakes', { sid: winSect })
      }
    }
    /* 战利品: 败方宝库 30% → 散修按人头平分; 宗门联盟按输出(贡献)比例分配(地盘仍归输出最高者) */
    if (defSect && f.sects[defSect]) {
      const loot = Math.floor((getVault(f, defSect).stones || 0) * 0.3)
      atk.loot = loot
      if (loot > 0) {
        getVault(f, defSect).stones -= loot
        if (atk.rogue) {
          queueWarEffect(atk, 'rogueLoot', 'rogueLoot', { amount: loot, players: Object.values(atk.actors || {}).filter(a => a.kind === 'player' && a.side === 'atk' && (a.rounds > 0 || !atk.roundHistory.length)).map(a => a.id) })
          atkLog(atk, `【洗劫】从【${defName}】宝库掠夺 ${loot} 灵石，按人头分给参战散修`, now)
        } else {
          const { list, total } = coalitionShares(atk)
          if (list.length && total > 0) {
            let used = 0
            const parts = []
            for (let i = 0; i < list.length; i++) {
              const it = list[i]
              const part = i === list.length - 1 ? loot - used : Math.floor(loot * it.power / total)
              if (part > 0 && f.sects[it.sid]) {
                getVault(f, it.sid).stones = (getVault(f, it.sid).stones || 0) + part
                used += part
                parts.push(`${sectName(f, it.sid)} ${part}`)
              }
            }
            atkLog(atk, `【洗劫】从【${defName}】宝库掠夺 ${loot} 灵石，按输出分配：${parts.join('、')}`, now)
          } else if (winSect) {
            getVault(f, winSect).stones = (getVault(f, winSect).stones || 0) + loot
            atkLog(atk, `【洗劫】从【${defName}】宝库掠夺 ${loot} 灵石，充入宗门宝库`, now)
          }
        }
      }
    }
    /* 宗门打宗门打赢：永久灭门，不再设置 rebuildAt 换皮重建；攻打小区仍只夺地盘不灭宗 */
    if (atk.targetType === 'sect' && defSect && f.sects[defSect]) {
      const sid = defSect
      const s = f.sects[sid]
      const deadName = s.name
      const sm = f.sectMap[sid] || {}
      /* 记录灭门之仇后，剩余门人散尽；已俘虏/已送矿者不重复处理 */
      createVendetta(f, sid, [atkName], 'sect', now)
      for (const p of sectAlive(f, sid)) {
        removeFromSectMap(f, sid, p.name)
        p.status = 'scatter'; p.sect = null; p.pos = null
        logEvent(f, 'leave', `【散尽】${deadName} 宗门覆灭，${p.name} 流落江湖`, now)
      }
      /* 玩家成员随宗门彻底覆灭，解除宗门身份；不删除玩家本身 */
      for (const [u2, pp] of Object.entries(f.players || {})) {
        if (pp && pp.sect === sid) {
          if (pp.injury) (f.injuries ||= {})[u2] = structuredClone(pp.injury)
          delete f.players[u2]
          logEvent(f, 'player', `【灭门】玩家 ${pp.name} 随【${deadName}】覆灭，脱离宗门`, now)
        }
      }
      /* 旧宗门关系、职位索引和矿山归属全部断开，宗门对象从天下宗门正式删除 */
      for (const other of Object.values(f.sects)) {
        if (!other) continue
        if (Array.isArray(other.enemies)) other.enemies = other.enemies.filter(x => x !== sid)
        if (Array.isArray(other.allies)) other.allies = other.allies.filter(x => x !== sid)
      }
      queueWarEffect(atk, `liberate:${sid}`, 'liberate', { sid })
      for (const prisoner of f.sectJails?.[sid] || []) if (prisoner.uid) queueWarEffect(atk, `release:${prisoner.uid}`, 'release', { uid: prisoner.uid })
      if (f.sectJails) delete f.sectJails[sid]
      for (const miner of f.sectMines?.[sid] || []) {
        const q = f.roster[miner.name]; if (q) { q.status = 'scatter'; q.mineOf = null; q.sect = null; q.pos = null }
      }
      if (f.sectMines && f.sectMines[sid]) delete f.sectMines[sid]
      /* 永久除名宗门保留最后名称, 历史战报/关系引用不再显示"未知" */
      if (!f.sectDeadNames || typeof f.sectDeadNames !== 'object') f.sectDeadNames = {}
      f.sectDeadNames[sid] = deadName
      forgetSectDiplomacy(f, sid)
      f.worldLifecycleVersion = 2
      delete f.sectMap[sid]
      delete f.sects[sid]
      logEvent(f, 'wipe', `【灭门】${deadName} 被【${atkName}】攻破，宗门彻底覆灭，从天下宗门除名！`, now, { major: true })
      try { sendToGroup(gid, `💥【天下大事】${atkName} 攻破【${deadName}】，宗门彻底覆灭并从天下宗门除名！`) } catch (err) { }
    }
    for (const actor of Object.values(atk.actors || {})) if (actor.kind === 'player' && actor.side === 'atk' && actor.rounds > 0) {
      const pp = f.players[actor.id]; if (pp) pp.contribution = (pp.contribution || 0) + 300
    }
    const winTxt = (winSect && winSect !== atk.atkSect) ? `（由贡献最高的盟友【${sectName(f, winSect)}】夺得）` : ''
    logEvent(f, 'attack', `【攻占】${atkName} ${atk.kind}得手，${targetTxt}易主！${winTxt}`, now, { major: true })
    const winText = `🏯【天下大事】${atkName} 攻占${targetTxt}！${winTxt}${atk.disposedNote ? `🌙 ${atk.disposedNote}` : (((atk.captives && atk.captives.byAtk && atk.captives.byAtk.players) || []).length ? (winSect ? `⛓️ ${((atk.captives && atk.captives.byAtk && atk.captives.byAtk.players) || []).length} 名玩家被俘，请 ${winSect === atk.atkSect ? atkName : sectName(f, winSect)} 宗主发 #处置俘虏 查看处置（全杀/搜刮再杀/全放/搜刮再放/关天牢）` : '') : '')}`
    try { await sendSettleImage(f, gid, atk, true, winSect, atkPower, defPower, defName, winText) } catch (err) { }
  } else {
    for (const actor of Object.values(atk.actors || {})) if (actor.kind === 'player' && actor.side === 'atk' && actor.rounds > 0) {
      const pp = f.players[actor.id]; if (pp) pp.contribution = (pp.contribution || 0) + 100
    }
    /* 攻打失败: 参战攻方玩家也被抓(碾压时守方追击抓得多), 交守方处置; 未被俘者轻伤 */
    const atkPs = atk.atkPlayers || []
    for (const uid of atkPs) {
      if (atk.captives.players.includes(uid)) continue
      if (warRoll(atk, `capture:player:${uid}`) < (crush ? 0.55 : 0.25)) {
        await capturePlayerNow(f, gid, atk, uid, now, defSect ? sectName(f, defSect) : '守军', 'def')
      }
    }
    for (const uid of atkPs) {
      if (atk.captives.players.includes(uid)) continue
      if (warRoll(atk, `injury:${uid}`) < 0.5) applyInjury(f, uid, 1 + Math.floor(warRoll(atk, `injury-level:${uid}`) * 2), now, gid, `${warReceipt(atk)}:injury:${atk.phase}:${atk.round}:${uid}`)
    }
    if (atk.captives.players.length) {
      atkLog(atk, `【俘虏】${atk.captives.players.length} 名玩家被俘`, now)
      for (const uid of atk.captives.players) {
        const cp = f.players && f.players[uid]
        if (cp) logEvent(f, 'captive', `【被俘】玩家 ${cp.name} 战败被俘`, now, { who: [cp.name], sect: atk.atkSect })
      }
    }
    /* 攻方失败: 参战攻方门人先判被俘(碾压时守方追击抓得多), 再判战死; 没参战的门人与战场无关, 不受影响 */
    if (defSect && atk.atkSect) {
      for (const n of atk.atkFakes || []) {
        const p = f.roster[n]
        if (!p || !p.alive) continue
        if (warRoll(atk, `capture:fake:${n}`) < (crush ? 0.55 : 0.2)) { ensureCapSub(atk); atk.captives.fakes.push(n); atk.captives.byDef.fakes.push(n) }
      }
    }
    /* 参战攻方门人战死判定(只从出征名单, 排除已俘者; 不再隔空全宗战死) */
    if (atk.atkSect) settleDefeatDeaths(f, atk, atk.atkSect, defSect || atk.atkSect, false, crush, now, atk.captives.fakes)
    /* 被俘者交守方(胜方)处置: 守方宗门门人气质; 玩家宗门同样由宗门弟子依性格处置 */
    if (defSect && atk.atkSect && (atk.captives.fakes || []).length) {
      atkLog(atk, `【俘虏】${atk.captives.fakes.length} 名门人被俘`, now)
      for (const n of atk.captives.fakes) {
        const cp = f.roster[n]
        if (cp) logEvent(f, 'captive', `【被俘】${sectName(f, atk.atkSect)} 门人 ${n} 战败被俘`, now, { who: [n], sect: atk.atkSect })
      }
      /* 守方有玩家宗主 → 伪玩家战俘也保留等 #处置俘虏(和玩家战俘一致), AI/散修 → 自动处置 */
      const s = f.sects[defSect]
      if (!(s && s.owner)) queueWarEffect(atk, `fakes:${defSect}`, 'fakes', { sid: defSect })
    }
    /* 玩家战俘交守方(胜方)处置: 守方有玩家宗主 → 保留等 #处置俘虏; AI/散修 → 自动处置 */
    if (defSect && atk.captives.players.length) {
      const s = f.sects[defSect]
      if (!(s && s.owner)) queueWarEffect(atk, `players:${defSect}`, 'players', { sid: defSect })
    }
    logEvent(f, 'attack', `【败退】${atkName} 攻打${targetTxt}失利，退兵而归`, now, { major: true })
    const loseText = `🏯【天下大事】${atkName} 攻打${targetTxt}失利，守御成功！${atk.disposedNote ? `🌙 ${atk.disposedNote}` : (((atk.captives && atk.captives.byDef && atk.captives.byDef.players) || []).length ? (defSect && f.sects[defSect] && f.sects[defSect].owner ? `⛓️ ${((atk.captives && atk.captives.byDef && atk.captives.byDef.players) || []).length} 名玩家被俘，请 ${defName} 宗主发 #处置俘虏 查看处置（全杀/搜刮再杀/全放/搜刮再放/关天牢）` : '') : '')}`
    try { await sendSettleImage(f, gid, atk, false, null, atkPower, defPower, defName, loseText) } catch (err) { }
  }
  /* 宗门战结束后统一收魂：同一目标只算一次，获胜方实际参战且装备万魂幡的玩家均分。 */
  atk.settlement.outcomeDone = true
  checkpointWar(f, gid)
  } catch (err) {
    restoreWarFrame(f, outcomeBefore)
    throw err
  }
  }
  await flushWarEffects(f, gid, atk, {
    liberate: data => liberateDestroyedCaptor(f, gid, data.sid, now),
    release: data => unmarkPlayerCaptive(gid, data.uid),
    players: data => autoDisposePlayerCaptives(f, gid, atk, data.sid, now, data.list || null),
    fakes: data => disposeFakeCaptives(f, gid, atk, data.sid, now, data.list || null),
    rogueLoot: async (data, receipt) => {
      const count = data.players.length
      if (!count) return
      const share = Math.floor(data.amount / count)
      for (let i = 0; i < count; i++) await payWarPlayer(gid, data.players[i], i === count - 1 ? data.amount - share * (count - 1) : share, `${receipt}:${data.players[i]}`)
    }
  }, checkpointWar)
  await settleWanhunSouls(f, gid, atk, win ? 'atk' : 'def')
  /* 攻打结束 → 发起方进入冷却(玩家/散修 30 分钟, AI 伪玩家宗门 1 小时) */
  if (atk.atkSect && f.sects[atk.atkSect]) {
    f.sects[atk.atkSect].atkCdUntil = now + (atk.by === 'ai' ? CFG.FAKE_ATK_CD : CFG.PLAYER_ATK_CD) * 60000
  } else if (atk.by === 'rogue') {
    const team = rogueTeamOf(f, atk.rogue)
    if (team) team.atkCdUntil = now + CFG.PLAYER_ATK_CD * 60000
  }
  /* 休战期: 小区按攻打激烈程度4~12小时; 宗门目标按攻打激烈程度12~24小时 */
  const cdMs = atk.targetType === 'area' ? truceMsOf(atk, 4, 12) : truceMsOf(atk, 12, 24)
  f.targetCd[(atk.targetType === 'area' ? 'area:' : 'sect:') + atk.target] = now + cdMs
  /* 被抓玩家: 被擒瞬间已标记被俘+通知; 结算时若已被自动处置 → 补一条处置结果通知(等玩家宗主处置的不重复) */
  for (const uid of (atk.capturedUids || [])) {
    const stillCap = (atk.captives.players || []).map(String).includes(String(uid))
    if (stillCap) continue
    let sname = '敌军'
    try {
      if (atk.result === 'win') {
        if (atk.atkSect && f.sects[atk.atkSect]) sname = sectName(f, atk.atkSect)
      } else {
        const ds = defenderOf(f, atk)
        if (ds && f.sects[ds]) sname = sectName(f, ds)
      }
    } catch (err) { }
    try {
      const g = Bot.pickGroup(gid)
      if (g && g.sendMsg) g.sendMsg([segment.at(Number(uid)), `\n⛓️ 你曾被【${sname}】俘虏，战事结束已被对方处置（结果见 #天下大事）`])
    } catch (err) { }
  }
  /* 小区易主后立即同步税收归属(w.sectMap), 避免后续税收/繁荣算给旧宗门 */
  try { syncWorldSectMap(f, getWorld(gid)) } catch (err) { }
  atkLog(atk, `【${atk.result === 'win' ? '攻占成功' : '攻打失败'}】共 ${atk.round} 轮，耗时约 ${Math.max(0, Math.round((now - atk.start) / 60000))} 分钟`, now)
  /* 参战表现结算: 参战者记战绩, 避战者记缺席; 连续避战遭同门按性格/关系/宗门文化非议(甚至记恨) */
  try { settleSectAttendance(f, atk, now) } catch (err) { }
  /* 结算 → 解救: 骑砍2式——俘虏跟着抓他的人走; 本场败方溃败, 其扣押的胜方成员获救
     win: 胜方=攻方(联盟), 败方=守方 defSect; lose: 胜方=守方 defSect, 败方=攻方 atk.atkSect */
  if (atk.result === 'win') {
    let winSect = atk.atkSect
    try { winSect = winnerOfCoalition(atk) } catch (err) { }
    /* 联盟胜利时，贡献最高者只是地盘归属者；攻方及所有参战盟友都属于胜方，
       本场/他场解救必须覆盖整个胜方阵营，避免发起方或其他盟友的被俘者成为孤儿记录 */
    const winningSects = [...new Set([atk.atkSect, ...Object.keys(atk.coalition || {})].filter(Boolean))]
    if (winningSects.length) await rescueCaptivesOf(f, gid, winningSects, now, defSect, atk.id)
  } else if (atk.result === 'lose' && defSect && f.sects[defSect]) {
    await rescueCaptivesOf(f, gid, [defSect], now, atk.atkSect, atk.id)
  }
  atk.settlement.done = true
  atk.phase = 'done'
  checkpointWar(f, gid)
}

/** 该场战争是否涉及玩家(攻/守任一宗门有玩家成员, 或攻方是散修玩家小队) —— 涉及玩家才播报, 否则只做系统记录 */
export function involvesPlayer (f, atk) {
  if (!atk) return false
  if (atk.rogue) return true
  const defSect = defenderOf(f, atk)
  return Object.values(f.players || {}).some(x => x && x.sect && (x.sect === atk.atkSect || (defSect && x.sect === defSect)))
}

/** 休战期(动态小时): 按攻打激烈程度(参战人数+拉锯轮数)高低计算, 打得越狠休战越久
 *  小区 4~12 小时; 宗门 12~24 小时 */
export function truceMsOf (atk, min = 4, max = 12) {
  const n = ((atk.atkFakes || []).length) + ((atk.atkPlayers || []).length) +
            ((atk.defFakes || []).length) + ((atk.defPlayers || []).length)
  const hours = Math.min(max, Math.max(min, min + Math.round((n + (atk.round || 0) * 2) * 0.5)))
  return hours * 3600000
}

/** 攻打结算图片界面(战果/战力/战损/俘虏/战利品/处置选项); 渲染失败回退纯文本播报 */
export async function sendSettleImage (f, gid, atk, win, winSect, atkPower, defPower, defName, fallback) {
  /* 不涉及玩家的战争只在系统记录, 不往群里播报 */
  if (!involvesPlayer(f, atk)) return
  const atkName = atkDisplayName(f, atk)
  /* 结算图在易主/灭门后渲染: 小区用战前归属(defName), 宗门用 sectTxtOf(灭门则只剩名) */
  const targetTxt = atk.targetType === 'sect'
    ? sectTxtOf(f, atk.target)
    : (defName === '无主之地' ? `【${atk.target}】（无主）` : `【${atk.target}】（${defName}）`)
  const winTxt = winSect && winSect !== atk.atkSect ? `（由贡献最高的盟友【${sectName(f, winSect)}】夺得）` : ''
  const durMin = Math.max(0, Math.round(((atk.endAt || Date.now()) - atk.start) / 60000))
  const lines = []
  lines.push('⚔️ 战争结算')
  lines.push('━━━━━━━━━━━━')
  lines.push(`进攻方：${atkName}（${atk.kind}）`)
  lines.push(`目标：${targetTxt}`)
  lines.push(`结果：${win ? '✅ 攻占成功' : '❌ 攻打失败'}${winTxt}`)
  lines.push(`耗时：${durMin} 分钟${atk.round ? ` · ${atk.round} 轮` : '（速战速决）'}`)
  lines.push(`战力：攻 ${atkPower || 0} vs 守 ${defPower || 0}`)
  lines.push('━━━━━━━━━━━━')
  lines.push(`参战：攻方门人 ${(atk.atkFakes || []).length} + 玩家 ${(atk.atkPlayers || []).length}｜守方门人 ${(atk.defFakes || []).length} + 玩家 ${(atk.defPlayers || []).length}`)
  /* 战损摘要(从战况日志提取战死/远遁/受伤/俘虏处置) */
  const keys = ['【战死】', '【远遁】', '【受伤】', '【处决】', '【释放】', '【搜刮】', '【收押】', '【惩戒】', '【收编】', '【俘虏】']
  const losses = (atk.log || []).filter(l => keys.some(k => (l.txt || '').includes(k))).map(l => l.txt)
  for (const t of losses.slice(-4)) lines.push(t)
  /* 俘虏名单 */
  const cf = (atk.captives || {}).fakes || []
  const cp = (atk.captives || {}).players || []
  if (cf.length || cp.length) {
    const fakeNames = cf.slice(0, 6).join('、')
    const playerNames = cp.slice(0, 6).map(u => { const pp = f.players[u]; return pp ? pp.name : u }).join('、')
    lines.push(`⛓️ 俘虏：${fakeNames}${cf.length > 6 ? ` 等 ${cf.length} 名门人` : `（${cf.length} 名门人）`} + ${playerNames}${cp.length > 6 ? ' 等' : ''}（${cp.length} 名玩家）`)
  }
  /* 战利品(联盟按输出分配) */
  const loot = atk.loot || 0
  if (loot > 0) {
    const cN = Object.keys(atk.coalition || {}).filter(sid => (atk.coalition[sid].power || 0) > 0).length
    lines.push(`💰 战利品：掠夺 ${loot} 灵石${atk.rogue ? '，按人头分给参战散修' : (cN > 1 ? '，按输出分给参战宗门' : '，充入宗门宝库')}`)
  }
  /* 论功行赏(按输出 0~2000/人, 已由 payWarRewards 结算存 atk.rewards) */
  const rw = (atk.rewards || []).filter(x => x.reward > 0)
  const rwTxt = rw.length ? `💰 论功行赏：${rw.length} 名参战者按输出共获 ${rw.reduce((a, x) => a + x.reward, 0)} 灵石（0~2000/人）` : ''
  if (rw.length) {
    lines.push(`💰 论功行赏：${rw.length} 名参战者共获 ${rw.reduce((a, x) => a + x.reward, 0)} 灵石（按输出 0~2000/人）`)
    lines.push(`　${rw.slice().sort((a, b) => b.reward - a.reward).slice(0, 8).map(x => `${x.name}·${x.reward}`).join('、')}`)
  }
  /* 胜方为玩家宗主且有玩家战俘(只算胜方抓的败方人, 不含胜方被擒自己人) → 处置选项 */
  const canHandle = win && winSect && f.sects[winSect] && f.sects[winSect].owner && (((atk.captives && atk.captives.byAtk && atk.captives.byAtk.players) || []).length > 0)
  if (canHandle) {
    lines.push('━━━━━━━━━━━━')
    lines.push('⛓️ 俘虏处置（胜方宗主专属）：')
    lines.push('1️⃣ #处置俘虏 全杀')
    lines.push('2️⃣ #处置俘虏 搜刮再杀')
    lines.push('3️⃣ #处置俘虏 全放')
    lines.push('4️⃣ #处置俘虏 搜刮再放')
    lines.push('5️⃣ #处置俘虏 收编')
    lines.push('6️⃣ #处置俘虏 关天牢')
    lines.push('7️⃣ #处置俘虏 送矿山')
    lines.push('（发 #处置俘虏 查看被俘名单）')
  }
  /* 延迟 5 秒渲染并发送(避开结算时刻 tick 高峰; 用 lines 快照, 不受后续存档变化影响); 渲染带20秒超时, 发送失败自动重试 */
  setTimeout(async () => {
    let img = null
    try {
      img = await Promise.race([
        textToImg(lines.join('\n')),
        new Promise(res => setTimeout(() => res(null), 20000))
      ])
    } catch (err) { img = null }
    if (img) await sendToGroup(gid, img)
    else await sendToGroup(gid, fallback + (rwTxt ? `\n${rwTxt}` : ''))
  }, 5000)
}

/** 发送群消息: 失败自动重试(间隔10秒, 最多3次), 静默容错 */
export async function sendToGroup (gid, msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const g = Bot.pickGroup(gid)
      if (!g || !g.sendMsg) return false
      await g.sendMsg(msg)
      return true
    } catch (err) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, 10000))
    }
  }
  return false
}

/** AI(伪玩家宗主)发动战争的公告图: 准备期发到群里, 说明详情并列出攻/守双方的玩家成员; 不涉及玩家只在系统记录不发 */
export async function sendWarNotice (f, gid, atk) {
  if (!involvesPlayer(f, atk)) return
  const atkName = atkNameOf(f, atk)
  const defSect = defenderOf(f, atk)
  const defName = defSect ? sectName(f, defSect) : '无主之地'
  const targetTxt = warTargetTxt(f, atk)
  const remain = Math.max(1, Math.ceil((atk.prepEnd - Date.now()) / 60000))
  /* 攻/守双方玩家成员 */
  const playersOf = (sid) => {
    if (!sid || !f.sects[sid]) return []
    return Object.values(f.players || {}).filter(p => p && p.sect === sid).map(p => p.name)
  }
  const atkPlayers = playersOf(atk.atkSect)
  const defPlayers = playersOf(defSect)
  const atkForce = atk.atkSect ? sectAlive(f, atk.atkSect).length : 0
  const defForce = defSect ? sectAlive(f, defSect).length : 0
  const pA = atk.atkSect ? await computeAtkPower(f, gid, atk) : 0
  const pD = await computeDefPower(f, gid, atk)
  const lines = []
  lines.push('⚔️【宗门战争公告】')
  lines.push(`📢 ${atkName} 向 ${targetTxt} 宣战！`)
  lines.push('')
  lines.push(`🟥 攻方：${atkName}（弟子 ${atkForce} 人）`)
  lines.push(`   玩家成员：${atkPlayers.length ? atkPlayers.map(n => '🌙 ' + n).join('、') : '（暂无玩家成员）'}`)
  lines.push(`🟦 守方：${defName}（弟子 ${defForce} 人）`)
  lines.push(`   玩家成员：${defPlayers.length ? defPlayers.map(n => '🌙 ' + n).join('、') : '（暂无玩家成员）'}`)
  lines.push('')
  lines.push(`🎯 目标：${targetTxt}`)
  lines.push(`⚔️ 战法：${atk.kind || '正面强攻'}`)
  lines.push(`⏳ 准备期剩余：${remain} 分钟`)
  lines.push(`💪 攻方战力 ${pA} ｜ 守方战力 ${pD}`)
  lines.push('')
  lines.push('🏯 若你是宗门成员，请做好应战/出征准备！')
  try {
    const img = await textToImg(lines.join('\n'))
    if (img) sendToGroup(gid, img)
    else sendToGroup(gid, lines.join('\n'))
  } catch (err) { }
}

/** 终止攻打(撤兵): 玩家宗主/副宗、散修队长可主动终止; AI 被打回防也走这里
 *  终止不设目标保护期(targetCd), 但发起方(宗门/小队)进入攻打冷却(玩家30分钟, AI 4小时) */
export async function abortSectAttack (f, gid, atk, now = Date.now(), byWho = '', side = 'atk', force = false) {
  if (!atk || atk.phase === 'done') return { ok: false, msg: '没有在进行中的攻打' }
  if (atk.phase === 'settling') return { ok: false, msg: '战争正在结算，请稍后查看结果' }
  if (atk.phase === 'fight' && !force) {
    atk.retreating = side
    atkLog(atk, `【撤退】${side === 'def' ? '守方' : '攻方'}下令撤退，本轮交战后按败退结算`, now)
    saveFake(f, gid)
    return { ok: true, msg: '已下令撤退，本轮仍承担伤亡，回合结束后按败退结算' }
  }
  if (side === 'def' && !force) {
    for (const n of atk.defFakes || []) releaseWarFake(f, atk, n, '弃守', now)
    for (const uid of atk.defPlayers || []) recordWarExit(atk, 'player', uid, '弃守', now)
    atk.defFakes = []; atk.defPlayers = []; atk.defended = false; atk.defenderDecided = true
    saveFake(f, gid)
    return { ok: true, msg: '守军已弃守，攻方将在准备期结束后攻占目标。总部被攻破仍会灭门。' }
  }
  for (const field of ['atkFakes', 'defFakes']) for (const name of atk[field] || []) releaseWarFake(f, atk, name, '撤军', now)
  for (const uid of atk.captives?.players || []) await unmarkPlayerCaptive(gid, uid)
  atk.captives = { fakes: [], players: [] }
  const targetTxt = warTargetTxt(f, atk)
  atk.phase = 'done'
  atk.result = 'abort'
  atk.endAt = now
  /* 战后维护: 撤兵也算参战, 攻/守双方记录参战时间(仅玩家宗主宗门生效) */
  markSectWar(f, atk.atkSect, now)
  markSectWar(f, defenderOf(f, atk), now)
  /* 小区被打: 目标小区 3 小时内不产出任何收益 */
  if (atk.targetType === 'area') markAreaRaid(f, atk.target, now)
  atkLog(atk, `【撤兵】${atkNameOf(f, atk)} 终止攻打${targetTxt}${byWho ? '（' + byWho + '）' : ''}`, now)
  logEvent(f, 'attack', `【撤兵】${atkNameOf(f, atk)} 终止攻打${targetTxt}收兵而归${byWho ? '（' + byWho + '）' : ''}`, now, { major: true })
  /* 终止不设目标保护期(可立即被再攻打), 但发起方进入攻打冷却(玩家/散修30分钟, AI伪玩家宗门1小时) */
  if (atk.atkSect && f.sects[atk.atkSect]) {
    f.sects[atk.atkSect].atkCdUntil = now + (atk.by === 'ai' ? CFG.FAKE_ATK_CD : CFG.PLAYER_ATK_CD) * 60000
  } else if (atk.by === 'rogue') {
    const team = rogueTeamOf(f, atk.rogue)
    if (team) team.atkCdUntil = now + CFG.PLAYER_ATK_CD * 60000
  }
  saveFake(f, gid)
  return { ok: true, msg: `✅ ${atkNameOf(f, atk)} 已终止攻打${targetTxt}并撤军（目标不进入保护期，30分钟攻打冷却后即可再发起）` }
}

/** 每分钟推进: 准备期到期/速战/拉锯/超时自动判 */
export async function resolveSectAttacks (f, gid, now = Date.now()) {
  const atks = (f.sectAttacks || []).filter(a => a.phase !== 'done')
  if (!atks.length) return false
  let changed = false
  for (const atk of atks) {
    try {
      initWarState(f, atk, now)
      syncWarClock(atk, now)
      reconcileWarActors(f, atk)
      if (atk.phase === 'fight' && atk.roundJob?.done && atk.roundJob.result) { await finishSectAttack(f, gid, atk, atk.roundJob.result === 'win', now); changed = true; continue }
      if (atk.phase === 'settling') { await finishSectAttack(f, gid, atk, atk.settlement.win, now); changed = true; continue }
      if (new Date(now).getHours() >= 1 && new Date(now).getHours() < 6) { changed = true; continue }
      /* 旧档/异常兜底: 准备期0人攻打的战事, 补1名门人或直接终止, 不允许继续以0人推进 */
      if (atk.phase === 'prep' && !atk.version && atk.atkSect && !(atk.atkFakes || []).length && !(atk.atkPlayers || []).length) {
        const tRegion = atk.targetType === 'area' ? regionOfArea(atk.target) : sectRegion(f, atk.target)
        const guard = ensureMinimumAttackers(f, atk, atk.atkSect, tRegion, atk.cost)
        if (!guard.ok) {
          const atkS = f.sects[atk.atkSect]
          await abortSectAttack(f, gid, atk, now, '无可用出征门人', 'atk', true)
          if (atkS && atkS.vault) atkS.vault.stones = (atkS.vault.stones || 0) + (Number(atk.cost) || 0)
          changed = true
          continue
        }
        changed = true
      }
      if (atk.phase === 'prep' && atk.version && !(atk.atkFakes.length + atk.atkPlayers.length)) {
        await abortSectAttack(f, gid, atk, now, '攻军撤空', 'atk', true); changed = true; continue
      }
      /* 每分钟推进前先清理旧档/联盟助战留下的失效参战名单。 */
      pruneFightParticipants(f, atk)
      /* 宗门目标不存在/已灭门/无人 → 中止攻打；永久删除宗门后也不能留下“未知战争” */
      if (atk.targetType === 'sect') {
        const ts = f.sects[atk.target]
        if (!ts || (ts.wipeAt && ts.wipeAt <= now) || sectAlive(f, atk.target).length === 0) {
          atkLog(atk, '【中止】目标宗门已不存在或覆灭，攻打取消', now)
          await abortSectAttack(f, gid, atk, now, '目标宗门已不存在或覆灭', 'atk', true)
          if (atk.atkSect && f.sects[atk.atkSect]) {
            const s = f.sects[atk.atkSect]
            if (atk.cost > 0) s.vault.stones = (s.vault.stones || 0) + atk.cost
            s.atkCdUntil = 0
          }
          saveFake(f, gid)
          changed = true
          continue
        }
      }
      /* 发起宗门不存在/已灭门 → 中止其攻打，避免永久灭门后留下未知攻方 */
      if (atk.atkSect && (!f.sects[atk.atkSect] || (f.sects[atk.atkSect].wipeAt && f.sects[atk.atkSect].wipeAt <= now))) {
        atkLog(atk, '【中止】发起宗门已不存在或覆灭，攻打取消', now)
        await abortSectAttack(f, gid, atk, now, '本宗已不存在或覆灭', 'atk', true)
        changed = true
        continue
      }
      /* 小区归属宗门已灭门 → 小区无主化(攻打按无主继续) */
      if (atk.targetType === 'area') {
        const owner = f.areas && f.areas[atk.target]
        if (owner && f.sects[owner] && f.sects[owner].wipeAt && f.sects[owner].wipeAt <= now) {
          delete f.areas[atk.target]
          if (f.areaDef) delete f.areaDef[atk.target]
          changed = true
        }
      }
      /* AI 宗门攻打中被打: 评估回防(守不住/来犯者人多)还是继续强攻(我方人多) */
      if (atk.by === 'ai' && atk.atkSect) {
        const incoming = (f.sectAttacks || []).find(a => a.phase !== 'done' && a.id !== atk.id &&
          (a.targetType === 'sect' ? a.target === atk.atkSect : f.areas && f.areas[a.target] === atk.atkSect))
        if (incoming) {
          try {
            const incP = await computeAtkPower(f, gid, incoming)
            const myDef = await potentialDefPower(f, gid, incoming)
            if (myDef < incP) {
              /* 来犯者人多/守不住 → 撤军回防(终止自己的攻打; 不设目标保护期, 本宗进入冷却) */
              atkLog(atk, '【回防】宗门后方告急，主力回防！', now)
              await abortSectAttack(f, gid, atk, now, '回防')
              changed = true
            }
            /* 否则(我方人多)继续强攻, 不理会来犯 */
          } catch (err) { }
        }
      }
      if (atk.phase === 'prep') {
        /* 兼容旧档在途的散修攻打(改前发起的, 旧代码未自动判定/未派人): 按新逻辑补评估, 守得住就派人守城 */
        if (atk.by === 'rogue' && atk.targetType === 'sect' && !atk.rogueAuto && !(atk.defFakes || []).length) {
          const ds = f.sects[atk.target]
          if (ds && !isPlayerLead(f, atk.target)) {
            atk.rogueAuto = true
            if (await aiWantDefend(f, gid, atk)) {
              atk.defended = true
              atk.defAuto = true
              atk.defenderDecided = true
              defendRespond(f, atk)
              atkLog(atk, `【应战】守方决定坚守，${atk.defFakes.length} 名门人响应守城`, now)
              changed = true
            }
          }
        }
        /* 战争公告图: AI(伪玩家宗主)发起的战争, 准备期剩29~10分钟(warNoticeAt)时随机发一次 */
        if (atk.by === 'ai' && !atk.warNotified && atk.warNoticeAt && now >= atk.warNoticeAt) {
          atk.warNotified = true
          changed = true
          try { await sendWarNotice(f, gid, atk) } catch (err) { console.log('[宗门系统]战争公告异常:', err && err.stack) }
        }
        if (!atk.defenderDecided && now >= atk.prepEnd - 1 * 60000) {
          /* 29分钟未回复: 自动判定(孙子兵法·动态防守决策) */
          const defSect = defenderOf(f, atk)
          atk.defAuto = defSect ? (f.sects[defSect]?.owner ? f.sects[defSect].defensePolicy !== '保人' : await aiWantDefend(f, gid, atk)) : false
          atk.defended = atk.defAuto
          atk.defenderDecided = true
          if (atk.defended) defendRespond(f, atk)
          changed = true
        }
        if (now >= atk.prepEnd) {
          const defSect = defenderOf(f, atk)
          if (atk.defended && defSect) {
            atk.phase = 'fight'
            atk.round = 0
            atk.nextRound = now
            /* 开战: 守方参战门人写入个人事迹(#查人可见) */
            logEvent(f, 'attack', `【开战】${atkNameOf(f, atk)} 攻打${warTargetTxt(f, atk)}，守方${sectTxtOf(f, defSect)}列阵迎战！`, now, { who: sectAlive(f, defSect).map(p => p.name) })
            atkLog(atk, `【开战】${atkNameOf(f, atk)} 攻打${warTargetTxt(f, atk)}，守方 ${atk.defFakes.length} 名门人列阵迎战（攻方 ${atk.atkFakes.length} 门人 + ${atk.atkPlayers.length} 玩家）`, now)
            changed = true
          } else {
            await finishSectAttack(f, gid, atk, true, now)
            changed = true
          }
        }
      } else if (atk.phase === 'fight') {
        if (now >= atk.nextRound || (atk.roundJob && !atk.roundJob.done)) {
          atk.nextRound = now + CFG.ROUND_MIN * 60000
          /* AI 守方战斗中持续调兵: 被玩家攻打时每轮倾巢回防, AI 互殴时低概率补兵 */
          try { aiReinforce(f, atk, now) } catch (err) { }
          const done = await resolveRound(f, gid, atk, now)
          if (done) await finishSectAttack(f, gid, atk, done === 'win', now)
          changed = true
        } else {
          /* 实时战报: 轮次间隔中每2分钟检查一次, 仅当战况变化(士气/参战人数/战死/被俘)才追加对峙日志, 无变化不重复刷屏 */
          if (now - (atk.lastStallLog || 0) >= 120000) {
            const aN = (atk.atkFakes || []).length + (atk.atkPlayers || []).length
            const dN = (atk.defFakes || []).length + (atk.defPlayers || []).length
            const logs = atk.log || []
            const deadN = logs.filter(l => String(l.txt || '').includes('【战死】')).length
            const capF = (atk.captives && atk.captives.fakes) || []
            const capP = (atk.captives && atk.captives.players) || []
            const cur = { r: atk.round, a: Math.round(atk.moraleA), d: Math.round(atk.moraleD), aN, dN, dead: deadN, cap: capF.length + capP.length }
            const snap = atk.lastStallSnap
            const same = snap && snap.r === cur.r && snap.a === cur.a && snap.d === cur.d &&
              snap.aN === cur.aN && snap.dN === cur.dN && snap.dead === cur.dead && snap.cap === cur.cap
            if (!same) {
              atk.lastStallLog = now
              atk.lastStallSnap = cur
              const capNames = []
              for (const u of capP) { try { capNames.push(`🌙${await getNick(gid, u)}`) } catch (err) { capNames.push(`🌙${u}`) } }
              const capShow = [...capF, ...capNames]
              const capTxt = capShow.length ? capShow.slice(0, 8).join('、') + (capShow.length > 8 ? ' 等' : '') : '无'
              atkLog(atk, `【对峙】第 ${atk.round} 轮·攻方士气 ${Math.max(0, Math.round(atk.moraleA))}%（${aN} 人）／守方士气 ${Math.max(0, Math.round(atk.moraleD))}%（${dN} 人）｜累计战死 ${deadN} · 被俘 ${capF.length + capP.length}（${capTxt}）`, now)
              changed = true
            }
          }
        }
      }
    } catch (err) { console.log('[宗门系统]攻打结算异常:', err && err.stack) }
  }
  f.sectAttacks = f.sectAttacks.filter(a => a.phase !== 'done' || now - (a.endAt || 0) < 86400000 || hasWarCaptives(a))
  return changed
}

/** AI(伪玩家)攻打: 不限并发——每个伪玩家宗门按自身 4 小时攻打冷却独立行动; 玩家攻打不受此限 */
/** 孙子兵法·防守决策(动态评估, 非固定阈值):
 *  知己知彼(战力比) / 守宗重于守区(总部被端=灭门更拼) / 合纵连横(有盟友愿撑) /
 *  性格(好战愿战, 平和保种) / 兴衰(兴旺愿守, 衰落弃守) / 坚壁清野(悬殊则弃守) */
async function aiWantDefend (f, gid, atk) {
  const defSect = defenderOf(f, atk)
  if (!defSect || !f.sects[defSect]) return false
  /* 伪玩家宗门的领地由系统自动治理：只要仍有可战门人，宗门本体和已占领小区都必须组织防守。
   * 这样“防守”不是永远取决于一次随机阈值，跨区调兵仍由 defendRespond 按宝库预算处理。 */
  if (atk.by === 'ai' && defSect && !isPlayerLead(f, defSect) && sectAlive(f, defSect).some(p => canFakeFight(f, p.name))) return true
  /* 玩家宗门直接攻打宗门本体时，守方只要还有门人就必须应战；战败才触发永久灭门 */
  if (f.sects[defSect].owner && f.sects[defSect].defensePolicy === '保人') {
    return (await potentialDefPower(f, gid, atk)) >= (await potentialAtkPower(f, gid, atk))
  }
  if (atk.by === 'player' && atk.targetType === 'sect' && sectAlive(f, defSect).length > 0) return true
  /* AI宗门本体战必须应战；只要还有存活门人，守方就不能自动弃守 */
  if (atk.by === 'ai' && atk.targetType === 'sect' && sectAlive(f, defSect).length > 0) return true
  const pD = await potentialDefPower(f, gid, atk)
  const pA = await potentialAtkPower(f, gid, atk)
  if (pA <= 0) return true
  const ratio = pD / pA
  let need = 0.55
  const s = f.sects[defSect]
  if (atk.targetType === 'sect') need *= 0.8        // 守宗重于守区: 总部被端=灭门, 更拼
  if ((s.allies || []).length) need *= 0.9          // 合纵连横: 有盟友可能助战, 愿撑
  const zz = f.sectMap[defSect] && f.sectMap[defSect].zongzhu ? f.roster[f.sectMap[defSect].zongzhu] : null
  if (zz && (zz.trait === '好斗' || zz.trait === '嗜杀' || zz.path === '魔道')) need *= 0.85  // 好战愿战
  else if (zz && (zz.trait === '平和' || zz.trait === '善良')) need *= 1.15                  // 平和保种
  const vit = sectVitality(f, defSect)
  if (vit >= 60) need *= 0.9                        // 兴旺: 守得住的价值高, 愿守
  else if (vit <= 25) need *= 1.2                   // 衰落: 弃守保种
  return ratio >= need                             // 坚壁清野: 悬殊则弃守
}
/** AI普通宗门不可越级挑战明显更强的目标；双方都是霸主时允许有限度强强越级 */
function aiTargetMinAttackRatio (f, atkId, tSect) {
  if (!tSect || !f.sects[tSect]) return 0
  const attackerLands = areaCount(f, atkId)
  const targetLands = areaCount(f, tSect)
  return attackerLands >= 4 && targetLands >= 4 ? 0.7 : 0.85
}

/** 孙子兵法·攻打目标评分(动态多因子, 非固定阈值):
 *  知己知彼(战力比) / 避实击虚(不打强) / 趁火打劫(目标刚打完/正被攻/兵少) /
 *  粮草先行(宝库支撑跨区) / 合纵连横(目标盟友风险) / 以逸待劳(同区补给) / 性格修正 */
export async function scoreAiTarget (f, gid, atkId, c, myRegion, myPw, warK, now) {
  if (c.unowned) return 55 + Math.random() * 15     // 无主: 无人守, 白拿(避实击虚)
  /* 宗门目标存于 c.t(宗门名, 非 c.target) → 用 sectIdByName 解析为 id(原查不到导致宗门战目标全失效) */
  const tSect = c.tt === 'sect' ? sectIdByName(f, c.t) : (f.areas ? f.areas[c.t] : null)
  const ts = tSect ? f.sects[tSect] : null
  if (!ts) return 0
  let defPw = await aiTargetDefensePower(f, gid, tSect, c.region, c.tt, c.t)
  const attackerLands = areaCount(f, atkId)
  const targetLands = areaCount(f, tSect)
  const isHegemonTarget = attackerLands >= 4 && targetLands >= 4 && c.tt === 'sect'
  /* 普通宗门不得挑战明显强于自己的目标；霸主争雄仅放宽到约1.4倍战力 */
  if (myPw < defPw * aiTargetMinAttackRatio(f, atkId, tSect)) return -999
  /* 实力相当的宗门本体优先级高于单纯软目标，避免强宗门长期只刷弱者 */
  const closeness = 1 - Math.min(1, Math.abs(myPw - defPw) / Math.max(myPw, defPw, 1))
  /* 宗门本体不能沿用“小区避实击虚”权重:
   * 它会让目标越弱分越高, 导致强宗门即使有强敌也持续刷弱宗。
   * 宗门战只按战力接近度为主。 */
  let score = c.tt === 'sect'
    ? Math.round(closeness * 100)
    : clamp((myPw / Math.max(1, defPw) - 0.4) * 45, -20, 55)
  if (isHegemonTarget) score += 70
  const recentWar = (f.sectAttacks || []).some(a => a.phase === 'done' && (a.endAt || 0) > now - 12 * 3600000 &&
    (a.atkSect === tSect || (a.targetType === 'sect' ? a.target === tSect : (f.areas && f.areas[a.target] === tSect))))
  if (recentWar) score += 14                         // 趁火打劫: 刚打完仗, 兵力士气受损
  const tAlive = sectAlive(f, tSect).length
  if (tAlive <= 5) score += 10                       // 兵少好欺负
  else if (tAlive <= 10) score += 4
  const underAtk = (f.sectAttacks || []).some(a => a.phase !== 'done' &&
    (a.targetType === 'sect' ? a.target === tSect : (f.areas && f.areas[a.target] === tSect)))
  if (underAtk) score += 12                          // 鹬蚌相争, 渔翁得利
  score -= (ts.allies || []).length * 8               // 合纵连横: 目标盟友会助战
  if (c.region !== myRegion) {
    const vault = (getVault(f, atkId) && getVault(f, atkId).stones) || 0
    if (vault < 20000) score -= 10                    // 粮草先行: 宝库薄少打跨区(原-25过严致AI不动)
  }
  if (c.region === myRegion) score += 6               // 以逸待劳: 同区补给方便
  score *= warK                                       // 性格: 好斗激进/平和保守
  return score
}
/** AI 攻方宗门可出动总战力(所有在世门人战力之和, 简化评估用) */
export async function aiSectOffensePower (f, id) {
  let pw = 0
  let count = 0
  const tai = new Set((f.sectMap[id] && f.sectMap[id].taishang) || [])
  for (const p of sectAlive(f, id)) {
    if (!tai.has(p.name) && canFakeFight(f, p.name) && warActorAvailable(f, 'fake', p.name)) {
      pw += personPower(p)
      count++
    }
  }
  const s = f.sects[id]
  const yanwu = (s && s.facilities && s.facilities.yanwu) || 0
  return Math.max(0, Math.round((pw + count * CFG.PERSON_BASE) * (1 + 0.02 * yanwu)))
}
/** AI 评估目标防守战力: 宗门本体计全宗可战门人, 小区只计目标大区门人; 玩家宗门另加玩家战力 */
export async function aiTargetDefensePower (f, gid, tSect, region, targetType = 'sect', target = null) {
  if (!tSect || !f.sects[tSect]) return 0
  const tai = new Set(f.sectMap[tSect]?.taishang || [])
  let candidates = sectAlive(f, tSect).filter(p => (!tai.has(p.name) || (p.loc || DEFAULT_REGION) === region) && canFakeFight(f, p.name))
  if (targetType === 'area') candidates = withHomeReserve(f, tSect, candidates)
  const plan = planWarDeployment(f, gid, tSect, region, candidates)
  const players = []
  if (f.sects[tSect].owner) for (const [uid, pp] of Object.entries(f.players || {})) {
    if (pp?.sect === tSect && canPlayerFight(f, uid) && warActorAvailable(f, 'player', uid) && getLoc(getWorld(gid), uid) === region) players.push(await playerPower(f, gid, uid))
  }
  return deploymentPower(f, tSect, plan.units.map(u => f.roster[u.name]), players, { defense: true, targetType, target })
}

/** 选择与攻方战力的同级宗门本体候选; 返回空数组表示没有同级对手。
 *  原实现只保留战力最接近的一个目标, 导致 AI 永远只打同一个最弱宗、天下死水一潭;
 *  现返回战力带 [0.8, 1.25] 内全部同级宗门, 宗门战争目标多样化 */
export function selectAiSectTargetPool (smart, myPw) {
  return (smart || []).filter(c => c.tt === 'sect' &&
    c.targetPw >= myPw * 0.8 && c.targetPw <= myPw * 1.25)
}

export async function spawnAiSectAttacks (f, gid, now = Date.now()) {
  /*
   * AI 战争调度是唯一入口。不限并发——每个伪玩家宗门按自身 4 小时攻打冷却独立行动:
   * 冷却到就尝试一次; 目标在途/休战/越级自动跳过; 发起失败短退避, 不阻塞其他宗门。
   * 这样"放弃小区/灭门"留出的无主地会被迅速争抢, 天下持续有仗打。
   */
  if (!f.targetCd || typeof f.targetCd !== 'object') f.targetCd = {}
  const nowInFlight = (f.sectAttacks || []).filter(a => a.phase !== 'done')
  /* 在途目标与正被攻打的宗门: 一轮里避免撞同一目标、让被围者继续宣战 */
  const inFlightAreas = new Set()
  const inFlightSects = new Set()
  const beingAttacked = new Set()
  for (const a of nowInFlight) {
    if (a.targetType === 'area') inFlightAreas.add(a.target)
    else if (a.target) inFlightSects.add(a.target)
    if (a.targetType === 'sect' && a.target) beingAttacked.add(a.target)
    else if (a.targetType === 'area' && a.target && f.areas[a.target]) beingAttacked.add(f.areas[a.target])
  }
  const inFlightAttackers = new Set(nowInFlight.map(a => a.atkSect).filter(Boolean))
  /* 世界全部小区(REGIONS 30 个): 含 f.areas 已占领 + 未分配的新区(不在 f.areas = 真·无主) */
  const allAreas = []
  for (const k of Object.keys(REGIONS)) for (const a of (REGIONS[k].areas || [])) allAreas.push(a)
  let started = 0
  for (const atk of Object.keys(f.sects)) {
    const s = f.sects[atk]
    if (!s || s.owner || s.wipeAt) continue
    const population = sectAlive(f, atk).length
    const attackCost = CFG.ATK_BASE + population * CFG.ATK_PER
    const reserveCost = Math.max(attackCost, population * CFG.SECT_DEPLOY_COST)
    if (!assessSectDevelopment(f, atk, now, { attackCost, reserveCost }).ready) continue
    if (inFlightAttackers.has(atk)) continue
    if (beingAttacked.has(atk)) continue
    /* 每个宗门自身攻打冷却(伪玩家宗门 1 小时) + 失败短退避(不每分钟硬撞在途目标) */
    if ((s.atkCdUntil || 0) > now) continue
    if ((s.atkRetryAt || 0) > now) continue
    if (!sectAlive(f, atk).some(p => canFakeFight(f, p.name))) continue
    const sReg = sectRegion(f, atk)
    const myAllies = (s.allies) || []
    /* 收集全部可打目标(含跨区与无主新区; 排除盟友/自己/冷却/在途) */
    const choices = []
    for (const a of allAreas) {
      if (f.areas[a] === atk) continue
      if (myAllies.includes(f.areas[a]) || hasTruce(f, atk, f.areas[a], now)) continue
      if (inFlightAreas.has(a)) continue
      if ((f.targetCd['area:' + a] || 0) > now) continue
      const oid = f.areas && f.areas[a]
      const os = oid ? f.sects[oid] : null
      choices.push({ t: a, tt: 'area', region: regionOfArea(a) || 'center', def: areaDefLevel(f, a), unowned: !os || os.wipeAt > 0 })
    }
    for (const id2 of Object.keys(f.sects)) {
      const s2 = f.sects[id2]
      if (!s2 || id2 === atk || s2.wipeAt || hasTruce(f, atk, id2, now) || sectAlive(f, id2).length === 0) continue
      if (myAllies.includes(id2)) continue
      if (inFlightSects.has(id2)) continue
      if ((f.targetCd['sect:' + id2] || 0) > now) continue
      /* 2026-08-19 修复: AI 宗门也进入目标池(AI 互斗), 否则 AI 只能打10万+战力的强宗/小区, 永远打不过 → 江湖僵死 */
      choices.push({ t: sectName(f, id2), tt: 'sect', region: s2.region || 'center', def: 0 })
    }
    if (!choices.length) continue
    /* AI 智能评估(孙子兵法): 动态多因子评分, 非固定阈值 */
    const myPw = await aiSectOffensePower(f, atk)
    const zzAtk = f.sectMap[atk] && f.sectMap[atk].zongzhu ? f.roster[f.sectMap[atk].zongzhu] : null
    const warK = (zzAtk && (zzAtk.trait === '好斗' || zzAtk.trait === '嗜杀' || zzAtk.path === '魔道')) ? 1.15 : (zzAtk && (zzAtk.trait === '平和' || zzAtk.trait === '善良')) ? 0.8 : 1
    const smart = []
    for (const c of choices) {
      const targetId = c.tt === 'sect' ? sectIdByName(f, c.t) : f.areas?.[c.t]
      const coalitionPlans = planAiCoalition(f, gid, atk, targetId, c.region, now)
      const coalitionPower = coalitionPlans.reduce((sum, x) => sum + deploymentPower(f, atk, x.plan.units.map(u => f.roster[u.name])), 0)
      const sc = await scoreAiTarget(f, gid, atk, c, sReg, myPw + coalitionPower, warK, now)
      if (sc <= 0) continue
      const tSect = c.tt === 'sect' ? sectIdByName(f, c.t) : (f.areas ? f.areas[c.t] : null)
      const targetPw = tSect ? await aiTargetDefensePower(f, gid, tSect, c.region, c.tt, c.t) : 0
      smart.push({ ...c, coalitionPlans, score: Math.round(sc), targetPw })
    }
    if (!smart.length) {
      /* 破釜沉舟: 好斗/嗜杀/魔道宗主宗门若无稳赢目标, 仍会挑最弱目标一战(避免江湖僵死); 平和/善良保持克制 */
      if (warK < 1.15) continue
      let soft = null
      let bestRatio = -1
      for (const c of choices) {
        const tSect3 = c.tt === 'sect' ? sectIdByName(f, c.t) : (f.areas ? f.areas[c.t] : null)
        if (!tSect3 || !f.sects[tSect3]) { soft = soft || c; continue }
        const dp = await aiTargetDefensePower(f, gid, tSect3, c.region, c.tt, c.t)
        /* 破釜沉舟也不能绕过普通宗门的越级限制 */
        if (myPw < dp * aiTargetMinAttackRatio(f, atk, tSect3)) continue
        const r = myPw / Math.max(1, dp)
        if (r > bestRatio) { bestRatio = r; soft = c }
      }
      if (!soft) continue
      smart.push({ ...soft, score: 1 })
    }
    const attackerLands = areaCount(f, atk)
    const balancedSectTargets = selectAiSectTargetPool(smart, myPw)
    /* 霸主争雄：占地4块以上时，优先锁定另一非盟友大宗门本体，避免永远欺负无主/小宗 */
    const hegemonTargets = attackerLands >= 4
      ? smart.filter(c => c.tt === 'sect' && areaCount(f, sectIdByName(f, c.t)) >= 4)
      : []
    const free = smart.filter(c => c.unowned)
    const ownedAreas = smart.filter(c => c.tt === 'area' && !c.unowned)
    let cand
    if (free.length && Math.random() < 0.6) {
      /* 无主小区(白拿): 60% 概率兵贵神速, 抢占宗门放弃/灭门留出的空地 */
      cand = free
    } else {
      /* 同级宗门(强强对话) 与 有主小区(夺地盘) 同台加权随机 —— 小区频繁易主, 宗门战继续 */
      const splitOpts = [balancedSectTargets, ownedAreas].filter(a => a && a.length)
      if (splitOpts.length) {
        cand = pick(splitOpts)
      } else if (free.length) {
        cand = free
      } else if (hegemonTargets.length) {
        cand = hegemonTargets
      } else {
        /* 小宗门维持无主优先、软目标优先 */
        const home = smart.filter(c => c.region === sReg)
        const away = smart.filter(c => c.region !== sReg)
        let pool = home
        if (!home.length) pool = away
        else if (away.length) {
          const homeBest = Math.max(...home.map(c => c.score))
          const awayBest = Math.max(...away.map(c => c.score))
          if (awayBest - homeBest >= 25) pool = away
        }
        const poolFree = pool.filter(c => c.unowned)
        const poolOwned = pool.filter(c => !c.unowned)
        const sectTargets = smart.filter(c => c.tt === 'sect')
        if (sectTargets.length) cand = sectTargets
        else if (poolOwned.length) cand = poolOwned
        else if (poolFree.length) cand = poolFree
        else cand = pool
      }
    }
    const total = cand.reduce((a, c) => a + c.score, 0)
    let rr2 = Math.random() * total
    let ch = cand[0]
    for (const c of cand) { rr2 -= c.score; if (rr2 <= 0) { ch = c; break } }
    const r = await startSectAttack(f, gid, atk, ch.t, 'ai', { coalitionPlans: ch.coalitionPlans || [] })
    if (r.ok) {
      started++
      /* 本轮后续宗门避开刚发起的目标与被围宗门(atkRec.target 才是 sect 的 id / area 名) */
      if (ch.tt === 'area') inFlightAreas.add(ch.t)
      const atkRec = f.sectAttacks[f.sectAttacks.length - 1]
      if (atkRec) {
        if (atkRec.targetType === 'sect' && atkRec.target) { inFlightSects.add(atkRec.target); beingAttacked.add(atkRec.target) }
        else if (atkRec.targetType === 'area' && atkRec.target && f.areas[atkRec.target]) beingAttacked.add(f.areas[atkRec.target])
        notifyDefender(f, gid, atkRec)
        /* AI 盟友自动助战: 结盟宗门一起攻打, 打赢按输出(贡献)最高者得地盘/战利品 */
        try { await aiAllyAssist(f, gid, atkRec, now) } catch (err) { console.log('[宗门系统]AI盟友助战异常:', err && err.stack) }
      }
    } else {
      /* 发起失败(撞在途/宝库不足等): 10 分钟短退避, 不每分钟硬撞 */
      s.atkRetryAt = now + 10 * 60000
    }
  }
  return started > 0
}

/** @ 被攻方的玩家宗主 */
export async function notifyDefender (f, gid, atk) {
  try {
    const defSect = defenderOf(f, atk)
    if (!defSect) return
    const ownerUid = f.sects[defSect] && f.sects[defSect].owner
    if (!ownerUid) return
    const name = warTargetTxt(f, atk)
    const g = Bot.pickGroup(gid)
    if (g && g.sendMsg) {
      /* 玩家宗主防守被攻打: 提示宗门伪玩家弟子响应召集守城 */
      const defS = f.sects[defSect]
      const n = defS ? sectAlive(f, defSect).length : 0
      const recruitTxt = n > 0 ? `\n⚔️ 本宗有 ${n} 名门人，可下令组织守军。` : ''
      g.sendMsg([segment.at(Number(ownerUid)), `\n🏯【宗门警报】${atkDisplayName(f, atk)} 正在攻打${name}！${recruitTxt}\n30分钟内请回复：\n#守 （坚守迎战）\n#不守 （弃守；总部被攻破即灭门）\n⚔️ 开战后可 #驰援 中途调回在外门人回防`])
    }
  } catch (err) { }
}

