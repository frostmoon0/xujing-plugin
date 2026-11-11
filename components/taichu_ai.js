import { isTaichuEnabled, taichuExplorationEffects, taichuSetCount, wearTaichuLoadout } from './taichu_equipment.js'
import { TAICHU_EQUIPMENT, TAICHU_RECIPES } from './taichu_data.js'
import { getBagEquipEntries } from './equip_data.js'
import { craftTaichu, repairTaichu, craftTaichuFragment } from './taichu_crafting.js'
import { createTaichuRun, actTaichuRun, supplyTaichuRun, retreatTaichuRun, taichuChoices, getTaichuSettlement, commitTaichuSettlement, TAICHU_ENTRY_COST, TAICHU_DIFFICULTIES } from './taichu_dungeon.js'

const MINUTE = 60000
const itemCount = (bag, name) => Math.max(0, Number(bag?.items?.[name]?.count ?? bag?.items?.[name]) || 0)
const owns = (bag, name) => Object.values(bag?.equipped || {}).includes(name) || itemCount(bag, name) > 0

/** 固定目标直到完成，避免刚收齐的材料又作为余货卖出。 */
export function planFakeTaichuEquipment (p, { enabled = isTaichuEnabled() } = {}) {
  if (!enabled || !p?.bag) return null
  const previous = p.taichuTarget
  const name = TAICHU_RECIPES[previous] && !owns(p.bag, previous)
    ? previous : Object.keys(TAICHU_RECIPES).find(key => !owns(p.bag, key))
  if (!name) return null
  const recipe = TAICHU_RECIPES[name]
  const needs = { ...recipe.materials, [recipe.base]: 1 }
  const missing = Object.fromEntries(Object.entries(needs).flatMap(([key, count]) => {
    const have = itemCount(p.bag, key) + (Object.values(p.bag.equipped || {}).includes(key) ? 1 : 0)
    return count > have ? [[key, count - have]] : []
  }))
  return { name, route: recipe.route, recipe, needs, missing }
}

/** 同一份需求同时用于定向求购和卖方保留数量。 */
export function fakeTaichuMaterialNeeds (p, { enabled = isTaichuEnabled() } = {}) {
  if (!p?.taichuTarget) return {}
  return planFakeTaichuEquipment(p, { enabled })?.needs || {}
}

export function chooseFakeTaichuAction (run, p, plan) {
  const choices = taichuChoices(run)
  const keys = choices.map(x => x.key)
  const prefer = (...wanted) => wanted.find(key => keys.includes(key)) || keys[0]
  const node = run.node || {}
  if (node.kind === 'route') return prefer(plan?.route || 'forge', 'forge')
  if (node.kind === 'array') return prefer(`disarm:${node.answer}`, 'suppress', 'force')
  if (node.kind === 'remnant') {
    const member = run.members?.[String(p.name)] || {}
    if ((member.energy ?? 100) < 45 && member.supplies > 0) return prefer('rest', 'seal', 'leave')
    if ((member.energy ?? 100) < 20) return prefer('leave', 'seal')
    return prefer('seal', 'search', 'rest')
  }
  const counters = { shield: 'break', charge: 'interrupt', summon: 'attack', mark: 'guard' }
  return prefer(counters[node.threat], 'attack', 'guard')
}

/**
 * 在 fakeTick 的群锁内推进。run、背包、金钱与周额度同在 fake_{gid}.json，
 * 由调用方一次保存；无需跨档发奖，重启不会另开一趟或重复结算。
 */
export function tickFakeTaichu (f, gid, now, {
  powerOf, canAct, workshopLevel, addItem, takeItem, autoEquip, log,
  homeRegion, travelTo, enabled = isTaichuEnabled()
}) {
  if (!enabled) {
    let released = false
    for (const p of Object.values(f.roster || {})) {
      if (p?.realmBusy?.realmId?.startsWith('taichu:')) { delete p.realmBusy; released = true }
    }
    return released
  }
  let changed = false
  const emit = (p, text) => log?.(f, 'flavor', `【太初古墟】${p.name} ${text}`, now, { who: [p.name], onlyPerson: true })
  for (const p of Object.values(f.roster || {})) {
    if (!p?.alive) {
      if (p?.taichuRun) { delete p.taichuRun; if (p.realmBusy?.realmId?.startsWith('taichu:')) delete p.realmBusy; changed = true }
      continue
    }
    // 自己的标记不等同另一个秘境的占用；不清理其他模块的锁。
    const run = p.taichuRun
    if (run) {
      const available = { ...p }
      if (available.realmBusy?.realmId === `taichu:${run.id}`) delete available.realmBusy
      if (!canAct(f, available, now)) continue
      if (p.realmBusy?.realmId !== `taichu:${run.id}`) {
        p.realmBusy = { realmId: `taichu:${run.id}`, gid: String(gid) }
        changed = true
      }
      if (run.phase === 'active' && now < (p.taichuNextAt || 0)) continue
      if (run.phase === 'active') {
        const next = structuredClone(run)
        const effects = taichuExplorationEffects(p.bag, { enabled })
        const action = chooseFakeTaichuAction(next, p, planFakeTaichuEquipment(p, { enabled }))
        const materials = Object.fromEntries(Object.entries(p.bag?.items || {}).map(([name]) => [name, itemCount(p.bag, name)]))
        const actor = { power: powerOf(p), bonuses: { ...effects, setCount: taichuSetCount(p.bag, { enabled }) }, materials }
        let result = actTaichuRun(next, String(p.name), action, actor, { enabled, now })
        if (!result.ok && next.phase === 'active' && supplyTaichuRun(next, String(p.name), { enabled, now }).ok) {
          result = actTaichuRun(next, String(p.name), action, actor, { enabled, now })
        }
        if (!result.ok) {
          // 无法推进时撤离，同样交给副本引擎结算已封存物品。
          if (next.phase === 'active' && !retreatTaichuRun(next, String(p.name), { enabled, now }).ok) continue
          result = { ok: true, wear: 0, consume: {} }
        }
        const consumed = Object.entries(result.consume || {})
        if (consumed.some(([name, count]) => itemCount(p.bag, name) < count)) continue
        for (const [name, count] of consumed) takeItem(p.bag, name, count)
        if (result.wear > 0) wearTaichuLoadout(p.bag, result.wear, { receipt: `${next.id}:${next.turn ?? next.steps ?? now}`, enabled })
        p.taichuRun = next
        p.taichuNextAt = now + MINUTE
        changed = true
      }
      const finished = p.taichuRun
      if (finished.phase === 'active') continue
      p.taichuLedger ||= {}
      const settlement = getTaichuSettlement(finished, String(p.name), p.taichuLedger, now, { enabled })
      if (settlement) {
        for (const [name, count] of Object.entries(settlement.items || {})) addItem(p.bag, name, count, null, false)
        p.bag.taichu ||= {}
        if (finished.phase === 'cleared' && settlement.route) {
          p.bag.taichu.routeClears ||= {}
          p.bag.taichu.routeClears[settlement.route] = (p.bag.taichu.routeClears[settlement.route] || 0) + 1
        }
        commitTaichuSettlement(finished, String(p.name), p.taichuLedger, now, { enabled })
        emit(p, `${finished.phase === 'cleared' ? '完成' : '结束'}本趟探索，按同规则结算战利品`)
      }
      p.taichuLastTrip = { at: now, phase: finished.phase, route: finished.route, id: finished.id }
      delete p.taichuRun
      if (p.realmBusy?.realmId === `taichu:${finished.id}`) delete p.realmBusy
      p.taichuNextAt = now + 60 * MINUTE
      autoEquip?.(p.bag)
      changed = true
      continue
    }
    if (now < (p.taichuNextAt || 0) || !canAct(f, p, now)) continue
    if (!p.taichuTarget && !Object.values(p.bag?.equipped || {}).some(name => TAICHU_EQUIPMENT[name]) && powerOf(p) < TAICHU_DIFFICULTIES.normal.power * 0.9) continue
    p.taichuNextAt = now + 10 * MINUTE
    const plan = planFakeTaichuEquipment(p, { enabled })
    if (plan) p.taichuTarget = plan.name
    else delete p.taichuTarget
    changed = true

    const workshop = workshopLevel(f, p)
    const atHome = !homeRegion || (p.loc || 'center') === homeRegion(f, p)
    if (workshop > 0 && !atHome) {
      travelTo?.(f, p, homeRegion(f, p), now, '天工坊修理与打造')
      continue
    }
    if (workshop > 0) {
      // 先修理，缺料则换备用，损坏的太初装备不能当作正常战力出门。
      const repairEntries = [...getBagEquipEntries(p.bag), ...Object.entries(p.bag?.equipped || {}).map(([part, name]) => ({ name, attr: p.bag.equippedAttr?.[part] }))]
      for (const { name, attr } of repairEntries) {
        if (!TAICHU_EQUIPMENT[name] || !attr?.taichu || attr.taichu.durability >= 500) continue
        const result = repairTaichu(p.bag, attr.taichu.id, { actor: p, workshopLevel: workshop, enabled })
        if (result.ok) emit(p, `在天工坊修复${name}`)
      }
      if (plan) {
        for (const name of [plan.recipe.diagram, plan.recipe.core]) {
          if (itemCount(p.bag, name) < 1) craftTaichuFragment(p.bag, name, { enabled })
        }
        const result = craftTaichu(p.bag, plan.name, { actor: p, workshopLevel: workshop, enabled })
        if (result.ok) { emit(p, `按玩家同配方打造${plan.name}`); autoEquip?.(p.bag); continue }
      }
    }
    autoEquip?.(p.bag)
    if (Object.values(p.bag?.equippedAttr || {}).some(attr => attr?.taichu && attr.taichu.durability < 150)) continue
    // 不靠刷高难送死换资源；固定难度由同引擎提供，先保证普通档容错。
    const power = powerOf(p)
    const difficulty = ['extreme', 'hard', 'normal'].find(key => power >= TAICHU_DIFFICULTIES[key].power * 0.9 && (Number(p.money) || 0) >= TAICHU_ENTRY_COST[key] + 10000)
    if (!difficulty) continue
    if (!plan && Object.values(p.bag?.equipped || {}).filter(name => TAICHU_EQUIPMENT[name]).length >= 6) continue
    const next = createTaichuRun({ gid, leader: String(p.name), members: [{ id: String(p.name), name: p.name, kind: 'fake', power }], difficulty, now }, { enabled })
    p.money -= TAICHU_ENTRY_COST[difficulty]
    p.taichuRun = next
    p.realmBusy = { realmId: `taichu:${next.id}`, gid: String(gid) }
    p.taichuNextAt = now + MINUTE
    emit(p, `支付${TAICHU_ENTRY_COST[difficulty]}灵石备齐补给，进入${TAICHU_DIFFICULTIES[difficulty].name}古墟`)
  }
  return changed
}
