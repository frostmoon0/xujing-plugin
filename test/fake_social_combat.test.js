import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { EVENT_GENS, genFight, killPerson, createKillGrudge, createVendetta, cultivatePerson, fakeSubThreshold, personPower, addPerson, getFake } from '../components/fake_data.js'
import { Save_Path } from '../components/plugin.js'
import { ensureFakeRelations, repairFakeRelations, rememberFakeRelation, setFakeSpouses, addFakeEnemy, clearFakeFeud } from '../components/fake_relations.js'
import { FAKE_LUCK_TIERS, ensureFakeLuck, luckyChance, luckyDeathRate, pickLuckyFake } from '../components/fake_luck.js'
import { hasBloodFeud, defeatDeathRate, canInflictCombatDeath } from '../components/sect/survival.js'
import { resolveRoundCasualties, settleDefeatDeaths } from '../components/sect/war.js'
import { resolveNpcEncounter } from '../components/npc_action.js'
import { absoluteWinRate, guardWinRate } from '../components/fight.js'

global.logger ||= { info () {}, warn () {}, error () {} }
const NOW = Date.now()
let seq = 0
function person (name, level = 12, extra = {}) {
  const p = { name, level, alive: true, status: 'scatter', loc: 'center', money: 0, exp: 0, accum: 0, luckTier: 1, lifeAt: 1, joinAt: 1, trait: '好斗', path: '正道', loyalty: 80,
    bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} }, ...extra }
  ensureFakeRelations(p)
  return p
}
function world (...people) {
  return { gid: `social_combat_${process.pid}_${++seq}`, roster: Object.fromEntries(people.map(p => [p.name, p])), pool: [], poolPriority: [], poolBans: {},
    sects: { a: { name: '甲宗', vault: {} }, b: { name: '乙宗', vault: {} } }, sectMap: {}, players: {}, major: [], minor: [], byPerson: {}, bySect: {}, trades: [], deathRecords: {} }
}
const event = name => EVENT_GENS.find(fn => fn.name === name)
function zero (t) { t.mock.method(Math, 'random', () => 0) }

test('夺爱不能抢自己的道侣成为自我道侣', t => {
  zero(t)
  const a = person('甲'), b = person('乙'), f = world(a, b)
  setFakeSpouses(f, a, b)
  assert.equal(event('genStealWife')(f, NOW), null)
  assert.equal(a.relations.spouse, '乙'); assert.equal(b.relations.spouse, '甲')
})
test('夺爱成功双向配对，同时解除夺爱者原配并记恨', t => {
  zero(t)
  const a = person('甲', 68), b = person('乙', 1), c = person('丙', 1), d = person('丁', 1), f = world(a, c, b, d)
  setFakeSpouses(f, a, b); setFakeSpouses(f, c, d)
  assert.ok(event('genStealWife')(f, NOW))
  assert.equal(a.relations.spouse, '丁'); assert.equal(d.relations.spouse, '甲')
  assert.equal(b.relations.spouse, null); assert.equal(c.relations.spouse, null)
  assert.ok(b.relations.enemies.includes('甲')); assert.ok(c.relations.enemies.includes('甲'))
})
test('炼气无法夺走仙帝的道侣', t => {
  zero(t)
  const a = person('甲', 1), b = person('乙', 68), c = person('丙', 68), f = world(a, b, c)
  setFakeSpouses(f, b, c)
  assert.equal(event('genStealWife')(f, NOW), null)
  assert.equal(b.relations.spouse, '丙')
})
test('关系人死亡释放道侣、师徒和亲友引用，同名新人不会继承关系', () => {
  const a = person('甲'), b = person('乙'), f = world(a, b)
  setFakeSpouses(f, a, b)
  a.relations.master = '乙'; b.relations.disciples = ['甲']
  for (const key of ['friends', 'confidants', 'siblings', 'kin']) { a.relations[key] = ['乙']; b.relations[key] = ['甲'] }
  killPerson(f, b, '测试死亡', NOW)
  assert.equal(a.relations.spouse, null); assert.equal(a.relations.master, null)
  for (const key of ['friends', 'confidants', 'siblings', 'kin']) assert.deepEqual(a.relations[key], [])
  f.roster.乙 = person('乙', 12, { lifeAt: NOW + 1 })
  assert.equal(a.relationLives?.乙, undefined)
})
test('旧档清除缺失、自指、单向配偶与旧生涯引用，保留正常双向关系且幂等', () => {
  const a = person('甲'), b = person('乙'), c = person('丙'), d = person('丁'), f = world(a, b, c, d)
  a.relations.spouse = '失踪'; b.relations.spouse = '丙'; c.relations.spouse = '丙'
  a.relations.friends = ['丁']; d.relations.friends = ['甲']; a.relationLives = { 丁: 0 }
  b.relations.confidants = ['丁']; d.relations.confidants = ['乙']
  assert.equal(repairFakeRelations(f), true)
  for (const p of [a, b, c]) assert.equal(p.relations.spouse, null)
  assert.deepEqual(a.relations.friends, []); assert.deepEqual(d.relations.friends, [])
  assert.deepEqual(b.relations.confidants, ['丁']); assert.equal(b.relationLives.丁, 1)
  assert.equal(repairFakeRelations(f), false)
})
test('旧档没有生涯标记时，死亡记录也能隔离同名新人', () => {
  const a = person('甲'), b = person('乙', 12, { lifeAt: 30 }), f = world(a, b)
  a.relations.spouse = '乙'; b.relations.spouse = '甲'; f.deathRecords.乙 = { t: 20 }
  repairFakeRelations(f)
  assert.equal(a.relations.spouse, null); assert.equal(b.relations.spouse, null)
})
test('丧偶者可重新结缘，直接师徒和手足不能被随机配对', t => {
  zero(t)
  const a = person('甲'), b = person('乙'), c = person('丙'), f = world(a, b, c)
  setFakeSpouses(f, a, b); killPerson(f, b, '死亡', NOW)
  assert.ok(event('genRomance')(f, NOW)); assert.equal(a.relations.spouse, '丙')
  for (const relation of ['master', 'siblings']) {
    const x = person('甲'), y = person('乙'), w = world(x, y)
    if (relation === 'master') { x.relations.master = '乙'; y.relations.disciples = ['甲'] } else { x.relations.siblings = ['乙']; y.relations.siblings = ['甲'] }
    assert.equal(event('genRomance')(w, NOW), null)
  }
})
for (const mode of ['remote', 'jail', 'realm', 'travel', 'self', 'one-way']) test(`双修不允许${mode}关系/状态`, t => {
  zero(t)
  const a = person('甲'), b = person('乙'), f = world(a, b)
  setFakeSpouses(f, a, b)
  if (mode === 'remote') b.loc = 'west'
  if (mode === 'jail') f.sectJails = { a: [{ name: '乙' }] }
  if (mode === 'realm') b.realmBusy = {}
  if (mode === 'travel') b.fakeTravel = {}
  if (mode === 'self') a.relations.spouse = '甲'
  if (mode === 'one-way') b.relations.spouse = null
  assert.equal(event('genShuangxiu')(f, NOW), null)
  assert.equal(a.exp, 0); assert.equal(b.exp, 0)
})
test('正常双修各获得一次收益，知己关系重复事件不再刷出', t => {
  zero(t)
  const a = person('甲'), b = person('乙'), f = world(a, b)
  setFakeSpouses(f, a, b)
  assert.ok(event('genShuangxiu')(f, NOW)); assert.equal(a.exp, 20); assert.equal(b.exp, 20)
  assert.ok(event('genBond')(f, NOW)); assert.equal(event('genBond')(f, NOW), null)
})
test('和解同步清空双向血仇、生涯索引和对应灭门对象，保留其它仇家', t => {
  zero(t)
  const a = person('甲'), b = person('乙'), c = person('丙'), f = world(a, b, c)
  addFakeEnemy(a, b, true); addFakeEnemy(b, a, true); addFakeEnemy(a, c, true)
  a.vendetta = { culprit: ['乙', '丙'] }; b.vendetta = { culprit: ['甲'] }
  assert.ok(event('genReconcile')(f, NOW))
  assert.equal(hasBloodFeud(a, b), false); assert.equal(hasBloodFeud(b, a), false)
  assert.deepEqual(a.vendetta.culprit, ['丙']); assert.equal(b.vendetta, null)
  assert.equal(hasBloodFeud(a, c), true)
})
test('灭门复仇只追真实凶手，杀掉一个后其余凶手仍被追踪', t => {
  zero(t)
  const a = person('甲', 68, { status: 'sect', sect: 'a' }), b = person('乙', 1), c = person('丙', 1), d = person('丁', 1), f = world(a, b, c, d)
  addFakeEnemy(a, b)
  assert.equal(createVendetta(f, 'a', ['丙', '丁'], 'sect', NOW), 1)
  assert.ok(hasBloodFeud(a, c))
  event('genVendetta')(f, NOW)
  assert.equal(f.roster.丙, undefined); assert.equal(b.alive, true)
  assert.deepEqual(a.vendetta.culprit, ['丁'])
})
test('秘境实际击杀入口也为死者亲友建立血仇', () => {
  const a = person('甲'), b = person('乙'), c = person('丙'), f = world(a, b, c)
  setFakeSpouses(f, b, c)
  const source = fs.readFileSync(new URL('../components/realm_data.js', import.meta.url), 'utf8')
  const code = source.match(/^function killFakePerson \([\s\S]*?^\}/m)[0]
  const kill = vm.runInNewContext(`${code};killFakePerson`, { getFake: () => f, saveFake: () => {}, createKillGrudge, killPerson })
  const loser = { id: 'loser', members: ['乙'] }, st = { title: '测试秘境', teams: { loser } }
  kill('test', st, loser, '乙', { kind: 'fake', leader: '甲', name: '甲队' })
  assert.equal(f.roster.乙, undefined); assert.ok(hasBloodFeud(c, a))
})
test('秘境混战两个出手方向都不保留炼气战胜仙帝的10%保底', async t => {
  zero(t)
  const source = fs.readFileSync(new URL('../components/realm_data.js', import.meta.url), 'utf8')
  const code = source.match(/^async function meleeFight \([\s\S]*?^\}/m)[0]
  for (const reverse of [false, true]) {
    const weak = person('炼气', 1), strong = person('仙帝', 68), f = world(weak, strong), killed = []
    const teams = [weak, strong].map(p => ({ id: p.name, name: p.name, kind: 'fake', members: [p.name] }))
    const fight = vm.runInNewContext(`${code};meleeFight`, {
      Math, absoluteWinRate, guardWinRate, luckyDeathRate, AMBUSH_TAKE: 0.3,
      ambushPower: async (gid, team) => personPower(f.roster[team.members[0]]),
      wearRealmTeam: async () => {}, takePoolShare: () => ({ items: [], money: 0 }),
      currentFakePersons: (gid, team) => team.members.map(n => f.roster[n]).filter(p => p?.alive),
      killFakePerson: (gid, st, team, name) => { killed.push(name); killPerson(f, f.roster[name], '秘境战死', NOW); return { level: 1 } }
    })
    await fight({}, 'test', ...(reverse ? teams.reverse() : teams))
    assert.deepEqual(killed, ['炼气']); assert.ok(strong.alive)
  }
})
test('切磋按真实战力判胜负，不增加任何人的击杀数', t => {
  zero(t)
  const a = person('甲', 1), b = person('乙', 68), f = world(a, b)
  assert.match(genFight(f, NOW).txt, /乙 技高一筹/)
  assert.equal(a.kills || 0, 0); assert.equal(b.kills || 0, 0); assert.equal(b.duelWins, 1); assert.ok(b.alive)
})
test('真实旧战役种子：炼气不能让获胜的仙帝随机战死或被俘', async () => {
  const a = person('仙帝', 68, { status: 'sect', sect: 'a' }), b = person('炼气', 1, { status: 'sect', sect: 'b' }), f = world(a, b)
  const war = { id: 30724, start: 1, round: 1, roundWinner: 'atk', atkSect: 'a', defSect: 'b', atkFakes: ['仙帝'], defFakes: ['炼气'], atkPlayers: [], defPlayers: [], moraleA: 100, moraleD: 100 }
  await resolveRoundCasualties(f, f.gid, war, NOW, personPower(a), personPower(b))
  assert.ok(a.alive); assert.ok(war.atkFakes.includes('仙帝')); assert.equal(a.injury, undefined)
})
test('最终败方结算也不能被不足以杀伤自己的弱军随机判死', () => {
  const a = person('仙帝', 68, { status: 'sect', sect: 'a' }), b = person('炼气', 1, { status: 'sect', sect: 'b' }), f = world(a, b)
  for (let id = 1; id <= 100; id++) settleDefeatDeaths(f, { id, atkFakes: ['仙帝'], defFakes: ['炼气'] }, 'a', 'b', false, false, NOW)
  assert.ok(a.alive)
})
test('攻打死亡率随境界严格降低，仙帝以上继续下降；合力足够仍可威胁强者', () => {
  const levels = [1, 4, 12, 36, 64, 68, 78, 136, 567]
  for (let i = 1; i < levels.length; i++) assert.ok(defeatDeathRate(levels[i]) < defeatDeathRate(levels[i - 1]))
  assert.ok(defeatDeathRate(567) > 0)
  assert.equal(canInflictCombatDeath(100, 10200), false)
  assert.equal(canInflictCombatDeath(10200, 10200), true)
})
test('七档气运独立抽取并持久保留，最高档只占抽取池0.2%', () => {
  assert.equal(FAKE_LUCK_TIERS.length, 7)
  const total = FAKE_LUCK_TIERS.reduce((s, x) => s + x.weight, 0)
  let before = 0
  for (let tier = 1; tier <= 7; tier++) {
    const p = {}
    assert.equal(ensureFakeLuck(p, () => (before + FAKE_LUCK_TIERS[tier - 1].weight / 2) / total), tier)
    assert.equal(ensureFakeLuck(p, () => { throw Error('不应重抽') }), tier)
    before += FAKE_LUCK_TIERS[tier - 1].weight
  }
  assert.equal(FAKE_LUCK_TIERS[6].weight / total, 0.002)
})
test('旧档首次补齐气运立即保存，再次加载不重新随机', t => {
  const f = world(person('甲'))
  f.preRan = true; f.bagVersion = 2
  fs.mkdirSync(`${Save_Path}/world`, { recursive: true })
  const seed = `${Save_Path}/world/fake_${f.gid}.json`
  fs.writeFileSync(seed, JSON.stringify(f))
  getFake(f.gid)
  const old = JSON.parse(fs.readFileSync(seed, 'utf8'))
  assert.equal(repairFakeRelations(old), false)
  delete old.roster.甲.luckTier
  old.gid += '_old'
  const file = `${Save_Path}/world/fake_${old.gid}.json`
  fs.writeFileSync(file, JSON.stringify(old))
  let roll = 0.999
  t.mock.method(Math, 'random', () => roll)
  assert.equal(getFake(old.gid).roster.甲.luckTier, 7)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.roster.甲.luckTier, 7, '未触发其它迁移也必须立即保存气运')
  roll = 0
  saved.gid += '_reload'
  fs.writeFileSync(`${Save_Path}/world/fake_${saved.gid}.json`, JSON.stringify(saved))
  assert.equal(getFake(saved.gid).roster.甲.luckTier, 7)
  saved.gid += '_self'
  saved.roster.甲.relations.spouse = '甲'
  saved.roster.甲.relations.master = '甲'
  saved.roster.甲.relations.kin = ['甲']
  const broken = `${Save_Path}/world/fake_${saved.gid}.json`
  fs.writeFileSync(broken, JSON.stringify(saved))
  getFake(saved.gid)
  const repaired = JSON.parse(fs.readFileSync(broken, 'utf8')).roster.甲
  assert.equal(repaired.relations.spouse, null); assert.equal(repaired.relations.master, null)
  assert.deepEqual(repaired.relations.kin, []); assert.equal(repaired.luckTier, 7)
})
test('气运之子不按名字或名额绑定，死后消失，不继承或转移，同名新人重新抽取', t => {
  let roll = 0.999
  t.mock.method(Math, 'random', () => roll)
  const f = world()
  f.sectMap.a = { zongzhu: null, fuzong: [], taishang: [], zhishi: [], dizi: [] }
  const a = addPerson(f, '甲', 'a', 'zhishi', 12)
  const b = addPerson(f, '乙', 'a', 'zhishi', 12)
  assert.equal(a.luckTier, 7); assert.equal(b.luckTier, 7)
  roll = 0
  const c = addPerson(f, '丙', 'a', 'zhishi', 12)
  assert.equal(c.luckTier, 1)
  setFakeSpouses(f, a, c)
  const before = c.money
  killPerson(f, a, '陨落', NOW)
  assert.equal(f.roster.甲, undefined)
  assert.ok(c.money > before, '亲属仍正常继承财物')
  assert.equal(c.luckTier, 1, '财物继承不会传递气运')
  assert.equal(b.luckTier, 7)
  killPerson(f, b, '陨落', NOW)
  assert.ok(Object.values(f.roster).every(p => p.luckTier !== 7), '死亡不会将称号转给其它在世者')
  const next = addPerson(f, '甲', 'a', 'zhishi', 1)
  assert.notEqual(next, a); assert.equal(next.luckTier, 1)
  roll = 0.999
  assert.equal(addPerson(f, '丁', 'a', 'zhishi', 1).luckTier, 7)
})
test('气运仅改变原有概率，基准档不变，最高档也有失败和死亡概率', () => {
  assert.equal(luckyChance(60, { luckTier: 1 }), 60)
  let growth = 0, death = Infinity
  for (let tier = 1; tier <= 7; tier++) {
    const p = { luckTier: tier }, chance = luckyChance(60, p), risk = luckyDeathRate(0.08, p)
    assert.ok(chance >= growth && chance < 100); assert.ok(risk > 0 && risk <= death)
    growth = chance; death = risk
  }
  assert.equal(luckyChance(0, { luckTier: 7 }), 0)
  assert.ok(luckyChance(90, { luckTier: 7 }) < 100)
  assert.equal(luckyChance(99.5, { luckTier: 1 }), 99.5)
  assert.equal(luckyChance(99.5, { luckTier: 7 }), 99.5, '加成封顶不能反过来降低原有概率')
  assert.equal(luckyChance(100, { luckTier: 7 }), 100)
  const a = person('甲'), b = person('乙', 12, { luckTier: 7 })
  assert.equal(personPower(a), personPower(b), '气运不直接提高战力')
})
test('高气运提高被既有机缘选中的概率，同时普通档仍能获得机缘', () => {
  const a = person('甲'), b = person('乙', 12, { luckTier: 7 })
  assert.equal(pickLuckyFake([a, b], () => 0), a)
  assert.equal(pickLuckyFake([a, b], () => 0.4), b)
})
test('最高气运提高突破概率但不额外增加本次修炼收益，也不保证突破', async t => {
  let values
  t.mock.method(Math, 'random', () => values.shift() ?? 0.999)
  const ordinary = person('甲', 1), lucky = person('乙', 1, { luckTier: 7 }), f = world(ordinary, lucky)
  for (const p of [ordinary, lucky]) { p.exp = fakeSubThreshold(2); p.bag.items.破障丹 = { count: 2 } }
  values = [0, 0.95]; await cultivatePerson(f, ordinary)
  values = [0, 0.95]; await cultivatePerson(f, lucky)
  assert.equal(ordinary.level, 1); assert.equal(lucky.level, 2)
  const fail = person('丙', 1, { luckTier: 7, exp: fakeSubThreshold(2) }); fail.bag.items.破障丹 = { count: 1 }
  values = [0, 0.999]; await cultivatePerson(f, fail); assert.equal(fail.level, 1)
  assert.equal(ordinary.exp + ordinary.accum, lucky.exp + lucky.accum)
})
test('最高气运遭遇真正强敌仍可能死亡，随机点落在降低后的区间内即可触发', t => {
  zero(t)
  const a = person('甲', 68, { path: '魔道' }), b = person('乙', 12, { luckTier: 7 }), f = world(a, b)
  const result = resolveNpcEncounter(f, [a], b, personPower, NOW, { lethal: true })
  assert.equal(result.won, true); assert.equal(result.kill, true)
})
