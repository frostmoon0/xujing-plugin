import { caveEnemyPower, caveEncounterDelay, GHOST_ENCOUNTER_CHANCE, CAVE_PROTECTION_MS, CAVE_LOST_MS } from './cave_rules.js'
import { caveNight, syncCaveNightClock } from './cave_clock.js'
import { guardWinRate, fightBestOf5 } from './fight.js'
import { hasDingxianyou } from './equip_data.js'
import { npcCanAct } from './npc_action.js'
import { rollCaveLoot } from './cave_loot.js'
import { wearNpcTaichu } from './taichu_combat.js'

const MINUTE = 60000
const REST_MS = 30 * MINUTE
const count = (p, name) => Math.max(0, Number(p.bag?.items?.[name]?.count ?? p.bag?.items?.[name]) || 0)
const minimumChance = p => Math.max(95, (p.trait === '谨慎' ? 99 : 98) - (hasDingxianyou(p.bag) || count(p, '还魂丹') > 0 ? 2 : 0))

/** 按实际战力和已有魂石规划；预留一分钟出窟、两分钟敌人成长余量。 */
export function planFakeCaveTrip (p, power, stones = count(p, '魂石'), elapsed = 0, protectedMinutes = 0) {
  const minChance = minimumChance(p)
  const limit = Math.min(120, Math.floor(elapsed + protectedMinutes + stones * 10 - 1))
  let minutes = Math.floor(elapsed)
  for (let m = Math.ceil(elapsed); m <= limit; m++) {
    if (guardWinRate(power, caveEnemyPower(m + 2)) < minChance) break
    minutes = m
  }
  // 不为最后一两分钟额外买整段保护；留到下趟使用。
  if (minutes >= 10 && minutes % 10 < 3) minutes = Math.floor(minutes / 10) * 10 - 1
  return { ok: minutes - elapsed >= 3, minutes, minChance }
}

/** 按安全深度备石；短途一颗，长期准备最多八颗，实际采购仍受钱包和库存限制。 */
export function fakeCaveSupplyTarget (p, power) {
  const plan = planFakeCaveTrip(p, power, 8)
  return Math.max(1, Math.min(8, Math.ceil(plan.minutes / 10)))
}

function syncClock (party, now) {
  const clock = { inCave: true, enteredAt: party.startedAt, protectionUntil: party.stoneAt, nextEncounterAt: party.nextAt, nightClockAt: party.nightClockAt }
  syncCaveNightClock(clock, now)
  const paused = clock.enteredAt - party.startedAt
  party.startedAt = clock.enteredAt
  party.stoneAt = clock.protectionUntil
  party.nextAt = clock.nextEncounterAt
  party.nightClockAt = clock.nightClockAt
  if (paused) for (const member of Object.values(party.members || {})) {
    if (member.protectionUntil) member.protectionUntil += paused
  }
}

/** 同步推进，不读取正式存档；背包与日志均由伪玩家数据层注入。 */
export function tickFakeCaves (f, gid, now, { powerOf, addItem, takeItem, log }) {
  if (!Array.isArray(f.fakeCaves)) f.fakeCaves = []
  const occupied = new Set()
  for (const party of f.fakeCaves) {
    party.names = [...new Set((party.names || []).filter(n => f.roster?.[n]?.alive && !occupied.has(n)))]
    party.names.forEach(n => occupied.add(n))
    party.startedAt = Number(party.startedAt) || now
    party.nextAt = Number(party.nextAt) || now + caveEncounterDelay()
    party.stoneAt = Number(party.stoneAt) || party.startedAt + CAVE_PROTECTION_MS
    syncClock(party, now)
    party.loot ||= {}
    party.members ||= {}
    const elapsed = Math.max(0, (now - party.startedAt) / MINUTE)
    for (const name of party.names) if (!party.members[name]) {
      const p = f.roster[name]
      const plan = planFakeCaveTrip(p, powerOf(p), count(p, '魂石'), elapsed, Math.max(0, (party.stoneAt - now) / MINUTE))
      party.members[name] = { plannedMinutes: plan.minutes, protectionUntil: party.stoneAt, stonesSpent: 1, loot: {} }
    }
  }
  // 夜间计时和玩家一致暂停；离线不补打、不补发战利品。
  if (caveNight(now)) return

  const emit = (p, text, major = false, who = [p.name]) => log(f, 'cave', `【万魂窟】${text}`, now, { who, ...(major ? { major: true } : { onlyPerson: true }) })
  const finish = (party, p, outcome, text) => {
    const member = party?.members?.[p.name]
    if (party) party.names = party.names.filter(n => n !== p.name)
    p.fakeCaveRestUntil = now + REST_MS
    p.fakeCaveLastTrip = {
      at: now, minutes: party ? Math.max(0, Math.floor((now - party.startedAt) / MINUTE)) : 0,
      loot: { ...(member?.loot || {}) }, stonesSpent: member?.stonesSpent || 0, outcome
    }
    if (text) emit(p, text, true)
  }
  const findParty = p => f.fakeCaves.find(c => c.names.includes(p.name))
  const usePill = p => {
    if (!(p.fakeCaveLost || Number(p.fakeLostUntil) > now) || !takeItem(p.bag, '还魂丹', 1)) return false
    delete p.fakeCaveLost
    p.fakeLostUntil = 0
    const party = findParty(p)
    // 已获救者保留刚结算的收益记录；服丹不重复结算或发放。
    if (party) finish(party, p, 'pill', `${p.name} 服用还魂丹，解除失魂后离开`)
    else emit(p, `${p.name} 服用还魂丹，解除失魂`, true)
    return true
  }
  const rescue = () => {
    const used = new Set()
    for (const p of Object.values(f.roster || {})) {
      if (!p.alive || !p.fakeCaveLost) continue
      if (usePill(p)) continue
      const party = findParty(p)
      const canHelp = q => q?.name !== p.name && !used.has(q.name) && q.loc === 'west' && npcCanAct(f, q, now, { skipCave: !!party?.names.includes(q.name) }) &&
        !(q.relations?.enemies || []).includes(p.name) && !(p.relations?.enemies || []).includes(q.name)
      const helper = (party?.names || []).map(n => f.roster[n]).find(canHelp) || Object.values(f.roster || {}).find(canHelp)
      if (!helper) continue
      used.add(helper.name)
      delete p.fakeCaveLost
      p.fakeLostUntil = now + CAVE_LOST_MS
      finish(party, p, 'rescued', `${helper.name} 将 ${p.name} 救出，${p.name} 仍失魂10小时`)
      usePill(p)
    }
  }
  for (const p of Object.values(f.roster || {})) if (p.alive && (p.fakeCaveLost || Number(p.fakeLostUntil) > now)) usePill(p)
  rescue()

  for (const party of f.fakeCaves) {
    const elapsed = Math.max(0, (now - party.startedAt) / MINUTE)
    const due = now >= party.nextAt
    for (const name of party.names.slice()) {
      const p = f.roster[name]
      if (!p?.alive || p.fakeCaveLost) continue
      if (p.loc !== 'west' || !npcCanAct(f, p, now, { skipCave: true })) {
        finish(party, p, 'interrupted', `${p.name} 行程中断，停止探索`)
        continue
      }
      const member = party.members[name]
      const power = powerOf(p)
      if (elapsed >= member.plannedMinutes || (now >= member.protectionUntil && count(p, '魂石') < 1)) {
        finish(party, p, 'safe', `${p.name} 结束探索，携所得离开`)
        continue
      }
      if (!due && guardWinRate(power, caveEnemyPower(elapsed + 2)) < minimumChance(p)) {
        finish(party, p, 'safe', `${p.name} 察觉阴魂增强，提前离开`)
        continue
      }
      // 所有续费都发生在保护到期时；不足一段行程不会继续消耗。
      if (now >= member.protectionUntil) {
        if (member.plannedMinutes - elapsed < 3) {
          finish(party, p, 'safe', `${p.name} 收起战利品，留存魂石后返回`)
          continue
        }
        if (!takeItem(p.bag, '魂石', 1)) {
          finish(party, p, 'safe', `${p.name} 魂石耗尽，退出万魂窟`)
          continue
        }
        member.stonesSpent++
        member.protectionUntil = now + CAVE_PROTECTION_MS
      }
      if (!due) continue
      const award = loot => {
        for (const [item, amount] of Object.entries(loot)) {
          addItem(p.bag, item, amount)
          member.loot[item] = (member.loot[item] || 0) + amount
          party.loot[item] = (party.loot[item] || 0) + amount
        }
      }
      if (Math.random() < GHOST_ENCOUNTER_CHANCE) {
        award({ 无主幽魂: 1 })
        emit(p, `${p.name} 吸收无主幽魂×1`)
        continue
      }
      const chance = guardWinRate(power, caveEnemyPower(Math.floor(elapsed)))
      const unsafe = chance < minimumChance(p)
      if (unsafe && hasDingxianyou(p.bag)) {
        finish(party, p, 'retreat', `${p.name} 借定仙游避开阴魂，安全离开`)
        continue
      }
      // 遭遇已发生时不能直接退出。低于五成选择撤退，其余用同源五局三胜。
      const retreat = unsafe && chance < 50
      const won = retreat ? Math.random() * 100 < chance : fightBestOf5(chance).winner === 'me'
      if (!retreat) wearNpcTaichu(p, `fake-cave:${party.startedAt}:${party.nextAt}:${p.name}`, won ? 2 : 4)
      if (won) {
        if (retreat) finish(party, p, 'retreat', `${p.name} 避开阴魂，撤出万魂窟`)
        else {
          const loot = rollCaveLoot(Math.floor(elapsed))
          award(loot)
          emit(p, `${p.name} 斩杀阴魂，获得${Object.entries(loot).map(([n, c]) => `${n}×${c}`).join('、')}`)
          if (unsafe) finish(party, p, 'safe', `${p.name} 收起战利品，提前离开`)
        }
      } else {
        p.fakeCaveLost = { at: now, gid: String(gid) }
        p.fakeLostUntil = 0
        emit(p, `${p.name} ${retreat ? '撤退' : '战斗'}失败，失魂被困窟中`, true)
        usePill(p)
      }
    }
    if (due) party.nextAt = now + caveEncounterDelay()
    const protections = party.names.filter(n => !f.roster[n]?.fakeCaveLost).map(n => party.members[n]?.protectionUntil).filter(Boolean)
    if (protections.length) party.stoneAt = Math.min(...protections)
  }
  rescue()
  f.fakeCaves = f.fakeCaves.filter(c => c.names.length)

  if (f.fakeCaves.length >= 3 || Math.random() >= 0.02) return
  const pool = Object.values(f.roster || {}).filter(p => p.loc === 'west' && npcCanAct(f, p, now) && (Number(p.fakeCaveRestUntil) || 0) <= now && count(p, '魂石') > 0)
    .map(p => ({ p, plan: planFakeCaveTrip(p, powerOf(p)) })).filter(x => x.plan.ok)
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]] }
  if (pool.length < 2) return
  const entrants = pool.slice(0, 2 + Math.floor(Math.random() * 2))
  const party = { names: [], members: {}, startedAt: now, nightClockAt: now, nextAt: now + caveEncounterDelay(), stoneAt: now + CAVE_PROTECTION_MS, loot: {} }
  for (const { p, plan } of entrants) {
    if (!takeItem(p.bag, '魂石', 1)) continue
    party.names.push(p.name)
    party.members[p.name] = { plannedMinutes: plan.minutes, protectionUntil: party.stoneAt, stonesSpent: 1, loot: {} }
  }
  if (party.names.length) {
    f.fakeCaves.push(party)
    log(f, 'cave', `【万魂窟】${party.names.join('、')} 结伴入窟，按各自战力和魂石安排归程`, now, { who: party.names.slice(), major: true })
  }
}
