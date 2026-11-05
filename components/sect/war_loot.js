import { EQUIP_TPL, ITEM_TPL, MATERIAL_TPL, isBound } from '../equip_data.js'

/** 只转移有接收仓位的物品；未知/专属物品保留在原背包，禁止静默删除。 */
export function extractWarLoot (bag, ratio = 1, random = Math.random) {
  const entries = []
  const allowed = name => !isBound(name) && !!(EQUIP_TPL[name] || ITEM_TPL[name] || MATERIAL_TPL[name])
  for (const [name, item] of Object.entries(bag?.items || {})) {
    if (!allowed(name) || random() >= ratio) continue
    const count = Math.max(0, Math.floor(Number(item?.count ?? item) || 0))
    if (!count) continue
    if (EQUIP_TPL[name] && Array.isArray(item.list) && item.list.length) {
      let remaining = count
      for (const group of item.list) {
        const n = Math.min(remaining, Math.max(0, Number(group.count) || 0))
        if (n) entries.push({ name, count: n, attr: structuredClone(group.attr || {}) })
        remaining -= n
      }
      if (remaining) entries.push({ name, count: remaining, attr: structuredClone(item.attr || {}) })
    } else entries.push({ name, count, attr: EQUIP_TPL[name] ? structuredClone(item.attr || {}) : null })
    delete bag.items[name]
  }
  for (const [slot, name] of Object.entries(bag?.equipped || {})) {
    if (!name || !allowed(name) || random() >= ratio) continue
    entries.push({ name, count: 1, attr: structuredClone(bag.equippedAttr?.[slot] || {}) })
    bag.equipped[slot] = ''
    if (bag.equippedAttr) bag.equippedAttr[slot] = null
  }
  return entries
}

export function depositWarLoot (vault, entries) {
  for (const { name, count, attr } of entries) {
    const field = MATERIAL_TPL[name] ? 'mats' : ITEM_TPL[name] ? 'pills' : 'equips'
    vault[field] ||= {}
    vault[field][name] = (Number(vault[field][name]) || 0) + count
    if (field === 'equips') {
      vault.equipAttrs ||= {}
      const groups = vault.equipAttrs[name] ||= []
      const group = groups.find(g => JSON.stringify(g.attr) === JSON.stringify(attr))
      if (group) group.count += count
      else groups.push({ count, attr: structuredClone(attr) })
    }
  }
}

/** 与宝库数量同时消费属性组；旧档/宗门自炼装备没有属性组时沿用原生成规则。 */
export function takeVaultEquipAttrs (vault, name, count) {
  const groups = vault.equipAttrs?.[name] || []
  const result = []; let remaining = count
  for (const group of groups) {
    const n = Math.min(remaining, Math.max(0, Number(group.count) || 0))
    if (n) { result.push({ count: n, attr: group.attr }); group.count -= n; remaining -= n }
  }
  if (vault.equipAttrs?.[name]) vault.equipAttrs[name] = groups.filter(g => g.count > 0)
  if (remaining) result.push({ count: remaining, attr: null })
  return result
}
