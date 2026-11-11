import { warActorOwner, warCaptiveOwner } from './sect/war_state.js'
import { absoluteWinRate, fightBestOf5 } from './fight.js'
import { wearNpcTaichu } from './taichu_combat.js'

const MINUTE = 60000
export const NPC_CONFLICT_CD = 60 * MINUTE
export const NPC_VICTIM_CD = 120 * MINUTE

/** 身体与关押状态统一资格；参战时另行核对是否属于当前战争。 */
export function npcInCave (f, p) {
  return !!(p?.fakeCaveLost || (f.fakeCaves || []).some(c => (c.names || []).includes(p?.name)))
}

export function npcCanParticipate (f, p, now = Date.now(), { skipCave = false } = {}) {
  if (!p?.alive || p.realmBusy || p.fakeTravel || p.servantOf || p.mineOf || p.status === 'mine') return false
  if (p.fakeCaveLost || (!skipCave && npcInCave(f, p))) return false
  if ((Number(p.fakeLostUntil) || 0) > now || warCaptiveOwner(f, 'fake', p.name)) return false
  if (Object.values(f.sectMines || {}).some(xs => (xs || []).some(x => x?.name === p.name))) return false
  if (Object.values(f.sectJails || {}).some(xs => (xs || []).some(x => x?.name === p.name))) return false
  return !(f.raidJail || []).some(x => x?.name === p.name && x.until > now)
}

/** 日常主动行为不得同时占用宗门战争身份。 */
export function npcCanAct (f, p, now = Date.now(), options = {}) {
  return npcCanParticipate(f, p, now, options) && !warActorOwner(f, 'fake', p.name)
}

export function npcCanThreaten (f, p, now = Date.now()) {
  if (!npcCanAct(f, p, now) || (p.dangerUntil || 0) > now) return false
  const injury = p.injury
  return !injury || injury.level < 2 || now >= (injury.at || 0) + [0, 30, 120, 480][injury.level] * MINUTE
}

export function npcCanBeTarget (f, p, actor, now = Date.now()) {
  return p?.name !== actor?.name && npcCanAct(f, p, now) && (p.dangerUntil || 0) <= now &&
    (p.encounterSafeUntil || 0) <= now && (p.loc || 'center') === (actor?.loc || 'center')
}

/** 真实胜负与装备损耗先于资产转移和死亡；宗门、修为或人数由调用方处理。 */
export function resolveNpcEncounter (f, actors, target, powerOf, now = Date.now(), { lethal = false, vendetta = false } = {}) {
  const party = [...new Set(actors)].filter(Boolean)
  if (!party.length || party.some(p => !npcCanThreaten(f, p, now)) || !npcCanBeTarget(f, target, party[0], now) ||
      party.some(p => p.name === target.name || (p.loc || 'center') !== (party[0].loc || 'center'))) return { ok: false, reason: 'unavailable' }
  const attack = party.reduce((n, p) => n + powerOf(p), 0)
  const defense = powerOf(target)
  // 可判断的明显劣势先回避，不先抢财物再宣称失败。
  if (attack < defense * 0.9) {
    for (const p of party) p.dangerUntil = now + NPC_CONFLICT_CD
    return { ok: false, reason: 'outmatched' }
  }
  const won = fightBestOf5(absoluteWinRate(attack, defense)).winner === 'me'
  const receipt = `npc-encounter:${f.gid || ''}:${now}:${party.map(p => p.name).sort().join(',')}:${target.name}`
  for (const p of party) wearNpcTaichu(p, receipt, won ? 2 : 4)
  wearNpcTaichu(target, receipt, won ? 4 : 2)
  for (const p of [...party, target]) {
    p.lastFight = now
    p.dangerUntil = now + NPC_CONFLICT_CD
    p.encounterSafeUntil = now + NPC_VICTIM_CD
  }
  const losers = won ? [target] : party
  for (const p of losers) {
    const level = attack > defense * 2 && won ? 3 : 2
    if (!p.injury || p.injury.level < level || now >= p.injury.at + [0, 30, 120, 480][p.injury.level] * MINUTE) p.injury = { level, at: now }
  }
  const evil = party.some(p => p.trait === '嗜杀' || p.path === '魔道')
  const deathRate = Math.min(0.45, (evil ? 0.12 : 0.04) + (vendetta ? 0.2 : 0)) * (target.sect ? 0.6 : 1)
  return { ok: true, won, kill: won && lethal && Math.random() < deathRate, attack, defense }
}
