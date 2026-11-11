import { TAICHU_EQUIPMENT, TAICHU_RECIPES, TAICHU_MATERIALS, TAICHU_FRAGMENT_NEED, TAICHU_SUPPLY_RECIPES } from './taichu_data.js'
import { createTaichuAttr, isTaichuEnabled } from './taichu_equipment.js'
import { addItemToBag, consumeBagItem, consumeBagItems } from './equip_data.js'

const fail = msg => ({ ok: false, msg })
const commit = (bag, next) => {
  for (const raw of Object.values(next.items || {})) if (raw?.list?.length) raw.attr = raw.list[0].attr
  for (const key of Object.keys(bag)) delete bag[key]
  Object.assign(bag, next)
}
const have = (bag, name) => Math.max(0, Number(bag.items?.[name]?.count ?? bag.items?.[name]) || 0)
function missingMaterials (bag, materials) {
  return Object.entries(materials).filter(([name, count]) => have(bag, name) < count).map(([name, count]) => `${name}×${count - have(bag, name)}`)
}
function canPay (actor, stones, contribution) {
  if (!actor || !Number.isFinite(actor.money) || actor.money < stones) return fail(`灵石不足，需要${stones}`)
  if ((Number(actor.contribution) || 0) < contribution) return fail(`宗门贡献不足，需要${contribution}`)
  return { ok: true }
}

/** 所有条件在副本中检查；只有成功才提交背包和个人钱款。调用方保存两者。 */
export function craftTaichu (bag, name, { workshopLevel = 0, actor, enabled = isTaichuEnabled() } = {}) {
  if (!enabled) return fail('太初玩法尚未开放')
  const recipe = TAICHU_RECIPES[name]
  if (!recipe) return fail('没有这件太初装备的配方')
  if (workshopLevel < 1) return fail('需要宗门天工坊一级')
  if (!(bag?.taichu?.routeClears?.[recipe.route] > 0)) return fail('需亲自完成对应古墟路线')
  const check = canPay(actor, recipe.stones, recipe.contribution)
  if (!check.ok) return check
  const missing = missingMaterials(bag, recipe.materials)
  if (missing.length) return fail(`缺少材料：${missing.join('、')}`)
  const next = structuredClone(bag)
  const part = TAICHU_EQUIPMENT[name].type
  if (have(next, recipe.base) > 0) {
    if (!consumeBagItem(next, recipe.base, 1)) return fail('装备胚子不足')
  } else if (next.equipped?.[part] === recipe.base) {
    next.equipped[part] = ''
    if (next.equippedAttr) next.equippedAttr[part] = null
  } else return fail(`缺少装备胚子：${recipe.base}`)
  if (!consumeBagItems(next, recipe.materials)) return fail('材料不足')
  const { atk, def, hp } = TAICHU_EQUIPMENT[name]
  const attr = createTaichuAttr(Object.fromEntries(Object.entries({ atk, def, hp }).filter(([, value]) => value !== undefined)))
  addItemToBag(next, name, 1, attr, false)
  commit(bag, next)
  actor.money -= recipe.stones
  actor.contribution = (actor.contribution || 0) - recipe.contribution
  return { ok: true, msg: `打造成功：${name}`, name, attr, costs: recipe }
}

function repairTarget (bag, selector) {
  const candidates = []
  for (const [part, name] of Object.entries(bag?.equipped || {})) {
    const attr = bag.equippedAttr?.[part]
    if (TAICHU_EQUIPMENT[name]?.type === part && attr?.taichu) candidates.push({ part, name, attr, equipped: true })
  }
  for (const [name, raw] of Object.entries(bag?.items || {})) {
    if (!TAICHU_EQUIPMENT[name]) continue
    for (const group of raw.list || [raw]) if (group.count > 0 && group.attr?.taichu) candidates.push({ name, part: TAICHU_EQUIPMENT[name].type, attr: group.attr, equipped: false })
  }
  const exact = candidates.filter(c => c.attr.taichu.id === selector || (c.equipped && c.part === selector))
  if (exact.length === 1) return exact[0]
  const prefix = typeof selector === 'string' && selector.length >= 8 ? candidates.filter(c => c.attr.taichu.id.startsWith(selector)) : []
  return prefix.length === 1 ? prefix[0] : null
}

export function previewRepairTaichu (bag, selector, { workshopLevel = 0, enabled = isTaichuEnabled() } = {}) {
  if (!enabled) return fail('太初玩法尚未开放')
  if (workshopLevel < 1) return fail('需要宗门天工坊一级')
  const target = repairTarget(bag, selector)
  if (!target) return fail('未找到唯一装备，请使用穿戴部位或装备ID')
  const meta = target.attr.taichu
  const missing = Math.max(0, meta.maxDurability - meta.durability)
  if (!missing && !(meta.wearRemainder > 0)) return fail('这件装备无需修理')
  const units = Math.max(1, Math.ceil((missing + (meta.wearRemainder || 0)) / 100))
  const costs = { materials: { '月魄石': units * 10, '流光玉': units * 5, '凤羽玉': units }, stones: units * 5000, contribution: units * 2 }
  return { ok: true, msg: `修理${target.name}需要${costs.stones}灵石、${costs.contribution}贡献及${Object.entries(costs.materials).map(([n, c]) => `${n}×${c}`).join('、')}`, costs, id: meta.id, name: target.name }
}

export function repairTaichu (bag, selector, { workshopLevel = 0, actor, enabled = isTaichuEnabled() } = {}) {
  const preview = previewRepairTaichu(bag, selector, { workshopLevel, enabled })
  if (!preview.ok) return preview
  const check = canPay(actor, preview.costs.stones, preview.costs.contribution)
  if (!check.ok) return check
  const next = structuredClone(bag)
  if (!consumeBagItems(next, preview.costs.materials)) return fail('修理材料不足')
  const target = repairTarget(next, preview.id)
  target.attr.taichu.durability = target.attr.taichu.maxDurability
  target.attr.taichu.wearRemainder = 0
  commit(bag, next)
  actor.money -= preview.costs.stones
  actor.contribution = (actor.contribution || 0) - preview.costs.contribution
  return { ...preview, msg: `已修复${preview.name}，耐久恢复至1000` }
}

export function craftTaichuFragment (bag, name, { enabled = isTaichuEnabled() } = {}) {
  if (!enabled) return fail('太初玩法尚未开放')
  if (!TAICHU_MATERIALS[name] || !TAICHU_MATERIALS[`${name}碎片`]) return fail('该物品不能由碎片合成')
  const next = structuredClone(bag)
  if (!consumeBagItem(next, `${name}碎片`, TAICHU_FRAGMENT_NEED)) return fail(`需要${name}碎片×${TAICHU_FRAGMENT_NEED}`)
  addItemToBag(next, name, 1, null, false)
  commit(bag, next)
  return { ok: true, msg: `已合成${name}`, name }
}

export function makeTaichuSupply (bag, name, { actor, workshopLevel = 0, enabled = isTaichuEnabled() } = {}) {
  if (!enabled) return fail('太初玩法尚未开放')
  const recipe = TAICHU_SUPPLY_RECIPES[name]
  if (!recipe) return fail('没有这种补给配方')
  if (name === '太初修补包' && workshopLevel < 1) return fail('制作修补包需要宗门天工坊一级')
  const check = canPay(actor, recipe.stones, recipe.contribution)
  if (!check.ok) return check
  const next = structuredClone(bag)
  if (!consumeBagItems(next, recipe.materials)) return fail('补给材料不足')
  addItemToBag(next, name, 1, null, false)
  commit(bag, next)
  actor.money -= recipe.stones
  actor.contribution = (actor.contribution || 0) - recipe.contribution
  return { ok: true, msg: `已制作${name}`, name }
}

/** 应急包在副本非战斗阶段由入口检查后调用，每包恢复单件200耐久。 */
export function patchTaichu (bag, selector, { enabled = isTaichuEnabled() } = {}) {
  if (!enabled) return fail('太初玩法尚未开放')
  const next = structuredClone(bag)
  const target = repairTarget(next, selector)
  if (!target) return fail('未找到唯一装备')
  if (target.attr.taichu.durability >= target.attr.taichu.maxDurability) return fail('装备无需修补')
  if (!consumeBagItem(next, '太初修补包', 1)) return fail('缺少太初修补包')
  target.attr.taichu.durability = Math.min(target.attr.taichu.maxDurability, target.attr.taichu.durability + 200)
  commit(bag, next)
  return { ok: true, msg: `已修补${target.name}，耐久${target.attr.taichu.durability}/1000` }
}
