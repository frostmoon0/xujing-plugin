import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PUPPET_INITIAL_COST,
  PUPPET_UPGRADE_COSTS,
  PUPPET_POWER_RANGES,
  PUPPET_MAX_POWER,
  PUPPET_POWER_MULTIPLIER,
  PUPPET_PASSIVES,
  PUPPET_CHAPTERS,
  PUPPET_TECHNIQUE_FRAGMENT,
  PUPPET_DEPLOY_COST_PER_RANK,
  puppetDeployCost,
  getPuppetPower,
  parsePuppetTechniqueDismantleCmd,
  rollPuppetPower,
  puppetChapterForRank,
  resolvePuppet,
  puppetCoreCount,
  givePuppetCore,
  takePuppetCore,
  _test
} from '../components/puppet_data.js'
import { ensureBagShape, addItemToBag, MATERIAL_TPL, itemIcon } from '../components/equip_data.js'
import { COLOR_SPECIAL, realmSpecialPool, rollRealmSpecialReward } from '../components/realm_data.js'

test('傀儡每阶消耗对应阶数的妖丹与五个万阵核心', () => {
  assert.equal(PUPPET_INITIAL_COST.materials.一阶妖丹, 1)
  assert.equal(PUPPET_INITIAL_COST.materials.万阵核心, 5)
  const cn = ['', '一', '二', '三', '四', '五', '六', '七']
  for (let rank = 2; rank <= 7; rank++) {
    assert.equal(PUPPET_UPGRADE_COSTS[rank].materials.万阵核心, 5)
    assert.equal(PUPPET_UPGRADE_COSTS[rank].materials[`${cn[rank]}阶妖丹`], 1)
  }
})

test('傀儡祭出费用按阶位递增, 每升一阶增加一万灵石', () => {
  assert.equal(PUPPET_DEPLOY_COST_PER_RANK, 10000)
  for (let rank = 1; rank <= 7; rank++) assert.equal(puppetDeployCost(rank), rank * 10000)
  assert.equal(puppetDeployCost(0), 10000)
  assert.equal(puppetDeployCost(99), 70000)
})


test('祭出傀儡战力按基础战力3倍计入，未祭出不计入', () => {
  assert.equal(PUPPET_POWER_MULTIPLIER, 3)
  const bag = { artifacts: { puppets: [{ id: 'p', name: '测试傀儡', rank: 3, power: 1001, passive: 'atk', equipped: true, deployed: true, nextChargeAt: Date.now() + 60000 }] } }
  assert.equal(getPuppetPower(bag), 3003)
  bag.artifacts.puppets[0].deployed = false
  assert.equal(getPuppetPower(bag), 0)
})
test('傀儡术分解指令兼容有无空格并解析数量', () => {
  assert.deepEqual(parsePuppetTechniqueDismantleCmd('#分解傀儡术 傀儡术下篇 3'), { name: '傀儡术下篇', amount: 3 })
  assert.deepEqual(parsePuppetTechniqueDismantleCmd('#分解傀儡术下篇3'), { name: '傀儡术下篇', amount: 3 })
  assert.deepEqual(parsePuppetTechniqueDismantleCmd('分解傀儡术 中篇'), { name: '傀儡术中篇', amount: 1 })
  assert.equal(parsePuppetTechniqueDismantleCmd('#分解傀儡术'), null)
  assert.equal(PUPPET_TECHNIQUE_FRAGMENT, '功法残卷')
  assert.equal(MATERIAL_TPL[PUPPET_TECHNIQUE_FRAGMENT].quality, 7)
  assert.equal(itemIcon(PUPPET_TECHNIQUE_FRAGMENT), '🌈')
  const bag = { items: {} }
  addItemToBag(bag, PUPPET_TECHNIQUE_FRAGMENT, 3, null, false)
  assert.equal(bag.items[PUPPET_TECHNIQUE_FRAGMENT].count, 3)
})


test('傀儡术按篇章开放阶位', () => {
  assert.equal(puppetChapterForRank(1), '傀儡术下篇')
  assert.equal(puppetChapterForRank(2), '傀儡术下篇')
  assert.equal(puppetChapterForRank(3), '傀儡术中篇')
  assert.equal(puppetChapterForRank(5), '傀儡术中篇')
  assert.equal(puppetChapterForRank(6), '傀儡术上篇')
  assert.equal(puppetChapterForRank(7), '傀儡术上篇')
})

test('傀儡战力按一阶随机和前阶增量生成并封顶', () => {
  assert.equal(rollPuppetPower(1, 0, () => 0), PUPPET_POWER_RANGES[1][0])
  assert.equal(rollPuppetPower(1, 0, () => 0.999999), PUPPET_POWER_RANGES[1][1])
  assert.equal(rollPuppetPower(2, 500, () => 0), 500 + PUPPET_POWER_RANGES[2][0])
  assert.equal(rollPuppetPower(7, 6999, () => 0.999999), PUPPET_MAX_POWER)
})

test('傀儡术纳入秘境彩奖励池，与彩材料同池不单独掉率', () => {
  for (const chapter of PUPPET_CHAPTERS) assert.ok(COLOR_SPECIAL.includes(chapter))
  for (const chapter of PUPPET_CHAPTERS) assert.ok(realmSpecialPool().includes(chapter))
  /* 彩奖励池命中时，可能抽到傀儡术篇章 */
  const pool = realmSpecialPool()
  assert.ok(pool.length >= COLOR_SPECIAL.length)
  /* 皇城使用同一池：天阶15%概率命中，命中即返回池内物品 */
  const name = rollRealmSpecialReward('tian', () => 0)
  assert.ok(pool.includes(name))
  assert.equal(rollRealmSpecialReward('tian', () => 0.5), null)
})

test('傀儡名字重复时必须使用序号', () => {
  const bag = { artifacts: { puppets: [
    { id: 'a', name: '玄甲', rank: 1, power: 500, passive: 'atk' },
    { id: 'b', name: '玄甲', rank: 1, power: 600, passive: 'def' }
  ] } }
  assert.equal(resolvePuppet(bag, '玄甲').puppet, null)
  assert.equal(resolvePuppet(bag, '1').puppet.id, 'a')
})

test('傀儡被动晶核不占背包, 旧档自动迁移到 artifacts.puppetCores', () => {
  const bag = { items: { 傀儡被动晶核: { count: 2 } }, artifacts: {} }
  ensureBagShape(bag)
  assert.equal(bag.items['傀儡被动晶核'], undefined)
  assert.equal(bag.artifacts.puppetCores, 2)
  /* 读写接口 */
  assert.equal(puppetCoreCount(bag), 2)
  assert.equal(givePuppetCore(bag, 1), 3)
  assert.equal(takePuppetCore(bag, 2), true)
  assert.equal(puppetCoreCount(bag), 1)
  assert.equal(takePuppetCore(bag, 5), false)
  assert.equal(puppetCoreCount(bag), 1)
})

test('缓存背包中的旧晶核字段读取时自动迁移, 打造分支可识别', () => {
  const bag = { items: { 傀儡被动晶核: { count: 2 } }, artifacts: { puppetCores: 1 } }
  assert.equal(puppetCoreCount(bag), 3)
  assert.equal(bag.items.傀儡被动晶核, undefined)
  assert.equal(bag.artifacts.puppetCores, 3)
})

test('增加傀儡被动晶核直接写入法宝计数, 不回到普通背包', () => {
  const bag = { items: {}, artifacts: {} }
  addItemToBag(bag, '傀儡被动晶核', 2)
  assert.equal(bag.items.傀儡被动晶核, undefined)
  assert.equal(bag.artifacts.puppetCores, 2)
})

test('傀儡被动只含五类战斗属性', () => {
  assert.deepEqual(Object.keys(PUPPET_PASSIVES), ['atk', 'def', 'hp', 'crit', 'cdmg'])
  const bag = { items: {} }
  _test.addMaterialRefund(bag, { materials: { 无主幽魂: 1, 摄魂铁: 2, 阴魂石: 3 } })
  assert.equal(bag.items.无主幽魂, undefined)
  assert.equal(bag.items.摄魂铁.count, 1)
  assert.equal(bag.items.阴魂石.count, 1)
})

test('傀儡被动数值已翻倍, 一阶到七阶逐阶递增', () => {
  assert.deepEqual(PUPPET_PASSIVES.atk.values, [0.06, 0.1, 0.14, 0.18, 0.22, 0.26, 0.3])
  assert.deepEqual(PUPPET_PASSIVES.def.values, [0.06, 0.1, 0.14, 0.18, 0.22, 0.26, 0.3])
  assert.deepEqual(PUPPET_PASSIVES.hp.values, [0.06, 0.1, 0.14, 0.18, 0.22, 0.26, 0.3])
  assert.deepEqual(PUPPET_PASSIVES.crit.values, [0.04, 0.06, 0.08, 0.1, 0.12, 0.16, 0.2])
  assert.deepEqual(PUPPET_PASSIVES.cdmg.values, [0.1, 0.16, 0.22, 0.28, 0.36, 0.44, 0.52])
  for (const key of Object.keys(PUPPET_PASSIVES)) {
    const values = PUPPET_PASSIVES[key].values
    assert.equal(values.length, 7)
    for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1], `${key} 第${i + 1}阶不应低于前一阶`)
  }
})
