import test from 'node:test'
import assert from 'node:assert/strict'
import { _test, autoPickForPlayer, NODE_TYPES, TERRAINS } from '../components/realm_data.js'

test('万法残墟的残碑事件不再是小游戏式赌石', () => {
  const st = { phase: 'explore', terrain: 'shifang', diff: 'huang', teams: {} }
  const team = { id: 'player:test', kind: 'player', members: ['1'], step: 1, combatPower: 1000 }
  const node = _test.buildNode(st, team, 'canwu', 1000)
  assert.match(node.title, /道则残碑/)
  assert.equal(node.data.kind, 'insight')
  assert.equal(node.choices.length, 3)
  assert.match(node.choices[0].label, /参悟/)
  assert.equal(autoPickForPlayer({ type: 'canwu' }), 3)
})

test('随机节点表已移除 dushi, 新地形名为万法残墟', () => {
  assert.ok(!NODE_TYPES.includes('dushi'))
  assert.ok(NODE_TYPES.includes('canwu'))
  assert.equal(TERRAINS.shifang.name, '万法残墟')
  assert.notEqual(TERRAINS.shifang.name, '石坊赌源')
})
