import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as equip from '../components/equip_data.js'
import { fakeArtifactTick, fakeGoalTick, fakeRareTick, FAKE_RARE_POOL, fakeTradePrice, fakeBasePrice } from '../components/fake_data.js'
import { ARRAY_CORE, ARRAY_CORE_RECIPE, ARRAY_CORE_COST } from '../components/equip_data.js'
import { PUPPET_INITIAL_COST } from '../components/puppet_data.js'

const NOW = +new Date(2026, 10, 13, 12)
const MINUTE = 60000
const rawNames = ARRAY_CORE_RECIPE.map(x => x.name)
let sequence = 0
const count = (p, name) => Number(p.bag.items[name]?.count ?? p.bag.items[name]) || 0
const raw = amount => Object.fromEntries(rawNames.map(name => [name, amount]))
const wait = { fakeGoalAt: NOW + 24 * 60 * MINUTE }
function person (name, items = {}, extra = {}) {
  return {
    name, alive: true, status: 'scatter', loc: 'west', level: 1, money: 2000000,
    fakeGoal: '傀儡', fakeTradeThreshold: 0,
    bag: {
      items: Object.fromEntries(Object.entries({ 魂石: 8, 修为丹: 1, ...items }).map(([key, value]) => [key, { count: value }])),
      equipped: {}, equippedAttr: {},
      artifacts: { dingxianyou: { owned: true, equipped: false }, wanhun: { rank: 1, equipped: false } }
    },
    ...extra
  }
}
function fixture (...people) {
  return {
    gid: `fake_array_core_${process.pid}_${++sequence}`, roster: Object.fromEntries(people.map(p => [p.name, p])),
    sects: {}, sectMap: {}, players: {}, major: [], minor: [], byPerson: {}, bySect: {}, trades: [], fakeCaves: []
  }
}
function assertRaw (p, amount) {
  for (const name of rawNames) assert.equal(count(p, name), amount, name)
}

// 沿用购买测试的最小VM方式，执行真实私有事件及背包操作，仅固定参与者和随机分支。
const eventSource = fs.readFileSync(new URL('../components/fake_data.js', import.meta.url), 'utf8')
function eventCode (name) {
  const match = eventSource.match(new RegExp(`^function ${name} \\([\\s\\S]*?^\\}`, 'm'))
  assert.ok(match, `缺少真实事件函数${name}`)
  return match[0]
}
function privateEvent (name) {
  const bagCode = eventSource.slice(eventSource.indexOf('function ensureFakeBag ('), eventSource.indexOf('const DIR =')).replace(/export /g, '')
  const goalStart = eventSource.indexOf('const FAKE_ARTIFACT_GOALS =')
  const goalsCode = eventSource.slice(goalStart, eventSource.indexOf('/** 法宝目标材料不主动甩卖', goalStart))
  const needCode = ['fakeGoalOf', 'fakeMissingCoreCount', 'fakeArtifactNeeds', 'fakeNeedCount', 'fakeSocialPair'].map(eventCode).join('\n')
  return vm.runInNewContext(`${bagCode}\n${goalsCode}\n${needCode}\n${eventCode(name)}\n;${name}`, {
    ...equip, PUPPET_INITIAL_COST,
    DEFAULT_REGION: 'center', npcCanAct: (f, p) => !!p?.alive,
    Math: Object.assign(Object.create(Math), { random: () => name === 'genTeacherDisciple' ? 0.99 : 0 }),
    pick: values => values[0],
    pickAlive: (f, except) => Object.values(f.roster).find(p => p.alive && p.name !== except),
    pickBy: (f, predicate) => Object.values(f.roster).find(p => p.alive && predicate(p)),
    relPoolOf: () => [], relLabelOf: () => '故人', sectName: () => '测试宗门',
    evWho: people => ({ who: people.map(p => p.name) }), evMeta: p => ({ who: [p.name] }),
    fakeTaichuMaterialNeeds: () => ({})
  })
}

test('万阵核心沿用玩家四材各1和30万配方，NPC奇遇仅保留原材', t => {
  assert.equal(ARRAY_CORE_COST, 300000)
  assert.equal(ARRAY_CORE_RECIPE.length, 4)
  assert.ok(ARRAY_CORE_RECIPE.every(x => x.count === 1))
  assert.ok(!FAKE_RARE_POOL.some(x => x.name === ARRAY_CORE))
  const total = FAKE_RARE_POOL.reduce((sum, entry) => sum + entry.weight, 0)
  for (const name of rawNames) {
    const index = FAKE_RARE_POOL.findIndex(x => x.name === name)
    assert.ok(index >= 0, name)
    const before = FAKE_RARE_POOL.slice(0, index).reduce((sum, entry) => sum + entry.weight, 0)
    const queue = [0, 0, (before + FAKE_RARE_POOL[index].weight / 2) / total]
    t.mock.method(Math, 'random', () => queue.shift() ?? 0)
    const p = person('奇遇者')
    const f = fixture(p)
    f.fakeRareAt = NOW - 1
    fakeRareTick(f, NOW)
    assert.equal(count(p, name), 1)
    assert.equal(count(p, ARRAY_CORE), 0)
  }
})

test('没有真实原材时，钱包与旧鬼市库存都不能凭空产生核心', t => {
  t.mock.method(Math, 'random', () => 0)
  const p = person('缺原材')
  const f = fixture(p)
  f.fakeGhostStock = { nextAt: NOW + 3600000, stock: { 万阵核心: 10, ...raw(10) } }
  fakeGoalTick(f, f.gid, NOW)
  fakeArtifactTick(f, NOW)
  assert.equal(count(p, ARRAY_CORE), 0)
  assertRaw(p, 0)
  assert.equal(p.money, 2000000)
  assert.equal(p.bag.artifacts.puppets?.length || 0, 0)
  assert.equal(f.trades.length, 0)
})

test('某种阵材只有傀儡预留4件时，不能扣其它原材或灵石合成核心', () => {
  const p = person('缺一材', { ...raw(9), [rawNames[0]]: 4 })
  const before = structuredClone(p.bag.items)
  fakeArtifactTick(fixture(p), NOW)
  assert.deepEqual(p.bag.items, before)
  assert.equal(count(p, ARRAY_CORE), 0)
  assert.equal(p.money, 2000000)
})

test('不足单核费用或不足保留50万后的单核费用，均不扣钱扣料', () => {
  for (const money of [ARRAY_CORE_COST - 1, PUPPET_INITIAL_COST.money + ARRAY_CORE_COST - 1]) {
    const p = person('缺灵石', raw(9), { money })
    const before = structuredClone(p.bag.items)
    fakeArtifactTick(fixture(p), NOW)
    assert.equal(p.money, money)
    assert.deepEqual(p.bag.items, before)
    assert.equal(count(p, ARRAY_CORE), 0)
  }
})

test('合成五枚核心逐枚扣30万和各1阵材，保留傀儡50万与四材各4', () => {
  const p = person('制核心', raw(9))
  const f = fixture(p)
  fakeArtifactTick(f, NOW)
  assert.equal(count(p, ARRAY_CORE), 5)
  assertRaw(p, 4)
  assert.equal(p.money, 500000)
  assert.equal(p.bag.artifacts.puppets, undefined, '傀儡其它材料未齐，不得直接造出傀儡')
  fakeArtifactTick(f, NOW + MINUTE)
  assert.equal(count(p, ARRAY_CORE), 5)
  assertRaw(p, 4)
  assert.equal(p.money, 500000, '核心已够，不继续合成或重复扣钱')
})

test('原材或钱包仅支持两枚时只做两枚，剩余资产保留', () => {
  for (const [materials, money] of [[6, 2000000], [10, 1100000]]) {
    const p = person('逐核合成', raw(materials), { money })
    fakeArtifactTick(fixture(p), NOW)
    assert.equal(count(p, ARRAY_CORE), 2)
    assertRaw(p, materials - 2)
    assert.equal(p.money, money - 2 * ARRAY_CORE_COST)
    assert.equal(p.bag.artifacts.puppets, undefined)
  }
})

test('已有三枚核心时只再做两枚；已有五枚时不多造', () => {
  const p = person('已有三枚', { ...raw(6), [ARRAY_CORE]: 3 }, { money: 1100000 })
  fakeArtifactTick(fixture(p), NOW)
  assert.equal(count(p, ARRAY_CORE), 5)
  assertRaw(p, 4)
  assert.equal(p.money, 500000)
  const ready = person('已有五枚', { ...raw(9), [ARRAY_CORE]: 5 })
  fakeArtifactTick(fixture(ready), NOW)
  assert.equal(count(ready, ARRAY_CORE), 5)
  assertRaw(ready, 9)
  assert.equal(ready.money, 2000000)
})

test('全套原材各9及200万可先合五核再按原配方造一阶傀儡', t => {
  t.mock.method(Math, 'random', () => 0)
  assert.equal(PUPPET_INITIAL_COST.money, 500000)
  assert.equal(PUPPET_INITIAL_COST.materials[ARRAY_CORE], 5)
  const items = { ...PUPPET_INITIAL_COST.materials, ...raw(9), [ARRAY_CORE]: 0 }
  const p = person('炼傀儡', items)
  const f = fixture(p)
  fakeArtifactTick(f, NOW)
  assert.equal(p.bag.artifacts.puppets?.length, 1)
  assert.equal(p.bag.artifacts.puppets[0].rank, 1)
  assert.ok(p.bag.artifacts.puppets[0].nextChargeAt > NOW)
  assert.equal(p.money, 0)
  for (const name of Object.keys(PUPPET_INITIAL_COST.materials)) assert.equal(count(p, name), 0, name)
  fakeArtifactTick(f, NOW + MINUTE)
  assert.equal(p.bag.artifacts.puppets.length, 1)
  assert.equal(p.money, 0)
})

test('旧存档已有核心可直接用于原配方，盈余核心仍保留', t => {
  t.mock.method(Math, 'random', () => 0)
  const p = person('用旧核心', { ...PUPPET_INITIAL_COST.materials, [ARRAY_CORE]: 7 }, { money: 500000 })
  fakeArtifactTick(fixture(p), NOW)
  assert.equal(p.bag.artifacts.puppets?.length, 1)
  assert.equal(count(p, ARRAY_CORE), 2)
  assertRaw(p, 0)
  assert.equal(p.money, 0)
})

test('两名缺核者的四材各9属于刚需，不互相倒卖合核原材', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('缺一材', { ...PUPPET_INITIAL_COST.materials, ...raw(9), [ARRAY_CORE]: 0, [rawNames[0]]: 8 }, { money: 4000000 })
  const seller = person('自己要合核', { ...PUPPET_INITIAL_COST.materials, ...raw(9), [ARRAY_CORE]: 0 }, wait)
  const f = fixture(buyer, seller)
  for (let i = 0; i < 4; i++) fakeGoalTick(f, f.gid, NOW + i * 7 * MINUTE)
  assert.equal(count(buyer, rawNames[0]), 8)
  assertRaw(seller, 9)
  assert.equal(f.trades.length, 0)
})

test('原材卖家只卖各9之外的真实盈余，买方按报价补足一件', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('购原材', { ...PUPPET_INITIAL_COST.materials, ...raw(9), [ARRAY_CORE]: 0, [rawNames[0]]: 8 }, { money: 4000000 })
  const seller = person('原材有余', { ...PUPPET_INITIAL_COST.materials, ...raw(9), [ARRAY_CORE]: 0, [rawNames[0]]: 10 }, wait)
  const f = fixture(buyer, seller)
  const price = fakeTradePrice(f, rawNames[0], fakeBasePrice(rawNames[0]))
  fakeGoalTick(f, f.gid, NOW)
  assertRaw(buyer, 9)
  assertRaw(seller, 9)
  assert.equal(buyer.money, 4000000 - price)
  assert.equal(f.trades.length, 1)
  assert.ok(f.trades[0].txt.includes(`${rawNames[0]}×1`))
})

test('已有三核的卖家仅需各6阵材，超出部分可卖给缺料者', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('购一材', { ...PUPPET_INITIAL_COST.materials, ...raw(9), [ARRAY_CORE]: 0, [rawNames[0]]: 8 }, { money: 4000000 })
  const seller = person('已有三核', { ...PUPPET_INITIAL_COST.materials, ...raw(6), [ARRAY_CORE]: 3, [rawNames[0]]: 7 }, wait)
  const f = fixture(buyer, seller)
  fakeGoalTick(f, f.gid, NOW)
  assertRaw(buyer, 9)
  assertRaw(seller, 6)
  assert.equal(count(seller, ARRAY_CORE), 3)
  assert.equal(f.trades.length, 1)
})

test('成品核心有卖家也不直接购买，缺核者通过自己的原材合成', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('自己合核', { ...PUPPET_INITIAL_COST.materials, ...raw(9), [ARRAY_CORE]: 0 })
  const seller = person('核心有余', { ...PUPPET_INITIAL_COST.materials, [ARRAY_CORE]: 10 }, wait)
  seller.bag.artifacts.puppets = [{ rank: 1, power: 400, deployed: false, equipped: false }]
  const f = fixture(buyer, seller)
  fakeGoalTick(f, f.gid, NOW)
  assert.equal(count(buyer, ARRAY_CORE), 0)
  assert.equal(count(seller, ARRAY_CORE), 10)
  assert.equal(f.trades.length, 0)
  assert.equal(buyer.money, 2000000)
  fakeArtifactTick(f, NOW)
  assert.equal(buyer.bag.artifacts.puppets?.length, 1)
  assert.equal(count(seller, ARRAY_CORE), 10)
})

test('合核资金计入总预算，不足200万时变卖闲置物品并保留九份原材', t => {
  t.mock.method(Math, 'random', () => 0)
  const saver = person('筹合核钱', { ...PUPPET_INITIAL_COST.materials, ...raw(9), [ARRAY_CORE]: 0 }, { money: 1000000 })
  const buyer = person('买闲置物', {}, { ...wait, money: 5000000 })
  const f = fixture(saver, buyer)
  fakeGoalTick(f, f.gid, NOW)
  assert.ok(saver.money > 1000000, '50万傀儡费之外还需筹齐缺少五核的150万')
  assertRaw(saver, 9)
  assert.equal(count(saver, ARRAY_CORE), 0)
  assert.equal(f.trades.length, 1)
  assert.ok(!rawNames.some(name => f.trades[0].txt.includes(`【${name}】`)))
})

for (const [eventName, label] of [['genGift', '赠礼'], ['genTeacherDisciple', '弟子孝敬'], ['genLoot', '夺宝']]) {
  test(`${label}不会转移万阵核心，普通物品仍可正常流转`, () => {
    const run = privateEvent(eventName)
    for (const ordinary of [false, true]) {
      const donor = person('持有者', {}, { path: '正道', relations: {} })
      const receiver = person('接收者', {}, { path: '魔道', level: 40, relations: {} })
      donor.bag.items = { [ARRAY_CORE]: { count: 2 }, ...(ordinary ? { 修为丹: { count: 2 } } : {}) }
      receiver.bag.items = {}
      if (eventName === 'genTeacherDisciple') {
        donor.relations.master = receiver.name
        receiver.relations.disciples = [donor.name]
      }
      const f = fixture(donor, receiver)
      const result = run(f, NOW)
      assert.equal(count(donor, ARRAY_CORE), 2)
      assert.equal(count(receiver, ARRAY_CORE), 0)
      if (ordinary) {
        assert.ok(result?.txt.includes('修为丹'))
        assert.equal(count(donor, '修为丹'), 1)
        assert.equal(count(receiver, '修为丹'), 1)
      } else {
        assert.equal(result, null)
        assert.equal(donor.money, 2000000)
        assert.equal(receiver.money, 2000000)
      }
    }
  })
}

test('变卖事件保留成品核心、合核九份原材和绑定功法，只卖真实闲置物', () => {
  const sell = privateEvent('genSell')
  const coreHolder = person('有余核心')
  coreHolder.bag.items = { [ARRAY_CORE]: { count: 7 } }
  assert.equal(sell(fixture(coreHolder), NOW), null)
  assert.equal(count(coreHolder, ARRAY_CORE), 7)
  assert.equal(coreHolder.money, 2000000)
  const crafter = person('九份原材', { ...raw(9), 傀儡术下篇: 1 })
  delete crafter.bag.items.魂石
  delete crafter.bag.items.修为丹
  const f = fixture(crafter)
  assert.equal(sell(f, NOW), null)
  assertRaw(crafter, 9)
  assert.equal(count(crafter, '傀儡术下篇'), 1)
  crafter.bag.items.修为丹 = { count: 2 }
  const result = sell(f, NOW)
  assert.ok(result?.txt.includes('修为丹'))
  assert.equal(count(crafter, '修为丹'), 1)
  assert.ok(crafter.money > 2000000)
  assertRaw(crafter, 9)
  assert.equal(count(crafter, '傀儡术下篇'), 1)
})
