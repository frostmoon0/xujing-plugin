import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createTaichuAttr } from '../components/taichu_equipment.js'
import { getBagEquipEntries } from '../components/equip_data.js'
import { resolveNpcEncounter } from '../components/npc_action.js'
import { npcConflict, genFight, genVaultRob } from '../components/fake_data.js'

const NOW = Date.UTC(2026, 10, 9, 2)
const person = (name, level = 100) => ({ name, level, alive: true, status: 'scatter', loc: 'center', money: 1000, trait: '平和', path: '正道', relations: {},
  bag: { items: {}, equipped: { weapon: '太初·断界' }, equippedAttr: { weapon: createTaichuAttr({ atk: 2400 }) }, artifacts: {} } })
const fixture = () => {
  const a = person('甲', 100), b = person('乙', 20)
  return { gid: 'isolated', roster: { 甲: a, 乙: b }, sects: {}, sectMap: {}, major: [], minor: [], byPerson: {}, trades: [] }
}
function enable (t) {
  const read = fs.readFileSync.bind(fs)
  t.mock.method(fs, 'readFileSync', (file, ...args) => String(file).replace(/\\/g, '/').endsWith('/config/taichu.json') ? '{"enabled":true}' : read(file, ...args))
}

test('默认关闭时NPC实际交战不扣太初耐久', t => {
  t.mock.method(Math, 'random', () => 0)
  const f = fixture()
  assert.equal(resolveNpcEncounter(f, [f.roster.甲], f.roster.乙, () => 100, NOW).ok, true)
  assert.equal(f.roster.甲.bag.equippedAttr.weapon.taichu.durability, 1000)
  assert.equal(f.roster.乙.bag.equippedAttr.weapon.taichu.durability, 1000)
})

test('胜负成立扣双方耐久，重复交战及回避不重复扣', t => {
  enable(t); t.mock.method(Math, 'random', () => 0)
  const f = fixture(), a = f.roster.甲, b = f.roster.乙
  const power = p => p.name === '甲' ? 200 : 100
  assert.equal(resolveNpcEncounter(f, [a], b, power, NOW).won, true)
  assert.equal(a.bag.equippedAttr.weapon.taichu.durability, 998)
  assert.equal(b.bag.equippedAttr.weapon.taichu.durability, 996)
  assert.equal(resolveNpcEncounter(f, [a], b, power, NOW).ok, false)
  assert.equal(a.bag.equippedAttr.weapon.taichu.durability, 998)
  const other = fixture()
  assert.equal(resolveNpcEncounter(other, [other.roster.甲], other.roster.乙, p => p.name === '甲' ? 1 : 100, NOW).reason, 'outmatched')
  assert.equal(other.roster.甲.bag.equippedAttr.weapon.taichu.durability, 1000)
})

test('战败方加重损耗，守方按普通损耗，耐久Ⅴ分数累计', t => {
  enable(t); t.mock.method(Math, 'random', () => 0.99)
  const f = fixture(), a = f.roster.甲, b = f.roster.乙
  a.bag.equippedAttr.weapon.taichu.enchants.durability = 5
  assert.equal(resolveNpcEncounter(f, [a], b, () => 100, NOW).won, false)
  assert.equal(a.bag.equippedAttr.weapon.taichu.durability, 1000)
  assert.ok(Math.abs(a.bag.equippedAttr.weapon.taichu.wearRemainder - 4 / 6) < 1e-8)
  assert.equal(b.bag.equippedAttr.weapon.taichu.durability, 998)
})

test('NPC冲突先扣耐久再搜刮，转移后不会恢复满耐久', t => {
  enable(t); t.mock.method(Math, 'random', () => 0)
  const f = fixture(), a = f.roster.甲, b = f.roster.乙
  const id = b.bag.equippedAttr.weapon.taichu.id
  const result = npcConflict(f, [a], b, NOW, { lethal: false })
  assert.equal(result.won, true)
  const entries = [...getBagEquipEntries(a.bag), ...Object.values(a.bag.equippedAttr).map(attr => ({ attr }))]
  assert.equal(entries.find(entry => entry.attr?.taichu?.id === id).attr.taichu.durability, 996)
  assert.equal(b.bag.equipped.weapon, '')
})

test('守卫洗劫与日常切磋都扣实际装备耐久，回执避免重复损耗', t => {
  enable(t); t.mock.method(Math, 'random', () => 0)
  const f = fixture()
  genFight(f, NOW)
  assert.equal(f.roster.甲.bag.equippedAttr.weapon.taichu.durability, 998)
  assert.equal(f.roster.乙.bag.equippedAttr.weapon.taichu.durability, 998)
  genFight(f, NOW)
  assert.equal(f.roster.甲.bag.equippedAttr.weapon.taichu.durability, 998)
  const raid = fixture(); delete raid.roster.乙
  assert.ok(genVaultRob(raid, NOW))
  assert.equal(raid.roster.甲.bag.equippedAttr.weapon.taichu.durability, 998)
  genVaultRob(raid, NOW)
  assert.equal(raid.roster.甲.bag.equippedAttr.weapon.taichu.durability, 998)
  t.mock.method(Math, 'random', () => 0.99)
  const failed = fixture(); delete failed.roster.乙
  genVaultRob(failed, NOW)
  assert.equal(failed.roster.甲.bag.equippedAttr.weapon.taichu.durability, 996)
  assert.equal(failed.raidJail[0].name, '甲')
})
