import test from 'node:test'
import assert from 'node:assert/strict'
import { _test, enterRealm, openPrivateRealm, genNode, genFakeTeams, applyEvent, advanceTeams, resolveNode, driveFakeTeams, refreshTeamPower, beginAmbush, processAmbushRound } from '../components/realm_data.js'
import { realmNpcChoice, realmNpcAmbush, realmNpcShouldLeave } from '../components/realm_ai.js'
import { saveFake, personPower } from '../components/fake_data.js'
import { calcCombatPower } from '../components/fight.js'
import { getBag, EQUIP_TPL } from '../components/equip_data.js'
import xujing from '../components/xujing_data.js'
import { setDiplomacyRelation } from '../components/sect/diplomacy_state.js'

global.redis = { get: async () => null, set: async () => 'OK', del: async () => 1 }
global.logger ||= { error: () => {}, info: () => {} }
let seq = 0
const guardian = { kind: 'guardian', name: '守园大妖', text: '守园大妖出现。' }
const bag = () => ({ items: {}, equipped: {}, equippedAttr: {}, artifacts: {} })
function fixture () {
  const gid = `realm_ai_${process.pid}_${++seq}`
  const f = { gid, roster: {}, players: {}, sects: { a: { name: '甲宗' }, b: { name: '乙宗' } }, sectMap: {}, rogueTeams: {} }
  saveFake(f, gid)
  const st = Object.assign(_test.emptyRealm(), { gid, realmId: gid, phase: 'explore', terrain: 'dongtian', diff: 'huang', region: 'center', title: '测试秘境', startAt: Date.now(), endAt: Date.now() + 60 * 60000 })
  return { gid, f, st }
}
function npc (fixture, name, level = 40, extra = {}, teamExtra = {}) {
  const p = { name, alive: true, status: 'scatter', level, path: '正道', trait: '平和', bag: bag(), money: 0, ...extra }
  p.realmBusy = { realmId: fixture.st.realmId, gid: fixture.gid }
  fixture.f.roster[name] = p
  const team = { id: name, name, kind: 'fake', leader: name, members: [name], entered: true, node: null, step: 0, pool: [], contrib: {}, victory: {}, lives: 3, injured: 0, nextActionAt: 0, ...teamExtra }
  fixture.st.teams[name] = team
  return { p, team }
}
async function player (fix, uid = '91001', level = 40) {
  const b = await xujing.getQQYUserBattle(uid, null, false, fix.gid + '.json')
  b[uid].level = level
  await xujing.getQQYUserBattle(uid, b, true, fix.gid + '.json')
  return (await enterRealm(fix.st, fix.gid, uid)).team
}
function node (type, data = {}) {
  return { type, title: type, text: '', data, actor: '91001', choices: [1, 2, 3].map(n => ({ n })) }
}

test('新入场真人在第一个普通节点前遇到异变，按真实战力显示并结算', async () => {
  const fix = fixture(), team = await player(fix)
  const expected = calcCombatPower(40, getBag('91001', fix.gid), 1, fix.gid, '91001').power
  delete team.combatPower // 兼容尚未初始化缓存的旧档
  const applied = await applyEvent(fix.st, fix.gid, guardian)
  assert.equal(applied.pushes.length, 1)
  assert.match(team.node.text, new RegExp(`我方战力：${expected}`))
  const result = await resolveNode(fix.st, fix.gid, team, team.node, 1, {})
  assert.match(result.msgs.join('\n'), /迎战获胜/)
  assert.equal(team.lives, 3)
})

test('新伪玩家队异变显示与结算一致，不再显示6000却按1判负', async () => {
  const fix = fixture(), { p, team } = npc(fix, '修士')
  await applyEvent(fix.st, fix.gid, guardian)
  const expected = personPower(p)
  assert.equal(team.combatPower, expected)
  const result = await resolveNode(fix.st, fix.gid, team, team.node, 1, {})
  assert.match(result.msgs[0], new RegExp(`我方 ${expected}`))
  assert.match(result.msgs.join('\n'), /迎战获胜/); assert.equal(team.lives, 3)
})

test('古钥秘境创建时初始化队伍真实战力', async () => {
  const fix = fixture()
  await player(fix)
  const opened = await openPrivateRealm(fix.gid, {}, '91001', 'solo:91001', ['91001'])
  assert.equal(opened.ok, true); assert.ok(opened.team.combatPower > 1000)
})

test('旧队列的1战力文本出队时修正；结算按当前成员和修为刷新', async () => {
  const fix = fixture(), team = await player(fix)
  team.node = node('spring')
  await applyEvent(fix.st, fix.gid, guardian)
  assert.equal(team.eventQueue.length, 1)
  team.eventQueue[0].text = '旧异变\n我方战力：1 · 对方战力：920 · 胜率：10%'
  team.combatPower = 1; team.node = null; team.nextActionAt = 0
  const pending = await advanceTeams(fix.st, fix.gid, {})
  assert.equal(pending.length, 1); assert.match(pending[0].node.text, /我方战力：6037/)
  const b = await xujing.getQQYUserBattle('91001', null, false, fix.gid + '.json')
  b['91001'].level = 1
  await xujing.getQQYUserBattle('91001', b, true, fix.gid + '.json')
  const result = await resolveNode(fix.st, fix.gid, team, team.node, 1, {})
  assert.match(result.msgs[0], /我方 137 /); assert.match(result.msgs.join('\n'), /迎战落败/)
})

test('队员退出后不沿用满队战力；装备、增益和NPC本场伤势均计入', async () => {
  const fix = fixture(), a = await player(fix), b = await player(fix, '91002', 20)
  a.members.push('91002'); delete fix.st.teams[b.id]
  const both = await refreshTeamPower(fix.gid, a)
  a.members.pop()
  assert.ok(await refreshTeamPower(fix.gid, a) < both)
  const { team, p } = npc(fix, '伤员', 40, {}, { powerBoost: 1.1, injured: 2 })
  const expected = Math.round(personPower(p) * 1.1 * 0.76)
  assert.equal(await refreshTeamPower(fix.gid, team), expected)
  team.step = 8
  const beast = await genNode(fix.st, team, fix.gid)
  assert.match(beast.text, new RegExp(`我方战力：${expected}`))
})

test('异变不再给仍在赶路的伪玩家队派发节点或奖励', async () => {
  const fix = fixture(), { team } = npc(fix, '在途', 40, {}, { entered: false })
  await applyEvent(fix.st, fix.gid, guardian)
  assert.equal(team.node, null)
  await applyEvent(fix.st, fix.gid, { kind: 'treasure', name: '秘藏' })
  assert.equal(team.pool.length, 0)
})

test('各类性格在明显不敌时均不挑战妖兽、异变和试炼', () => {
  for (const actor of [{ trait: '好斗' }, { trait: '嗜杀', path: '魔道' }, { trait: '善良' }, { act: '贪玩' }]) {
    for (const type of ['beast', 'trial', 'chuangguan', 'canwu', 'duojie']) {
      const choice = realmNpcChoice({ lives: 3 }, node(type, { requiredPower: 1000 }), actor, { power: 100 })
      assert.notEqual(choice, 1, `${actor.trait}/${type}`)
    }
  }
})

test('普通性格收取安全宝物、灵材和淬体，战力足够时也会过关', () => {
  for (const type of ['treasure', 'scroll', 'spring', 'beast', 'trial', 'chuangguan']) {
    assert.equal(realmNpcChoice({ lives: 3 }, node(type, { requiredPower: 1000 }), { trait: '平和' }, { power: 2000 }), 1, type)
  }
  assert.equal(realmNpcChoice({ lives: 3 }, node('beast', { enemyPower: 1000 }), { trait: '好斗' }, { power: 100 }), 3, '能免费绕行就不付300灵石')
})

test('濒危及有贵重收获时提高交战门槛，性格不会覆盖强弱和友方判断', () => {
  const fight = node('player', { target: 'other' }), actor = { trait: '嗜杀', path: '魔道' }
  assert.equal(realmNpcChoice({ lives: 3 }, fight, actor, { power: 1500, opponentPower: 1000 }), 1)
  assert.notEqual(realmNpcChoice({ lives: 1, pool: [{ quality: 7, count: 1 }] }, fight, actor, { power: 1500, opponentPower: 1000 }), 1)
  assert.notEqual(realmNpcChoice({ lives: 3 }, fight, actor, { power: 9999, opponentPower: 1000, friendly: true }), 1)
})

test('真实AI遇到强妖兽绕行、不花钱、不扣队命，普通性格会拾宝', async () => {
  const fix = fixture(), { team, p } = npc(fix, '好斗者', 1, { trait: '好斗', money: 1000 }, { step: 8 })
  fix.st.diff = 'tian'
  const result = await driveFakeTeams(fix.st, fix.gid, {})
  assert.match(result.msgs.join('\n'), /绕|避/)
  assert.match(result.msgs.join('\n'), /守园妖兽/)
  assert.equal(team.lives, 3); assert.equal(p.money, 1000)
  assert.equal(team.injured, 0); assert.equal(p.injury, undefined)
  assert.deepEqual(team.pool, [])
  team.step = 0; team.nextActionAt = 0; p.trait = '平和'
  await driveFakeTeams(fix.st, fix.gid, {})
  assert.ok(team.pool.length > 0, '普通性格不再白白放弃安全收获')
})

test('NPC不会为了挑战强玩家放弃较弱的可战目标', async () => {
  const fix = fixture(), { team } = npc(fix, '好斗队', 20, { trait: '好斗' }, { step: 3 })
  const strong = await player(fix, '91001', 100)
  const weak = npc(fix, '弱敌', 1).team
  const n = await genNode(fix.st, team, fix.gid)
  assert.equal(n.data.target, weak.id); assert.notEqual(n.data.target, strong.id)
})

test('NPC不会挑选同宗、盟友、停战宗门或亲友为主动攻击目标', async () => {
  for (const relation of ['same', 'allied', 'truce', 'friend']) {
    const fix = fixture(), a = npc(fix, '甲', 100, { sect: 'a', trait: '嗜杀', path: '魔道' }, { step: 2 })
    const b = npc(fix, '乙', 1, { sect: relation === 'same' ? 'a' : 'b' })
    if (relation === 'allied') setDiplomacyRelation(fix.f, 'a', 'b', 'allied')
    if (relation === 'truce') setDiplomacyRelation(fix.f, 'a', 'b', 'neutral', Date.now(), '', { truce: true })
    if (relation === 'friend') a.p.relations = { friends: [b.p.name] }
    const n = await genNode(fix.st, a.team, fix.gid)
    assert.equal(n.type, 'treasure', relation); assert.equal(b.team.engagedBy, undefined)
  }
})

test('目标在选项生成后变强，NPC决策会复核并避让，不照旧缓存硬打', async () => {
  const fix = fixture(), a = npc(fix, '好斗队', 20, { trait: '好斗', money: 1000 }, { step: 2 })
  const b = npc(fix, '弱敌', 1, { money: 2000 }, { nextActionAt: Date.now() + 60000 })
  const n = await genNode(fix.st, a.team, fix.gid)
  assert.equal(n.data.target, b.team.id)
  b.p.level = 100
  const result = await driveFakeTeams(fix.st, fix.gid, {})
  assert.match(result.msgs.join('\n'), /绕|避|错开|未曾交战/)
  assert.ok(result.msgs.join('\n').includes(b.team.name))
  assert.equal(b.team.engagedBy, undefined)
  assert.equal(a.team.lives, 3); assert.equal(b.team.lives, 3)
  assert.equal(a.team.injured, 0); assert.equal(b.team.injured, 0)
  assert.equal(a.p.injury, undefined); assert.equal(b.p.injury, undefined)
  assert.equal(a.p.money, 1000); assert.equal(b.p.money, 2000)
  assert.deepEqual(a.team.pool, []); assert.deepEqual(b.team.pool, [])
})

test('事件队列不覆盖正在处理的遭遇，也不会绕过行动间隔连刷', async () => {
  const fix = fixture(), { team } = npc(fix, '修士', 40)
  team.node = node('spring'); team.node.actor = team.leader
  team.eventQueue = [node('trial', { requiredPower: 900 })]
  await driveFakeTeams(fix.st, fix.gid, {})
  assert.equal(team.powerBoost, 1.1)
  assert.equal(team.eventQueue.length, 1)
  const step = team.step
  await driveFakeTeams(fix.st, fix.gid, {})
  assert.equal(team.step, step); assert.equal(team.eventQueue.length, 1)
})

test('低队命NPC结算真实属性战利品后撤离，释放占用，重跑不会重复领奖', async () => {
  const fix = fixture(), { p, team } = npc(fix, '谨慎者', 40, {}, { lives: 1 })
  const red = Object.keys(EQUIP_TPL).find(n => EQUIP_TPL[n].quality === 6 && EQUIP_TPL[n].type === 'weapon')
  const attr = { atk: 444, def: 3, hp: 55 }
  team.pool.push({ name: red, count: 1, quality: 6, attr }, { name: '灵石', count: 200, currency: true })
  const before = personPower(p)
  const result = await driveFakeTeams(fix.st, fix.gid, {})
  assert.match(result.msgs.join('\n'), /撤离秘境/)
  assert.equal(fix.st.teams[team.id], undefined); assert.equal(p.realmBusy, undefined)
  assert.deepEqual(p.bag.equippedAttr.weapon, attr); assert.equal(p.money, 200); assert.ok(personPower(p) > before)
  await driveFakeTeams(fix.st, fix.gid, {})
  assert.equal(p.money, 200)
})

test('临近出口面对强敌时优先带走收获，充裕时仍正常探索', () => {
  const team = { lives: 3, pool: [{ name: '修为丹', count: 1 }] }
  assert.equal(realmNpcShouldLeave(team, 1000, 10000, 4 * 60000), true)
  assert.equal(realmNpcShouldLeave(team, 1000, 10000, 30 * 60000), false)
  assert.equal(realmNpcShouldLeave({ lives: 1, pool: [] }, 1000, 10000, 4 * 60000), false)
  const now = Date.now()
  const exposed = { ...team, exposedUntil: now + 60000, startedAt: now - 6 * 60000 }
  assert.equal(realmNpcShouldLeave(exposed, 1000, 10000, 30 * 60000, now), true, '已暴露且附近有明显强敌，先保住已有收获')
})

test('被俘、服役、在途和失魂的伪玩家不会报名新秘境', () => {
  const fix = fixture()
  const states = { 正常: {}, 战俘: {}, 矿工: { mineOf: 'a' }, 仆从: { servantOf: 'a' }, 在途: { fakeTravel: { end: Date.now() + 60000 } }, 失魂: { fakeLostUntil: Date.now() + 60000 } }
  for (const [name, state] of Object.entries(states)) {
    const { p } = npc(fix, name, 10, state)
    delete p.realmBusy
  }
  fix.f.sectAttacks = [{ phase: 'done', captives: { fakes: ['战俘'], players: [] } }]
  const random = Math.random
  let teams
  try { Math.random = () => 0; teams = genFakeTeams(fix.gid, fix.st) } finally { Math.random = random }
  assert.deepEqual(Object.values(teams).flatMap(t => t.members), ['正常'])
})

test('曝光后附近有强势敌人时提前结算，普通和平强者不会造成无谓恐慌', async () => {
  for (const aggressive of [true, false]) {
    const fix = fixture(), weak = npc(fix, '弱队', 1, {}, { exposedUntil: Date.now() + 10 * 60000, startedAt: Date.now() - 6 * 60000 })
    npc(fix, '强队', 100, { trait: aggressive ? '嗜杀' : '平和' }, { nextActionAt: Date.now() + 60000 })
    weak.team.pool.push({ name: '修为丹', count: 1 })
    const result = await driveFakeTeams(fix.st, fix.gid, {})
    assert.equal(result.msgs.some(x => x.includes('撤离秘境')), aggressive)
  }
})

test('出口不会仅凭好斗性格送死；强且有利可图才围剿，贵重收获优先离场', () => {
  const enemy = { team: { pool: [{ quality: 6, count: 1 }] }, power: 1000 }
  assert.equal(realmNpcAmbush({ lives: 3 }, { trait: '嗜杀' }, 100, [enemy]), 'flee')
  assert.equal(realmNpcAmbush({ lives: 3 }, { trait: '好斗' }, 3000, [enemy]), 'fight')
  assert.equal(realmNpcAmbush({ lives: 3, pool: [{ quality: 7, count: 2 }] }, { trait: '好斗' }, 3000, [enemy]), 'flee')
  assert.equal(realmNpcAmbush({ lives: 3 }, { trait: '平和' }, 3000, [enemy]), 'flee')
})

test('真实出口初始化按双方当前战力决策，受创或对手变强后可退出围剿', async () => {
  const fix = fixture(), a = npc(fix, '好斗者', 1, { trait: '好斗' }), b = npc(fix, '强敌', 100, { trait: '平和' })
  b.team.pool.push({ name: '修为丹', count: 1 })
  a.team.combatPower = 999999
  await beginAmbush(fix.st, fix.gid, Date.now())
  assert.equal(a.team.ambush, 'flee')
  a.p.level = 100; b.p.level = 1; a.team.ambush = 'fight'; a.team.injured = 2
  const result = await processAmbushRound(fix.st, fix.gid, Date.now())
  assert.match(result.join('\n'), /退出围剿/)
  assert.equal(fix.st.teams[a.team.id], undefined)
})

test('NPC出口不会互殴或拦截友方撤离，战利品保留在原主人', async () => {
  const fix = fixture(), a = npc(fix, '甲', 100, { sect: 'a', trait: '好斗' }), b = npc(fix, '乙', 1, { sect: 'a' })
  const c = npc(fix, '外宗', 1, { sect: 'b', trait: '平和' }, { ambush: 'flee' })
  a.team.ambush = 'fight'; b.team.ambush = 'flee'
  b.team.pool.push({ name: '灵石', count: 500, currency: true }); c.team.pool.push({ name: '修为丹', count: 1 })
  const random = Math.random
  let result
  try { Math.random = () => 0.99; result = await processAmbushRound(fix.st, fix.gid, Date.now()) } finally { Math.random = random }
  assert.equal(b.p.money, 500); assert.equal(fix.st.teams[b.team.id], undefined)
  assert.ok(result.some(x => x.includes('乙') && x.includes('突围成功')))
})

test('两个友方NPC都决定围剿时，不会因随机配对互相伤害', async () => {
  const fix = fixture(), a = npc(fix, '甲', 100, { sect: 'a', trait: '好斗' }), b = npc(fix, '乙', 100, { sect: 'a', trait: '好斗' })
  const enemy = npc(fix, '外宗', 1, { sect: 'b' }, { ambush: 'flee' })
  a.team.ambush = 'fight'; b.team.ambush = 'fight'
  enemy.team.pool.push({ name: '修为丹', count: 2 })
  const random = Math.random
  let result
  try { Math.random = () => 0.99; result = await processAmbushRound(fix.st, fix.gid, Date.now()) } finally { Math.random = random }
  assert.equal(a.team.injured, 0); assert.equal(b.team.injured, 0)
  assert.ok(!result.some(x => x.includes('对阵')))
})
