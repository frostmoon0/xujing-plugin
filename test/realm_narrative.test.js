import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { realmNpcTeamIdentity, formatRealmNpcAction } from '../components/realm_narrative.js'
import { _test, genFakeTeams, driveFakeTeams } from '../components/realm_data.js'
import { saveFake } from '../components/fake_data.js'
import { Save_Path } from '../components/plugin.js'

const NOW = new Date('2026-11-11T12:00:00+08:00').getTime()
const sectNameOf = id => ({ qing: '青云宗', tai: '太虚门' })[id] || id
let sequence = 0
const person = (name, sect = '', extra = {}) => ({
  name, sect, status: sect ? 'sect' : 'scatter', alive: true, level: 40,
  path: '正道', trait: '平和', loc: 'center', money: 0,
  bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} }, ...extra
})
const party = () => ({ id: 'fake1', kind: 'fake', name: '青云宗·林青云一行', leader: '林青云', members: ['林青云', '叶轻舟'], step: 0 })
const node = (type, data = {}, text = '') => ({ type, title: '', text, data, choices: [1, 2, 3].map(n => ({ n })) })

function npcText (messages, team) {
  assert.ok(Array.isArray(messages))
  assert.ok(messages.length > 0)
  assert.ok(messages.every(x => typeof x === 'string' && x.trim()))
  const text = messages.join('\n')
  assert.ok(text.includes(team.name), '旁白应明确正在行动的队伍')
  assert.doesNotMatch(text, /我方|对方|\$\{|\{\{|undefined|\[object Object\]/)
  return text
}

function fixture (t, persons = []) {
  const gid = `realm_narrative_${process.pid}_${Date.now()}_${++sequence}`
  const f = { gid, roster: Object.fromEntries(persons.map(p => [p.name, p])), players: {}, sects: { qing: { name: '青云宗' }, tai: { name: '太虚门' } }, sectMap: {}, rogueTeams: {} }
  saveFake(f, gid)
  const st = Object.assign(_test.emptyRealm(), {
    gid, realmId: gid, phase: 'explore', terrain: 'dongtian', diff: 'huang',
    region: 'center', title: '测试秘境', startAt: NOW, endAt: NOW + 60 * 60000
  })
  t.after(() => {
    for (const file of [`${Save_Path}/world/fake_${gid}.json`, `${Save_Path}/realm/realm_${gid}.json`]) {
      for (const suffix of ['', '.bak']) fs.rmSync(`${file}${suffix}`, { force: true })
    }
  })
  return { gid, f, st }
}

test('全员同宗时队名包含真实宗门与指定领队，同宗不同领队可区分', () => {
  const persons = [person('叶轻舟', 'qing'), person('林青云', 'qing')]
  const first = realmNpcTeamIdentity(persons, { leader: '林青云', sectNameOf })
  const second = realmNpcTeamIdentity(persons, { leader: '叶轻舟', sectNameOf })
  assert.equal(first.sectName, '青云宗')
  assert.ok(first.name.includes('青云宗') && first.name.includes('林青云'))
  assert.ok(second.name.includes('青云宗') && second.name.includes('叶轻舟'))
  assert.notEqual(first.name, second.name)
})

test('多宗队与同宗夹散修的队伍均不冒充单一宗门', () => {
  for (const persons of [
    [person('林青云', 'qing'), person('沈长风', 'tai')],
    [person('林青云', 'qing'), person('叶轻舟')],
    [person('林青云'), person('叶轻舟')]
  ]) {
    const identity = realmNpcTeamIdentity(persons, { leader: '林青云', sectNameOf })
    assert.equal(identity.sectName, '')
    assert.ok(identity.name.includes('林青云'))
    assert.notEqual(identity.name, '青云宗')
    assert.notEqual(identity.name, '太虚门')
    assert.doesNotMatch(identity.name, /^(?:青云宗|太虚门)(?:[·\s]|$)/)
  }
})

test('独行者的身份和姓名可辨，空队仍有可用兜底', () => {
  const solo = realmNpcTeamIdentity([person('叶轻舟')], { sectNameOf })
  assert.equal(solo.name, '叶轻舟')
  assert.equal(solo.sectName, '')
  const sectSolo = realmNpcTeamIdentity([person('林青云', 'qing')], { sectNameOf })
  assert.equal(sectSolo.name, '林青云')
  assert.equal(sectSolo.sectName, '青云宗')
  const empty = realmNpcTeamIdentity()
  assert.equal(typeof empty.name, 'string')
  assert.ok(empty.name.trim())
  assert.equal(empty.sectName, '')
})

test('拾宝旁白保留实际物品数量和暴露时长', () => {
  const team = party()
  const messages = ['获得💎灵石×2000、🌿星霜草×3，归入队伍战利品；位置暴露10分钟。']
  const text = npcText(formatRealmNpcAction(team, node('treasure'), 1, messages), team)
  for (const fact of ['灵石', '2000', '星霜草', '3', '暴露', '10分钟']) assert.ok(text.includes(fact), fact)
})

test('战斗旁白指明遭遇目标并保留双方战力与结果', () => {
  const team = party()
  const encounter = node('fake', { targetName: '横江队' }, '与【横江队】相遇。')
  const text = npcText(formatRealmNpcAction(team, encounter, 1, ['⚔️ 我方 2400 · 对方 900 · 胜率80%\n我方获胜。', '夺得奖励池份额：灵石×300']), team)
  for (const fact of ['横江队', '2400', '900', '80%', '300']) assert.ok(text.includes(fact), fact)
  assert.match(text, /胜|得手/)
})

test('搜刮收获和无人可行动的提示始终归实际胜方，落败者不会被写成受益者', () => {
  const team = party()
  const targetName = '横江队'
  const encounter = node('fake', { targetName })
  for (const won of [true, false]) {
    const result = `⚔️ 我方 2400 · 对方 900 · 胜率80%\n我方${won ? '获胜' : '落败'}。`
    const loot = npcText(formatRealmNpcAction(team, encounter, 1, [result, '🧳 夺得奖励池份额：灵石×300', '🎒 从【败者甲】搜得星霜草×2', '搜刮完成，对方仍在场。']), team)
    if (won) {
      assert.doesNotMatch(loot, /【横江队】(?:夺得奖励池|从【败者甲】|搜刮)/)
    } else {
      assert.ok(loot.includes('【横江队】夺得奖励池份额：灵石×300'))
      assert.ok(loot.includes('【横江队】从【败者甲】搜得星霜草×2'))
      assert.ok(loot.includes('【横江队】搜刮'))
    }
    const unavailable = npcText(formatRealmNpcAction(team, encounter, 1, [result, '对方队伍已无人可行动。']), team)
    const winner = won ? team.name : targetName
    const loser = won ? targetName : team.name
    assert.ok(unavailable.includes(`【${winner}】已无人可继续行动`))
    assert.ok(!unavailable.includes(`【${loser}】已无人可继续行动`))
  }
})

test('技术用语替换不会破坏恰好含有我方、对方的真实姓名', () => {
  const team = { ...party(), name: '青云宗·我方星君一行', leader: '我方星君' }
  const targetName = '对方山庄·对方长老队'
  const encounter = node('fake', { targetName }, `与【${targetName}】相遇。`)
  const result = formatRealmNpcAction(team, encounter, 1, ['⚔️ 我方 2400 · 对方 900 · 胜率80%\n我方获胜。'])
  const text = result.join('\n')
  assert.ok(text.includes(team.name))
  assert.ok(text.includes(targetName))
})

test('参悟、闯关、猎杀等失败不被美化为成功，保留损失和伤势', () => {
  const team = party()
  for (const [type, failure] of [
    ['canwu', '参悟失败，遭到道则反噬。'], ['chuangguan', '闯关失败。'],
    ['trial', '迎战落败。'], ['beast', '猎杀失败，遭到妖兽攻击。'],
    ['duojie', '夺宝失败，遭到雷击。'], ['jiemi', '破禁失败，乱源+1。'],
    ['elder', '试探失败，被老者击退。']
  ]) {
    const result = ['⛔ 队命-1，剩余2。', failure, '伤势加重2层。']
    const text = npcText(formatRealmNpcAction(team, node(type, { enemyName: '守园妖兽' }), 1, result), team)
    assert.match(text, /失败|落败|反噬|击退/, type)
    assert.match(text, /队命-1|损失1|损失一/, type)
    assert.match(text, /剩余2|余下2|还剩2/, type)
    assert.ok(text.includes('伤势') && text.includes('2'), type)
    assert.doesNotMatch(text, /成功|获胜|获得|得手/, type)
  }
})

test('绕行旁白说明躲过的妖兽或试炼，避让修士也有明确对象', () => {
  const team = party()
  const beast = npcText(formatRealmNpcAction(team, node('beast', { enemyName: '龙宫蛟卫' }), 3, ['已绕行。']), team)
  assert.ok(beast.includes('龙宫蛟卫'))
  assert.match(beast, /绕|避/)
  const trial = npcText(formatRealmNpcAction(team, node('trial'), 2, ['已绕行。']), team)
  assert.match(trial, /试炼|考验/)
  const encounter = npcText(formatRealmNpcAction(team, node('fake', {}, '与【横江队】相遇。'), 3, ['已避开对方。']), team)
  assert.ok(encounter.includes('横江队'))
  assert.match(encounter, /绕|避|未交战/)
})

test('带异变上下文的遭遇明确绕过或败于异变，不冒充普通试炼', () => {
  const team = party()
  const encounter = { ...node('trial', { eventText: '守园大妖出现在前路。' }), title: '异变拦路' }
  const avoided = npcText(formatRealmNpcAction(team, encounter, 2, ['已绕行。']), team)
  assert.match(avoided, /异变/)
  assert.match(avoided, /绕|避/)
  const lost = npcText(formatRealmNpcAction(team, encounter, 1, ['⛔ 队命-1，剩余2。', '迎战落败。']), team)
  assert.match(lost, /异变/)
  assert.match(lost, /落败/)
  assert.doesNotMatch(`${avoided}\n${lost}`, /试炼守卫|试炼对手|试炼中/)
})

test('不同节点的行动语境可区分，灵泉增益和抉择数值保留', () => {
  const team = party()
  const spring = npcText(formatRealmNpcAction(team, node('spring'), 1, ['淬体完成，本场战力+10%，获得灵石×200。']), team)
  const scroll = npcText(formatRealmNpcAction(team, node('scroll'), 1, ['采得星霜草×3，归入队伍战利品。']), team)
  const rescue = npcText(formatRealmNpcAction(team, node('jueze'), 1, ['救助完成，道心+2，获得修为丹×1。']), team)
  assert.match(spring, /灵泉|淬体/)
  assert.ok(spring.includes('+10%') && spring.includes('200'))
  assert.match(scroll, /采|灵材/)
  assert.ok(scroll.includes('星霜草') && scroll.includes('3'))
  assert.match(rescue, /救助|援手/)
  assert.ok(rescue.includes('道心+2'))
  assert.equal(new Set([spring, scroll, rescue]).size, 3)
})

test('身份和旁白格式化不消耗随机数、不修改输入，空结算不会虚构行动', t => {
  t.mock.method(Math, 'random', () => { assert.fail('文案格式化不得改变实际游戏的随机序列') })
  const persons = [person('林青云', 'qing'), person('叶轻舟', 'qing')]
  const team = party()
  const encounter = node('beast', { enemyName: '守园妖兽' })
  const messages = ['⚔️ 我方 2400 · 守园妖兽 900 · 胜率80%', '猎杀成功，获得灵石×200。']
  const before = structuredClone({ persons, team, encounter, messages })
  realmNpcTeamIdentity(persons, { leader: team.leader, sectNameOf })
  const first = formatRealmNpcAction(team, encounter, 1, messages)
  const second = formatRealmNpcAction(team, encounter, 1, messages)
  assert.deepEqual(first, second)
  assert.deepEqual({ persons, team, encounter, messages }, before)
  assert.deepEqual(formatRealmNpcAction(team, encounter, 1, []), [])
})

test('真实伪玩家组队生成时沿用领队命名，混编队不会错误挂同宗名', t => {
  t.mock.method(Date, 'now', () => NOW)
  t.mock.method(Math, 'random', () => 0)
  for (const mixed of [false, true]) {
    const persons = [person('林青云', 'qing', { pos: 'fuzong' }), person('叶轻舟', mixed ? '' : 'qing')]
    const fix = fixture(t, persons)
    const teams = Object.values(genFakeTeams(fix.gid, fix.st))
    assert.equal(teams.length, 1)
    const team = teams[0]
    assert.ok(team.name.includes(team.leader))
    assert.equal(team.sectName, mixed ? '' : '青云宗')
    assert.deepEqual([...team.members].sort(), persons.map(p => p.name).sort())
  }
})

test('真实探索推进会刷新旧队名并用旁白播报，实际奖励与暴露状态仍准确', async t => {
  t.mock.method(Date, 'now', () => NOW)
  t.mock.method(Math, 'random', () => 0.5)
  const persons = [person('林青云', 'qing', { pos: 'fuzong' }), person('叶轻舟', 'qing')]
  const fix = fixture(t, persons)
  const team = {
    ...party(), name: '青云宗', sectName: '青云宗', entered: true,
    nextActionAt: 0, pool: [], contrib: {}, victory: {}, lives: 3, injured: 0,
    startedAt: NOW, node: {
      ...node('treasure', { reward: [{ name: '修为丹', count: 2, quality: 3 }] }),
      actor: '林青云', choices: [{ n: 1, label: '拾取' }, { n: 2, label: '放弃' }]
    }
  }
  for (const p of persons) p.realmBusy = { realmId: fix.st.realmId, gid: fix.gid }
  fix.st.teams[team.id] = team

  const result = await driveFakeTeams(fix.st, fix.gid, {})

  assert.ok(team.name.includes('林青云'))
  assert.notEqual(team.name, '青云宗')
  assert.equal(team.sectName, '青云宗')
  const text = npcText(result.msgs, team)
  assert.ok(text.includes('修为丹') && text.includes('2') && text.includes('10分钟'))
  assert.equal(team.pool.find(x => x.name === '修为丹')?.count, 2)
  assert.equal(team.exposedUntil, NOW + 10 * 60000)
  assert.equal(team.node, null)
})

test('旧遭遇节点刷新目标当前队名，避让播报不沿用存档里的旧称', async t => {
  t.mock.method(Date, 'now', () => NOW)
  t.mock.method(Math, 'random', () => 0.5)
  const persons = [person('林青云', 'qing'), person('叶轻舟', 'qing'), person('慕容长风', 'tai')]
  const fix = fixture(t, persons)
  const base = { entered: true, nextActionAt: NOW + 60000, pool: [], contrib: {}, victory: {}, lives: 3, injured: 0, startedAt: NOW }
  const target = { ...base, id: 'fake2', kind: 'fake', name: '旧太虚门队', leader: '慕容长风', members: ['慕容长风'] }
  const encounter = { ...node('fake', { target: target.id, targetName: target.name }, `与【${target.name}】相遇。`), actor: '林青云' }
  const team = { ...base, ...party(), node: encounter }
  fix.st.teams = { [team.id]: team, [target.id]: target }

  const result = await driveFakeTeams(fix.st, fix.gid, {})

  assert.equal(encounter.data.targetName, target.name)
  assert.equal(target.name, '慕容长风')
  const text = npcText(result.msgs, team)
  assert.ok(text.includes('慕容长风'))
  assert.doesNotMatch(text, /旧太虚门队/)
  assert.equal(team.lives, 3); assert.equal(target.lives, 3)
  assert.equal(team.injured, 0); assert.equal(target.injured, 0)
  assert.equal(target.engagedBy, undefined)
})
