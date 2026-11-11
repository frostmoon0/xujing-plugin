import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fakeGoalTick, fakeArtifactTick } from '../components/fake_data.js'
import { EQUIP_TPL } from '../components/equip_data.js'
import { Save_Path } from '../components/plugin.js'

const MINUTE = 60000
const NOW = +new Date(2026, 10, 10, 12)
const redWeapons = Object.keys(EQUIP_TPL).filter(n => EQUIP_TPL[n].quality === 6 && EQUIP_TPL[n].type === 'weapon')
const betterWeapon = Object.keys(EQUIP_TPL).find(n => EQUIP_TPL[n].quality === 7 && EQUIP_TPL[n].type === 'weapon')
let sequence = 0
const count = (p, name) => Number(p.bag.items[name]?.count ?? p.bag.items[name]) || 0
const redCount = p => redWeapons.reduce((sum, name) => sum + count(p, name), 0)

function person (name, items = {}, extra = {}) {
  return {
    name, alive: true, status: 'scatter', loc: 'west', level: 1, money: 100000,
    fakeGoal: '万魂幡', fakeTradeThreshold: 0,
    bag: {
      items: { 魂石: { count: 8 }, 修为丹: { count: 1 }, 万魂幡残卷: { count: 5 }, 阴魂砂: { count: 20 }, 游魂骨: { count: 20 },
        ...Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { count: value }])) },
      // 配方用红武器保留在背包，避免本用例被自动换装的独立行为干扰。
      equipped: { weapon: betterWeapon }, equippedAttr: { weapon: { atk: 100000 } }, artifacts: {}
    },
    ...extra
  }
}

function fixture (t, ...people) {
  const gid = `fake_trade_material_${process.pid}_${++sequence}`
  t.after(() => fs.rmSync(path.join(Save_Path, 'world', `world_${gid}.json`), { force: true }))
  return {
    gid, roster: Object.fromEntries(people.map(p => [p.name, p])), major: [], minor: [], byPerson: {}, bySect: {}, trades: [],
    fakeGhostStock: { nextAt: NOW + 24 * 60 * MINUTE, stock: {} }
  }
}

const wait = { fakeGoalAt: NOW + 24 * 60 * MINUTE }
const cloudTrades = f => f.trades.filter(x => x.txt.startsWith('【云裳仙蕊】'))

test('未铸成彩武的万魂幡目标保留自己需要的6云裳，不卖给另一名缺料者', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('买方', { 云裳仙蕊: 5 })
  const seller = person('卖方', { 云裳仙蕊: 6 }, wait)
  const f = fixture(t, buyer, seller)
  fakeGoalTick(f, f.gid, NOW)
  assert.equal(count(buyer, '云裳仙蕊'), 5)
  assert.equal(count(seller, '云裳仙蕊'), 6)
  assert.equal(cloudTrades(f).length, 0)
})

test('云裳按6减已有数一次补齐，卖方仅出售自己6件之外的盈余', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('买方', { 云裳仙蕊: 2 })
  const seller = person('卖方', { 云裳仙蕊: 10 }, wait)
  const f = fixture(t, buyer, seller)
  fakeGoalTick(f, f.gid, NOW)
  assert.equal(count(buyer, '云裳仙蕊'), 6)
  assert.equal(count(seller, '云裳仙蕊'), 6)
  assert.equal(cloudTrades(f).length, 1)
  assert.match(cloudTrades(f)[0].txt, /云裳仙蕊×4/)
  assert.equal(buyer.money, 100000 - 400 * 4)
})

test('卖方余货不足一次补齐缺口时，不再以单件在人群中倒手', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('买方', { 云裳仙蕊: 2 })
  const seller = person('卖方', { 云裳仙蕊: 7 }, wait)
  const f = fixture(t, buyer, seller)
  fakeGoalTick(f, f.gid, NOW)
  assert.equal(count(buyer, '云裳仙蕊'), 2)
  assert.equal(count(seller, '云裳仙蕊'), 7)
  assert.equal(cloudTrades(f).length, 0)
})

test('同批与多轮推进时，两名未凑齐6云裳的人不会互相买回同一批材料', t => {
  t.mock.method(Math, 'random', () => 0)
  const a = person('甲', { 云裳仙蕊: 1 })
  const b = person('乙', { 云裳仙蕊: 3 })
  const f = fixture(t, a, b)
  for (let round = 0; round < 8; round++) fakeGoalTick(f, f.gid, NOW + round * 7 * MINUTE)
  assert.equal(cloudTrades(f).length, 0)
  assert.equal(count(a, '云裳仙蕊'), 1)
  assert.equal(count(b, '云裳仙蕊'), 3)
  assert.equal(a.money, 100000)
  assert.equal(b.money, 100000)
})

test('已持有成长性特殊彩武的卖方无需再保留6云裳，可供另一人补齐', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('买方', { 云裳仙蕊: 2 })
  const seller = person('卖方', { 云裳仙蕊: 4, 成长性特殊彩武: 1 }, wait)
  const f = fixture(t, buyer, seller)
  fakeGoalTick(f, f.gid, NOW)
  assert.equal(count(buyer, '云裳仙蕊'), 6)
  assert.equal(count(seller, '云裳仙蕊'), 0)
  assert.equal(count(seller, '成长性特殊彩武'), 1)
  assert.match(cloudTrades(f)[0]?.txt || '', /云裳仙蕊×4/)
})

test('未有彩武的万魂幡目标保留仅有的1件红武器', t => {
  t.mock.method(Math, 'random', () => 0)
  assert.ok(redWeapons.length >= 2)
  const buyer = person('买方', { 云裳仙蕊: 6 })
  const seller = person('卖方', { 云裳仙蕊: 6, [redWeapons[0]]: 1 }, wait)
  const f = fixture(t, buyer, seller)
  fakeGoalTick(f, f.gid, NOW)
  assert.equal(redCount(buyer), 0)
  assert.equal(redCount(seller), 1)
  assert.equal(f.trades.length, 0)
})

test('求购红武器选择卖方实际有盈余的品种，不随机指定缺货名称', t => {
  t.mock.method(Math, 'random', () => 0)
  const actual = redWeapons[1]
  const buyer = person('买方', { 云裳仙蕊: 6 })
  buyer.bag.equipped = {}
  buyer.bag.equippedAttr = {}
  const seller = person('卖方', { 云裳仙蕊: 6, [actual]: 2 }, wait)
  const f = fixture(t, buyer, seller)
  fakeGoalTick(f, f.gid, NOW)
  assert.equal(count(buyer, actual), 1)
  assert.equal(count(seller, actual), 1)
  assert.equal(f.trades.length, 1)
  assert.ok(f.trades[0].txt.includes(`${actual}×1`))
  assert.ok(!buyer.bag.equipped.weapon, '购作配方材料的红武器应留在包中')
  fakeArtifactTick(f, NOW)
  assert.ok(buyer.bag.artifacts.wanhun, '新买的红武器应能直接用于铸武并炼幡')
  assert.equal(count(buyer, actual), 0)
})

test('红武器跨品种合计保留1件，多出的另一个品种仍可出售', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('买方', { 云裳仙蕊: 6 })
  const seller = person('卖方', { 云裳仙蕊: 6, [redWeapons[0]]: 1, [redWeapons[1]]: 1 }, wait)
  const f = fixture(t, buyer, seller)
  fakeGoalTick(f, f.gid, NOW)
  assert.equal(redCount(buyer), 1)
  assert.equal(redCount(seller), 1)
  assert.equal(f.trades.length, 1)
})

test('没有玩家卖家时，鬼市买入的配方红武器留包并能直接用于铸武炼幡', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('鬼市买方', { 云裳仙蕊: 6 })
  buyer.bag.equipped = {}
  buyer.bag.equippedAttr = {}
  const f = fixture(t, buyer)
  f.fakeGhostStock.stock.红武器 = 1
  fakeGoalTick(f, f.gid, NOW)
  assert.equal(redCount(buyer), 1)
  assert.ok(!buyer.bag.equipped.weapon)
  assert.equal(f.fakeGhostStock.stock.红武器, undefined)
  assert.equal(buyer.money, 100000 - 800)
  fakeArtifactTick(f, NOW)
  assert.ok(buyer.bag.artifacts.wanhun)
  assert.equal(redCount(buyer), 0)
  assert.equal(count(buyer, '云裳仙蕊'), 0)
})

test('按真实缺口买齐云裳后，可实际铸成彩武并进一步炼成万魂幡', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('买方', { 云裳仙蕊: 2, [redWeapons[0]]: 1 })
  const seller = person('卖方', { 云裳仙蕊: 10 }, wait)
  const f = fixture(t, buyer, seller)
  fakeGoalTick(f, f.gid, NOW)
  fakeArtifactTick(f, NOW)
  assert.ok(buyer.bag.artifacts.wanhun)
  assert.equal(count(buyer, '成长性特殊彩武'), 0)
  assert.equal(count(buyer, '云裳仙蕊'), 0)
  assert.equal(redCount(buyer), 0)
  assert.equal(count(buyer, '万魂幡残卷'), 0)
  assert.equal(count(buyer, '阴魂砂'), 0)
  assert.equal(count(buyer, '游魂骨'), 0)
  assert.equal(count(seller, '云裳仙蕊'), 6)
})

test('已有万魂幡后不再消耗6云裳与红武器重复铸造中间彩武', t => {
  t.mock.method(Math, 'random', () => 0)
  const p = person('已有幡', { 云裳仙蕊: 6, [redWeapons[0]]: 1 })
  p.bag.artifacts.wanhun = { rank: 1, equipped: true }
  const f = fixture(t, p)
  fakeArtifactTick(f, NOW)
  assert.equal(count(p, '云裳仙蕊'), 6)
  assert.equal(redCount(p), 1)
  assert.equal(count(p, '成长性特殊彩武'), 0)
})

test('魔窟商人补货也不能买走另一人预留的6云裳', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('买方', { 魂石: 0 })
  const seller = person('卖方', { 云裳仙蕊: 6 }, wait)
  const f = fixture(t, buyer, seller)
  const slot = { name: '云裳仙蕊', kind: 'material', count: 3, reward: '魂石', used: false }
  f.fakeMerchantShops = { 买方: { refreshAt: NOW + 24 * 60 * MINUTE, demands: [slot] } }
  fakeGoalTick(f, f.gid, NOW)
  assert.equal(count(seller, '云裳仙蕊'), 6)
  assert.equal(count(buyer, '魂石'), 0)
  assert.equal(slot.used, false)
  assert.equal(cloudTrades(f).length, 0)
})

test('魔窟商人按现有材料后的真实缺口一次购齐，并保留卖方所需6云裳', t => {
  t.mock.method(Math, 'random', () => 0)
  const buyer = person('买方', { 魂石: 0, 云裳仙蕊: 1 })
  const seller = person('卖方', { 云裳仙蕊: 8 }, wait)
  const f = fixture(t, buyer, seller)
  const slot = { name: '云裳仙蕊', kind: 'material', count: 3, reward: '魂石', used: false }
  f.fakeMerchantShops = { 买方: { refreshAt: NOW + 24 * 60 * MINUTE, demands: [slot] } }
  fakeGoalTick(f, f.gid, NOW)
  assert.equal(count(seller, '云裳仙蕊'), 6)
  assert.equal(count(buyer, '云裳仙蕊'), 0)
  assert.equal(count(buyer, '魂石'), 1)
  assert.equal(slot.used, true)
  assert.equal(cloudTrades(f).length, 1)
  assert.match(cloudTrades(f)[0].txt, /云裳仙蕊×2/)
})
