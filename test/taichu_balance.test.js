import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { TAICHU_EQUIPMENT, TAICHU_RECIPES } from '../components/taichu_data.js'
import { createTaichuAttr, taichuEquipStats, isTaichuEnabled } from '../components/taichu_equipment.js'
import { getTotalAttr, addItemToBag, ensureBagShape } from '../components/equip_data.js'
import { craftTaichu } from '../components/taichu_crafting.js'
import { getWanhunSoulPower, Wanhun } from '../components/wanhun_data.js'
import { REALM_MAX_LEVEL } from '../components/realm_cap.js'
import { injuredPower } from '../components/injury.js'

const enabled = { enabled: true }
function taichuBag () {
  const bag = { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} }
  for (const [name, tpl] of Object.entries(TAICHU_EQUIPMENT)) {
    bag.equipped[tpl.type] = name
    bag.equippedAttr[tpl.type] = createTaichuAttr(Object.fromEntries(['atk', 'def', 'hp'].filter(key => tpl[key]).map(key => [key, tpl[key]])))
  }
  return bag
}
function oldGraduationBag () {
  const bag = { items: {}, equipped: { weapon: 'rainbow:max' }, equippedAttr: {}, artifacts: {}, rainbows: [{ id: 'max', baseAtk: 3000, maxAtk: 3000 }] }
  for (const [part, name] of Object.entries({ helmet: '攻势·头盔', chest: '攻势·胸甲', pants: '攻势·裤子', shoes: '攻势·鞋子', ring: '攻势·戒指' })) {
    bag.equipped[part] = name
    bag.equippedAttr[part] = part === 'ring' ? { atk: 450, def: 390, hp: 3000 } : { def: 780, hp: 3000 }
  }
  return bag
}
function addFullWanhun (bag) {
  bag.artifacts.wanhun = { equipped: true, deployed: false, rank: 9, attack: 500, mainSoul: { level: 567 }, deputySouls: Array.from({ length: 3 }, () => ({ level: 567 })) }
}

// 执行真实战斗公式，仅替换存储/宠物入口；不改正式配置或创建玩家存档。
function fightWithPet (petPower = 9000) {
  const source = fs.readFileSync(new URL('../components/fight.js', import.meta.url), 'utf8')
    .replace(/^import\s[^\n]*\r?$/gm, '').replace(/^export /gm, '')
  return vm.runInNewContext(`${source}\n; ({ realmPower, calcCombatPower })`, {
    REALM_MAX_LEVEL, getWanhunSoulPower, injuredPower,
    getTotalAttr: bag => getTotalAttr(bag, enabled), getActivePetPower: () => petPower,
    getPuppetPower: () => 0, readPlayerInjury: () => null
  })
}

test('太初六件预算实算：原生89100、含套装109350、合法满附魔181650', () => {
  const bag = taichuBag(), before = structuredClone(bag)
  const native = Object.entries(bag.equippedAttr).reduce((sum, [part, attr]) => {
    const stats = taichuEquipStats(attr, part, 0, enabled)
    return sum + stats.atk * 2 + stats.def * 2 + stats.hp / 5
  }, 0)
  assert.equal(native, 89100)
  assert.deepEqual(getTotalAttr(bag, enabled), { atk: 10800, def: 30420, hp: 134550, hpPct: 0, power: 109350 })
  assert.deepEqual(bag, before)
  bag.equippedAttr.weapon.taichu.enchants = { sharpness: 5 }
  for (const part of ['helmet', 'chest', 'pants', 'shoes']) bag.equippedAttr[part].taichu.enchants = { armor: 5, vitality: 5 }
  bag.equippedAttr.ring.taichu.enchants = { sharpness: 5, vitality: 5 }
  assert.equal(getTotalAttr(bag, enabled).power, 181650)
})

test('保留旧境界及万魂战力，满魂毕业参考换装提升25%至35%', () => {
  const fight = fightWithPet(), old = oldGraduationBag(), next = taichuBag()
  assert.equal(fight.realmPower(567), 84900)
  assert.equal(getTotalAttr(old, enabled).power, 16920)
  assert.equal(Wanhun.aidPercent(9), 1)
  addFullWanhun(old); addFullWanhun(next)
  assert.equal(getWanhunSoulPower(old, 567), 169800)
  const before = structuredClone(old)
  const oldPower = fight.calcCombatPower(567, old, 1, 'memory', 'u', null).power
  const newPower = fight.calcCombatPower(567, next, 1, 'memory', 'u', null).power
  assert.equal(oldPower, 281620)
  assert.equal(newPower, 374050)
  assert.equal(newPower - oldPower, 92430)
  assert.ok(newPower / oldPower >= 1.25 && newPower / oldPower <= 1.35)
  for (const buff of [1.54, (1.54 + 0.2) * 2]) {
    assert.equal(fight.calcCombatPower(567, old, buff, 'memory', 'u', null).power, Math.round(oldPower * buff))
    assert.equal(fight.calcCombatPower(567, next, buff, 'memory', 'u', null).power, Math.round(newPower * buff))
  }
  assert.deepEqual(old, before)
})

test('现有装备不受太初开关影响，旧太初属性快照不会被模板重写', () => {
  const old = oldGraduationBag(), before = structuredClone(old)
  assert.deepEqual(getTotalAttr(old, enabled), getTotalAttr(old, { enabled: false }))
  assert.deepEqual(old, before)
  const legacy = { items: { '太初·断界': { count: 1, attr: createTaichuAttr({ atk: 2400 }) } }, equipped: {}, equippedAttr: {}, artifacts: {} }
  const attr = structuredClone(legacy.items['太初·断界'].attr)
  ensureBagShape(legacy)
  assert.deepEqual(legacy.items['太初·断界'].attr, attr)
  assert.equal(isTaichuEnabled(), false)
})

test('六件新打造产物使用增强模板并继续真实扣费', () => {
  for (const [name, recipe] of Object.entries(TAICHU_RECIPES)) {
    const bag = { items: {}, equipped: {}, equippedAttr: {}, taichu: { routeClears: { [recipe.route]: 1 } } }
    for (const [item, count] of Object.entries(recipe.materials)) addItemToBag(bag, item, count, null, false)
    addItemToBag(bag, recipe.base, 1, { atk: 1 }, false)
    const actor = { money: recipe.stones, contribution: recipe.contribution }
    const result = craftTaichu(bag, name, { ...enabled, workshopLevel: 1, actor })
    assert.equal(result.ok, true, name)
    for (const key of ['atk', 'def', 'hp']) assert.equal(result.attr[key], TAICHU_EQUIPMENT[name][key], `${name}:${key}`)
    assert.equal(actor.money, 0)
    assert.equal(actor.contribution, 0)
    assert.deepEqual(result.attr.taichu.enchants, {})
  }
})
