import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as equip from '../components/equip_data.js'
import { gongfaScore, fakeSubThreshold, fakeLearnBestGongfa, runBestGongfa } from '../components/fake_data.js'

// 执行真实购买逻辑，仅将商店、世界存档、事件等外部服务替换为内存实现。
const source = fs.readFileSync(new URL('../components/fake_data.js', import.meta.url), 'utf8')
const bagCode = source.slice(source.indexOf('function ensureFakeBag ('), source.indexOf('const DIR ='))
const buyerCode = source.slice(source.indexOf('/* 购物冷却到期后重评真实需求'), source.indexOf('/** 突破时自动买破障丹'))
function makeBuyer (stocks, random = 0.99) {
  const purchases = []
  let available = true
  const context = vm.createContext({
    ...equip, gongfaScore, fakeSubThreshold, fakeLearnBestGongfa, runBestGongfa,
    rand: ([min]) => min,
    Math: Object.assign(Object.create(Math), { random: () => random }),
    getStock: async (gid, shop, region) => stocks[shop] || {},
    buyStock: async (gid, shop, name, count, region) => {
      const stock = stocks[shop] || {}
      if (!available || !(stock[name] > 0)) return { ok: false, count: 0 }
      stock[name]--
      purchases.push({ shop, name, region })
      return { ok: true, count: 1 }
    },
    getWorld: () => ({}), taxFor: () => 10, addTax: () => {}, saveWorld: () => {},
    logTrade: () => {}, recordActive: async () => {}, evMeta: () => ({}),
    regionNameOf: name => name, sectName: () => '', SHOP_CN: {},
    SLOT_MAP: Object.fromEntries(['weapon', 'helmet', 'chest', 'pants', 'shoes', 'ring'].map(s => [s, s]))
  })
  vm.runInContext(`${bagCode.replace(/export /g, '')}\n${buyerCode.replaceAll('} catch (err) { return false }', '} catch (err) { throw err }')}\nglobalThis.buy = tryFakeBuy`, context)
  return { purchases, buy: p => context.buy({ gid: 'test', roster: {}, sects: {}, major: [], minor: [], byPerson: {}, bySect: {} }, 'test', p, Date.now()), soldOut: () => { available = false } }
}
function person (money = 1000) {
  return { name: '测试修士', alive: true, level: 1, exp: 0, money, loc: 'west', learnedGongfa: [], activeGongfa: '', bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} } }
}
function wear (p, names) {
  for (const name of names) equip.addItemToBag(p.bag, name, 1)
}
const basicGongfa = Object.keys(equip.GONGFA_TPL).find(n => equip.gongfaPrice(n) === 200 && gongfaScore(n) > 0)
const helm = Object.keys(equip.EQUIP_TPL).find(n => equip.EQUIP_TPL[n].type === 'helmet' && equip.EQUIP_TPL[n].quality === 1)

test('旧愿望金额过高仍可按实际售价买到基础武器，扣钱扣库存且立即穿戴', async () => {
  const p = person(500)
  p.wish = { type: 'weapon', part: 'weapon', tier: 5, price: 30000, at: 1 }
  const stocks = { qige: { 桃木剑: 1 } }
  const h = makeBuyer(stocks)
  assert.equal(await h.buy(p), true)
  assert.equal(p.money, 300)
  assert.equal(stocks.qige.桃木剑, 0)
  assert.equal(p.bag.equipped.weapon, '桃木剑')
  assert.equal(h.purchases[0].region, 'west')
  assert.equal(p.wish, null)
})

test('武器之后优先学战斗功法，不被其它五个空槽或已学傀儡术阻塞', async () => {
  const p = person(1000)
  wear(p, ['桃木剑'])
  p.learnedGongfa = ['傀儡术下篇']
  const h = makeBuyer({ qige: { [helm]: 1 }, cangbaoge: { [basicGongfa]: 1 } })
  assert.equal(await h.buy(p), true)
  assert.equal(h.purchases[0].name, basicGongfa)
  assert.equal(p.activeGongfa, basicGongfa)
  assert.ok(p.learnedGongfa.includes(basicGongfa))
  assert.equal(p.bag.items[basicGongfa], undefined)
  assert.equal(p.money, 800)
})

test('目标空槽没货只补其它空槽，不买已有武器；再次购物不重复购买', async () => {
  const p = person(2000)
  wear(p, ['桃木剑'])
  p.learnedGongfa = [basicGongfa]; p.activeGongfa = basicGongfa
  const stocks = { qige: { 桃木剑: 4, [helm]: 2 } }
  const h = makeBuyer(stocks)
  assert.equal(await h.buy(p), true)
  assert.equal(h.purchases[0].name, helm)
  const remaining = p.money
  assert.equal(await h.buy(p), false)
  assert.equal(p.money, remaining)
  assert.equal(h.purchases.length, 1)
  assert.equal(stocks.qige.桃木剑, 4)
})

test('武器和功法缺货仍可补其它空槽，后续补货会重评并补武器', async () => {
  const p = person(1000)
  const stocks = { qige: { [helm]: 1 }, cangbaoge: {} }
  const h = makeBuyer(stocks)
  assert.equal(await h.buy(p), true)
  assert.equal(h.purchases[0].name, helm)
  stocks.qige.桃木剑 = 1
  assert.equal(await h.buy(p), true)
  assert.equal(p.bag.equipped.weapon, '桃木剑')
})

test('背包中已有装备与战斗书先使用，不重复消费', async () => {
  const p = person(1000)
  equip.addItemToBag(p.bag, '桃木剑', 1, null, false)
  equip.addItemToBag(p.bag, basicGongfa, 1, null, false)
  const h = makeBuyer({ qige: { 桃木剑: 3 }, cangbaoge: { [basicGongfa]: 3 } })
  assert.equal(await h.buy(p), false)
  assert.equal(p.money, 1000)
  assert.equal(p.bag.equipped.weapon, '桃木剑')
  assert.equal(p.activeGongfa, basicGongfa)
  assert.equal(h.purchases.length, 0)
})

test('不买重复功法或生活功法；买不起和购买时售罄均不扣钱', async () => {
  const p = person(100)
  wear(p, ['桃木剑'])
  const h = makeBuyer({ cangbaoge: { [basicGongfa]: 1 } })
  assert.equal(await h.buy(p), false)
  assert.equal(p.money, 100)
  p.money = 1000
  h.soldOut()
  assert.equal(await h.buy(p), false)
  assert.equal(p.money, 1000)
  const life = Object.keys(equip.GONGFA_TPL).find(n => equip.gongfaPrice(n) > 0 && gongfaScore(n) === 0)
  const h2 = makeBuyer({ cangbaoge: { [life]: 2, [basicGongfa]: 2 } })
  p.learnedGongfa = [basicGongfa]; p.activeGongfa = basicGongfa
  assert.equal(await h2.buy(p), false)
  assert.equal(h2.purchases.length, 0)
})

test('武器即使有货也不购买实际属性不如当前装备的物品', async () => {
  const p = person(30000)
  wear(p, equip.STARTER_ITEMS)
  p.bag.equippedAttr.weapon = { atk: 500 }
  p.learnedGongfa = [basicGongfa]; p.activeGongfa = basicGongfa; p.trait = '好斗'
  const weapon = Object.keys(equip.EQUIP_TPL).find(n => equip.EQUIP_TPL[n].type === 'weapon' && equip.EQUIP_TPL[n].quality === 4)
  const h = makeBuyer({ qige: { [weapon]: 1 } })
  assert.equal(await h.buy(p), false)
  assert.equal(p.money, 30000)
  assert.equal(h.purchases.length, 0)
})

test('破障丹缺货不阻塞其它空槽，也不把丹药档位误用于装备预算', async () => {
  const p = person(5000)
  wear(p, ['桃木剑'])
  p.learnedGongfa = [basicGongfa]; p.activeGongfa = basicGongfa
  p.exp = fakeSubThreshold(p.level + 1)
  const blueHelm = Object.keys(equip.EQUIP_TPL).find(n => equip.EQUIP_TPL[n].type === 'helmet' && equip.EQUIP_TPL[n].quality === 3)
  const h = makeBuyer({ dange: {}, qige: { [blueHelm]: 1 } })
  assert.equal(await h.buy(p), true)
  assert.equal(h.purchases[0].name, blueHelm)
  assert.equal(p.money, 1000)
})
