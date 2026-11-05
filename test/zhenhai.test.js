import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ZHENHAI_MATERIALS, ZHENHAI_TIERS, ZHENHAI_RECIPES,
  sealMaxHp, rollZhenhaiMaterial, rankName, createZhenhai, getZhenhai, cooldownLeft, ZHENHAI_DROP_TABLE
} from '../components/zhenhai_data.js'
import { sealBlocksTravel } from '../components/world_data.js'
import { realmRewardPool, rollRewardList } from '../components/realm_data.js'
import { MATERIAL_TPL, ARTIFACT_TPL } from '../components/equip_data.js'
import { COLOR_MATS } from '../components/raid_data.js'

test('镇海珠五阶血量 = 阶位次数 × 使用者战力(已翻倍)', () => {
  assert.equal(ZHENHAI_TIERS[1].hits, 20)
  assert.equal(ZHENHAI_TIERS[2].hits, 44)
  assert.equal(ZHENHAI_TIERS[3].hits, 70)
  assert.equal(ZHENHAI_TIERS[4].hits, 100)
  assert.equal(ZHENHAI_TIERS[5].hits, 140)
  assert.equal(sealMaxHp(1, 20000), 20 * 20000)
  assert.equal(sealMaxHp(5, 20000), 140 * 20000)
})

test('镇海珠绑定、拥有即生效、不占装备栏', () => {
  assert.equal(ARTIFACT_TPL['镇海珠'].bound, true)
  const bag = { artifacts: {} }
  const art = createZhenhai(bag, 1000)
  assert.equal(art.rank, 1)
  assert.equal(getZhenhai(bag).rank, 1)
  assert.equal(rankName(1), '1阶·镇浪')
  assert.equal(cooldownLeft(art, 1000), 0)
})

test('封海只影响非主人, 1阶定仙游例外', () => {
  const seal = { region: 'east', tier: 2, owner: '1', until: Date.now() + 60000 }
  const w = { seal }
  assert.ok(sealBlocksTravel(w, '2', 'center', 'east'))
  assert.ok(sealBlocksTravel(w, '2', 'east', 'west'))
  assert.equal(sealBlocksTravel(w, '1', 'east', 'west'), null)
  assert.equal(sealBlocksTravel(w, '2', 'west', 'north'), null)
  const tier1 = { seal: { ...seal, tier: 1 } }
  assert.equal(sealBlocksTravel(tier1, '2', 'center', 'east', { allowDingxianyou: true }), null)
  assert.ok(sealBlocksTravel(tier1, '2', 'center', 'east'))
})

test('镇海材料不进原混池, 只从东海专属判定/保底出', () => {
  const east = { terrain: 'dongtian', region: 'east', specialPending: false, specialGranted: 0 }
  const pool = realmRewardPool(east)
  for (const name of ZHENHAI_MATERIALS) assert.ok(!pool.includes(name), `${name} should not be in mixed pool`)
  const zhenhai = { terrain: 'zhenhai', region: 'east', specialPending: false, specialGranted: 0 }
  const zhenhaiPool = realmRewardPool(zhenhai)
  for (const name of ZHENHAI_MATERIALS) assert.ok(!zhenhaiPool.includes(name), `${name} should not be in mixed pool`)
  const other = realmRewardPool({ terrain: 'dongtian', region: 'center' })
  for (const name of ZHENHAI_MATERIALS) assert.ok(!other.includes(name), `${name} should not be outside east`)
  /* 东海任意秘境通过专属层/保底出 */
  const list = rollRewardList(east, 'tian', () => 0.99)
  const guaranteed = list.find(i => ZHENHAI_MATERIALS.includes(i.name))
  assert.ok(guaranteed, 'east realm should guarantee a material')
  assert.ok(guaranteed.count <= 3, '保底镇海砂不应超过新的 1~3 范围')
  const again = rollRewardList(east, 'tian', () => 0.99)
  assert.ok(!again.some(i => ZHENHAI_MATERIALS.includes(i.name)), '每场秘境只保底一次, 事件内不重复保底')
})

test('5 种材料属性/来源, 且不进藏宝阁彩色池', () => {
  const expected = { 镇海砂: 5, 龙宫珊瑚: 6, 海眼寒铁: 7, 潮汐月华: 7, 沧溟珠泪: 7 }
  for (const [name, quality] of Object.entries(expected)) {
    assert.ok(MATERIAL_TPL[name], `missing ${name}`)
    assert.equal(MATERIAL_TPL[name].quality, quality)
    assert.ok(!COLOR_MATS.includes(name), `${name} leaked into raid color pool`)
  }
})

test('配方表完整且总消耗可算', () => {
  const total = { 镇海砂: 0, 龙宫珊瑚: 0, 海眼寒铁: 0, 潮汐月华: 0, 沧溟珠泪: 0 }
  for (const key of ['craft', 2, 3, 4, 5]) {
    const recipe = ZHENHAI_RECIPES[key]
    assert.ok(recipe && recipe.money > 0)
    for (const [name, count] of Object.entries(recipe.mats)) total[name] += count
  }
  assert.deepEqual(total, { 镇海砂: 460, 龙宫珊瑚: 210, 海眼寒铁: 49, 潮汐月华: 18, 沧溟珠泪: 7 })
})

test('材料抽取权重总和与数量范围', () => {
  const sand = ZHENHAI_DROP_TABLE.find(x => x.name === '镇海砂')
  const coral = ZHENHAI_DROP_TABLE.find(x => x.name === '龙宫珊瑚')
  assert.deepEqual([sand.min, sand.max], [1, 3])
  assert.deepEqual([coral.min, coral.max], [1, 2])
  for (let i = 0; i < 200; i++) {
    const got = rollZhenhaiMaterial(() => Math.random())
    assert.ok(ZHENHAI_MATERIALS.includes(got.name))
    assert.ok(got.count >= 1)
  }
})
