import test from 'node:test'
import assert from 'node:assert/strict'
import { pillPerson, breakPerson, fakePillTargets, fakeSubThreshold, fakeCombatPill, fakeArtifactTick, fakeGoalTick, EVENT_GENS } from '../components/fake_data.js'
import { craftFakeEquipment, fakeEquipmentNeeds, FAKE_RED_ORES } from '../components/fake_equipment_crafting.js'
import { EQUIP_TPL, addItemToBag } from '../components/equip_data.js'
import { REALM_MAX_LEVEL } from '../components/realm_cap.js'

global.logger ||= { info () {}, warn () {}, error () {} }
let seq = 0
const count = (p, name) => Number(p.bag.items[name]?.count ?? p.bag.items[name]) || 0
const red = Object.keys(EQUIP_TPL).find(name => EQUIP_TPL[name].quality === 6 && EQUIP_TPL[name].type === 'helmet')
function person (name = '甲', level = 40) {
  return { name, alive: true, level, exp: fakeSubThreshold(level), accum: 0, money: 100000, luckTier: 1, loc: 'center', status: 'scatter',
    bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} }, activities: {} }
}
function world (...people) { return { gid: `consumption_${process.pid}_${++seq}`, roster: Object.fromEntries(people.map(p => [p.name, p])), sects: {}, players: {}, major: [], minor: [], byPerson: {}, bySect: {}, trades: [] } }
function give (p, name, count) { addItemToBag(p.bag, name, count, null, false) }

test('修为丹一次按需求批量吃，灵力守恒且同轮不能重复服用', () => {
  const p = person(), f = world(p), before = p.exp
  give(p, '修为丹', 300)
  const ev = pillPerson(f, p), taken = 300 - count(p, '修为丹')
  assert.ok(taken > 1 && taken <= 99); assert.match(ev.txt, new RegExp(`修为丹×${taken}`))
  assert.equal(p.exp + p.accum, before + taken * 200)
  assert.equal(pillPerson(f, p), null); assert.equal(count(p, '修为丹'), 300 - taken)
})
test('已到瓶颈不浪费修为丹，零库存和满级都不吃', () => {
  const p = person(), f = world(p)
  give(p, '修为丹', 30); p.exp = fakeSubThreshold(p.level + 1)
  assert.equal(pillPerson(f, p), null); assert.equal(count(p, '修为丹'), 30)
  p.level = REALM_MAX_LEVEL
  assert.deepEqual(fakePillTargets(p), { 修为丹: 0, 破障丹: 0 })
  assert.equal(pillPerson(f, p), null)
  const empty = person('乙'); empty.bag.items.修为丹 = { count: 0 }
  assert.equal(pillPerson(world(empty), empty), null)
})
test('累计池装不下整颗时停止，避免批量服丹消散灵力', () => {
  const p = person(), f = world(p)
  p.exp = fakeSubThreshold(p.level + 1) - 1; p.accum = 9999; give(p, '修为丹', 99)
  assert.equal(pillPerson(f, p), null); assert.equal(count(p, '修为丹'), 99)
})
test('连续突破每一重都消耗一颗破障丹', async t => {
  t.mock.method(Math, 'random', () => 0.5)
  const p = person('甲', 1), f = world(p)
  p.exp = fakeSubThreshold(6); give(p, '破障丹', 10)
  const ev = await breakPerson(f, p)
  assert.equal(p.level, 6); assert.equal(count(p, '破障丹'), 5)
  assert.match(ev.txt, /破障丹×5/)
})
test('突破失败即停止，只扣本次一颗，短时调息阻止同轮多入口反复冲关', async t => {
  t.mock.method(Math, 'random', () => 0.999)
  const p = person('甲', 1), f = world(p)
  p.exp = fakeSubThreshold(6); give(p, '破障丹', 10)
  assert.equal((await breakPerson(f, p)).type, 'backfire')
  assert.equal(p.level, 1); assert.equal(count(p, '破障丹'), 9)
  assert.equal(pillPerson(f, p), null); assert.equal(await breakPerson(f, p), null)
  assert.equal(count(p, '破障丹'), 9)
})
test('自然突破率更高时不吃丹降成功率，也不采购破障丹', async t => {
  t.mock.method(Math, 'random', () => 0.999)
  const p = person('甲', 1), f = world(p)
  p.status = 'sect'; p.sect = 's'; f.sects.s = { facilities: { yanwu: 50 } }
  p.exp = fakeSubThreshold(2); give(p, '破障丹', 10)
  assert.equal(fakePillTargets(p, f).破障丹, 0)
  await breakPerson(f, p)
  assert.equal(p.level, 2); assert.equal(count(p, '破障丹'), 10)
})
for (const state of ['jail', 'travel', 'war']) test(`${state}状态不吃丹、不冲关、不打造彩装`, async () => {
  const p = person(), f = world(p)
  give(p, '修为丹', 99); give(p, '造梦神玉', 6); give(p, red, 1)
  if (state === 'jail') f.sectJails = { s: [{ name: p.name }] }
  if (state === 'travel') p.fakeTravel = { endAt: Date.now() + 600000 }
  if (state === 'war') f.sectAttacks = [{ id: 1, phase: 'fight', atkFakes: [p.name] }]
  assert.equal(pillPerson(f, p), null); assert.equal(await breakPerson(f, p), null)
  fakeArtifactTick(f)
  assert.equal(count(p, '修为丹'), 99); assert.equal(count(p, '造梦神玉'), 6); assert.equal(count(p, red), 1)
})
test('战斗丹药药效尚在时不反复吃、不覆盖', () => {
  const p = person(), f = world(p); give(p, '惊鸿丹', 5)
  assert.equal(fakeCombatPill(f, p), true)
  const buff = { ...p.pill }
  assert.equal(fakeCombatPill(f, p), false); assert.equal(count(p, '惊鸿丹'), 4); assert.deepEqual(p.pill, buff)
})
test('仆从仍可在家按原规则服丹修炼和突破', async t => {
  t.mock.method(Math, 'random', () => 0)
  const p = person('甲', 1), f = world(p); p.servantOf = '主人'
  give(p, '修为丹', 20); give(p, '破障丹', 20)
  assert.ok(pillPerson(f, p)); assert.ok(await breakPerson(f, p)); assert.ok(p.level > 1)
})
test('彩装严格消耗6造梦神玉及1件背包红装，成品随机并自动择优穿戴', t => {
  t.mock.method(Math, 'random', () => 0)
  const p = person(); give(p, '造梦神玉', 6); give(p, red, 1)
  const results = craftFakeEquipment(p)
  assert.equal(results.length, 1); assert.equal(results[0].quality, 7)
  assert.equal(EQUIP_TPL[results[0].name].quality, 7)
  assert.equal(count(p, '造梦神玉'), 0); assert.equal(count(p, red), 0)
  assert.equal(p.bag.equipped.weapon, results[0].name)
})
test('红装胚子可自行按五种矿物配方炼成，再用于彩装', t => {
  t.mock.method(Math, 'random', () => 0)
  const p = person(); give(p, '造梦神玉', 6)
  for (const ore of FAKE_RED_ORES) give(p, ore, 1)
  const results = craftFakeEquipment(p)
  assert.deepEqual(results.map(x => x.quality), [6, 7])
  for (const ore of FAKE_RED_ORES) assert.equal(count(p, ore), 0)
  assert.equal(count(p, '造梦神玉'), 0)
})
test('同名红装优先消耗弱属性组，保留强属性组用于穿戴', t => {
  t.mock.method(Math, 'random', () => 0)
  const p = person(); give(p, '造梦神玉', 6)
  const strong = { def: 260, hp: 1000 }, weak = { def: 100, hp: 400 }
  addItemToBag(p.bag, red, 1, strong, false); addItemToBag(p.bag, red, 1, weak, false)
  craftFakeEquipment(p)
  assert.equal(p.bag.equipped.helmet, red); assert.deepEqual(p.bag.equippedAttr.helmet, strong)
  assert.equal(count(p, red), 0)
})
test('缺一种材料不扣其它材料，穿戴中的红装不拿去做耗材', () => {
  const p = person(); give(p, '造梦神玉', 5); give(p, red, 1)
  const before = structuredClone(p.bag)
  assert.deepEqual(craftFakeEquipment(p), []); assert.deepEqual(p.bag, before)
  give(p, '造梦神玉', 1); delete p.bag.items[red]
  p.bag.equipped.helmet = red; p.bag.equippedAttr.helmet = { def: 150, hp: 600 }
  assert.deepEqual(craftFakeEquipment(p), []); assert.equal(p.bag.equipped.helmet, red)
  assert.equal(count(p, '造梦神玉'), 6)
})
test('太初目标预留的胚子不被彩装打造消耗，已有全套彩装后停止筹料', () => {
  const p = person(); give(p, '造梦神玉', 6); give(p, red, 1)
  assert.deepEqual(craftFakeEquipment(p, Date.now(), { [red]: 1 }), [])
  assert.equal(count(p, red), 1)
  for (const [name, tpl] of Object.entries(EQUIP_TPL)) if (tpl.quality === 7) p.bag.equipped[tpl.type] = name
  assert.deepEqual(fakeEquipmentNeeds(p), {}); assert.deepEqual(craftFakeEquipment(p), [])
})
test('彩装优先于法宝中间物消耗红胚，不能由法宝抢走本轮彩装材料', t => {
  t.mock.method(Math, 'random', () => 0)
  const p = person(); give(p, '造梦神玉', 6); give(p, '霓裳剑', 1); give(p, '云裳仙蕊', 6)
  fakeArtifactTick(world(p))
  assert.equal(count(p, '造梦神玉'), 0); assert.equal(count(p, '云裳仙蕊'), 6)
  assert.equal(count(p, '成长性特殊彩武'), 0)
  assert.ok(Object.values(p.bag.equipped).some(name => EQUIP_TPL[name]?.quality === 7))
})
test('求购优先补齐彩装材料，卖方留足自己6个，后续不会相互倒卖', t => {
  t.mock.method(Math, 'random', () => 0)
  const a = person('甲'), b = person('乙'), now = Date.now(), f = world(a, b)
  give(a, '造梦神玉', 4); give(b, '造梦神玉', 8); give(a, '魂石', 8); give(b, '魂石', 8)
  a.fakeTradeThreshold = 0; b.fakeGoalAt = now + 86400000
  fakeGoalTick(f, f.gid, now)
  assert.equal(count(a, '造梦神玉'), 6); assert.equal(count(b, '造梦神玉'), 6)
  assert.match(f.trades[0].txt, /造梦神玉×2/)
  assert.equal(f.trades.length, 1)
})
test('旧剧情采购入口已移除，炼丹必须凑齐真实药材配方', t => {
  t.mock.method(Math, 'random', () => 0)
  assert.ok(!EVENT_GENS.some(fn => fn.name === 'genShop'))
  const craft = EVENT_GENS.find(fn => fn.name === 'genCraft'), p = person(), f = world(p)
  give(p, '月魄石', 1)
  assert.equal(craft(f, Date.now()), null); assert.equal(count(p, '月魄石'), 1)
  give(p, '望舒花', 1); give(p, '星霜草', 2)
  assert.match(craft(f, Date.now()).txt, /惊鸿丹/)
  assert.equal(count(p, '惊鸿丹'), 1); assert.equal(count(p, '望舒花'), 0); assert.equal(count(p, '星霜草'), 0)
})
