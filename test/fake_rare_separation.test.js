import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Save_Path } from '../components/plugin.js'
import { SPECIAL_MAX, rollReward } from '../components/realm_data.js'
import { FAKE_ARTIFACT_BLACKLIST, fakeCanUseArtifact, fakeMarketIndex, fakeTradePrice, fakeItemSupply, fakeArtifactTick, fakeBasePrice, fakeCaveTick, fakeGoalTick, fakeMerchantShop, fakeTravelTo, fakeTravelTick, personPower, pruneFakeMerchantShops, fakeGhostStock, fakeMartBuy, repairFakeEquipment, inheritFakeAssets, genFate, gongfaScore, runBestGongfa, fakeLearnBestGongfa, fakeSellJunkGongfa } from '../components/fake_data.js'
import { EQUIP_TPL } from '../components/equip_data.js'

test('伪玩家特殊彩名额与玩家完全独立', () => {
  const st = {
    region: 'center', terrain: 'dongtian', diff: 'tian',
    specialPending: true, specialGranted: SPECIAL_MAX,
    fakeSpecialPending: true, fakeSpecialGranted: 0
  }
  /* 玩家彩名额已满: 伪玩家仍可吃自己的独立名额 */
  rollReward(st, 'tian', () => 0, { special: true, fake: true })
  assert.equal(st.specialGranted, SPECIAL_MAX, '玩家名额不能被伪玩家消耗')
  assert.equal(st.fakeSpecialGranted, 1, '伪玩家应消耗自己的名额')
})

test('玩家名额与伪玩家名额互不抢占', () => {
  const st = {
    region: 'center', terrain: 'dongtian', diff: 'tian',
    specialPending: true, specialGranted: 0,
    fakeSpecialPending: true, fakeSpecialGranted: SPECIAL_MAX
  }
  rollReward(st, 'tian', () => 0, { special: true, fake: true })
  assert.equal(st.specialGranted, 0, '伪玩家名额满时不能动玩家名额')
  assert.equal(st.fakeSpecialGranted, SPECIAL_MAX)
})

test('镇海珠禁止伪玩家打造/使用', () => {
  assert.ok(FAKE_ARTIFACT_BLACKLIST.includes('镇海珠'))
  assert.equal(fakeCanUseArtifact('镇海珠'), false)
  assert.equal(fakeCanUseArtifact('傀儡'), true)
})

test('伪玩家市场灵石/供需动态定价', () => {
  const poor = { roster: { a: { alive: true, money: 100000 } } }
  const rich = { roster: { a: { alive: true, money: 20000000 } } }
  assert.ok(fakeMarketIndex(rich) > fakeMarketIndex(poor), '灵石多应推高物价')
  const scarce = { roster: { a: { alive: true, money: 5000000, bag: { items: {} } } } }
  const abundant = { roster: {
    a: { alive: true, money: 5000000, bag: { items: { 修为丹: { count: 10 } } } },
    b: { alive: true, money: 5000000, bag: { items: { 修为丹: { count: 20 } } } }
  } }
  assert.equal(fakeItemSupply(scarce, '修为丹'), 0)
  assert.equal(fakeItemSupply(abundant, '修为丹'), 30)
  assert.ok(fakeTradePrice(abundant, '修为丹', 100) < fakeTradePrice(scarce, '修为丹', 100), '库存多应更便宜')
  assert.ok(fakeBasePrice('云裳仙蕊') > fakeBasePrice('镇海砂'), '高品质材料基础价应更高')
})

test('伪玩家自己铸造特殊彩武(6云裳+红武器)', () => {
  const red = Object.keys(EQUIP_TPL).find(n => EQUIP_TPL[n].quality === 6 && EQUIP_TPL[n].type === 'weapon')
  assert.ok(red, '应存在红色武器模板')
  const f = { roster: { p: {
    name: '铸武', alive: true, realmBusy: false, money: 1000,
    bag: { items: { 云裳仙蕊: { count: 6 }, [red]: { count: 1 } }, equipped: {}, equippedAttr: {}, artifacts: {} }
  } } }
  fakeArtifactTick(f, 1000)
  assert.equal(f.roster.p.bag.items['成长性特殊彩武']?.count, 1)
  assert.equal(f.roster.p.bag.items['云裳仙蕊'], undefined)
  assert.equal(f.roster.p.bag.items[red], undefined)
})

test('伪玩家没有魂石不会进万魂窟', () => {
  const make = (name, stones) => ({ name, alive: true, realmBusy: false, loc: 'west', level: 30, money: 10000, bag: { items: stones ? { 魂石: { count: stones } } : {}, equipped: {}, equippedAttr: {}, artifacts: {} } })
  const old = Math.random
  Math.random = () => 0
  try {
    const noStone = { roster: { 甲: make('甲'), 乙: make('乙') }, major: [], minor: [], byPerson: {}, bySect: {}, fakeCaves: [] }
    fakeCaveTick(noStone, 'g', +new Date(2026, 10, 7, 12))
    assert.equal(noStone.fakeCaves.length, 0)
    const withStone = { roster: { 甲: make('甲', 2), 乙: make('乙', 2) }, major: [], minor: [], byPerson: {}, bySect: {}, fakeCaves: [] }
    fakeCaveTick(withStone, 'g', +new Date(2026, 10, 7, 12))
    assert.equal(withStone.fakeCaves.length, 1)
    assert.equal(withStone.roster.甲.bag.items.魂石.count, 1)
    assert.equal(withStone.roster.乙.bag.items.魂石.count, 1)
  } finally { Math.random = old }
})

test('伪玩家魂石耗尽会自动退出万魂窟', () => {
  const make = (name) => ({ name, alive: true, realmBusy: false, loc: 'west', level: 30, money: 10000, bag: { items: { 魂石: { count: 1 } }, equipped: {}, equippedAttr: {}, artifacts: {} } })
  const old = Math.random
  Math.random = () => 0
  try {
    const t = +new Date(2026, 10, 7, 12)
    const f = { roster: { 甲: make('甲'), 乙: make('乙') }, major: [], minor: [], byPerson: {}, bySect: {}, fakeCaves: [] }
    fakeCaveTick(f, 'g', t)
    assert.equal(f.fakeCaves.length, 1)
    fakeCaveTick(f, 'g', t + 10 * 60000)
    assert.equal(f.fakeCaves.length, 0, '魂石耗尽应自动退出')
    assert.equal(f.roster.甲.bag.items.魂石, undefined)
    assert.equal(f.roster.乙.bag.items.魂石, undefined)
  } finally { Math.random = old }
})

test('伪玩家每人有独立魔窟商人货单', () => {
  const p1 = { name: '甲', alive: true, bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} }, money: 0 }
  const p2 = { name: '乙', alive: true, bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} }, money: 0 }
  const f = { roster: { 甲: p1, 乙: p2 } }
  const s1 = fakeMerchantShop(f, p1, 1000)
  const s2 = fakeMerchantShop(f, p2, 1000)
  assert.equal(s1.demands.length, 12)
  assert.equal(s2.demands.length, 12)
  assert.equal(s1.demands.filter(s => s.reward === '魂石').length, 10)
  assert.equal(s1.demands.filter(s => s.reward === '还魂丹').length, 2)
  assert.notEqual(s1, s2)
})

test('伪玩家跨区走真实传送费用/耗时', () => {
  const gid = 'travel_test_' + Date.now()
  const f = { gid, roster: {} }
  const rich = { name: '富', loc: 'center', money: 3000, bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} } }
  f.roster['富'] = rich
  assert.equal(fakeTravelTo(f, rich, 'west', 1000), true)
  assert.equal(rich.loc, 'west')
  assert.equal(rich.money, 1000)
  const poor = { name: '穷', loc: 'center', money: 0, bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} } }
  f.roster['穷'] = poor
  assert.equal(fakeTravelTo(f, poor, 'west', 1000), true)
  assert.ok(poor.fakeTravel, '付不起传送费应进入强行跨越在途')
  const old = Math.random
  Math.random = () => 0
  try { fakeTravelTick(f, 1000 + 5 * 60000) } finally { Math.random = old }
  assert.equal(poor.loc, 'west')
  try { fs.rmSync(`${Save_Path}/world/world_${gid}.json`, { force: true }) } catch (err) { }
})

test('伪玩家法宝接入实际战力(定仙游/万魂/傀儡)', () => {
  const base = { name: '战力', level: 30, bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} } }
  const p = JSON.parse(JSON.stringify(base))
  const before = personPower(p)
  p.bag.artifacts.dingxianyou = { owned: true, equipped: true }
  assert.ok(personPower(p) > before, '定仙游应提升战力')
  p.bag.artifacts.wanhun = { equipped: true, deployed: true, rank: 1, mainSoul: { level: 20 }, deputySouls: [] }
  assert.ok(personPower(p) > before, '万魂幡魂力应提升战力')
})

test('过期魔窟商人货单会被清理', () => {
  const f = { fakeMerchantShops: { 甲: { refreshAt: 0, demands: [] }, 乙: { refreshAt: Date.now() + 3600000, demands: [] } } }
  assert.equal(pruneFakeMerchantShops(f, Date.now()), 1)
  assert.ok(f.fakeMerchantShops.乙)
  assert.equal(f.fakeMerchantShops.甲, undefined)
})

test('伪玩家缺法宝材料会去便宜鬼市补', () => {
  const p = { name: '缺料', alive: true, realmBusy: false, loc: 'west', level: 30, money: 10000, fakeTradeThreshold: 0, bag: { items: { 魂石: { count: 1 } }, equipped: {}, equippedAttr: {}, artifacts: {} } }
  const f = { gid: 'mart', roster: { 缺料: p }, major: [], minor: [], byPerson: {}, bySect: {}, trades: [], fakeCaves: [] }
  fakeGoalTick(f, 'mart', Date.now())
  assert.ok(p.bag.items.万魂幡残卷?.count >= 1, '应买到万魂幡残卷')
  assert.ok(p.money < 10000, '应扣灵石')
})

test('伪玩家不会倒卖最后一颗魂石', () => {
  const a = { name: '甲', alive: true, realmBusy: false, loc: 'west', level: 30, money: 10000, fakeTradeThreshold: 0, bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} } }
  const b = { name: '乙', alive: true, realmBusy: false, loc: 'west', level: 30, money: 10000, fakeTradeThreshold: 0, bag: { items: { 魂石: { count: 1 } }, equipped: {}, equippedAttr: {}, artifacts: {} } }
  const f = { gid: 'stone', roster: { 甲: a, 乙: b }, major: [], minor: [], byPerson: {}, bySect: {}, trades: [], fakeCaves: [] }
  fakeGoalTick(f, 'stone', Date.now())
  assert.equal(b.bag.items.魂石.count, 1, '卖家必须保留最后一颗魂石')
  assert.ok(a.bag.items.魂石?.count >= 1, '买家应从鬼市补到魂石')
})

test('鬼市库存有数量限制并按周期补货', () => {
  const p = { name: '买货', alive: true, money: 1000000, bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} } }
  const f = { roster: { 买货: p } }
  const shop = fakeGhostStock(f, 1000)
  shop.nextAt = 1000 + 24 * 3600000
  const cap = shop.stock.魂石
  assert.ok(cap > 0)
  let bought = 0
  for (let i = 0; i < cap + 5; i++) if (fakeMartBuy(f, p, '魂石', 1000 + i * 11 * 60000)) bought++
  assert.equal(bought, cap, '不能超过初始库存')
  assert.equal(shop.stock.魂石, undefined, '库存应售罄')
  assert.equal(fakeMartBuy(f, p, '魂石', 1000 + (cap + 6) * 11 * 60000), false, '售罄后等补货')
  shop.nextAt = 1000
  fakeGhostStock(f, 1000 + 24 * 3600000 + 1)
  assert.ok(shop.stock.魂石 > 0, '到点应补货')
})

test('伪玩家装备修复: 清无效战利品/空位陈旧属性并自动穿戴', () => {
  const bag = {
    items: { 青锋剑: { count: 1 }, 流霜剑: { count: 1 } },
    equipped: { weapon: '', helmet: '', chest: '', pants: '', shoes: '', ring: '' },
    equippedAttr: { weapon: { atk: 999 }, helmet: { def: 999 }, chest: null, pants: null, shoes: null, ring: null },
    artifacts: {}
  }
  repairFakeEquipment(bag)
  assert.equal(bag.items['青锋剑'], undefined, '未登记模板的垃圾装备应删除')
  assert.equal(bag.equipped.weapon, '流霜剑', '有效装备应自动穿上')
  assert.equal(bag.equippedAttr.helmet, null, '空装备位陈旧属性应清空')
})

test('机缘库越大越容易被伪玩家遇到并抽1~5件', () => {
  const p = { name: '有缘人', alive: true, realmBusy: false, money: 0, bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} } }
  const f = {
    roster: { 有缘人: p }, major: [], minor: [], byPerson: {}, bySect: {}, fatePool: {
      stones: 1000,
      items: [{ name: '阴魂砂', count: 5, attr: null }, { name: '游魂骨', count: 2, attr: null }]
    }
  }
  const old = Math.random
  Math.random = () => 0
  try {
    const ev = genFate(f, 1000)
    assert.ok(ev, '库里有货应触发机缘')
    assert.ok(p.bag.items.阴魂砂 || p.bag.items.游魂骨 || p.money > 0)
    assert.ok(f.fatePool.items.length < 2 || f.fatePool.stones < 1000)
  } finally { Math.random = old }
})

test('机缘抽到灵石: 作为1件并从池中拿走1%~20%', () => {
  const p = { name: '灵石有缘人', alive: true, realmBusy: false, money: 0, bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} } }
  const f = { roster: { 灵石有缘人: p }, major: [], minor: [], byPerson: {}, bySect: {}, fatePool: { stones: 1000, items: [{ name: '阴魂砂', count: 3, attr: null }] } }
  const old = Math.random
  let seq = [0, 0, 0, 0, 0.5] // 命中机缘、选人、抽1件、选中灵石、拿10.5%
  Math.random = () => seq.length ? seq.shift() : 0
  try {
    const ev = genFate(f, 1000)
    assert.ok(ev)
    assert.equal(p.money, 105)
    assert.equal(f.fatePool.stones, 895)
  } finally { Math.random = old }
})

test('伪玩家遗产优先给最亲的人，没有亲属才进机缘库', () => {
  const dead = {
    name: '死者', alive: true, money: 888,
    relations: { spouse: '道侣', confidants: [], siblings: [], master: null, disciples: [], kin: [], friends: [], enemies: [] },
    bag: {
      items: { 流霜剑: { count: 1, attr: { atk: 7 } } },
      equipped: { weapon: '水月扇', helmet: '', chest: '', pants: '', shoes: '', ring: '' },
      equippedAttr: { weapon: { atk: 9 }, helmet: null, chest: null, pants: null, shoes: null, ring: null },
      artifacts: {}
    }
  }
  const kin = {
    name: '道侣', alive: true, money: 0, status: 'scatter', bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} },
    relations: { spouse: '死者', confidants: [], siblings: [], master: null, disciples: [], kin: [], friends: [], enemies: [] }
  }
  const f = { roster: { 死者: dead, 道侣: kin }, major: [], minor: [], byPerson: {}, bySect: {}, fatePool: { stones: 0, items: [] } }
  inheritFakeAssets(f, dead, 1000)
  assert.equal(kin.money, 888)
  assert.ok(kin.bag.items.流霜剑)
  assert.equal(kin.bag.equipped.weapon, '水月扇')
  assert.equal(dead.money, 0)

  const alone = { name: '独行者', alive: true, money: 500, relations: {}, bag: { items: { 阴魂砂: { count: 1 } }, equipped: {}, equippedAttr: {}, artifacts: {} } }
  const f2 = { roster: { 独行者: alone }, major: [], minor: [], byPerson: {}, bySect: {}, fatePool: { stones: 0, items: [] } }
  inheritFakeAssets(f2, alone, 1000)
  assert.equal(f2.fatePool.stones, 500)
  assert.ok(f2.fatePool.items.some(x => x.name === '阴魂砂'))
})

test('伪玩家不把傀儡术当主动功法', () => {
  assert.equal(gongfaScore('傀儡术上篇'), 0)
  assert.ok(gongfaScore('红莲神功') > gongfaScore('紫霞功'))
  const p = { name: '功法', activeGongfa: '傀儡术上篇', learnedGongfa: ['傀儡术上篇', '红莲神功'], bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} } }
  runBestGongfa({}, p)
  assert.equal(p.activeGongfa, '红莲神功')
})

test('伪玩家自动学战斗功法并卖掉垃圾功法', () => {
  const p = {
    name: '清功', money: 0, activeGongfa: '红莲神功', learnedGongfa: ['红莲神功'],
    bag: { items: { 紫霞功: { count: 1 }, 同心诀: { count: 1 }, 傀儡术上篇: { count: 1 } }, equipped: {}, equippedAttr: {}, artifacts: {} }
  }
  fakeSellJunkGongfa({}, p, 1000)
  assert.equal(p.bag.items.紫霞功, undefined)
  assert.equal(p.bag.items.同心诀, undefined)
  assert.ok(p.bag.items.傀儡术上篇, '绑定傀儡术不能卖')
  assert.ok(p.money > 0)
  const q = { name: '学功', activeGongfa: '', learnedGongfa: [], bag: { items: { 红莲神功: { count: 1 } }, equipped: {}, equippedAttr: {}, artifacts: {} } }
  assert.equal(fakeLearnBestGongfa({}, q, 1000), true)
  assert.equal(q.activeGongfa, '红莲神功')
  assert.equal(q.bag.items.红莲神功, undefined)
})

test('伪玩家按同配方打造定仙游', () => {
  const f = { roster: { p: {
    name: '测试', alive: true, realmBusy: false,
    bag: {
      items: { 神游蛊: { count: 1 }, 玄阴玉: { count: 5 }, 镇魂晶: { count: 5 }, 血煞髓: { count: 5 } },
      equipped: {}, equippedAttr: {}, artifacts: {}
    }
  } } }
  fakeArtifactTick(f, 1000)
  assert.equal(f.roster.p.bag.artifacts.dingxianyou?.owned, true)
  assert.equal(f.roster.p.bag.items.神游蛊, undefined)
})

test('伪玩家按同配方打造万魂幡', () => {
  const f = { roster: { p: {
    name: '测试2', alive: true, realmBusy: false,
    bag: {
      items: { 万魂幡残卷: { count: 5 }, 阴魂砂: { count: 20 }, 游魂骨: { count: 20 }, 成长性特殊彩武: { count: 1 } },
      equipped: {}, equippedAttr: {}, artifacts: {}
    }
  } } }
  fakeArtifactTick(f, 1000)
  assert.equal(f.roster.p.bag.artifacts.wanhun?.rank, 1)
  assert.equal(f.roster.p.bag.items.万魂幡残卷, undefined)
})
