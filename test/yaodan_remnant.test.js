import test from 'node:test'
import assert from 'node:assert/strict'
import { MATERIAL_TPL, itemIcon, isYaodan, yaodanName, YAODAN_REMNANT_WEIGHTS, rollYaodanTierFromRemnant, WANHUN_ONLY_MATS } from '../components/equip_data.js'
import { realmRewardPool, realmSpecialPool, rollReward, REALM_CANDAN_CHANCE } from '../components/realm_data.js'

test('残丹是白色品质1材料, 非妖丹, 不属万魂窟专属, 图标为白色', () => {
  assert.ok(MATERIAL_TPL['残丹'], '残丹应在 MATERIAL_TPL 中')
  assert.equal(MATERIAL_TPL['残丹'].quality, 1)
  assert.equal(MATERIAL_TPL['残丹'].bound, undefined, '残丹不应绑定')
  assert.equal(isYaodan('残丹'), false)
  assert.equal(WANHUN_ONLY_MATS.has('残丹'), false)
  assert.equal(itemIcon('残丹'), '⚪')
})

test('残丹凝练妖丹权重覆盖1~7阶, 均大于0且合计100', () => {
  assert.deepEqual(Object.keys(YAODAN_REMNANT_WEIGHTS).map(Number).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7])
  for (const [tier, weight] of Object.entries(YAODAN_REMNANT_WEIGHTS)) {
    assert.equal(yaodanName(Number(tier)).startsWith(['一', '二', '三', '四', '五', '六', '七'][Number(tier) - 1]), true)
    assert.ok(Number(weight) > 0)
  }
  const total = Object.values(YAODAN_REMNANT_WEIGHTS).reduce((sum, w) => sum + Number(w), 0)
  assert.equal(total, 100)
})

test('rollYaodanTierFromRemnant 按累计权重落档(1~7), 随机源可注入', () => {
  /* 累计边界: 1[0,28) 2[28,52) 3[52,70) 4[70,82) 5[82,91) 6[91,97) 7[97,100) */
  assert.equal(rollYaodanTierFromRemnant(() => 0), 1)
  assert.equal(rollYaodanTierFromRemnant(() => 0.279999), 1)
  assert.equal(rollYaodanTierFromRemnant(() => 0.28), 2)
  assert.equal(rollYaodanTierFromRemnant(() => 0.519999), 2)
  assert.equal(rollYaodanTierFromRemnant(() => 0.52), 3)
  assert.equal(rollYaodanTierFromRemnant(() => 0.699999), 3)
  assert.equal(rollYaodanTierFromRemnant(() => 0.70), 4)
  assert.equal(rollYaodanTierFromRemnant(() => 0.819999), 4)
  assert.equal(rollYaodanTierFromRemnant(() => 0.82), 5)
  assert.equal(rollYaodanTierFromRemnant(() => 0.909999), 5)
  assert.equal(rollYaodanTierFromRemnant(() => 0.91), 6)
  assert.equal(rollYaodanTierFromRemnant(() => 0.969999), 6)
  assert.equal(rollYaodanTierFromRemnant(() => 0.97), 7)
  assert.equal(rollYaodanTierFromRemnant(() => 0.999999), 7)
})

test('残丹进入遗蜕秘境公共奖励池(各地形), 不进入特殊彩池', () => {
  for (const terrain of ['dongtian', 'leichi', 'taichu', 'shijian']) {
    assert.ok(realmRewardPool({ terrain }).includes('残丹'), `残丹应可在地形 ${terrain} 的遗蜕秘境池掉落`)
  }
  assert.equal(realmSpecialPool().includes('残丹'), false, '残丹不属特殊彩奖励, 不占彩奖励名额')
})

test('每个正常掉落件有固定概率直接为残丹, 特殊彩名额优先于残丹', () => {
  assert.equal(REALM_CANDAN_CHANCE, 0.18)
  const st = { terrain: 'leichi', diff: 'tian', specialPending: false, specialGranted: 0 }
  /* random<0.18 → 本件直接判为残丹 */
  const hit = rollReward(st, 'tian', () => 0)
  assert.equal(hit.name, '残丹')
  assert.equal(hit.quality, 1)
  assert.equal(hit.currency, false)
  assert.equal(hit.rare, false)
  /* cfg.candan:0 可禁用残丹分支, 走正常品质池 */
  assert.notEqual(rollReward(st, 'tian', () => 0, { candan: 0 }).name, '残丹')
  /* 特殊彩奖励名额优先: 即使 random 命中残丹概率, 有彩名额时仍给特殊彩 */
  const st2 = { ...st, specialPending: true }
  const special = rollReward(st2, 'tian', () => 0, { special: true })
  assert.notEqual(special.name, '残丹')
  assert.equal(st2.specialGranted, 1)
})
