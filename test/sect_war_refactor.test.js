import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Save_Path } from '../components/plugin.js'
import { getFake, saveFake, personPower, fakeGoalTick, fakeRareTick, fakeCaveTick, fakePetTick } from '../components/fake_data.js'
import { getWorld } from '../components/world_data.js'
import { getBag, saveBag, EQUIP_TPL } from '../components/equip_data.js'
import puppeteer from '../model/robot/puppeteer/puppeteer.js'
import xujing_data from '../components/xujing_data.js'
import { Wanhun } from '../components/wanhun_data.js'
import { initWarState, warActorOwner, reconcileWarActors, defenderOf, creditWarRound, syncWarClock } from '../components/sect/war_state.js'
import { planWarDeployment } from '../components/sect/war_roster.js'
import { depositWarLoot, extractWarLoot, takeVaultEquipAttrs } from '../components/sect/war_loot.js'
import { startSectAttack, sectForceAdjust, resolveRound, finishSectAttack, payWarRewards, abortSectAttack, computeDefPower, joinSectFight, resolveSectAttacks } from '../components/sect/war.js'
import { makePeace, recordCoalition, winnerOfCoalition, allyAssist } from '../components/sect/diplomacy.js'
import { handleCaptives, captiveOf, lootPlayerCaptive, liberateDestroyedCaptor } from '../components/sect/captive.js'
import { commandFromWarChoice, parseWarCommand, runWarCommand, warPreview } from '../components/sect/war_commands.js'
import { forceLock, isCurrent, unlock } from '../components/interact.js'
import { CFG_FILE } from '../components/sect/config.js'
import { chooseWarMenu, answerWarMenu } from '../components/sect/war_interaction.js'
import { withDeferredSaveContext, withImmediateSaveContext, saveOrDefer, pendingDeferredSaves, flushDeferredSaves } from '../components/deferred_save.js'

const base = new Date('2026-11-04T12:00:00').getTime()
let seq = 0
const gids = []
function fixture () {
  const gid = `war_refactor_${process.pid}_${++seq}`; gids.push(gid)
  const member = (name, sect, loc = 'center') => ({ name, sect, loc, alive: true, status: 'sect', pos: 'dizi', level: 12, money: 1000, loyalty: 80, trait: '好斗', act: '勤勉', relations: {}, bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} } })
  return {
    gid, sectSeq: 10, sectDeadNames: {}, targetCd: {}, major: [], minor: [], byPerson: {}, areaDef: {}, sectMines: {}, sectJails: {}, areas: { 天墉城: 's2' },
    sects: Object.fromEntries(['s1', 's2', 's3'].map((sid, i) => [sid, { name: ['青云宗', '太虚门', '玄天宗'][i], owner: String((i + 1) * 100), region: 'center', allies: [], enemies: [], facilities: {}, vault: { stones: 100000, mats: {}, pills: {}, equips: {}, gongfas: {} } }])),
    sectMap: Object.fromEntries(['s1', 's2', 's3'].map(sid => [sid, { taishang: [], fuzong: [], zhishi: [], dizi: [] }])),
    players: { 100: { name: '宗主甲', sect: 's1', pos: 'zongzhu' }, 200: { name: '宗主乙', sect: 's2', pos: 'zongzhu' }, 300: { name: '盟主', sect: 's3', pos: 'zongzhu' } },
    roster: { 甲: member('甲', 's1'), 乙: member('乙', 's2'), 丙: member('丙', 's3') }, sectAttacks: []
  }
}
function war (f, overrides = {}) {
  const a = { id: ++f.sectSeq, version: 2, start: base, clockAt: base, prepEnd: base + 1800000, nextRound: base, phase: 'prep', targetType: 'area', target: '天墉城', defSect: 's2', atkSect: 's1', by: 'player', kind: '正面强攻', bonus: 0, atkFakes: ['甲'], defFakes: ['乙'], atkPlayers: [], defPlayers: [], defended: true, defenderDecided: true, round: 0, moraleA: 100, moraleD: 100, captives: { fakes: [], players: [] }, ...overrides }
  f.sectAttacks.push(a); initWarState(f, a, base); return a
}

const cache = new Map()
global.logger ||= { error () {}, warn () {}, info () {} }
global.Bot = { pickGroup: () => ({ sendMsg: async () => true }) }
global.segment = { at: id => ({ type: 'at', qq: id }) }
test.before(() => {
  test.mock.method(puppeteer, 'screenshot', async () => false)
  const timer = global.setTimeout
  test.mock.method(global, 'setTimeout', (fn, ms, ...args) => [5000, 20000].includes(ms) ? { unref () {} } : timer(fn, ms, ...args))
})
global.redis = { async get (k) { return cache.get(k) ?? null }, async set (k, v) { cache.set(k, String(v)); return 'OK' }, async del (k) { return cache.delete(k) }, async keys () { return [] }, async ttl () { return -2 } }
test.after(() => {
  for (const gid of gids) {
    for (const file of [`world/fake_${gid}.json`, `world/world_${gid}.json`]) for (const suffix of ['', '.bak']) fs.rmSync(path.join(Save_Path, file + suffix), { force: true })
    // 此组测试仅在隔离镜像运行，路径由正式路径模块计算。
    fs.rmSync(path.join(Save_Path, 'bag', gid), { recursive: true, force: true })
  }
})

test('同一人只能属于一场战争；旧档重复名单由最早战役占有', () => {
  const f = fixture(); const a = war(f); const b = war(f, { start: base + 1, atkFakes: ['甲', '丙'], defFakes: ['甲', '乙'] })
  reconcileWarActors(f, b)
  assert.equal(warActorOwner(f, 'fake', '甲'), a)
  assert.deepEqual(b.atkFakes, ['丙']); assert.deepEqual(b.defFakes, [])
})

test('小区易主后，守方身份和历史目标不随当前占领者改变', () => {
  const f = fixture(); const a = war(f); f.areas.天墉城 = 's3'; delete f.sects.s2
  assert.equal(defenderOf(f, a), 's2'); assert.equal(a.snapshot.defender, '太虚门')
})

test('跨夜和序列化重启只顺延一次，凌晨不消耗准备时间', () => {
  const a = { phase: 'prep', start: +new Date('2026-11-04T00:59:00'), prepEnd: +new Date('2026-11-04T01:20:00') }
  syncWarClock(a, +new Date('2026-11-04T02:00:00'))
  const b = structuredClone(a); syncWarClock(b, +new Date('2026-11-04T06:00:00'))
  assert.equal(b.prepEnd, +new Date('2026-11-04T06:20:00'))
  syncWarClock(b, +new Date('2026-11-04T06:01:00')); assert.equal(b.pausedMs, 5 * 3600000)
})

test('封海时发起攻打失败不扣款、不移动、不敌对、不让守方出兵', async () => {
  const f = fixture(); f.roster.甲.loc = 'east'
  const w = getWorld(f.gid); w.seal = { region: 'east', owner: 'seal-owner', tier: 5, until: Date.now() + 600000 }
  // getSeal 兼容实际存档字段，直接使用当前字段。
  w.zhenhaiSeal = w.seal
  const before = structuredClone({ sects: f.sects, roster: f.roster })
  const r = await startSectAttack(f, f.gid, 's1', '太虚门', 'player', { count: 1 })
  assert.equal(r.ok, false, r.msg)
  assert.deepEqual({ sects: f.sects, roster: f.roster }, before); assert.equal(f.sectAttacks.length, 0)
})

test('调兵先用本地兵，排除秘境、在途、其他战场、关押和矿工', () => {
  const f = fixture(); f.roster.甲.loc = 'east'; f.roster.丙.sect = 's1'
  assert.deepEqual(planWarDeployment(f, f.gid, 's1', 'center', [f.roster.甲, f.roster.丙], 1).units.map(x => x.name), ['丙'])
  f.roster.甲.realmBusy = { realmId: 'r' }; f.roster.丙.fakeTravel = { to: 'west' }
  assert.equal(planWarDeployment(f, f.gid, 's1', 'center', [f.roster.甲, f.roster.丙]).units.length, 0)
})

test('准备期守方减到零视为弃守，不能取消攻打保住目标', async () => {
  const f = fixture(); const a = war(f)
  const r = await sectForceAdjust(f, f.gid, '200', String(a.id), -1)
  assert.equal(r.ok, true); assert.equal(a.phase, 'prep'); assert.equal(a.defended, false); assert.deepEqual(a.defFakes, [])
})

test('战斗中减兵到下一轮才生效；离场者保留累计贡献', async (t) => {
  const f = fixture(); const a = war(f, { phase: 'fight' })
  t.mock.method(Math, 'random', () => 0.99)
  await sectForceAdjust(f, f.gid, '100', String(a.id), -1)
  assert.deepEqual(a.atkFakes, ['甲'])
  assert.equal(await resolveRound(f, f.gid, a, base + 600000), 'lose')
  assert.deepEqual(a.atkFakes, []); assert.equal(a.actors['fake:甲'].rounds, 1); assert.ok(a.actors['fake:甲'].contribution > 0)
})

test('战斗撤退不能直接取消；当前轮完成后按本方败退', async (t) => {
  const f = fixture(); const a = war(f, { phase: 'fight' })
  t.mock.method(Math, 'random', () => 0.99)
  await abortSectAttack(f, f.gid, a, base, '测试', 'def')
  assert.equal(a.phase, 'fight'); assert.equal(await resolveRound(f, f.gid, a, base + 600000), 'win')
})

test('太上不能隐形参与两处守城，也不会被重复计入战力', async () => {
  const f = fixture(); f.sectMap.s2.taishang = ['乙']
  const a = war(f, { defFakes: [] }); war(f, { atkSect: 's2', atkFakes: ['乙'], defFakes: [], start: base - 1 })
  assert.equal(await computeDefPower(f, f.gid, a), 0)
})

test('累计贡献属于曾经参战的人，最后一刻入场不能夺走战果', async () => {
  const f = fixture(); const a = war(f)
  await creditWarRound(f, a, () => 100, async () => 100, base)
  a.atkFakes = ['丙']; f.roster.丙.level = 68; initWarState(f, a)
  await recordCoalition(f, f.gid, a, 's1'); await recordCoalition(f, f.gid, a, 's3')
  assert.equal(a.coalition.s1.power, 100); assert.equal(a.coalition.s3.power, 0); assert.equal(winnerOfCoalition(a), 's1')
})

test('同一笔玩家军饷中断后重试不重复入账，退场者仍可领取', async (t) => {
  const f = fixture(); const a = war(f, { atkPlayers: ['100'] })
  await creditWarRound(f, a, () => 100, async () => 100, base); a.atkPlayers = []
  const accounts = { 100: { money: 0 } }; let writes = 0
  t.mock.method(xujing_data, 'getQQYUserHome', async (uid, data) => { if (data) { writes++; return data }; return accounts })
  await payWarRewards(f, f.gid, a); const once = accounts[100].money
  a.rewardsPaid = false; a.rewardReceipts = {}; await payWarRewards(f, f.gid, a)
  assert.equal(once, 2000); assert.equal(accounts[100].money, once); assert.equal(writes, 1)
})

test('宗门总部被玩家小队攻破仍永久灭门，重复结算不再次分赃', async (t) => {
  const f = fixture(); const a = war(f, { targetType: 'sect', target: 's2', atkSect: null, rogue: '900', teamName: '破阵队', by: 'rogue', atkFakes: [], atkPlayers: ['900'], defFakes: [], defended: false })
  const accounts = { 900: { money: 0 } }
  t.mock.method(xujing_data, 'getQQYUserHome', async (uid, data) => data || accounts)
  await finishSectAttack(f, f.gid, a, true, base + 1800000)
  assert.equal(a.phase, 'done'); assert.equal(f.sects.s2, undefined); assert.equal(f.sectDeadNames.s2, '太虚门'); assert.equal(f.areas.天墉城, undefined)
  assert.equal(accounts[900].money, 30000)
  await finishSectAttack(f, f.gid, a, true, base + 1800001); assert.equal(accounts[900].money, 30000)
})

test('普通小区失守只易主，不灭掉原宗门', async () => {
  const f = fixture(); const a = war(f, { defFakes: [], defended: false })
  await finishSectAttack(f, f.gid, a, true, base + 1800000)
  assert.equal(f.areas.天墉城, 's1'); assert.ok(f.sects.s2); assert.equal(a.snapshot.defender, '太虚门')
})

test('玩家宗门之间议和需对方接受，同意后才停止战事', () => {
  const f = fixture(); const a = war(f); f.sects.s1.enemies = ['s2']; f.sects.s2.enemies = ['s1']
  assert.equal(makePeace(f, f.gid, 's1', '太虚门').ok, true); assert.equal(a.phase, 'prep')
  assert.equal(makePeace(f, f.gid, 's3', '青云宗', 'accept').ok, false)
  assert.equal(makePeace(f, f.gid, 's2', '青云宗', 'accept').ok, true); assert.equal(a.result, 'peace'); assert.equal(a.phase, 'done')
})

test('盟友只能派NPC，真人成员须自行报名，仍受同场地理限制', async (t) => {
  const f = fixture(); const a = war(f); f.sects.s3.allies = ['s1']
  t.mock.method(Math, 'random', () => 0)
  const r = await allyAssist(f, f.gid, '300', String(a.id), 1)
  assert.equal(r.ok, true, r.msg); assert.ok(a.atkFakes.includes('丙')); assert.ok(!a.atkPlayers.includes('300'))
  assert.equal(joinSectFight(f, f.gid, '300', 'auto', false, String(a.id)).ok, true)
})

test('俘虏菜单固定战役，不能在旧批次已空时处置下一批', async () => {
  const f = fixture(); const a = war(f, { phase: 'done', result: 'win', captives: { fakes: [], players: [], byAtk: { fakes: [], players: [] }, byDef: { fakes: [], players: [] } } })
  const b = war(f, { phase: 'done', result: 'win', captives: { fakes: ['乙'], players: [], byAtk: { fakes: ['乙'], players: [] }, byDef: { fakes: [], players: [] } } })
  const r = await handleCaptives(f, f.gid, 's1', '全杀', null, false, '100', a.id)
  assert.equal(r.ok, false); assert.equal(f.roster.乙.alive, true); assert.deepEqual(b.captives.fakes, ['乙'])
})

test('Redis标记丢失时，持久化俘虏池仍会限制行动', async () => {
  const f = fixture(); war(f, { captives: { fakes: [], players: ['999'] } }); saveFake(f, f.gid)
  assert.equal(getFake(f.gid), f); assert.ok(await captiveOf(f.gid, '999'))
})

test('装备战利品保留背包分组和穿戴属性，宝库取出属性不重掷', () => {
  const name = Object.keys(EQUIP_TPL).find(n => EQUIP_TPL[n].quality === 6)
  const bag = { items: { [name]: { count: 2, list: [{ count: 1, attr: { atk: 123 } }, { count: 1, attr: { atk: 456 } }] } }, equipped: { weapon: name }, equippedAttr: { weapon: { atk: 789 } } }
  const entries = extractWarLoot(bag, 1, () => 0)
  assert.deepEqual(entries.map(x => x.attr.atk), [123, 456, 789])
  const vault = {}; depositWarLoot(vault, entries)
  assert.equal(vault.equips[name], 3); assert.deepEqual(takeVaultEquipAttrs(vault, name, 3).map(x => x.attr.atk), [123, 456, 789])
})

test('搜刮扣款与收款均带收据，重复调用不再次扣物或扣钱', async (t) => {
  const f = fixture(); const uid = '999'; const bag = getBag(uid, f.gid)
  bag.items.修为丹 = { count: 4 }; saveBag(uid, bag, f.gid)
  const accounts = { 999: { money: 1000 } }
  t.mock.method(xujing_data, 'getQQYUserHome', async (uid, data) => data || accounts)
  const options = { toVault: true, receipt: 'war-test-once' }
  const first = await lootPlayerCaptive(f, f.gid, uid, 's1', 1, options)
  const second = await lootPlayerCaptive(f, f.gid, uid, 's1', 1, options)
  assert.deepEqual(first, second); assert.equal(accounts[999].money, 0); assert.equal(f.sects.s1.vault.stones, 101000); assert.equal(f.sects.s1.vault.pills.修为丹, 4)
})

test('数字指令解析、固定战场选择、人数和七项俘虏操作', async () => {
  assert.deepEqual(parseWarCommand('#派兵 １２ ３'), { verb: '派兵', args: ['12', '3'] })
  assert.deepEqual(parseWarCommand('#撤兵'), { verb: '撤退', args: [] })
  const f = fixture(); war(f, { start: Date.now(), prepEnd: Date.now() + 1800000, defenderDecided: false })
  const r = await runWarCommand(f, f.gid, '100', { verb: '派兵', args: [] })
  const selected = commandFromWarChoice(r.menu, 1)
  const amount = await runWarCommand(f, f.gid, '100', selected, r.menu)
  assert.equal(amount.menu.kind, 'amount'); assert.equal(amount.menu.warId, f.sectAttacks[0].id)
  assert.deepEqual(commandFromWarChoice(amount.menu, 3).args, [String(f.sectAttacks[0].id), '3'])
})

test('身份或战场改变后数字选择重新鉴权，不能凭旧菜单调兵', async () => {
  const f = fixture(); const a = war(f)
  const state = { kind: 'amount', verb: '派兵', warId: a.id }
  f.players[100].pos = 'dizi'
  assert.equal((await runWarCommand(f, f.gid, '100', commandFromWarChoice(state, 1), state)).ok, false)
})

test('数字交互被新菜单压住时保留旧菜单，移除新菜单后恢复', async () => {
  await forceLock('g', 'u', 'sect-war'); await forceLock('g', 'u', 'street')
  assert.equal(await isCurrent('g', 'u', 'sect-war'), false)
  await unlock('g', 'u', 'street'); assert.equal(await isCurrent('g', 'u', 'sect-war'), true)
  await unlock('g', 'u', 'sect-war')
})

test('只读攻打预估不会生成战争、消耗丹药、移动或扣费', async () => {
  const f = fixture(); const before = structuredClone(f)
  const r = await warPreview(f, f.gid, '100', '太虚门', 1)
  assert.equal(r.ok, true); assert.match(r.msg, /并非整场获胜率/); assert.deepEqual(f, before)
})

test('后台延迟保存中，结算检查点立即保存并消除旧的延迟写入', async () => {
  const writes = []
  await withDeferredSaveContext(async () => {
    saveOrDefer('war-checkpoint-test', () => writes.push('old'))
    withImmediateSaveContext(() => saveOrDefer('war-checkpoint-test', () => writes.push('checkpoint')))
    assert.deepEqual(writes, ['checkpoint'])
  })
  flushDeferredSaves(); assert.deepEqual(writes, ['checkpoint'])
})

test('同一受伤收据只触发一次万魂护体', () => {
  const f = fixture(); const bag = getBag('100', f.gid)
  bag.artifacts ||= {}; bag.artifacts.wanhun = { equipped: true, rank: 1, shieldReady: true, deployed: true, souls: 100 }
  saveBag('100', bag, f.gid)
  const first = Wanhun.tryShield('100', f.gid, 'injury-once')
  const soul = bag.artifacts.wanhun.souls
  assert.equal(first.used, true); assert.deepEqual(Wanhun.tryShield('100', f.gid, 'injury-once'), first); assert.equal(bag.artifacts.wanhun.souls, soul)
})

test('回合最终写盘失败后保留待恢复检查点，重试不会多算回合或贡献', async (t) => {
  const f = fixture(); const a = war(f, { phase: 'fight' })
  const rename = fs.renameSync
  let commits = 0
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith(`fake_${f.gid}.json`) && ++commits === 2) throw new Error('模拟断盘')
    return rename(from, to)
  })
  await assert.rejects(resolveRound(f, f.gid, a, base + 600000), /检查点保存失败/)
  assert.equal(a.round, 0); assert.equal(a.roundJob.done, false)
  const disk = JSON.parse(fs.readFileSync(`${Save_Path}/world/fake_${f.gid}.json`, 'utf8'))
  assert.equal(disk.sectAttacks[0].round, 0); assert.equal(disk.sectAttacks[0].roundJob.done, false)
  await resolveRound(f, f.gid, a, base + 660000)
  assert.equal(a.round, 1); assert.equal(a.roundHistory.length, 1); assert.equal(a.actors['fake:甲'].rounds, 1)
})

test('结算跨账户打款中断：世界先落盘，恢复时只补未兑现的收据', async (t) => {
  const f = fixture(); const a = war(f, { targetType: 'sect', target: 's2', atkSect: null, rogue: '900', by: 'rogue', atkFakes: [], atkPlayers: ['900', '901'], defFakes: [], defended: false })
  const accounts = { 900: { money: 0 }, 901: { money: 0 } }; let failed = false
  t.mock.method(xujing_data, 'getQQYUserHome', async (uid, data) => {
    if (uid === '901' && !data && !failed) { failed = true; throw new Error('模拟账户暂时不可用') }
    return data || accounts
  })
  await assert.rejects(finishSectAttack(f, f.gid, a, true, base + 1800000), /账户暂时不可用/)
  assert.equal(a.phase, 'settling'); assert.equal(a.settlement.outcomeDone, true); assert.equal(f.sects.s2, undefined)
  assert.equal(accounts[900].money, 15000)
  await finishSectAttack(f, f.gid, a, true, base + 1900000)
  assert.equal(a.phase, 'done'); assert.equal(accounts[900].money, 15000); assert.equal(accounts[901].money, 15000)
})

test('实际数字处理器遵守栈顶和重新鉴权，旧菜单不越权', async (t) => {
  const f = fixture(); saveFake(f, f.gid)
  const read = fs.readFileSync; const exists = fs.existsSync
  t.mock.method(fs, 'existsSync', file => String(file) === CFG_FILE || exists(file))
  t.mock.method(fs, 'readFileSync', (file, ...args) => String(file) === CFG_FILE ? JSON.stringify({ enabledGroups: [f.gid] }) : read(file, ...args))
  const app = { warPick: chooseWarMenu, warCommand: async e => answerWarMenu(e, await runWarCommand(f, f.gid, String(e.user_id), parseWarCommand(e.msg))) }; const replies = []
  const e = { group_id: f.gid, user_id: '100', msg: '#防守策略', reply: async text => replies.push(text) }
  assert.equal(await app.warCommand(e), true)
  const key = `xujing:sect-war-menu:${f.gid}:100`; const menu = cache.get(key)
  await forceLock(f.gid, '100', 'street')
  assert.equal(await app.warPick({ ...e, msg: '2' }), false); assert.equal(cache.get(key), menu)
  await unlock(f.gid, '100', 'street')
  f.players[100].pos = 'dizi'
  assert.equal(await app.warPick({ ...e, msg: '2' }), true)
  assert.equal(f.sects.s1.defensePolicy, undefined); assert.match(replies.at(-1), /只有宗主/)
})

test('实际数字处理器不能绕过失魂等其他玩法锁', async (t) => {
  const f = fixture(); saveFake(f, f.gid)
  const read = fs.readFileSync; const exists = fs.existsSync
  t.mock.method(fs, 'existsSync', file => String(file) === CFG_FILE || exists(file))
  t.mock.method(fs, 'readFileSync', (file, ...args) => String(file) === CFG_FILE ? JSON.stringify({ enabledGroups: [f.gid] }) : read(file, ...args))
  const app = { warPick: chooseWarMenu, warCommand: async e => answerWarMenu(e, await runWarCommand(f, f.gid, String(e.user_id), parseWarCommand(e.msg))) }
  const e = { group_id: f.gid, user_id: '100', msg: '#防守策略', reply: async () => {} }
  await app.warCommand(e)
  t.mock.method(Wanhun, 'isLocked', () => true)
  assert.equal(await app.warPick({ ...e, msg: '2' }), true)
  assert.equal(f.sects.s1.defensePolicy, undefined); assert.ok(cache.get(`xujing:sect-war-menu:${f.gid}:100`))
})

test('已经被灭门的宗门玩家仍可作为战俘被关押和处置', async () => {
  const f = fixture(); const a = war(f, { phase: 'done', result: 'win', defPlayers: ['200'], captives: { fakes: [], players: ['200'], byAtk: { fakes: [], players: ['200'] }, byDef: { fakes: [], players: [] } } })
  delete f.players[200]; delete f.sects.s2
  const r = await handleCaptives(f, f.gid, 's1', '关天牢', null, false, '100', a.id)
  assert.equal(r.ok, true, r.msg); assert.equal(f.sectJails.s1[0].uid, '200'); assert.ok(f.injuries[200])
})

test('战场NPC不同时购物远行、稀有奇遇、探索魔窟或搜寻灵兽', () => {
  const f = fixture(); war(f, { atkFakes: ['甲', '乙', '丙'], defFakes: [] })
  for (const p of Object.values(f.roster)) { p.loc = 'west'; p.fakeGoalAt = 0; p.fakePetAt = 0 }
  const before = structuredClone(f.roster)
  fakeGoalTick(f, f.gid, base); fakeRareTick(f, base); fakeCaveTick(f, f.gid, base); fakePetTick(f, f.gid, base)
  assert.deepEqual(f.roster, before)
})

test('真实战争推进模拟：不同兵力12场完整拉锯均能结束，重试无二次结算', async (t) => {
  let clock = base
  t.mock.method(Date, 'now', () => clock)
  const outcomes = []
  for (let sample = 0; sample < 12; sample++) {
    const f = fixture(); f.players = {}
    for (const s of Object.values(f.sects)) s.owner = null
    f.sectSeq = 100 + sample; f.roster = {}
    for (const [sid, prefix, count, level] of [['s1', '攻', 3 + sample % 5, 8 + sample], ['s2', '守', 3 + (sample * 3) % 5, 12]]) {
      for (let n = 0; n < count; n++) f.roster[prefix + n] = { name: prefix + n, alive: true, status: 'sect', sect: sid, loc: 'center', level, loyalty: 80, trait: '好斗', act: '勤勉', relations: {}, money: 1000, bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} } }
    }
    clock = base
    const r = await startSectAttack(f, f.gid, 's1', '天墉城', 'player', { count: 9, tactic: '正面强攻' })
    assert.equal(r.ok, true, r.msg)
    const a = r.atk
    clock = a.prepEnd; await resolveSectAttacks(f, f.gid, clock)
    for (let step = 0; a.phase !== 'done' && step < 10; step++) { clock += 600000; await resolveSectAttacks(f, f.gid, clock) }
    assert.equal(a.phase, 'done', `样本 ${sample} 未结束`); assert.ok(a.round <= 8)
    for (const s of Object.values(f.sects)) assert.ok(s.vault.stones >= 0)
    const snapshot = JSON.stringify(f)
    await finishSectAttack(f, f.gid, a, a.result === 'win', clock)
    assert.equal(JSON.stringify(f), snapshot)
    outcomes.push({ round: a.round, result: a.result })
  }
  assert.equal(outcomes.length, 12); assert.ok(outcomes.some(x => x.round > 0))
})

test('普通成员仍可使用旧的守指令自行参战，不代替高层决策', async () => {
  const f = fixture(); f.players[201] = { name: '守门弟子', sect: 's2', pos: 'dizi' }
  const a = war(f, { start: Date.now(), prepEnd: Date.now() + 1800000 })
  const result = await runWarCommand(f, f.gid, '201', { verb: '守', args: [String(a.id)] })
  assert.equal(result.ok, true, result.msg); assert.ok(a.defPlayers.includes('201'))
})

test('有宗门身份的小队队员可退战后自行重返，不误走宗门军队入口', async () => {
  const f = fixture(); f.rogueTeams = { t1: { id: 't1', name: '小队', leader: '100', members: ['100', '300'] } }
  const a = war(f, { start: Date.now(), prepEnd: Date.now() + 1800000, targetType: 'sect', target: 's2', by: 'rogue', rogue: '100', atkSect: null, atkFakes: [], atkPlayers: ['100', '300'] })
  assert.equal((await runWarCommand(f, f.gid, '300', { verb: '退战', args: [String(a.id)] })).ok, true)
  assert.ok(!a.atkPlayers.includes('300'))
  assert.equal((await runWarCommand(f, f.gid, '300', { verb: '参战', args: [String(a.id)] })).ok, true)
  assert.ok(a.atkPlayers.includes('300'))
})

test('盟友可继续派兵和只撤本宗兵，不能撤走发起方门人', async (t) => {
  const f = fixture(); const a = war(f, { start: Date.now(), prepEnd: Date.now() + 1800000 }); f.sects.s3.allies = ['s1']
  f.roster.丁 = structuredClone(f.roster.丙); f.roster.丁.name = '丁'
  t.mock.method(Math, 'random', () => 0)
  await allyAssist(f, f.gid, '300', String(a.id), 1)
  assert.equal((await runWarCommand(f, f.gid, '300', { verb: '派兵', args: [String(a.id), '1'] })).ok, true)
  assert.ok(a.atkFakes.includes('丙')); assert.ok(a.atkFakes.includes('丁'))
  assert.equal((await sectForceAdjust(f, f.gid, '300', String(a.id), -9)).ok, true)
  assert.deepEqual(a.atkFakes, ['甲']); assert.equal(a.phase, 'prep')
})

test('旧数字菜单在换宗后失效，不能按新阵营重解释同一选择', async () => {
  const f = fixture(); war(f, { start: Date.now(), prepEnd: Date.now() + 1800000 })
  const opened = await runWarCommand(f, f.gid, '100', { verb: '参战', args: [] })
  f.players[100].sect = 's2'
  const result = await runWarCommand(f, f.gid, '100', commandFromWarChoice(opened.menu, 1), opened.menu)
  assert.equal(result.ok, false); assert.match(result.msg, /身份已改变/)
})

test('关押宗门灭门释放其旧俘虏，保留其他盟友份额', async () => {
  const f = fixture()
  const old = war(f, { phase: 'done', result: 'win', atkSect: 's2', defSect: 's1', captives: {
    fakes: ['甲', '丙'], players: ['999', '998'], byAtk: { fakes: ['甲', '丙'], players: ['999', '998'] }, byDef: { fakes: [], players: [] },
    byShare: { s2: { fakes: ['甲'], players: ['999'] }, s3: { fakes: ['丙'], players: ['998'] } }
  } })
  saveFake(f, f.gid)
  cache.set(`xujing:captive:${f.gid}:999`, '太虚门')
  await liberateDestroyedCaptor(f, f.gid, 's2', base)
  assert.deepEqual(old.captives.fakes, ['丙']); assert.deepEqual(old.captives.players, ['998'])
  assert.equal(await captiveOf(f.gid, '999'), null); assert.ok(await captiveOf(f.gid, '998'))
})

test('已无持久化俘虏记录的残留Redis标记不会锁住自由玩家', async () => {
  const f = fixture(); saveFake(f, f.gid)
  cache.set(`xujing:captive:${f.gid}:999`, '已覆灭宗门')
  assert.equal(await captiveOf(f.gid, '999'), null)
  assert.equal(cache.get(`xujing:captive:${f.gid}:999`), undefined)
})
