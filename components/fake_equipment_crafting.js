import { EQUIP_TPL, attrPower, rollEquipAttr, rollRandomColorEquip, consumeBagItem, consumeBagItems, addItemToBag, autoEquipBest, isRainbowRef } from './equip_data.js'

// 与玩家 #制造红装 / #制造彩装 配方一致，彩装部位及属性使用同一个随机生成器。
export const FAKE_RED_ORES = ['月魄石', '星璇石', '流光玉', '织云石', '凤羽玉']
export const FAKE_COLOR_ORE = '造梦神玉'
const SLOTS = ['weapon', 'helmet', 'chest', 'pants', 'shoes', 'ring']
const count = (p, name) => Math.max(0, Number(p.bag?.items?.[name]?.count ?? p.bag?.items?.[name]) || 0)
const equippedQuality = (p, slot) => isRainbowRef(p.bag?.equipped?.[slot]) ? 7 : Number(EQUIP_TPL[p.bag?.equipped?.[slot]]?.quality) || 0

function redBase (p, reserved = {}) {
  return Object.keys(p.bag?.items || {}).filter(name => EQUIP_TPL[name]?.quality === 6 && !EQUIP_TPL[name]?.bound && count(p, name) > (reserved[name] || 0))
    .flatMap(name => {
      const item = p.bag.items[name]
      return (item.list?.length ? item.list : [{ count: count(p, name), attr: item.attr || {} }]).filter(g => g.count > 0).map(g => ({ name, attr: g.attr || {} }))
    }).sort((a, b) => attrPower(a.attr) - attrPower(b.attr))[0]
}

/** 彩装优先于普通法宝筹料；穿戴中的装备和太初目标胚子不作为耗材。 */
export function fakeEquipmentNeeds (p, reserved = {}) {
  if (!p?.bag || SLOTS.every(slot => equippedQuality(p, slot) >= 7)) return {}
  const needs = { [FAKE_COLOR_ORE]: 6 + (reserved[FAKE_COLOR_ORE] || 0) }
  const red = redBase(p, reserved)
  if (red) needs[red.name] = 1 + (reserved[red.name] || 0)
  else for (const ore of FAKE_RED_ORES) needs[ore] = 1 + (reserved[ore] || 0)
  return needs
}

/** 每轮最多三炉；只有具备整份材料才执行，产物正常入包并择优穿戴。 */
export function craftFakeEquipment (p, now = Date.now(), reserved = {}) {
  if (!p?.bag || now < (p.activities?.nextEquipCraft || 0)) return []
  const results = []
  for (let round = 0; round < 3; round++) {
    if (!Object.keys(fakeEquipmentNeeds(p, reserved)).length) break
    let red = redBase(p, reserved)
    const canColor = count(p, FAKE_COLOR_ORE) - (reserved[FAKE_COLOR_ORE] || 0) >= 6
    if (!red && FAKE_RED_ORES.every(name => count(p, name) - (reserved[name] || 0) >= 1)) {
      const names = Object.keys(EQUIP_TPL).filter(name => EQUIP_TPL[name].quality === 6)
      if (!names.length) break
      const name = names[Math.floor(Math.random() * names.length)]
      const attr = rollEquipAttr(EQUIP_TPL[name].type, 6)
      if (!consumeBagItems(p.bag, Object.fromEntries(FAKE_RED_ORES.map(ore => [ore, 1])))) break
      addItemToBag(p.bag, name, 1, attr, false)
      results.push({ quality: 6, name, materials: FAKE_RED_ORES.map(ore => `${ore}×1`).join('、') })
      red = redBase(p, reserved)
    }
    if (red && canColor) {
      const product = rollRandomColorEquip()
      if (!product) break
      const next = { items: structuredClone(p.bag.items) }
      if (!consumeBagItem(next, FAKE_COLOR_ORE, 6) || !consumeBagItem(next, red.name, 1, red.attr)) break
      p.bag.items = next.items
      addItemToBag(p.bag, product.name, 1, product.attr, false)
      results.push({ quality: 7, name: product.name, materials: `${FAKE_COLOR_ORE}×6、${red.name}×1` })
    } else {
      if (results.length) autoEquipBest(p.bag)
      break
    }
    autoEquipBest(p.bag)
  }
  if (results.length) (p.activities ||= {}).nextEquipCraft = now + 30 * 60000
  return results
}
