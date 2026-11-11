import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaichuAttr, isTaichuEnabled, taichuEquipStats, wearTaichuEquipment, validEnchantLevel, taichuSetCount, taichuExplorationEffects, wearTaichuLoadout } from '../components/taichu_equipment.js'
import { TAICHU_EQUIPMENT, TAICHU_RECIPES } from '../components/taichu_data.js'
import { craftTaichu, repairTaichu, craftTaichuFragment, makeTaichuSupply, patchTaichu } from '../components/taichu_crafting.js'
import { EQUIP_TPL, MATERIAL_TPL, getTotalAttr, addItemToBag, takeBagItems, equipTake, unequipReturn, autoEquipBest, ensureBagShape } from '../components/equip_data.js'
import { wearPlayerTaichu, wearNpcTaichu, taichuBattleReceipt } from '../components/taichu_combat.js'

const enabled = { enabled: true }
const bag = () => ({ items: {}, equipped: {}, equippedAttr: {}, taichu: { routeClears: { forge: 1, soul: 1, tide: 1 } } })
function dressed () {
  const result = bag()
  for (const [name, tpl] of Object.entries(TAICHU_EQUIPMENT)) {
    result.equipped[tpl.type] = name
    result.equippedAttr[tpl.type] = createTaichuAttr(Object.fromEntries(['atk', 'def', 'hp'].filter(key => tpl[key]).map(key => [key, tpl[key]])))
  }
  return result
}

test('太初默认关闭，不改装备数值或扣耐久', () => {
  assert.equal(isTaichuEnabled(), false)
  const attr = createTaichuAttr({ atk: 2000 })
  attr.taichu.enchants.sharpness = 5
  const before = structuredClone(attr)
  assert.deepEqual(taichuEquipStats(attr, 'weapon', 6), { atk: 2000, def: 0, hp: 0 })
  assert.equal(wearTaichuEquipment(attr, 'weapon', 100), false)
  assert.deepEqual(attr, before)
})

test('启用时仅放大本件原生属性，套装相加且损坏立即失效', () => {
  const attr = createTaichuAttr({ atk: 2000, hp: 3000 })
  attr.taichu.enchants = { sharpness: 5, vitality: 5 }
  assert.deepEqual(taichuEquipStats(attr, 'ring', 6, enabled), { atk: 3000, def: 0, hp: 6900 })
  assert.equal(attr.atk, 2000)
  attr.taichu.durability = 0
  assert.deepEqual(taichuEquipStats(attr, 'ring', 6, enabled), { atk: 0, def: 0, hp: 0 })
  const b = dressed()
  assert.equal(taichuSetCount(b, enabled), 6)
  assert.equal(taichuExplorationEffects(b, enabled).dingxu, true)
  const before = getTotalAttr(b, enabled)
  b.equippedAttr.weapon.taichu.durability = 0
  assert.equal(taichuSetCount(b, enabled), 5)
  assert.equal(taichuExplorationEffects(b, enabled).dingxu, false)
  assert.ok(getTotalAttr(b, enabled).power < before.power)
})

test('耐久Ⅴ分数损耗累积，战斗回执幂等', () => {
  const b = dressed()
  b.equippedAttr.weapon.taichu.enchants.durability = 5
  for (let i = 0; i < 6; i++) assert.equal(wearTaichuLoadout(b, 1, { ...enabled, receipt: `battle:${i}` }), true)
  assert.equal(b.equippedAttr.weapon.taichu.durability, 999)
  assert.equal(wearTaichuLoadout(b, 100, { ...enabled, receipt: 'battle:5' }), false)
  assert.equal(b.equippedAttr.weapon.taichu.durability, 999)
})

test('附魔槽位和同名探索效果限制', () => {
  const b = dressed()
  b.equippedAttr.ring.taichu.enchants = { sharpness: 5, vitality: 5, durability: 5, treasure: 5 }
  assert.equal(validEnchantLevel(b.equippedAttr.ring, 'ring', 'treasure'), 0)
  b.equippedAttr.ring.taichu.enchants = { treasure: 5 }
  b.equippedAttr.helmet.taichu.enchants = { treasure: 3 }
  assert.equal(taichuExplorationEffects(b, enabled).treasure, 0.25)
})

test('专属物品支持背包识别但不会进入普通随机池', () => {
  assert.ok(EQUIP_TPL['太初·断界'])
  assert.ok(MATERIAL_TPL['太初印'])
  assert.ok(!Object.keys(EQUIP_TPL).includes('太初·断界'))
  assert.ok(!Object.keys(MATERIAL_TPL).includes('太初印'))
})

test('打造全条件校验且失败不扣钱物，成功扣穿戴胚子', () => {
  const b = bag(), actor = { money: 10000000, contribution: 1000 }
  const before = structuredClone(b), moneyBefore = structuredClone(actor)
  assert.equal(craftTaichu(b, '太初·断界', { ...enabled, actor, workshopLevel: 1 }).ok, false)
  assert.deepEqual(b, before)
  assert.deepEqual(actor, moneyBefore)
  for (const [name, count] of Object.entries(TAICHU_RECIPES['太初·断界'].materials)) addItemToBag(b, name, count, null, false)
  b.equipped.weapon = '攻势·武器'
  b.equippedAttr.weapon = { atk: 900 }
  const result = craftTaichu(b, '太初·断界', { ...enabled, actor, workshopLevel: 1 })
  assert.equal(result.ok, true)
  assert.equal(b.equipped.weapon, '')
  assert.equal(b.items['太初·断界'].count, 1)
  assert.equal(actor.money, 0)
  assert.equal(actor.contribution, 0)
  assert.deepEqual(result.attr.taichu.enchants, {})
})

test('修理原子扣费并保留身份附魔，失败不改变任何数据', () => {
  const b = dressed(), actor = { money: 100000, contribution: 1000 }
  b.equippedAttr.weapon.taichu.durability = 800
  b.equippedAttr.weapon.taichu.enchants.sharpness = 4
  const original = structuredClone(b)
  assert.equal(repairTaichu(b, 'weapon', { ...enabled, actor, workshopLevel: 1 }).ok, false)
  assert.deepEqual(b, original)
  assert.equal(actor.money, 100000)
  for (const [name, count] of Object.entries({ '月魄石': 20, '流光玉': 10, '凤羽玉': 2 })) addItemToBag(b, name, count, null, false)
  assert.equal(repairTaichu(b, 'weapon', { ...enabled, actor, workshopLevel: 1 }).ok, true)
  assert.equal(b.equippedAttr.weapon.taichu.durability, 1000)
  assert.equal(b.equippedAttr.weapon.taichu.id, original.equippedAttr.weapon.taichu.id)
  assert.equal(b.equippedAttr.weapon.taichu.enchants.sharpness, 4)
  assert.equal(actor.money, 90000)
})

test('交易搜刮取出、穿脱、序列化保留全部装备元数据', () => {
  const source = bag(), target = bag(), attr = createTaichuAttr({ atk: 2400 })
  attr.taichu.enchants.sharpness = 5
  attr.taichu.durability = 765
  addItemToBag(source, '太初·断界', 1, attr, false)
  addItemToBag(source, '太初·断界', 1, createTaichuAttr({ atk: 2400 }), false)
  assert.equal(source.items['太初·断界'].list.length, 2)
  const entries = takeBagItems(source, '太初·断界', 1)
  addItemToBag(target, entries[0].name, 1, entries[0].attr, false)
  assert.deepEqual(equipTake(target, 'weapon', '太初·断界', entries[0].attr), attr)
  unequipReturn(target, 'weapon')
  const loaded = JSON.parse(JSON.stringify(target))
  assert.deepEqual(loaded.items['太初·断界'].list.find(g => g.count > 0).attr, attr)
  assert.equal(source.items['太初·断界'].count, 1)
})

test('碎片定向合成和修补包实际扣料，默认关闭所有服务', () => {
  const b = dressed(), actor = { money: 20000, contribution: 100 }
  assert.equal(craftTaichuFragment(b, '断界图谱').ok, false)
  addItemToBag(b, '断界图谱碎片', 10, null, false)
  assert.equal(craftTaichuFragment(b, '断界图谱', enabled).ok, true)
  assert.equal(b.items['断界图谱'].count, 1)
  assert.equal(b.items['断界图谱碎片'], undefined)
  for (const [name, count] of Object.entries({ '月魄石': 30, '流光玉': 20, '凤羽玉': 2 })) addItemToBag(b, name, count, null, false)
  assert.equal(makeTaichuSupply(b, '太初修补包', { ...enabled, actor, workshopLevel: 1 }).ok, true)
  b.equippedAttr.weapon.taichu.durability = 600
  assert.equal(patchTaichu(b, 'weapon', enabled).ok, true)
  assert.equal(b.equippedAttr.weapon.taichu.durability, 800)
  assert.equal(b.items['太初修补包'], undefined)
})

test('自动换装比较套装与破损状态，彩武仍保留原实例', () => {
  const b = dressed()
  b.equipped.weapon = 'rainbow:r1'
  b.equippedAttr.weapon = null
  b.rainbows = [{ id: 'r1', name: '彩武', baseAtk: 2500, maxAtk: 2500 }]
  const attr = createTaichuAttr({ atk: 2400 })
  addItemToBag(b, '太初·断界', 1, attr, false)
  assert.ok(autoEquipBest(b, enabled).includes('太初·断界'))
  assert.equal(b.equipped.weapon, '太初·断界')
  assert.equal(b.rainbows[0].id, 'r1')
  b.equippedAttr.weapon.taichu.durability = 0
  addItemToBag(b, '桃木剑', 1, { atk: 4 }, false)
  autoEquipBest(b, enabled)
  assert.equal(b.equipped.weapon, '桃木剑')
  assert.equal(b.items['太初·断界'].list.filter(g => g.count > 0).length, 1)
})

test('旧格式太初装备分组迁移独立身份且重复读取不改ID', () => {
  const b = bag()
  b.items['太初·断界'] = { count: 2, attr: { atk: 2400 } }
  ensureBagShape(b)
  const groups = b.items['太初·断界'].list
  assert.equal(groups.length, 2)
  assert.notEqual(groups[0].attr.taichu.id, groups[1].attr.taichu.id)
  const before = structuredClone(b)
  ensureBagShape(b)
  assert.deepEqual(b, before)
})

test('普通战斗只在启用且实际穿太初时保存，同一结算不重复扣', () => {
  const b = dressed()
  let reads = 0, writes = 0
  const io = { enabled: true, load: () => { reads++; return b }, save: () => { writes++ } }
  assert.equal(wearPlayerTaichu('g', 'u', 'fight:one', 2, io), true)
  assert.equal(wearPlayerTaichu('g', 'u', 'fight:one', 2, io), false)
  assert.equal(b.equippedAttr.weapon.taichu.durability, 998)
  assert.equal(writes, 1)
  assert.equal(wearPlayerTaichu('g', 'u', 'fight:two', 2, { ...io, enabled: false }), false)
  assert.equal(reads, 2)
  const ordinary = { equipped: { weapon: '桃木剑' }, equippedAttr: { weapon: { atk: 4 } }, items: {} }
  const before = structuredClone(ordinary)
  assert.equal(wearPlayerTaichu('g', 'u', 'fight:three', 2, { ...io, load: () => ordinary }), false)
  assert.deepEqual(ordinary, before)
  assert.equal(writes, 1)
  assert.equal(wearNpcTaichu({ bag: b }, 'fight:one', 2, enabled), false)
  assert.equal(wearNpcTaichu({ bag: b }, 'fight:two', 2, enabled), true)
  assert.equal(b.equippedAttr.weapon.taichu.durability, 996)
})

test('战斗回执按消息ID稳定，缺少ID时同事件重入仍稳定', () => {
  assert.equal(taichuBattleReceipt({ message_id: 'm1' }, 'duel'), 'duel:m1')
  const event = {}
  assert.equal(taichuBattleReceipt(event, 'duel'), taichuBattleReceipt(event, 'duel'))
  assert.notEqual(taichuBattleReceipt({}, 'duel'), taichuBattleReceipt({}, 'duel'))
})

test('同名装备身份独立，元数据可无损序列化', () => {
  const a = createTaichuAttr({ atk: 2000 })
  const b = createTaichuAttr({ atk: 2000 })
  assert.notEqual(a.taichu.id, b.taichu.id)
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a)
  a.taichu.enchants.sharpness = 5
  assert.equal(validEnchantLevel(a, 'weapon', 'sharpness'), 5)
  assert.equal(validEnchantLevel(a, 'chest', 'sharpness'), 0)
  a.taichu.enchants.sharpness = 6
  assert.equal(validEnchantLevel(a, 'weapon', 'sharpness'), 0)
})
