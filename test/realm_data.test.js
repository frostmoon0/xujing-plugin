import test from 'node:test'
import assert from 'node:assert/strict'
import { _test, autoPickForPlayer, disposalChoices, rollEvent, rollRewardList, realmRewardPool, realmRewardInfo, realmRewardRange, REALM_REWARD_MATERIALS, REALM_QUALITY_WEIGHTS, fmtRewards, replaceRealmPlayerIds } from '../components/realm_data.js'
import { rogueTeamOf, applyRogue, respondApply } from '../components/sect/war.js'

test('妖兽事件展示固定战力与胜率', () => {
  const st = { phase: 'explore', terrain: 'dongtian', diff: 'huang', teams: {} }
  const team = { id: 'player:test', kind: 'player', members: ['1'], step: 0, combatPower: 1200 }
  const node = _test.buildNode(st, team, 'beast', 1200)

  assert.match(node.text, /妖兽战力：800/)
  assert.match(node.text, /胜率：73%/)
  assert.equal(node.text, _test.buildNode(st, team, 'beast', 1200).text)
})

test('秘境异变按乱源固定触发，不重复随机判定', () => {
  const st = { phase: 'explore', terrain: 'dongtian', diff: 'huang', chaos: 1, eventsFired: 0, lastEventChaos: 0, firedEvents: [] }

  assert.ok(rollEvent(st, { event_max: 4 }))
  assert.equal(rollEvent(st, { event_max: 4 }), null)
})

test('秘境奖励池包含材料、丹药、装备、功法和灵石', () => {
  const pool = realmRewardPool({ terrain: 'dongtian' })

  assert.ok(pool.includes('星霜草'))
  assert.ok(pool.includes('修为丹'))
  assert.ok(pool.includes('桃木剑'))
  assert.ok(pool.includes('凝霜诀'))
  assert.ok(pool.includes('灵石'))
  assert.ok(pool.includes('红莲神功'))
  assert.ok(pool.includes('傀儡术下篇'), '傀儡篇可普通探索掉落')
  assert.ok(pool.includes('傀儡术中篇'))
  assert.ok(pool.includes('傀儡术上篇'))
  assert.ok(!pool.includes('太阴月华诀'), '太阴月华诀仅藏宝阁洗劫, 不进秘境普通池')
  assert.ok(!pool.includes('攻势·武器'))
  assert.ok(!pool.includes('遗蜕古钥'))
  assert.ok(!pool.includes('镇魂晶'))
  assert.ok(!pool.includes('还魂丹'))
  assert.ok(!pool.includes('登仙令'))
  assert.ok(!pool.includes('仙帝丹'), '仙帝丹只能配方合成, 不进秘境普通池')
  assert.ok(!pool.includes('神游蛊'))
  assert.ok(!pool.includes('灵宝盒'))
  assert.ok(pool.length > 5)
  assert.deepEqual(REALM_REWARD_MATERIALS, [
    '星霜草', '青鸾草', '望舒花', '月华芝', '凤栖花', '云裳仙蕊',
    '月魄石', '星璇石', '流光玉', '织云石', '凤羽玉', '造梦神玉',
    '天衍阵纹', '乾坤阵晶', '太虚阵砂', '九幽阵髓'
  ])
})

test('秘境品质概率按阶别调整', () => {
  assert.deepEqual(REALM_QUALITY_WEIGHTS.huang, { 1: 145, 2: 145, 3: 145, 4: 145, 5: 145, 6: 145, 7: 30 })
  assert.deepEqual(REALM_QUALITY_WEIGHTS.xuan, { 1: 142, 2: 142, 3: 142, 4: 142, 5: 142, 6: 142, 7: 48 })
  assert.deepEqual(REALM_QUALITY_WEIGHTS.di, { 1: 140, 2: 140, 3: 140, 4: 140, 5: 140, 6: 140, 7: 60 })
  const rainbowRate = key => {
    const weights = REALM_QUALITY_WEIGHTS[key]
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0)
    return weights[7] / total * 100
  }
  assert.ok(Math.abs(rainbowRate('huang') - 10 / 3) < 1e-9)
  assert.ok(Math.abs(rainbowRate('xuan') - 16 / 3) < 1e-9)
  assert.ok(Math.abs(rainbowRate('di') - 20 / 3) < 1e-9)
  assert.ok(Math.abs(rainbowRate('tian') - 200 / 21) < 1e-9)
})

test('秘境事件按阶别掉落件数抽取多次，每件独立', () => {
  const st = { terrain: 'dongtian', diff: 'huang', specialPending: false }
  const huangList = rollRewardList(st, 'huang', () => 0)
  const tianList = rollRewardList(st, 'tian', () => 0)

  assert.ok(huangList.length >= 1 && huangList.length <= 2)
  assert.ok(tianList.length >= 3 && tianList.length <= 6)
  for (const item of huangList) assert.equal(item.count, 1)
  for (const item of tianList) assert.equal(item.count, 1)
})

test('秘境奖励数量按阶别随机范围生成', () => {
  const st = { terrain: 'dongtian', diff: 'huang' }
  const low = realmRewardInfo(st, 'huang')
  const high = realmRewardInfo(st, 'tian')
  const huangRange = realmRewardRange('huang')
  const tianRange = realmRewardRange('tian')

  assert.deepEqual(huangRange, { min: 1, max: 2 })
  assert.deepEqual(tianRange, { min: 3, max: 6 })
  assert.match(low.count, /^1~2$/)
  assert.match(high.count, /^3~6$/)
})

test('秘境相同收获合并显示数量', () => {
  assert.equal(fmtRewards([
    { name: '测试奖励', count: 1 },
    { name: '测试奖励', count: 1 },
    { name: '另一奖励', count: 2 }
  ]), '📦测试奖励×2、📦另一奖励×2')
})

test('秘境推送中的玩家 UID 始终替换为名字', () => {
  assert.equal(replaceRealmPlayerIds('【10001】击败【10002】\n10001：🟢修为丹×2\n🏆 首功：10002 完成最后一击！', new Map([['10001', '甲'], ['10002', '乙']])), '【甲】击败【乙】\n甲：🟢修为丹×2\n🏆 首功：乙 完成最后一击！')
  assert.doesNotMatch(replaceRealmPlayerIds('【10001】\n10001：暂无收获', new Map()), /10001/)
})


test('秘境奖励分配结果稳定', () => {
  const team = { members: ['2', '1'], contrib: { 1: 3, 2: 1 }, pool: [{ name: '修为丹', count: 3 }] }
  const first = _test.planSplit(team)
  const second = _test.planSplit(team)

  assert.deepEqual(first, second)
})

test('秘境遭遇战后提供十种分类处置', () => {
  const fakeChoices = disposalChoices({ kind: 'fake' })
  const playerChoices = disposalChoices({ kind: 'player' })

  assert.equal(fakeChoices.length, 10)
  assert.deepEqual(fakeChoices.map(choice => choice.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.match(fakeChoices[0].label, /放过/)
  assert.match(fakeChoices[1].label, /奖励池份额30%/)
  assert.match(fakeChoices[2].label, /奖励池份额全部/)
  assert.match(fakeChoices[5].label, /随身灵石30%/)
  assert.match(fakeChoices[6].label, /随身灵石全部/)
  assert.match(fakeChoices[3].label, /背包30%/)
  assert.match(fakeChoices[4].label, /背包全部/)
  assert.match(fakeChoices[5].label, /灵石30%/)
  assert.match(fakeChoices[6].label, /灵石全部/)
  assert.match(fakeChoices[7].label, /综合搜刮30%/)
  assert.match(fakeChoices[8].label, /全搜/)
  assert.match(fakeChoices[9].label, /斩灭其身.*业力.*吸魂/)
  assert.match(playerChoices[9].label, /重伤遣返本场/)
})

test('秘境分类处置分别控制奖励池背包和灵石', () => {
  const rates = [
    [0, 0, 0],
    [0.3, 0, 0],
    [1, 0, 0],
    [0, 0.3, 0],
    [0, 1, 0],
    [0, 0, 0.3],
    [0, 0, 1],
    [0.3, 0.3, 0.3],
    [1, 1, 1],
    [1, 1, 1]
  ]
  for (const [offset, expected] of rates.entries()) {
    const plan = _test.disposalPlan(offset + 1)
    assert.deepEqual([plan.poolRate, plan.bagRate, plan.moneyRate], expected)
  }
  assert.equal(_test.disposalPlan(1).release, true)
  assert.equal(_test.disposalPlan(3).expose, true)
  assert.equal(_test.disposalPlan(5).expose, true)
  assert.equal(_test.disposalPlan(7).expose, true)
  assert.equal(_test.disposalPlan(9).expose, true)
  assert.equal(_test.disposalPlan(10).kill, true)
})

test('秘境奖励池按战败成员份额取三成或全部', () => {
  const make = () => ({
    members: ['败者', '队友'],
    contrib: { 败者: 1, 队友: 1 },
    pool: [{ name: '修为丹', count: 10 }, { name: '灵石', count: 100, currency: true }]
  })
  const target30 = make()
  const got30 = _test.extractPoolShare(target30, '败者', 0.3)
  assert.deepEqual(got30.items.map(item => [item.name, item.count]), [['修为丹', 2]])
  assert.equal(got30.money, 15)
  assert.deepEqual(target30.pool.map(item => [item.name, item.count]), [['修为丹', 8], ['灵石', 85]])

  const targetAll = make()
  const gotAll = _test.extractPoolShare(targetAll, '败者', 1)
  assert.deepEqual(gotAll.items.map(item => [item.name, item.count]), [['修为丹', 5]])
  assert.equal(gotAll.money, 50)
  assert.deepEqual(targetAll.pool.map(item => [item.name, item.count]), [['修为丹', 5], ['灵石', 50]])
})

test('秘境伪玩家与超时处置保持旧行为映射', () => {
  assert.equal(_test.fakeDisposalIndex({ path: '魔道', trait: '嗜杀' }), 10)
  assert.equal(_test.fakeDisposalIndex({ path: '正道', trait: '好斗' }), 9)
  assert.equal(_test.fakeDisposalIndex({ path: '正道', trait: '平和' }), 8)
  assert.equal(autoPickForPlayer({ type: 'disposal', data: { disposalVersion: 2 } }), 8)
  assert.equal(autoPickForPlayer({ type: 'disposal', data: {} }), 1)
  assert.equal(_test.normalizeDisposalIndex(1, 1), 8)
  assert.equal(_test.normalizeDisposalIndex(2, 1), 9)
  assert.equal(_test.normalizeDisposalIndex(3, 1), 10)
  assert.equal(_test.normalizeDisposalIndex(3, 2), 3)
})

test('秘境搜刮量受上限与三成封顶：灵石按整数三成，背包按上限封顶', () => {
  assert.equal(_test.moneyLootAmount(100, 0), 0)
  assert.equal(_test.moneyLootAmount(100, 0.3), 30)
  assert.equal(_test.moneyLootAmount(101, 0.3), 30)
  assert.equal(_test.moneyLootAmount(100, 1), 100)
  assert.equal(_test.inventoryLootLimit(100, 0), 0)
  assert.equal(_test.inventoryLootLimit(100, 1), 100)
  assert.equal(_test.inventoryLootLimit(100, 0.3, { loot_cap: 5 }), 5)
  assert.equal(_test.inventoryLootLimit(10, 0.3, { loot_cap: 5 }), 3)
  assert.equal(_test.inventoryLootLimit(1, 0.3, { loot_cap: 5 }), 1)
})

test('多个组队申请不会互相覆盖', () => {
  const f = { rogueTeams: { rt1: { id: 'rt1', leader: '100', name: '队伍', members: ['100'] } }, rogueApplies: {} }
  assert.equal(applyRogue(f, 'g', '101', '100', '甲').ok, true)
  assert.equal(applyRogue(f, 'g', '102', '100', '乙').ok, true)
  assert.equal(f.rogueApplies['100'].length, 2)
  assert.equal(respondApply(f, 'g', '100', true).ok, true)
  assert.deepEqual(f.rogueTeams.rt1.members, ['100', '101'])
  assert.equal(respondApply(f, 'g', '100', true).ok, true)
  assert.deepEqual(f.rogueTeams.rt1.members, ['100', '101', '102'])
  assert.equal(rogueTeamOf(f, '102').id, 'rt1')
})

test('破界后首次行动错峰：2~6分钟随机且不全部撞同一时刻', () => {
  const now = 1_000_000
  const times = new Set(Array.from({ length: 60 }, () => _test.firstWaveAt(now)))
  for (const t of times) {
    assert.ok(t >= now + 2 * 60000, `首次行动过早: ${t}`)
    assert.ok(t <= now + 6 * 60000, `首次行动过晚: ${t}`)
  }
  /* 60 次采样里不应全部落在同一个时刻，否则探索第一波仍会同步推进刷屏 */
  assert.ok(times.size >= 2, `错峰区间无差异: ${[...times].join(',')}`)
})
