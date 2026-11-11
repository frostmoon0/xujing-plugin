import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTaichuRun, joinTaichuRun, actTaichuRun, taichuChoices, getTaichuSettlement, commitTaichuSettlement, taichuWeek, supplyTaichuRun, retreatTaichuRun, findPlayerTaichuRun } from '../components/taichu_dungeon.js'
import { emptyTaichuStore, readTaichuStore, saveTaichuStore, cleanupTaichuStore } from '../components/taichu_store.js'

const now = Date.UTC(2026, 10, 9, 0)
const options = { enabled: true, now, rng: () => 0 }
function runFixture (ids = ['1']) {
  return createTaichuRun({ gid: 'taichu_test', leader: ids[0], members: ids.map(id => ({ id, power: 100000, name: id })), difficulty: 'normal', now }, options)
}
const actor = { power: 100000, bonuses: {}, materials: { 天衍阵纹: 100 } }
function correctAction (run, remnants = 'search') {
  if (run.node.kind === 'route') return 'forge'
  if (run.node.kind === 'array') return `disarm:${run.node.answer}`
  if (run.node.kind === 'remnant') return remnants
  return ({ shield: 'break', charge: 'interrupt', summon: 'attack', mark: 'guard' })[run.node.threat]
}
function advance (run, choose = correctAction, bonuses = {}) {
  for (const id of Object.keys(run.members)) {
    if (run.members[id].energy < 12) supplyTaichuRun(run, id, options)
    assert.equal(actTaichuRun(run, id, choose(run), { ...actor, bonuses }, options).ok, true)
  }
}
function clearRun (run = runFixture()) {
  let guard = 0
  while (run.phase === 'active' && guard++ < 25) advance(run)
  assert.equal(run.phase, 'cleared')
  assert.equal(run.step, 18)
  return run
}

test('太初副本关闭时全部业务入口拒绝且不改变状态', () => {
  assert.throws(() => createTaichuRun({ members: [] }, { enabled: false }), /未开放/)
  const run = runFixture(), original = structuredClone(run)
  assert.equal(actTaichuRun(run, '1', 'forge', actor, { enabled: false }).ok, false)
  assert.equal(joinTaichuRun(run, { id: '2' }, { enabled: false }).ok, false)
  assert.equal(supplyTaichuRun(run, '1', { enabled: false }).ok, false)
  assert.equal(retreatTaichuRun(run, '1', { enabled: false }).ok, false)
  assert.equal(getTaichuSettlement(run, '1', {}, now, { enabled: false }), null)
  assert.deepEqual(run, original)
})

test('队伍限制、每人每轮行动一次、队长路线及开始后禁止加入', () => {
  const run = runFixture(['1', '2'])
  assert.equal(joinTaichuRun(run, { id: '3', power: 100000 }, options).ok, true)
  assert.equal(joinTaichuRun(run, { id: '4' }, options).ok, false)
  assert.equal(actTaichuRun(run, '2', 'soul', actor, options).ok, true)
  assert.equal(run.step, 0)
  assert.equal(actTaichuRun(run, '2', 'tide', actor, options).ok, false)
  assert.equal(joinTaichuRun(run, { id: '5' }, options).ok, false)
  assert.equal(actTaichuRun(run, '1', 'forge', actor, options).ok, true)
  assert.equal(actTaichuRun(run, '3', 'tide', actor, options).ok, true)
  assert.equal(run.route, 'forge')
  assert.equal(run.step, 1)
  assert.equal(actTaichuRun(run, 'outsider', 'force', actor, options).ok, false)
})

test('18次关键行动可通关，怪物强度固定，队员有独立资源', () => {
  const solo = clearRun()
  assert.equal(solo.bossDamage > 0, true)
  assert.equal(Object.keys(solo.members['1'].loot).length > 0, true)
  assert.equal(solo.members['1'].supplies < 4, true)
  assert.equal(getTaichuSettlement(solo, '1', {}, now, options).route, 'forge')
  const trio = clearRun(runFixture(['1', '2', '3']))
  assert.equal(trio.members['1'].energy, trio.members['2'].energy)
  assert.equal(trio.members['2'].energy, trio.members['3'].energy)
})

test('机关有明确线索、耗材预检原子、同趟定墟只能抵消一次', () => {
  const run = runFixture()
  advance(run)
  assert.match(run.node.hint, /先断青木/)
  assert.equal(taichuChoices(run).some(x => x.key === 'disarm:wood'), true)
  const before = structuredClone(run)
  assert.equal(actTaichuRun(run, '1', 'suppress', { ...actor, materials: {} }, options).ok, false)
  assert.deepEqual(run, before)
  assert.deepEqual(actTaichuRun(run, '1', 'suppress', { ...actor, bonuses: { seal: 0.25 } }, options).consume, { 天衍阵纹: 3 })
  advance(run, () => 'force', { setCount: 6 })
  assert.equal(run.instability, 0)
  assert.equal(run.dingxuUsed, true)
  advance(run, () => 'force', { setCount: 6 })
  assert.equal(run.instability, 1)
})

test('寻宝只提高普通材料，周核心最多2次，领奖幂等', () => {
  const ledger = {}
  for (let n = 0; n < 3; n++) {
    const run = clearRun()
    const claim = getTaichuSettlement(run, '1', ledger, now, options)
    assert.equal(claim.coreEligible, n < 2)
    assert.equal(claim.items.太初印 || 0, n < 2 ? 1 : 0)
    assert.equal(commitTaichuSettlement(run, '1', ledger, now, options), true)
    assert.equal(commitTaichuSettlement(run, '1', ledger, now, options), false)
    assert.deepEqual(getTaichuSettlement(run, '1', ledger, now + 8 * 86400000, options), claim)
  }
  assert.equal(ledger['1'].coreCount, 2)
  const normal = clearRun(), lucky = runFixture()
  while (lucky.phase === 'active') advance(lucky, correctAction, { treasure: 0.25 })
  assert.equal(getTaichuSettlement(normal, '1', {}, now, options).items.太初印, getTaichuSettlement(lucky, '1', {}, now, options).items.太初印)
  assert.equal(taichuWeek(Date.UTC(2026, 10, 8, 15, 59)), '2026-11-02')
  assert.equal(taichuWeek(Date.UTC(2026, 10, 8, 16, 0)), '2026-11-09')
})

test('同时生成多份结算计划也只能预留两次核心额度，过期可通过查询结算', () => {
  const ledger = {}, runs = [clearRun(), clearRun(), clearRun()]
  assert.deepEqual(runs.map(run => getTaichuSettlement(run, '1', ledger, now, options).coreEligible), [true, true, false])
  for (const run of runs) commitTaichuSettlement(run, '1', ledger, now, options)
  assert.equal(ledger['1'].coreCount, 2)
  assert.equal(Object.keys(ledger['1'].pending).length, 0)
  const expired = runFixture(), store = { runs: { [expired.id]: expired } }
  expired.members['1'].sealed.月魄石 = 2
  assert.equal(findPlayerTaichuRun(store, '1', { includeEnded: true, now: expired.expiresAt }).phase, 'failed')
  assert.deepEqual(getTaichuSettlement(expired, '1', {}, now, options).items, { 月魄石: 2 })
})

test('弱战力处理机制仍需承担固定挑战，错误机关会败退并加战败磨损', () => {
  const weak = runFixture()
  for (let count = 0; weak.phase === 'active' && count < 25; count++) {
    if (weak.members['1'].energy < 12) supplyTaichuRun(weak, '1', options)
    actTaichuRun(weak, '1', correctAction(weak), { ...actor, power: 100 }, options)
  }
  assert.equal(weak.phase, 'failed')
  const run = runFixture()
  advance(run)
  for (let index = 0; index < 3; index++) actTaichuRun(run, '1', 'force', actor, options)
  let last
  while (run.phase === 'active') {
    if (run.members['1'].energy < 12) supplyTaichuRun(run, '1', options)
    // 故意不处理护盾/蓄力/召唤/标记。
    const incorrect = run.node.kind === 'array' ? 'force' : run.node.kind === 'remnant' ? 'search' : run.node.threat === 'summon' ? 'guard' : 'attack'
    last = actTaichuRun(run, '1', incorrect, actor, options)
  }
  assert.equal(run.phase, 'failed')
  assert.equal(last.wear >= 15, true)
})

test('三路线改变镇守和最终Boss的机制顺序', () => {
  const firstThreats = [], bossThreats = []
  for (const route of ['forge', 'soul', 'tide']) {
    const run = runFixture()
    actTaichuRun(run, '1', route, actor, options)
    while (run.step < 4) advance(run)
    firstThreats.push(run.node.threat)
    while (run.step < 14) advance(run)
    bossThreats.push(run.node.threat)
  }
  assert.deepEqual(firstThreats, ['shield', 'charge', 'summon'])
  assert.deepEqual(bossThreats, ['shield', 'charge', 'summon'])
})

test('撤离、失败与过期只保留封存，未领取不能被清理丢失', () => {
  const run = runFixture()
  while (run.node.kind !== 'remnant') advance(run)
  run.members['1'].loot.月魄石 = 30
  advance(run, () => 'seal', { setCount: 4 })
  assert.equal(Object.values(run.members['1'].sealed).reduce((a, b) => a + b, 0), 12)
  assert.equal(retreatTaichuRun(run, '1', options).ok, true)
  const reward = getTaichuSettlement(run, '1', {}, now, options)
  assert.deepEqual(reward.items, run.members['1'].sealed)
  assert.equal(reward.coreEligible, false)
  const state = { ...emptyTaichuStore(), runs: { [run.id]: run } }
  assert.equal(findPlayerTaichuRun(state, '1', { now }), null)
  assert.equal(findPlayerTaichuRun(state, '1', { includeEnded: true, now }), run)
  cleanupTaichuStore(state, now + 30 * 86400000, options)
  assert.equal(state.runs[run.id], run)
  commitTaichuSettlement(run, '1', state.ledger, now, options)
  cleanupTaichuStore(state, now + 30 * 86400000, options)
  assert.equal(state.runs[run.id], undefined)
  const expired = runFixture()
  expired.members['1'].sealed.月魄石 = 3
  const expState = { ...emptyTaichuStore(), runs: { [expired.id]: expired } }
  assert.equal(cleanupTaichuStore(expState, expired.expiresAt, options), true)
  assert.equal(expired.phase, 'failed')
  assert.deepEqual(getTaichuSettlement(expired, '1', {}, now, options).items, { 月魄石: 3 })
})

test('存档原子写、备份恢复、双份损坏拒绝覆盖及默认关闭不写盘', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taichu-store-'))
  try {
    const opts = { enabled: true, directory }
    const state = emptyTaichuStore(), run = runFixture()
    state.runs[run.id] = run
    assert.equal(saveTaichuStore('../outside', state, { ...opts, enabled: false }), false)
    assert.equal(fs.readdirSync(directory).length, 0)
    assert.equal(saveTaichuStore('../outside', state, opts), true)
    const file = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json')))
    fs.writeFileSync(file, '{broken')
    assert.equal(readTaichuStore('../outside', opts).runs[run.id].id, run.id)
    assert.equal(saveTaichuStore('../outside', state, opts), true)
    fs.writeFileSync(file, '{broken')
    fs.writeFileSync(`${file}.bak`, '{broken')
    assert.throws(() => readTaichuStore('../outside', opts), /均损坏/)
    assert.throws(() => saveTaichuStore('../outside', state, opts))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
