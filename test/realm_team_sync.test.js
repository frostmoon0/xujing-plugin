import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { Save_Path } from '../components/plugin.js'
import { syncPlayerTeam, playerInRealm, autoPickForPlayer, beginAmbush, processAmbushRound, _test } from '../components/realm_data.js'
import { isPlayerActionLocked } from '../components/action_lock.js'
import { setRaid, delRaid, setJail, delJail } from '../components/raid_data.js'

const REALM_DIR = `${Save_Path}/realm`
const WORLD_DIR = `${Save_Path}/world`

function rm (file) { try { fs.unlinkSync(file) } catch (err) { } }

/** 写一份能通过 getFake 校验(有 sects + 存活 roster)的 fake 档, 内含玩家小队 */
function writeFake (gid, rogueTeams) {
  fs.mkdirSync(WORLD_DIR, { recursive: true })
  fs.writeFileSync(`${WORLD_DIR}/fake_${gid}.json`, JSON.stringify({
    sects: { s1: {} }, roster: { 张三: { name: '张三', alive: true } }, rogueTeams
  }))
}

/** 写一份可自定义 roster 的 fake 档(围剿测试用: 按 level 定战力) */
function writeFakeRoster (gid, roster) {
  fs.mkdirSync(WORLD_DIR, { recursive: true })
  fs.writeFileSync(`${WORLD_DIR}/fake_${gid}.json`, JSON.stringify({ sects: { s1: {} }, roster, rogueTeams: {} }))
}

/** 写一份公开秘境档 */
function writePubRealm (gid, phase, teams) {
  fs.mkdirSync(REALM_DIR, { recursive: true })
  fs.writeFileSync(`${REALM_DIR}/realm_${gid}.json`, JSON.stringify({ phase, teams }))
}

test('转让队长后 syncPlayerTeam 把秘境内队长快照同步为新队长', () => {
  const gid = 'testsync0001'
  writeFake(gid, { rt1: { id: 'rt1', leader: '101', name: '队伍', members: ['100', '101'] } })
  const st = { phase: 'explore', teams: {} }
  const team = {
    id: 'player:party:rt1', kind: 'player', partyId: 'party:rt1',
    leader: '100', partyLeader: '100', partyMembers: ['100'], members: ['100']
  }
  st.teams[team.id] = team

  const changed = syncPlayerTeam(st, gid, team)

  assert.equal(changed, true)
  assert.equal(team.leader, '101', '队长应同步为外部小队当前队长')
  assert.equal(team.partyLeader, '101', 'partyLeader 应同步')
  assert.deepEqual(team.partyMembers, ['100', '101'], 'partyMembers 应同步为新成员名单')
  rm(`${WORLD_DIR}/fake_${gid}.json`)
})

test('syncPlayerTeam 对 solo 队/无外部小队记录不改变快照', () => {
  const gid = 'testsync0002'
  writeFake(gid, { rt1: { id: 'rt1', leader: '101', name: '队伍', members: ['100', '101'] } })
  const st = { phase: 'explore', teams: {} }
  const solo = { id: 'player:solo:9', kind: 'player', partyId: 'solo:9', leader: '9', partyLeader: '9', partyMembers: ['9'], members: ['9'] }
  st.teams[solo.id] = solo
  assert.equal(syncPlayerTeam(st, gid, solo), false, 'solo 队不对外部小队同步')
  assert.equal(solo.leader, '9')

  /* 外部小队已解散(rogueTeams 为空): 保留秘境内快照队长 */
  const team = { id: 'player:party:rt1', kind: 'player', partyId: 'party:rt1', leader: '100', partyLeader: '100', partyMembers: ['100', '101'], members: ['100', '101'] }
  st.teams[team.id] = team
  writeFake(gid, {})
  assert.equal(syncPlayerTeam(st, gid, team), false)
  assert.equal(team.leader, '100', '队伍解散后不覆盖快照队长')
  rm(`${WORLD_DIR}/fake_${gid}.json`)
})

test('playerInRealm 判定公开/专属秘境中的玩家', () => {
  const gid = 'testrealm0001'
  writePubRealm(gid, 'explore', { 'player:party:rt1': { kind: 'player', partyId: 'party:rt1', members: ['100', '101'] } })
  assert.equal(playerInRealm(gid, '100'), true)
  assert.equal(playerInRealm(gid, '102'), false)

  /* 撤离(移出成员)后不再判定为在场 */
  writePubRealm(gid, 'explore', { 'player:party:rt1': { kind: 'player', partyId: 'party:rt1', members: ['101'] } })
  assert.equal(playerInRealm(gid, '100'), false, '已撤离成员不应被判定在秘境中')

  /* 屏障阶段在队同样算; idle 阶段不算 */
  writePubRealm(gid, 'barrier', { 'player:party:rt1': { kind: 'player', partyId: 'party:rt1', members: ['100'] } })
  assert.equal(playerInRealm(gid, '100'), true)
  writePubRealm(gid, 'idle', { 'player:party:rt1': { kind: 'player', partyId: 'party:rt1', members: ['100'] } })
  assert.equal(playerInRealm(gid, '100'), false)

  /* 专属秘境档 */
  const pid = '1680000000000'
  fs.mkdirSync(REALM_DIR, { recursive: true })
  fs.writeFileSync(`${REALM_DIR}/realm_p_${gid}_${pid}.json`, JSON.stringify({
    phase: 'explore', private: true, privateId: pid,
    teams: { 'player:party:rt2': { kind: 'player', partyId: 'party:rt2', members: ['200'] } }
  }))
  assert.equal(playerInRealm(gid, '200'), true)
  assert.equal(playerInRealm(gid, '100'), false)

  rm(`${REALM_DIR}/realm_${gid}.json`)
  rm(`${REALM_DIR}/realm_p_${gid}_${pid}.json`)
})

test('playerInRealm 无秘境档时不创建存档并返回 false', () => {
  const gid = 'testrealm0002'
  rm(`${REALM_DIR}/realm_${gid}.json`)
  assert.equal(playerInRealm(gid, '100'), false)
  assert.equal(fs.existsSync(`${REALM_DIR}/realm_${gid}.json`), false, '查询不应触发建档')
})

test('秘境中 isPlayerActionLocked 判定为锁定, 但 skipRealm 豁免秘境自身', async () => {
  const gid = 'testlock0001'
  writePubRealm(gid, 'explore', { 'player:party:rt1': { kind: 'player', partyId: 'party:rt1', members: ['100'] } })

  /* 在秘境中 → 判定为"脱不开身"(逛街/跨区等裸数字会被 guardActionLocked 拦) */
  assert.equal(await isPlayerActionLocked(gid, '100'), true)
  /* 秘境自身数字决策(pick)传 skipRealm → 秘境锁豁免, 但其它状态锁仍生效 */
  assert.equal(await isPlayerActionLocked(gid, '100', { skipRealm: true }), false)
  /* 不在秘境中的玩家不受秘境锁影响 */
  assert.equal(await isPlayerActionLocked(gid, '999', { skipRealm: true }), false)

  rm(`${REALM_DIR}/realm_${gid}.json`)
})

test('skipBattle 跳过战斗玩法锁(洗劫), 但天牢惩罚锁仍生效', async () => {
  const gid = 'testlock0003'
  const uid = '100'
  const backupFile = `${Save_Path}/raid_backup.json`
  const hadBackup = fs.existsSync(backupFile)
  /* 内存 redis 替身(raid/jail 双写都优先读 redis) */
  const store = new Map()
  global.redis = {
    get: async k => (store.has(k) ? store.get(k) : null),
    set: async (k, v) => { store.set(k, v) },
    del: async k => { store.delete(k) }
  }
  try {
    /* 洗劫中: 判定锁定; skipBattle 跳过(洗劫中可吃丹换装等玩家自身操作) */
    await setRaid(gid, uid, { phase: 'raid', gid, uid })
    assert.equal(await isPlayerActionLocked(gid, uid), true, '洗劫中判定锁定')
    assert.equal(await isPlayerActionLocked(gid, uid, { skipBattle: true }), false, 'skipBattle 跳过洗劫(战斗玩法锁)')
    await delRaid(gid, uid)
    /* 天牢中: 判定锁定; skipBattle 不跳过(天牢是惩罚锁, 不能吃丹换装) */
    await setJail(uid, 1)
    assert.equal(await isPlayerActionLocked(gid, uid), true, '天牢中判定锁定')
    assert.equal(await isPlayerActionLocked(gid, uid, { skipBattle: true }), true, 'skipBattle 不跳过天牢(惩罚锁)')
    await delJail(uid)
  } finally {
    try { await delRaid(gid, uid) } catch (err) { }
    try { await delJail(uid) } catch (err) { }
    delete global.redis
    if (!hadBackup) rm(backupFile)
  }
})

test('玩家队遭遇优先选玩家目标(两队可互相遭遇), 无玩家队时回退伪玩家/宝物', () => {
  /* 有其它玩家队: 'player' 节点目标必须是玩家队, 而非 id 排前的伪玩家队 */
  const st = {
    terrain: 'dongtian', diff: 'huang', teams: {
      A: { id: 'A', kind: 'player', members: ['1'] },
      B: { id: 'B', kind: 'player', members: ['2'] },
      F: { id: 'F', kind: 'fake', members: ['x'] }
    }
  }
  const node = _test.buildNode(st, st.teams.A, 'player')
  assert.equal(node.type, 'player')
  assert.equal(node.data.target, 'B', '有玩家队时应优先遭遇玩家队')
  assert.equal(st.teams.B.engagedBy, 'A', '目标玩家队应被占用, 避免被多队同时盯上')

  /* 只有伪玩家队时回退伪玩家 */
  const st2 = {
    terrain: 'dongtian', diff: 'huang', teams: {
      A: { id: 'A', kind: 'player', members: ['1'] },
      F: { id: 'F', kind: 'fake', members: ['x'] }
    }
  }
  const node2 = _test.buildNode(st2, st2.teams.A, 'player')
  assert.equal(node2.type, 'player')
  assert.equal(node2.data.target, 'F')

  /* 没有其它队时回退宝物节点 */
  const st3 = { terrain: 'dongtian', diff: 'huang', teams: { A: { id: 'A', kind: 'player', members: ['1'] } } }
  const node3 = _test.buildNode(st3, st3.teams.A, 'player')
  assert.equal(node3.type, 'treasure')
})

test('已被其他队伍锁定的玩家队不会再次生成节点，避免双向重复遭遇', async () => {
  const gid = 'testcollision0001'
  const st = _test.emptyRealm()
  st.gid = gid
  st.phase = 'explore'
  st.terrain = 'dongtian'
  st.diff = 'huang'
  st.teams = {
    A: { id: 'A', kind: 'player', leader: '1', members: ['1'], node: null, nextActionAt: 0 },
    B: { id: 'B', kind: 'player', leader: '2', members: ['2'], node: null, engagedBy: 'A', nextActionAt: 0 }
  }
  const pending = await (await import('../components/realm_data.js')).advanceTeams(st, gid, {})
  assert.equal(pending.some(x => x.team.id === 'B'), false)
  assert.equal(st.teams.B.node, null)
})

test('已有待处理节点的队伍不会再次成为第三队遭遇目标', () => {
  const st = { terrain: 'dongtian', diff: 'huang', teams: {
    A: { id: 'A', kind: 'player', members: ['1'] },
    B: { id: 'B', kind: 'player', members: ['2'], node: { type: 'treasure' } },
    C: { id: 'C', kind: 'player', members: ['3'] }
  } }
  const node = _test.buildNode(st, st.teams.C, 'player')
  assert.notEqual(node.data.target, 'B')
})
test('玩家超时未回复的系统代选全部为保守选项', () => {
  assert.equal(autoPickForPlayer({ type: 'treasure' }), 2, '放弃宝物不惊动')
  assert.equal(autoPickForPlayer({ type: 'player' }), 3, '遭遇玩家队避让')
  assert.equal(autoPickForPlayer({ type: 'fake' }), 3, '遭遇伪玩家绕道')
  assert.equal(autoPickForPlayer({ type: 'beast' }), 3, '妖兽绕道')
  assert.equal(autoPickForPlayer({ type: 'chuangguan' }), 2, '闯关取巧过关')
  assert.equal(autoPickForPlayer({ type: 'disposal' }), 1, '处置只搜刮30%不杀不暴露')
  assert.equal(autoPickForPlayer({ type: 'trial' }), 2, '异变绕行避开')
  assert.equal(autoPickForPlayer({ type: 'spring' }), 2)
  assert.equal(autoPickForPlayer({ type: 'elder' }), 2, '问路稳定小奖励')
  assert.equal(autoPickForPlayer({ type: 'unknown' }), 1)
  assert.equal(autoPickForPlayer(null), 1)
})

test('出口围剿初始化: 玩家队收表态菜单, 伪玩家按性格表态, 探索节点清空', () => {
  const gid = 'testambush0001'
  writeFakeRoster(gid, { 强者: { name: '强者', alive: true, level: 100, trait: '好斗' } })
  const st = _test.emptyRealm()
  st.gid = gid
  st.realmId = 'r1'
  st.teams = {
    A: { id: 'A', kind: 'player', name: '玩家队', leader: '1', members: ['1'], node: { type: 'treasure' }, pool: [] },
    B: { id: 'B', kind: 'fake', name: '伪强者队', leader: '强者', members: ['强者'], node: null, pool: [] }
  }
  const pending = beginAmbush(st, gid, 1000000)

  assert.equal(st.ambushAt, 1000000)
  assert.equal(st.ambushChoiceEnd, 1000000 + 45000, '表态宽限期45秒')
  assert.equal(pending.length, 1, '只有玩家队收到表态菜单')
  assert.equal(pending[0].team.id, 'A')
  assert.equal(st.teams.A.ambushNode.type, 'ambush')
  assert.equal(st.teams.A.node, null, '撤退阶段探索节点被清空')
  assert.equal(st.teams.B.ambush, 'fight', '伪玩家好斗性格参与围剿')
  rm(`${WORLD_DIR}/fake_${gid}.json`)
})

test('伪玩家平和性格倾向悄悄溜走', () => {
  const gid = 'testambush0002'
  writeFakeRoster(gid, { 平和者: { name: '平和者', alive: true, level: 1, trait: '平和' } })
  const st = _test.emptyRealm()
  st.gid = gid
  st.realmId = 'r2'
  st.teams = { B: { id: 'B', kind: 'fake', name: '伪平和队', leader: '平和者', members: ['平和者'], node: null, pool: [] } }

  beginAmbush(st, gid, 2000000)

  assert.equal(st.teams.B.ambush, 'flee', '平和性格应倾向溜走')
  rm(`${WORLD_DIR}/fake_${gid}.json`)
})

test('围剿混战: 强队抢弱队池子, 弱溜走队被拦截搜刮后遣返', async () => {
  const gid = 'testambush0003'
  writeFakeRoster(gid, {
    强者: { name: '强者', alive: true, level: 100 },
    弱者: { name: '弱者', alive: true, level: 1 }
  })
  const st = _test.emptyRealm()
  st.gid = gid
  st.realmId = 'r3'
  st.ambushChoiceEnd = 0
  st.teams = {
    strong: { id: 'strong', kind: 'fake', name: '围剿强队', leader: '强者', members: ['强者'], ambush: 'fight', pool: [], injured: 0 },
    weak: { id: 'weak', kind: 'fake', name: '溜走弱队', leader: '弱者', members: ['弱者'], ambush: 'flee', pool: [{ name: '修为丹', count: 10 }], injured: 0 }
  }

  const origRandom = Math.random
  Math.random = () => 0.9 // 战力悬殊胜负确定, 且不触发伪玩家战死(8%概率)
  const msgs = await processAmbushRound(st, gid, Date.now())
  Math.random = origRandom

  const joined = msgs.join('\n')
  assert.ok(joined.includes('第 1 轮混战'), '应推进混战: ' + joined)
  assert.ok(joined.includes('突围失败'), '弱溜走队应被抓: ' + joined)
  assert.ok((st.teams.strong.pool || []).some(x => x.name === '修为丹' && x.count >= 3), '围剿强队应分到被搜刮的30%池子')
  assert.equal(st.teams.weak, undefined, '被抓的溜走队被遣返移除')
  rm(`${WORLD_DIR}/fake_${gid}.json`)
})

test('无围剿者时溜走队成功突围带走战果', async () => {
  const gid = 'testambush0004'
  writeFakeRoster(gid, { 弱者: { name: '弱者', alive: true, level: 1 } })
  const st = _test.emptyRealm()
  st.gid = gid
  st.realmId = 'r4'
  st.ambushChoiceEnd = 0
  st.teams = {
    weak: { id: 'weak', kind: 'fake', name: '溜走队', leader: '弱者', members: ['弱者'], ambush: 'flee', pool: [{ name: '灵石', count: 100, currency: true, quality: 1 }], injured: 0 }
  }

  const origRandom = Math.random
  Math.random = () => 0.9
  const msgs = await processAmbushRound(st, gid, Date.now())
  Math.random = origRandom

  const joined = msgs.join('\n')
  assert.ok(joined.includes('突围成功'), '无围剿者应成功溜走: ' + joined)
  assert.equal(st.teams.weak, undefined, '溜走队提前结算离场')
  rm(`${WORLD_DIR}/fake_${gid}.json`)
})

test('出口围剿搜刮: 单件物品也应被搜走, 不能只剩灵石', async () => {
  const gid = 'testambush0005'
  writeFakeRoster(gid, {
    强者: { name: '强者', alive: true, level: 100 },
    弱者: { name: '弱者', alive: true, level: 1 }
  })
  const st = _test.emptyRealm()
  st.gid = gid
  st.realmId = 'r5'
  st.ambushChoiceEnd = 0
  st.teams = {
    strong: { id: 'strong', kind: 'fake', name: '围剿强队', leader: '强者', members: ['强者'], ambush: 'fight', pool: [], injured: 0 },
    weak: { id: 'weak', kind: 'fake', name: '溜走弱队', leader: '弱者', members: ['弱者'], ambush: 'flee', pool: [{ name: '修为丹', count: 1 }, { name: '星霜草', count: 1 }, { name: '灵石', count: 200, currency: true, quality: 1 }], injured: 0 }
  }

  const origRandom = Math.random
  Math.random = () => 0.9 // 战力悬殊胜负确定, 弱队溜走必被抓
  const msgs = await processAmbushRound(st, gid, Date.now())
  Math.random = origRandom

  const joined = msgs.join('\n')
  assert.ok(joined.includes('突围失败'), '弱溜走队应被抓: ' + joined)
  const strongPool = st.teams.strong?.pool || []
  assert.ok(strongPool.some(x => x.name === '修为丹' && x.count >= 1), '单件修为丹应被搜刮走: ' + JSON.stringify(strongPool))
  assert.ok(strongPool.some(x => x.name === '星霜草' && x.count >= 1), '单件星霜草应被搜刮走: ' + JSON.stringify(strongPool))
  assert.ok(strongPool.some(x => x.name === '灵石' && x.count >= 1), '灵石应被搜刮走: ' + JSON.stringify(strongPool))
  assert.equal(st.teams.weak, undefined, '被抓的溜走队被遣返移除')
  rm(`${WORLD_DIR}/fake_${gid}.json`)
})

