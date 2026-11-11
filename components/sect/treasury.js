import { CFG, facilityCost, FAKE_FAC_MULT, activeFacilityKeys, isPlayerLead, inWarUpkeep, WAR_UPKEEP_STONE_MULT, WAR_UPKEEP_MAT_MULT, MAT_COMMON, areaDefLevel } from './utils.js'
import { sectMemberCapacity } from './capacity.js'

export function facilityMaintenance (f, id, fac, lv, now = Date.now()) {
  if (!lv) return 0
  const cost = facilityCost(fac, 1)
  if (!cost) return 0
  const v = Math.round(cost.stones / 2400 * lv)
  if (fac === 'tiangong') return v
  const base = !f.sects[id].owner ? Math.max(1, Math.round(v * 10)) : v * 15
  return isPlayerLead(f, id) && inWarUpkeep(f, id, now) ? base * WAR_UPKEEP_STONE_MULT : base
}

/** 预留两小时维护、一次正常出征和下一项设施升级；计算不扣库存。 */
export function vaultReserve (f, id, now = Date.now()) {
  const s = f.sects?.[id]
  if (!s) return { stones: 0, mats: {}, maintenance: 0, deployment: 0, upgrade: 0 }
  const facs = activeFacilityKeys()
  const isFake = !s.owner
  const mats = {}
  const keep = cost => { for (const [m, n] of Object.entries(cost || {})) mats[m] = Math.max(mats[m] || 0, n) }
  const upgrades = []
  for (const fac of facs) {
    const level = Number(s.facilities?.[fac]) || 0
    const cap = isFake && !['yanwu', 'yaoyuan', 'tiangong'].includes(fac) ? 8 : 5
    if (level >= cap) continue
    const cost = facilityCost(fac, level + 1)
    const priceMult = isFake && fac !== 'tiangong' ? FAKE_FAC_MULT : 1
    upgrades.push({ fac, level, stones: Math.max(1, Math.round(cost.stones * priceMult)) })
    keep(Object.fromEntries(Object.entries(cost.mats).map(([m, n]) => [m, Math.max(1, Math.round(n * priceMult))])))
  }
  for (const [area, owner] of Object.entries(f.areas || {})) {
    if (owner !== id || areaDefLevel(f, area) >= 5) continue
    const cost = facilityCost('hushan', areaDefLevel(f, area) + 1)
    keep(Object.fromEntries(Object.entries(cost.mats).map(([m, n]) => [m, Math.max(1, Math.round(n * CFG.AREA_DEF_RATIO * (isFake ? FAKE_FAC_MULT : 1)))])))
  }
  const members = Object.values(f.roster || {}).filter(p => p?.alive && p.status === 'sect' && p.sect === id).length +
    Object.values(f.players || {}).filter(p => p?.sect === id).length
  const maintenance = 2 * facs.reduce((n, fac) => n + facilityMaintenance(f, id, fac, Number(s.facilities?.[fac]) || 0, now), 0)
  const troops = members ? Math.max(1, Math.ceil(members * 0.6)) : 0
  const deployment = troops ? CFG.ATK_BASE + troops * (CFG.ATK_PER + CFG.SECT_DEPLOY_COST) : 0
  const next = upgrades.find(x => x.level === 0) || [...upgrades].sort((a, b) => a.level - b.level)[0]
  const upgrade = upgrades.length ? (isFake ? next.stones : Math.min(...upgrades.map(x => x.stones))) : 0
  if (isPlayerLead(f, id)) {
    let pieces = 2 * Math.max(1, Math.min(9, Math.ceil(Math.max(1, members) * 9 / sectMemberCapacity(f, id)))) *
      (inWarUpkeep(f, id, now) ? WAR_UPKEEP_MAT_MULT : 1)
    const stock = s.vault?.mats || {}
    for (const m of [...MAT_COMMON].sort((a, b) => (stock[b] || 0) - (stock[a] || 0))) {
      const n = Math.min(pieces, Math.max(0, (Number(stock[m]) || 0) - (mats[m] || 0)))
      if (n) { mats[m] = (mats[m] || 0) + n; pieces -= n }
      if (!pieces) break
    }
  }
  return { stones: maintenance + deployment + upgrade, mats, maintenance, deployment, upgrade }
}

export function vaultAvailable (vault, reserve, name) {
  if (name === '灵石') return Math.max(0, (Number(vault.stones) || 0) - reserve.stones)
  return Math.max(0, (Number(vault.mats?.[name]) || 0) - (reserve.mats[name] || 0))
}
