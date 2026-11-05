import { npcCanAct } from '../npc_action.js'
import { defenderOf } from './war_state.js'

export function warIncludesSect (f, war, sid) { return war.atkSect === sid || defenderOf(f, war) === sid || !!war.coalition?.[sid] }

export function commonTerritoryThreat (f, a, b = null) {
  const counts = {}
  for (const sid of Object.values(f.areas || {})) counts[sid] = (counts[sid] || 0) + 1
  const threshold = Math.max(8, Math.ceil(Object.keys(f.areas || {}).length * 0.4))
  return Object.keys(counts).find(id => id !== a && id !== b && counts[id] >= threshold && counts[id] > (counts[a] || 0) && (!b || counts[id] > (counts[b] || 0))) || null
}

const HOUR = 3600000
export const AI_WAR_REST = { win: 4 * HOUR, lose: 8 * HOUR, abort: 2 * HOUR, peace: 6 * HOUR }

/** NPC先恢复与积蓄，再寻找扩张机会；不生成钱、人、修为或保护期。 */
export function assessSectDevelopment (f, sid, now = Date.now(), { attackCost = 0, reserveCost = 0 } = {}) {
  const s = f.sects?.[sid]
  if (!s || s.owner) return { ready: false, phase: 'player' }
  const members = Object.values(f.roster || {}).filter(p => p.alive && p.sect === sid && p.status === 'sect')
  const active = (f.sectAttacks || []).some(w => w.phase !== 'done' && warIncludesSect(f, w, sid))
  let phase = 'expand', reason = '人员与积蓄允许寻找扩张机会', until = 0
  const latest = (f.sectAttacks || []).filter(w => w.phase === 'done' && warIncludesSect(f, w, sid))
    .sort((a, b) => (b.endAt || 0) - (a.endAt || 0))[0]
  if (latest) {
    const attacking = latest.atkSect === sid || !!latest.coalition?.[sid]
    const ownWin = attacking ? latest.result === 'win' : latest.result === 'lose'
    const ownLose = attacking ? latest.result === 'lose' : latest.result === 'win'
    until = (latest.endAt || 0) + (ownWin ? AI_WAR_REST.win : ownLose ? AI_WAR_REST.lose : AI_WAR_REST[latest.result] || 0)
  }
  const available = members.filter(p => npcCanAct(f, p, now))
  const recovering = available.filter(p => p.injury?.level >= 2 && now < (p.injury.at || 0) + [0, 30, 120, 480][p.injury.level] * 60000)
  if (active) { phase = 'defend'; reason = '先完成当前攻防，不另开战' }
  else if (now < until) { phase = 'recover'; reason = '战后整顿，修炼补员与恢复' }
  else if (!available.length || recovering.length > available.length / 3) { phase = 'recover'; reason = '可战门人不足或重伤较多' }
  else if ((s.vault?.stones || 0) < attackCost + reserveCost) { phase = 'develop'; reason = '先积蓄出征及维护储备' }
  s.aiStrategy = { phase, reason, since: s.aiStrategy?.phase === phase ? s.aiStrategy.since : now, until: until > now ? until : 0 }
  return { ready: phase === 'expand', ...s.aiStrategy }
}
