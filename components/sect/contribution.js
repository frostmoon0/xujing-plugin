import { accrueSectDuty, dutyDay, PLAYER_DUTY_ACTIVE_MS } from './vault_rules.js'
import { npcCanAct } from '../npc_action.js'
import { warCaptiveOwner } from './war_state.js'
import { getJailRemain } from '../raid_data.js'
import { Wanhun } from '../wanhun_data.js'
import { getWorld, getMoving } from '../world_data.js'
import { lastCmdKey } from '../idle_cleanup.js'

/** 在 sectTick 的群锁内调用；读取一次真人活跃表，不生成额外存档。 */
export async function settleSectContributions (f, gid, now = Date.now(), opts = {}) {
  let activity = opts.activity
  if (!activity) {
    try { activity = await redis.hGetAll(lastCmdKey(gid)) } catch (err) { activity = {} }
  }
  let gained = 0; let members = 0
  for (const p of Object.values(f.roster || {})) {
    if (!p?.alive || p.status !== 'sect' || !f.sects?.[p.sect] || f.sects[p.sect].wipeAt) continue
    const eligible = npcCanAct(f, p, now) && (Number(p.fakeLostUntil) || 0) <= now
    gained += accrueSectDuty(p, p.sect, now, eligible); members++
  }
  const world = Object.keys(f.players || {}).length ? getWorld(gid) : null
  f.sectDutyPlayers ||= {}
  for (const [uid, d] of Object.entries(f.sectDutyPlayers)) if (!f.players?.[uid] && d.day !== dutyDay(now)) delete f.sectDutyPlayers[uid]
  for (const [uid, p] of Object.entries(f.players || {})) {
    if (!p?.sect || !f.sects?.[p.sect] || f.sects[p.sect].wipeAt) continue
    const last = Number(activity?.[uid]) || 0
    let eligible = last > 0 && now >= last && now - last <= PLAYER_DUTY_ACTIVE_MS
    eligible &&= !warCaptiveOwner(f, 'player', uid) && !Object.values(f.sectJails || {}).some(xs => (xs || []).some(x => String(x.uid) === uid))
    if (eligible) eligible = opts.playerEligible ? await opts.playerEligible(uid) :
      (await getJailRemain(uid)) <= 0 && !Wanhun.isLocked(uid, gid) && !(getMoving(world, uid)?.end > now)
    if (!p.sectDuty && f.sectDutyPlayers[uid]) p.sectDuty = f.sectDutyPlayers[uid]
    gained += accrueSectDuty(p, p.sect, now, eligible)
    f.sectDutyPlayers[uid] = p.sectDuty
    members++
  }
  return { changed: members > 0, gained }
}
