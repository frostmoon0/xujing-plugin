import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeCaveTick, personPower, fakeTravelTo, fakeGoalTick, fakeArtifactTick, fakeRareTick, cultivatePerson, breakPerson, pillPerson, stallPerson } from '../components/fake_data.js'
import { planFakeCaveTrip, fakeCaveSupplyTarget } from '../components/fake_cave.js'
import { npcCanAct, npcCanParticipate, npcInCave } from '../components/npc_action.js'
import { caveEnemyPower, GHOST_ENCOUNTER_CHANCE } from '../components/cave_rules.js'

const NOON = +new Date(2026, 10, 7, 12)
const MINUTE = 60000
function person (name, level = 40, stones = 1) {
  return { name, alive: true, status: 'scatter', loc: 'west', level, money: 100000, bag: { items: stones ? { 魂石: { count: stones } } : {}, equipped: {}, equippedAttr: {}, artifacts: {} } }
}
function fixture (t, level = 40, stones = 1) {
  const clock = { now: NOON, random: () => 0 }
  t.mock.method(Date, 'now', () => clock.now)
  t.mock.method(Math, 'random', () => clock.random())
  const f = { gid: 'cave_behavior', roster: { a: person('a', level, stones), b: person('b', level, stones) }, sects: {}, sectMap: {}, sectAttacks: [], fakeCaves: [] }
  const tick = (minutes = 0, value = 0.5) => { clock.now = NOON + minutes * MINUTE; clock.random = typeof value === 'function' ? value : () => value; fakeCaveTick(f, f.gid, clock.now) }
  return { f, clock, tick, enter: () => tick(0, 0) }
}
function forcedParty (f, clock, { protection = 10, plan = 120, next = 1 } = {}) {
  for (const p of Object.values(f.roster)) delete p.bag.items.魂石
  const party = { names: Object.keys(f.roster), startedAt: clock.now, nightClockAt: clock.now, nextAt: clock.now + next * MINUTE, stoneAt: clock.now + protection * MINUTE, loot: {}, members: {} }
  for (const n of party.names) party.members[n] = { plannedMinutes: plan, protectionUntil: party.stoneAt, stonesSpent: 1, loot: {} }
  f.fakeCaves.push(party)
  return party
}

test('阴魂曲线与8%幽魂概率为玩家/伪玩家同源', () => {
  assert.equal(caveEnemyPower(0), 400)
  assert.equal(caveEnemyPower(45), 28000)
  assert.equal(caveEnemyPower(60), 32000)
  assert.equal(caveEnemyPower(80), 40000)
  assert.equal(caveEnemyPower(90), 48000)
  assert.equal(GHOST_ENCOUNTER_CHANCE, 0.08)
})

test('一颗魂石可完成短途探索：保护到期前离开，战利品实际保留', t => {
  const { f, tick, enter } = fixture(t)
  enter(); assert.equal(f.fakeCaves.length, 1)
  const plan = f.fakeCaves[0].members.a.plannedMinutes
  assert.ok(plan >= 3 && plan <= 9)
  for (let m = 1; m <= 10; m++) tick(m)
  assert.equal(f.fakeCaves.length, 0)
  for (const p of Object.values(f.roster)) {
    assert.equal(p.fakeCaveLastTrip.outcome, 'safe')
    assert.equal(p.fakeCaveLastTrip.stonesSpent, 1)
    assert.equal(p.fakeCaveLost, undefined)
    assert.equal(p.bag.items.魂石, undefined)
    for (const [n, c] of Object.entries(p.fakeCaveLastTrip.loot)) assert.equal(p.bag.items[n].count, c)
    assert.ok(Object.keys(p.fakeCaveLastTrip.loot).length)
  }
})

test('低战力不消耗魂石入窟，强者可规划更深行程', t => {
  const { f, enter } = fixture(t, 4, 5)
  enter(); assert.equal(f.fakeCaves.length, 0)
  assert.equal(f.roster.a.bag.items.魂石.count, 5)
  const mid = person('mid', 40, 10), high = person('high', 567, 10)
  const a = planFakeCaveTrip(mid, personPower(mid)), b = planFakeCaveTrip(high, personPower(high))
  assert.ok(a.ok && b.ok && b.minutes > a.minutes)
  assert.ok(b.minutes > 50)
})

test('不为一两分钟额外消耗整颗魂石', t => {
  const { f, tick, enter } = fixture(t, 120, 5)
  enter()
  const minutes = f.fakeCaves[0].members.a.plannedMinutes
  assert.ok(minutes % 10 >= 3)
  for (let m = 1; m <= minutes; m++) tick(m)
  assert.equal(f.roster.a.fakeCaveLastTrip.stonesSpent, 2)
  assert.equal(f.roster.a.bag.items.魂石.count, 3)
})

test('补给目标随安全深度增长，强者不再永远只补一颗', t => {
  fixture(t)
  const mid = person('mid', 40, 1), stronger = person('stronger', 120, 1), high = person('high', 567, 1)
  assert.equal(fakeCaveSupplyTarget(mid, personPower(mid)), 1)
  assert.equal(fakeCaveSupplyTarget(stronger, personPower(stronger)), 2)
  assert.equal(fakeCaveSupplyTarget(high, personPower(high)), 7)
})

test('续费只在保护到期扣一次，强者不受旧45分钟上限限制', t => {
  const { f, tick, enter } = fixture(t, 567, 6)
  enter()
  for (let m = 1; m <= 46; m++) tick(m)
  assert.equal(f.fakeCaves.length, 1)
  assert.equal(f.roster.a.bag.items.魂石.count, 1)
  assert.equal(f.fakeCaves[0].members.a.stonesSpent, 5)
  tick(46); assert.equal(f.roster.a.bag.items.魂石.count, 1)
})

test('幽魂吸收实际入包，并与队伍和个人收益记录守恒', t => {
  const { f, tick, enter } = fixture(t)
  enter(); tick(1, 0)
  assert.equal(f.roster.a.bag.items.无主幽魂.count, 1)
  assert.equal(f.fakeCaves[0].members.a.loot.无主幽魂, 1)
  assert.equal(f.fakeCaves[0].loot.无主幽魂, 2)
  tick(1, 0); assert.equal(f.roster.a.bag.items.无主幽魂.count, 1)
})

test('奖励即时到账，安全离开不重复发奖且有出窟休整时间', t => {
  const { f, tick, enter } = fixture(t)
  enter(); tick(1, 0)
  tick(9); const before = structuredClone(f.roster.a.bag.items)
  tick(10, 0); assert.deepEqual(f.roster.a.bag.items, before)
  assert.equal(f.fakeCaves.length, 0)
  assert.ok(f.roster.a.fakeCaveRestUntil > Date.now())
})

test('队员独立规划，短途队员退出不带走强者或分走他人奖励', t => {
  const { f, tick, enter } = fixture(t, 567, 6)
  f.roster.b.bag.items.魂石.count = 1
  enter(); for (let m = 1; m <= 10; m++) tick(m)
  assert.deepEqual(f.fakeCaves[0].names, ['a'])
  assert.equal(f.roster.b.fakeCaveLastTrip.outcome, 'safe')
  assert.equal(f.roster.a.fakeCaveLastTrip, undefined)
})

test('已有遭遇时用定仙游100%撤退，拥有但未装备仍生效', t => {
  const { f, clock, tick } = fixture(t, 4)
  f.roster.a.bag.artifacts.dingxianyou = { owned: true, equipped: false }
  forcedParty(f, clock); tick(3, 0.99)
  assert.equal(f.roster.a.fakeCaveLastTrip.outcome, 'retreat')
  assert.equal(f.roster.a.fakeCaveLost, undefined)
  assert.deepEqual(f.roster.a.fakeCaveLastTrip.loot, {})
})

test('战败服用一颗还魂丹后退出，重复推进不再扣药', t => {
  const { f, clock, tick } = fixture(t)
  for (const p of Object.values(f.roster)) p.bag.items.还魂丹 = { count: 2 }
  forcedParty(f, clock)
  // 预先降低战力，模拟遇敌瞬间增益或装备变化；不是正常计划的入窟条件。
  for (const p of Object.values(f.roster)) p.level = 1
  tick(3, 0.99)
  assert.equal(f.fakeCaves.length, 0)
  for (const p of Object.values(f.roster)) {
    assert.equal(p.bag.items.还魂丹.count, 1)
    assert.equal(p.fakeCaveLost, undefined)
    assert.equal(p.fakeLostUntil, 0)
    assert.equal(p.fakeCaveLastTrip.outcome, 'pill')
  }
  tick(4, 0.99); assert.equal(f.roster.a.bag.items.还魂丹.count, 1)
})

test('无人救援会真正困窟，过10小时不会自动恢复；附近健康同伴可救出', t => {
  const { f, clock, tick } = fixture(t, 1)
  forcedParty(f, clock); tick(3, 0.99)
  assert.ok(f.roster.a.fakeCaveLost && f.roster.b.fakeCaveLost)
  assert.equal(f.fakeCaves[0].names.length, 2)
  assert.equal(npcCanAct(f, f.roster.a), false)
  tick(605, 0.99); assert.ok(f.roster.a.fakeCaveLost)
  f.roster.c = person('c', 100, 0)
  tick(606, 0.99)
  assert.equal(f.roster.a.fakeCaveLost, undefined)
  assert.ok(f.roster.a.fakeLostUntil > Date.now())
  assert.equal(npcCanAct(f, f.roster.a), false)
  tick(607, 0.99); assert.equal(f.fakeCaves.length, 0)
  assert.equal(f.roster.b.fakeCaveLost, undefined)
  tick(1208, 0.99); assert.equal(npcCanAct(f, f.roster.a), true)
})

test('队友救援不赠送还魂丹、不缩短10小时失魂', t => {
  const { f, clock, tick } = fixture(t, 4)
  f.roster.b.bag.artifacts.dingxianyou = { owned: true }
  forcedParty(f, clock); tick(3, 0.99)
  assert.equal(f.roster.a.fakeCaveLost, undefined)
  assert.equal(f.roster.a.fakeLostUntil, Date.now() + 10 * 3600000)
  assert.equal(f.roster.a.bag.items.还魂丹, undefined)
})

test('被困者后来获得还魂丹可以自救，重复推进不重复奖励', t => {
  const { f, clock, tick } = fixture(t, 1)
  forcedParty(f, clock); tick(3, 0.99)
  f.roster.a.bag.items.还魂丹 = { count: 1 }
  tick(4, 0.99)
  assert.equal(f.roster.a.fakeCaveLost, undefined)
  assert.equal(f.roster.a.bag.items.还魂丹, undefined)
  assert.equal(f.roster.a.fakeLostUntil, 0)
  // 自救者还能送出队友，但不能消除队友的失魂。
  assert.equal(f.roster.b.fakeCaveLost, undefined)
  assert.ok(f.roster.b.fakeLostUntil > Date.now())
})

for (const kind of ['realm', 'travel', 'war', 'jail', 'moved', 'dead']) test(`旧队伍成员变成${kind}不再隔空战斗或获奖`, t => {
  const { f, tick, enter } = fixture(t)
  enter()
  if (kind === 'realm') f.roster.a.realmBusy = {}
  if (kind === 'travel') f.roster.a.fakeTravel = {}
  if (kind === 'war') f.sectAttacks.push({ phase: 'fight', atkFakes: ['a'] })
  if (kind === 'jail') f.sectJails = { s: [{ name: 'a' }] }
  if (kind === 'moved') f.roster.a.loc = 'east'
  if (kind === 'dead') f.roster.a.alive = false
  tick(1, 0)
  assert.equal(f.roster.a.bag.items.无主幽魂, undefined)
  assert.ok(!f.fakeCaves.some(c => c.names.includes('a')))
})

test('入窟统一互斥战争、秘境、伏击和跨区，允许窟内自身推进', t => {
  const { f, enter } = fixture(t)
  enter(); const p = f.roster.a
  assert.equal(npcInCave(f, p), true)
  assert.equal(npcCanAct(f, p), false)
  assert.equal(npcCanParticipate(f, p), false)
  assert.equal(npcCanAct(f, p, Date.now(), { skipCave: true }), true)
  assert.equal(fakeTravelTo(f, p, 'east', Date.now()), false)
  assert.equal(p.loc, 'west')
})

test('窟内不修炼、突破、摆摊或消费日常丹药', async t => {
  const { f, enter } = fixture(t)
  enter(); const p = f.roster.a, before = structuredClone(p)
  assert.equal(await cultivatePerson(f, p), null)
  assert.equal(await breakPerson(f, p), null)
  assert.equal(pillPerson(f, p), null)
  assert.equal(stallPerson(f, p), null)
  assert.deepEqual(p, before)
})

test('旧存档重复编队只保留一次身份，不重复发奖', t => {
  const { f, clock, tick } = fixture(t)
  const party = forcedParty(f, clock)
  f.fakeCaves.push(structuredClone(party))
  tick(1, 0)
  assert.equal(f.roster.a.bag.items.无主幽魂.count, 1)
  assert.equal(f.fakeCaves.length, 1)
})

test('窟内不交易、不打造法宝、不获得窟外稀有奇遇', t => {
  const { f, tick, enter } = fixture(t)
  enter(); f.fakeRareAt = Date.now() - 1
  for (const p of Object.values(f.roster)) {
    p.bag.items.神游蛊 = { count: 1 }
    p.bag.items.玄阴玉 = { count: 5 }; p.bag.items.镇魂晶 = { count: 5 }; p.bag.items.血煞髓 = { count: 5 }
  }
  const before = structuredClone(f.roster.a.bag)
  fakeGoalTick(f, f.gid, Date.now()); fakeArtifactTick(f, Date.now()); fakeRareTick(f, Date.now())
  assert.deepEqual(f.roster.a.bag, before)
  assert.equal(f.roster.a.fakeGoalAt, undefined)
})

test('旧格式队伍懒迁移保留已有收益，不追补掉落或魂石', t => {
  const { f, clock, tick } = fixture(t, 567, 3)
  f.fakeCaves.push({ names: ['a', 'b'], startedAt: clock.now - 5 * MINUTE, nextAt: clock.now + MINUTE, stoneAt: clock.now + 5 * MINUTE, loot: { 阴魂砂: 3 } })
  tick()
  assert.ok(f.fakeCaves[0].members.a.plannedMinutes > 5)
  assert.equal(f.fakeCaves[0].loot.阴魂砂, 3)
  assert.equal(f.roster.a.bag.items.阴魂砂, undefined)
  assert.equal(f.roster.a.bag.items.魂石.count, 3)
})

test('夜间不战斗、不扣魂石，清晨保留剩余行程和保护', t => {
  const { f, clock, enter } = fixture(t, 567, 3)
  clock.now = +new Date(2026, 10, 7, 0, 59)
  fakeCaveTick(f, f.gid, clock.now)
  const party = f.fakeCaves[0], before = party.members.a.protectionUntil, started = party.startedAt
  clock.now = +new Date(2026, 10, 7, 3)
  fakeCaveTick(f, f.gid, clock.now)
  assert.equal(f.roster.a.bag.items.魂石.count, 2)
  assert.deepEqual(party.loot, {})
  clock.now = +new Date(2026, 10, 7, 6)
  clock.random = () => 0.5; fakeCaveTick(f, f.gid, clock.now)
  assert.equal(party.startedAt - started, 5 * 3600000)
  assert.equal(party.members.a.protectionUntil - before, 5 * 3600000)
  assert.equal(f.roster.a.bag.items.魂石.count, 2)
})

test('断线跨过整趟行程直接结束，不补打多轮或倒扣多颗魂石', t => {
  const { f, tick, enter } = fixture(t, 567, 5)
  enter(); tick(100, 0.5)
  assert.equal(f.fakeCaves.length, 0)
  assert.equal(f.roster.a.bag.items.魂石.count, 4)
  assert.deepEqual(f.roster.a.fakeCaveLastTrip.loot, {})
})
