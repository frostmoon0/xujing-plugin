import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeEatEmperorPill, EMPEROR_PILL, EMPEROR_TARGET_LEVEL, fakeSubThreshold } from '../components/fake_data.js'
import { ITEM_TPL, getItemSource } from '../components/equip_data.js'

function mkFake (level, count, exp = 0) {
  return { name: '甲', level, levelname: '', exp, bag: { items: { [EMPEROR_PILL]: { count } } } }
}

test('仙帝丹玩家不可服用, 但可自由流转', () => {
  assert.ok(ITEM_TPL[EMPEROR_PILL], '仙帝丹应存在道具模板中')
  assert.equal(ITEM_TPL[EMPEROR_PILL].bound, undefined, '不绑定, 允许赠送/拍卖/被搜刮')
  assert.match(ITEM_TPL[EMPEROR_PILL].desc, /玩家不可服用/)
  assert.match(ITEM_TPL[EMPEROR_PILL].desc, /伪玩家/)
  assert.match(getItemSource(EMPEROR_PILL), /玩家不可服用/)
})

test('低于仙帝10重的伪玩家服丹后直接到78级', () => {
  const p = mkFake(10, 2)
  const ev = fakeEatEmperorPill({}, p, 123)
  assert.ok(ev)
  assert.equal(ev.type, 'break')
  assert.equal(p.level, EMPEROR_TARGET_LEVEL)
  assert.equal(p.level, 78)
  assert.equal(p.levelname, '仙帝第10重')
  assert.equal(p.exp, fakeSubThreshold(78))
  assert.equal(p.bag.items[EMPEROR_PILL].count, 1, '一次只吃一颗, 多余的留在包里')
  assert.match(ev.txt, /仙帝丹/)
  assert.match(ev.txt, /仙帝第10重/)
})

test('只剩一颗时服完从背包移除', () => {
  const p = mkFake(77, 1)
  assert.ok(fakeEatEmperorPill({}, p, 1))
  assert.equal(p.level, 78)
  assert.equal(p.bag.items[EMPEROR_PILL], undefined)
})

test('已到仙帝10重及以上不服用, 丹药留在包里', () => {
  for (const lv of [78, 80, 350]) {
    const p = mkFake(lv, 1)
    assert.equal(fakeEatEmperorPill({}, p, 1), null)
    assert.equal(p.level, lv)
    assert.equal(p.bag.items[EMPEROR_PILL].count, 1)
  }
})

test('没有仙帝丹时返回 null', () => {
  const p = { name: '乙', level: 1, bag: { items: {} } }
  assert.equal(fakeEatEmperorPill({}, p, 1), null)
})

test('已有更高灵力不会被服丹降回去', () => {
  const p = mkFake(1, 1, 99999999)
  fakeEatEmperorPill({}, p, 1)
  assert.equal(p.exp, 99999999)
})
