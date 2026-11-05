import { getWorld, sealBlocksTravel, DEFAULT_REGION } from '../world_data.js'
import { personPower, fakeTravelTo, isInSectJail, isInRaidJail, isInSectMine } from '../fake_data.js'
import { CFG, getVault, sectRegion } from './utils.js'
import { warCaptiveOwner, warActorAvailable, recordWarExit } from './war_state.js'

/** 只生成计划，不扣钱、不改位置；通过后统一提交。 */
export function planWarDeployment (f, gid, sid, region, candidates, count = 0, war = null, budget = null) {
  const available = Math.max(0, budget ?? (Number(getVault(f, sid)?.stones) || 0))
  const world = getWorld(gid)
  const sorted = candidates.filter(p => p && p.alive && !p.realmBusy && !p.fakeTravel && p.status !== 'mine' && !p.mineOf && !isInSectJail(f, p.name) && !isInRaidJail(f, p.name) && !isInSectMine(f, p.name) && !warCaptiveOwner(f, 'fake', p.name) && warActorAvailable(f, 'fake', p.name, war))
    .sort((a, b) => Number((b.loc || DEFAULT_REGION) === region) - Number((a.loc || DEFAULT_REGION) === region) || personPower(b) - personPower(a))
  const units = []; let cost = 0
  for (const p of sorted) {
    if (count > 0 && units.length >= count) break
    const from = p.loc || DEFAULT_REGION
    const free = !!p.bag?.artifacts?.dingxianyou
    if (from !== region && sealBlocksTravel(world, p.name, from, region, { allowDingxianyou: free })) continue
    const fee = from === region || free ? 0 : CFG.SECT_DEPLOY_COST
    if (cost + fee > available) continue
    units.push({ name: p.name, from, fee }); cost += fee
  }
  return { units, cost, region }
}

export function commitWarDeployment (f, sid, war, side, plan) {
  if ((getVault(f, sid)?.stones || 0) < plan.cost) throw new Error('宗门调兵预算已变化')
  getVault(f, sid).stones -= plan.cost
  const field = side === 'def' ? 'defFakes' : 'atkFakes'
  war[field] ||= []
  war.actorSects ||= {}
  for (const unit of plan.units) {
    const p = f.roster[unit.name]
    p.loc = plan.region
    war.actorSects[`fake:${unit.name}`] = sid
    if (!war[field].includes(unit.name)) war[field].push(unit.name)
  }
}

/** 撤下者优先归宗；封海/费用不满足时留在原地，禁止直接改坐标穿海。 */
export function releaseWarFake (f, war, name, reason = '撤离', now = Date.now()) {
  const p = f.roster?.[name]
  recordWarExit(war, 'fake', name, reason, now)
  if (!p?.alive || !p.sect || warCaptiveOwner(f, 'fake', name) || isInSectJail(f, name) || isInRaidJail(f, name) || isInSectMine(f, name)) return
  const home = sectRegion(f, p.sect)
  if (home && home !== (p.loc || DEFAULT_REGION)) fakeTravelTo(f, p, home, now, `宗门战${reason}`)
}

export function applyWarWithdrawals (f, war, now = Date.now()) {
  for (const item of war.withdrawals || []) {
    const field = `${item.side}${item.kind === 'fake' ? 'Fakes' : 'Players'}`
    war[field] = (war[field] || []).filter(id => String(id) !== String(item.id))
    recordWarExit(war, item.kind, item.id, '主动撤离', now)
    if (item.kind === 'fake') releaseWarFake(f, war, item.id, '主动撤离', now)
  }
  war.withdrawals = []
}

/** AI出征或守边时保留一名可用的本地守备；已有太上留守则不额外扣人。 */
export function withHomeReserve (f, sid, candidates, war = null) {
  const s = f.sects?.[sid]
  if (!s || s.owner) return candidates
  const home = s.region || 'center'
  const all = Object.values(f.roster || {}).filter(p => p.alive && p.sect === sid && p.status === 'sect')
  const local = all.filter(p => (p.loc || 'center') === home && !p.realmBusy && !p.fakeTravel &&
    !isInSectJail(f, p.name) && !isInRaidJail(f, p.name) && !isInSectMine(f, p.name) &&
    !warCaptiveOwner(f, 'fake', p.name) && warActorAvailable(f, 'fake', p.name))
  if (all.length < 3 || !local.length) return candidates
  const tai = new Set(f.sectMap?.[sid]?.taishang || [])
  if (local.some(p => tai.has(p.name) && !candidates.some(q => q.name === p.name))) return candidates
  const reserve = local.slice().sort((a, b) => personPower(b) - personPower(a))[0]
  return candidates.filter(p => p.name !== reserve.name)
}
