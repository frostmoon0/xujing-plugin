import { warActorOwner, warCaptiveOwner } from './sect/war_state.js'
import { absoluteWinRate, fightBestOf5 } from './fight.js'

const MINUTE = 60000
export const NPC_CONFLICT_CD = 60 * MINUTE
export const NPC_VICTIM_CD = 120 * MINUTE

/** 日常主动行为统一资格；不剥夺在途/被俘成员的宗门身份。 */
export function npcCanAct (f, p, now = Date.now()) {
  if (!p?.alive || p.realmBusy || p.fakeTravel || p.servantOf || p.mineOf || p.status === 'mine') return false
  if (warActorOwner(f, 'fake', p.name) || warCaptiveOwner(f, 'fake', p.name)) return false
  if (Object.values(f.sectMines || {}).some(xs => (xs || []).some(x => x?.name === p.name))) return false
  if (Object.values(f.sectJails || {}).some(xs => (xs || []).some(x => x?.name === p.name))) return false
  return !(f.raidJail || []).some(x => x?.name === p.name && x.until > now)
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

/** 真实胜负先于资产与死亡；不修改背包、宗门、修为或人数。 */
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
