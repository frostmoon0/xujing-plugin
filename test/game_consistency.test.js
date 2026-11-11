import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import * as equip from '../components/equip_data.js'
import * as fight from '../components/fight.js'
import * as world from '../components/world_data.js'
import * as boss from '../components/boss_data.js'
import * as raid from '../components/raid_data.js'
import * as petData from '../components/pet_data.js'
import * as species from '../components/pet_species.js'
import * as realm from '../components/realm_data.js'
import * as ambush from '../components/ambush.js'
import * as guards from '../components/action_lock.js'
import * as war from '../components/sect/war.js'
import { playerPower } from '../components/sect/utils.js'
import { planWarDeployment } from '../components/sect/war_roster.js'
import { injuryState } from '../components/injury.js'
import { getFake, saveFake, personPower } from '../components/fake_data.js'
import xujing from '../components/xujing_data.js'
import { Wanhun, caveActionBlocked } from '../components/wanhun_data.js'
import { withGameLock } from '../components/game_lock.js'
import { Save_Path, Plugin_Name, Plugin_Path } from '../components/plugin.js'
import { recoverTaichuPlayerTransactions } from '../components/taichu_player.js'
import { playerInTaichu } from '../components/taichu_presence.js'
import { isTaichuEnabled } from '../components/taichu_equipment.js'
import * as taichuCombat from '../components/taichu_combat.js'

const NOW = +new Date(2026, 10, 6, 12)
const NativeDate = Date
class Noon extends NativeDate { constructor (...args) { super(...(args.length ? args : [NOW])) } }
const mem = new Map(), hashes = new Map()
global.redis = {
  get: async k => mem.get(k) ?? null, set: async (k, v) => { mem.set(k, v); return 'OK' },
  del: async k => mem.delete(k), ttl: async k => mem.has(k) ? 600 : -2, expire: async () => 1,
  hGetAll: async k => hashes.get(k) || {}, hSet: async (k, f, v) => hashes.set(k, { ...(hashes.get(k) || {}), [f]: v }),
  incr: async k => { const n = +(mem.get(k) || 0) + 1; mem.set(k, String(n)); return n }
}
global.Bot = { uin: 1, nickname: 'test', pickGroup: () => ({ sendMsg: async () => {}, getMemberMap: async () => new Map() }), pickUser: () => ({ sendMsg: async () => {} }) }
global.segment = { at: String }; global.logger = { error: () => {}, info: () => {} }
let seq = 0
const bag = () => ({ items: {}, equipped: {}, equippedAttr: {}, artifacts: {} })
function fixture () {
  const gid = `consistency_${process.pid}_${++seq}`
  const f = { gid, roster: {}, players: {}, sects: { a: { name: '甲宗', region: 'center', vault: { stones: 100000, mats: {}, pills: {}, equips: {} } }, b: { name: '乙宗', region: 'center' } }, sectMap: { a: { dizi: [], zhishi: [], taishang: [] }, b: { dizi: [], zhishi: [], taishang: [] } }, sectAttacks: [], rogueTeams: {}, areas: { 天墉城: 'b' } }
  saveFake(f, gid)
  return { gid, f, uid: String(90000 + seq) }
}
async function level (g, uid, lv) {
  const b = await xujing.getQQYUserBattle(uid, null, false, g + '.json'); b[uid].level = lv
  await xujing.getQQYUserBattle(uid, b, true, g + '.json')
}
function npc (f, name, extra = {}) {
  return (f.roster[name] = { name, alive: true, status: 'sect', sect: 'a', pos: 'zhishi', level: 20, loc: 'center', money: 1000, bag: bag(), ...extra })
}
function app (file, expression, extra = {}) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?from\s*['"][^'"]+['"];?\r?$/gm, '').replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '').replace(/^export /gm, '')
  return vm.runInNewContext(`${source}\n;(${expression})`, {
    ...equip, ...fight, ...world, ...boss, ...raid, ...petData, ...species, ...guards, ...war, ...ambush, ...taichuCombat,
    fs, path, console, structuredClone, Date: Noon, Math, global: {}, setTimeout, clearTimeout, setInterval,
    withGameLock, xujing_data: xujing, Save_Path, Plugin_Name, Plugin_Path, Wanhun, caveActionBlocked,
    recoverTaichuPlayerTransactions, playerInTaichu, isTaichuEnabled,
    getFake, saveFake, redis: global.redis, Bot: global.Bot, segment: global.segment, logger: global.logger,
    forceLock: async () => true, unlock: async () => true, isCurrent: async () => true,
    recordActive: async () => {}, recordLastCmd: async () => {}, dynastyReadActive: () => null,
    rescuingOf: async () => null, captiveOf: async () => null, playerInRealm: () => false,
    textToImg: async () => null, schedule: { scheduleJob: () => {} }, puppeteer: { screenshot: async () => null },
    plugin: class { constructor (c) { Object.assign(this, c) } }, ...extra
  })
}
function caveFile (gid, uid, pending = null) {
  const file = path.join(Save_Path, 'wanhun', `wanhun_${gid}.json`)
  const u = { cave: { inCave: true, enteredAt: Date.now() - 10 * 60000, nightClockAt: Date.now(), protectionUntil: Date.now() + 3600000, nextEncounterAt: Date.now() - 1, nextRealmDropAt: 0, unprotected: false, pending, loot: {} }, lostUntil: 0, lostInCave: false, realmDrop: { count: 0, nextRecoverAt: 0 } }
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ users: { [uid]: u }, shops: {} }))
  return file
}
const red = Object.keys(equip.EQUIP_TPL).find(n => equip.EQUIP_TPL[n].quality === 6 && equip.EQUIP_TPL[n].type === 'weapon')
const A = { atk: 321, def: 42, hp: 123 }, B = { atk: 222, def: 0, hp: 0 }
function attrsOwned (b) {
  const result = {}
  const add = (attr, count) => { const key = JSON.stringify(attr); result[key] = (result[key] || 0) + count }
  for (const g of b.items[red]?.list || []) add(g.attr, g.count)
  if (b.equipped.weapon === red) add(b.equippedAttr.weapon, 1)
  return result
}

test('Boss致命一击只记剩余血量，死亡后不再读取或计入新攻击者', async () => {
  const { gid, uid } = fixture(); await level(gid, uid, 20)
  const st = { hp: 1, damage: {}, attackGid: {} }
  assert.equal((await boss.attackHit(st, uid, gid)).dmg, 1)
  assert.equal((await boss.attackHit(st, 'other', gid)).dmg, 0)
  assert.equal(st.hp, 0); assert.equal(st.damage[uid], 1); assert.equal(st.damage.other, undefined)
})

test('真实Boss后台在致命一击停止本轮，其后玩家没有尸体贡献或分赃资格', async t => {
  const { gid } = fixture(); await level(gid, '101', 20); await level(gid, '102', 20)
  const now = Date.now(), st = { gid, region: 'center', typeName: '测试Boss', tier: 1, hp: 1, maxHp: 1, damage: {}, attackGid: {}, auto: { 101: { gid, lastHit: now - 60000 }, 102: { gid, lastHit: now - 60000 } }, nextSpawn: now + 86400000, end: now + 3600000, lastBcast: now, token: null }
  let damage, recipients
  const tick = app('apps/user/boss.js', '(killBoss = async s => { capture(s); s.region = null; s.auto = {}; }, bossTick)', {
    getBoss: () => st, saveBoss: () => {}, capture: s => { damage = structuredClone(s.damage); recipients = boss.planBossLoot(s).map(x => x.uid) }
  })
  t.mock.method(Math, 'random', () => 0.5)
  await tick(gid)
  assert.deepEqual(damage, { 101: 1 }); assert.deepEqual(recipients, ['101'])
})

test('登仙令在到期前可抢，到期瞬间与过期后均拒绝，原持令者仍能结算一次', async t => {
  const { gid } = fixture(); t.mock.method(Date, 'now', () => NOW)
  await level(gid, 'holder', 1); await level(gid, 'challenger', 100)
  t.mock.method(Math, 'random', () => 0.5)
  for (const end of [NOW - 1, NOW]) {
    const st = { token: { holder: 'holder', holderGid: gid, end, excluded: [], defended: 0 } }
    assert.equal((await boss.stealGrab(st, 'challenger', gid)).ok, false)
    assert.equal(st.token.holder, 'holder')
    assert.deepEqual(boss.settleToken(st), { holder: 'holder', gid }); assert.equal(boss.settleToken(st), null)
    assert.equal(boss.firstGrab({ token: { holder: null, end } }, 'challenger', gid).ok, false)
  }
  assert.equal((await boss.stealGrab({ token: { holder: 'holder', end: NOW + 1, excluded: [] } }, 'challenger', gid)).ok, true)
})

test('登仙令防守19/20/21次疲劳持续，零倍率不恢复完整战力', async t => {
  const { gid } = fixture(); await level(gid, 'holder', 100); await level(gid, 'challenger', 20)
  t.mock.method(Math, 'random', () => 0.5)
  assert.equal((await boss.stealGrab({ token: { holder: 'holder', end: Date.now() + 60000, excluded: [], defended: 0 } }, 'challenger', gid)).ok, false)
  for (const defended of [19, 20, 21]) {
    const st = { token: { holder: 'holder', end: Date.now() + 60000, excluded: [], defended } }
    assert.equal((await boss.stealGrab(st, 'challenger', gid)).ok, true, String(defended))
  }
})

test('按实际属性组取出装备，分组和数量守恒；不足时不修改原物品', () => {
  const b = bag(); equip.addItemToBag(b, red, 2, A, false); equip.addItemToBag(b, red, 1, B, false)
  const before = structuredClone(b)
  assert.deepEqual(equip.takeBagItems(b, red, 4), []); assert.deepEqual(b, before)
  assert.deepEqual(equip.takeBagItems(b, red, 2), [{ name: red, count: 2, attr: A }])
  assert.equal(b.items[red].count, 1); assert.deepEqual(b.items[red].list, [{ count: 1, attr: B }])
  assert.deepEqual(equip.takeBagItems(b, red, 1), [{ name: red, count: 1, attr: B }]); assert.equal(b.items[red], undefined)
})

test('旧NPC件数少于属性组时，以实际件数为准取走，不能残留零件数幽灵物品', () => {
  const b = bag(); b.items[red] = { count: 1, attr: A, list: [{ count: 1, attr: A }, { count: 1, attr: B }] }
  assert.deepEqual(equip.takeBagItems(b, red, 1), [{ name: red, count: 1, attr: A }]); assert.equal(b.items[red], undefined)
  b.items.修为丹 = 2
  assert.deepEqual(equip.takeBagItems(b, '修为丹', 1), [{ name: '修为丹', count: 1, attr: null }]); assert.equal(b.items.修为丹.count, 1)
})

for (const kind of ['player', 'fake']) for (const idx of [4, 5]) {
  test(`真实秘境搜刮${kind}背包${idx === 4 ? '三成' : '全部'}：属性不重抽，物品逐组守恒`, async () => {
    const { gid, f, uid } = fixture(), victim = 'victim'
    const b = kind === 'player' ? equip.getBag(victim, gid) : bag()
    b.items = {}; b.equipped = {}; b.equippedAttr = {}
    equip.addItemToBag(b, red, 2, A, false); equip.addItemToBag(b, red, 1, B, false)
    if (kind === 'player') equip.saveBag(victim, b, gid)
    else npc(f, victim, { bag: b })
    const target = { id: 't', kind, name: '目标队', members: [victim], pool: [], contrib: {} }
    const winner = { id: 'w', kind: 'player', name: '胜者', leader: uid, members: [uid], pool: [], contrib: {}, pendingDisposal: { targetId: 't', victim, disposalVersion: 2 }, node: { type: 'disposal', data: { disposalVersion: 2 }, choices: realm.disposalChoices(target) } }
    const st = Object.assign(realm._test.emptyRealm(), { gid, phase: 'explore', terrain: 'dongtian', diff: 'huang', teams: { t: target, w: winner } })
    assert.equal((await realm.resolveDisposal(st, gid, winner, idx, { loot_cap: 5 })).valid, true)
    const taken = idx === 4 ? 1 : 3
    assert.equal(winner.pool.reduce((sum, x) => sum + x.count, 0), taken)
    assert.ok(winner.pool.every(x => x.attr && [321, 222].includes(x.attr.atk)))
    assert.equal(b.items[red]?.count || 0, 3 - taken)
    assert.equal((b.items[red]?.list || []).reduce((sum, x) => sum + x.count, 0), 3 - taken)
    await realm.settleTeamNow(st, winner, gid)
    const total = { ...attrsOwned(b) }
    for (const [attr, n] of Object.entries(attrsOwned(equip.getBag(uid, gid)))) total[attr] = (total[attr] || 0) + n
    assert.deepEqual(total, { [JSON.stringify(A)]: 2, [JSON.stringify(B)]: 1 })
  })
}

test('藏宝阁真实围剿惩罚按属性分组交给攻击者，穿戴不扣', async t => {
  const { gid, uid } = fixture(), donor = equip.getBag('victim', gid)
  donor.items = {}; donor.equipped = { helmet: '花布冠' }; donor.equippedAttr = { helmet: { def: 2, hp: 8 } }
  equip.addItemToBag(donor, red, 2, A, false); equip.addItemToBag(donor, red, 1, B, false); equip.saveBag('victim', donor, gid)
  t.mock.method(Math, 'random', () => 0.3)
  const penalty = app('apps/user/raid.js', 'applyPenalty')
  await penalty(gid, { uid: 'victim', level: 1 }, false, uid)
  assert.equal(donor.items[red], undefined); assert.equal(donor.equipped.helmet, '花布冠')
  assert.deepEqual(attrsOwned(equip.getBag(uid, gid)), { [JSON.stringify(A)]: 2, [JSON.stringify(B)]: 1 })
})

test('失魂NPC不能调兵，旧参战名单也会剔除，恢复后重新具备资格', async t => {
  const { gid, f } = fixture(); let time = NOW; t.mock.method(Date, 'now', () => time)
  const p = npc(f, '失魂者', { fakeLostUntil: NOW + 10 * 3600000 })
  assert.equal(planWarDeployment(f, gid, 'a', 'center', [p], 1).units.length, 0)
  const atk = { id: 1, phase: 'fight', atkSect: 'a', defSect: 'b', targetType: 'area', target: '天墉城', atkFakes: [p.name], defFakes: [], atkPlayers: [], defPlayers: [], start: NOW }
  f.sectAttacks = [atk]
  assert.equal(await war.computeAtkPower(f, gid, atk), 0); assert.deepEqual(atk.atkFakes, [])
  f.sectAttacks = []; time = p.fakeLostUntil
  assert.equal(planWarDeployment(f, gid, 'a', 'center', [p], 1).units.length, 1)
})

test('伏击只挑可行动路人，失魂/被俘/关押/在途/仆从不入池', () => {
  const { f } = fixture()
  npc(f, '失魂', { fakeLostUntil: Date.now() + 60000 }); npc(f, '被俘'); npc(f, '关押'); npc(f, '在途', { fakeTravel: {} }); npc(f, '仆从', { servantOf: 'owner' })
  f.sectAttacks = [{ phase: 'done', captives: { fakes: ['被俘'], players: [] } }]; f.sectJails = { b: [{ name: '关押' }] }
  assert.equal(ambush.genPassers(f, 'center'), null)
  npc(f, '正常')
  assert.deepEqual(ambush.genPassers(f, 'center').names, ['正常'])
})

for (const phase of ['waiting', 'won', 'timeout']) {
  test(`伏击${phase}执行前重查目标状态，不能攻击或搜刮已离区/入秘境者`, async () => {
    const { gid, f, uid } = fixture()
    const p = npc(f, '旧目标', { loc: 'west', realmBusy: { realmId: 'other', gid } })
    const key = `xujing:ambush:${gid}:${uid}`, st = { gid, uid, phase: phase === 'waiting' ? 'waiting' : 'won', loc: 'center', names: [p.name], reaction: 'beg', dispAt: Date.now() - 1 }
    await redis.set(key, JSON.stringify(st))
    if (phase === 'waiting') assert.equal((await ambush.ambushAct(gid, uid, 'hit')).ok, false)
    else if (phase === 'won') assert.equal((await ambush.ambushDispose(gid, uid, '搜刮再杀')).ok, false)
    else await ambush.ambushTickOne(st)
    assert.equal(p.alive, true); assert.equal(p.money, 1000); assert.equal(await redis.get(key), null)
  })
}

for (const penalty of ['jail', 'lost', 'moving']) {
  test(`灵兽真实数字处理器在${penalty}状态复查后拒绝捕获，保持遭遇和背包`, async () => {
    const { gid, uid } = fixture(), state = petData.getPetState(gid)
    state.encounter[uid] = { speciesId: species.SPECIES[0].id, quality: 1, region: 'center', mode: 'egg', expireAt: Date.now() + 60000, maxAtk: 10, maxDef: 10, maxHp: 100 }; petData.savePetState(state)
    if (penalty === 'jail') await raid.setJail(uid, 10, gid)
    if (penalty === 'moving') world.getWorld(gid).moving[uid] = { end: Date.now() + 60000 }
    if (penalty === 'lost') {
      const file = caveFile(gid, uid), data = JSON.parse(fs.readFileSync(file, 'utf8')); data.users[uid].lostUntil = Date.now() + 60000; fs.writeFileSync(file, JSON.stringify(data))
    }
    const Base = app('model/api/api.js', 'YuePlugin'), Pet = app('apps/user/pet.js', 'pet', { plugin: Base })
    const messages = [], e = { group_id: gid, user_id: uid, msg: '1', message: [{ type: 'text', text: '1' }], sender: {}, reply: async x => messages.push(x) }
    assert.equal(await new Pet().petPick(e), true)
    assert.equal((state.bag[uid] || []).length, 0); assert.ok(state.encounter[uid]); assert.ok(messages.length)
  })
}

test('正常状态仍可用数字捕获灵兽，不影响已有交互', async () => {
  const { gid, uid } = fixture(), state = petData.getPetState(gid)
  state.encounter[uid] = { speciesId: species.SPECIES[0].id, quality: 1, region: 'center', mode: 'egg', expireAt: Date.now() + 60000, maxAtk: 10, maxDef: 10, maxHp: 100 }; petData.savePetState(state)
  const Pet = app('apps/user/pet.js', 'pet', { plugin: app('model/api/api.js', 'YuePlugin') })
  await new Pet().petPick({ group_id: gid, user_id: uid, msg: '1', message: [{ type: 'text', text: '1' }], sender: {}, reply: async () => {} })
  assert.equal(state.bag[uid].length, 1); assert.equal(state.encounter[uid], undefined)
})

test('万魂窟定仙游的遭遇通知、状态与实际撤退均显示100%，增益过期后战斗胜率刷新', async t => {
  const { gid, uid } = fixture(); t.mock.method(Date, 'now', () => NOW); await level(gid, uid, 10)
  const b = equip.getBag(uid, gid); b.artifacts.dingxianyou = { owned: true, equipped: true }; equip.saveBag(uid, b, gid)
  caveFile(gid, uid); await redis.set(`xujing:atk-buff:${uid}`, '1')
  t.mock.method(Math, 'random', () => 0.5)
  const notices = []; await Wanhun.tickCave(uid, gid, text => notices.push(text))
  assert.match(notices[0], /撤退成功率：100%/)
  const pending = Wanhun.getCave(uid, gid).cave.pending, old = pending.winChance
  await redis.del(`xujing:atk-buff:${uid}`)
  const current = fight.guardWinRate(fight.calcCombatPower(10, b, await fight.getBuffs(uid, gid), gid, uid).power, pending.power)
  assert.notEqual(current, old)
  assert.match(await Wanhun.caveStatus(uid, gid), new RegExp(`战斗胜率${current}%`))
  assert.match((await Wanhun.resolveCave(uid, gid, 'retreat')).msg, /100%/)
})

test('无定仙游时状态显示与实际战斗使用相同当前胜率', async t => {
  const { gid, uid } = fixture(); t.mock.method(Date, 'now', () => NOW); await level(gid, uid, 10)
  caveFile(gid, uid, { type: 'battle', name: '阴魂', power: 1763, winChance: 99, retreatChance: 99 })
  const rate = fight.guardWinRate(fight.calcCombatPower(10, equip.getBag(uid, gid), await fight.getBuffs(uid, gid), gid, uid).power, 1763)
  assert.match(await Wanhun.caveStatus(uid, gid), new RegExp(`战斗胜率${rate}%，撤退成功率${rate}%`))
  t.mock.method(Math, 'random', () => 0.99)
  const result = await Wanhun.resolveCave(uid, gid, 'fight')
  assert.match(result.msg, new RegExp(`单局胜率${rate}%`)); assert.equal(result.lost, true)
})

test('重伤在宗门、秘境、决斗、Boss、试炼伤害中统一扣一次，恢复后自然回升', async t => {
  const { gid, f, uid } = fixture(); let time = NOW; t.mock.method(Date, 'now', () => time); t.mock.method(Math, 'random', () => 0.5)
  await level(gid, uid, 40); await level(gid, 'opponent', 40)
  const b = equip.getBag(uid, gid), base = fight.calcCombatPower(40, b, 1, gid, uid).power
  f.players[uid] = { sect: 'a', injury: { level: 3, at: NOW } }
  const wounded = Math.round(base * 0.4)
  assert.equal(fight.calcCombatPower(40, b, 1, gid, uid).power, wounded)
  assert.equal(await playerPower(f, gid, uid), wounded)
  assert.equal(await realm.refreshTeamPower(gid, { kind: 'player', members: [uid] }), wounded)
  assert.equal(fight.fightWinRate(40, 40, uid, 'opponent', 8, 1, 1, gid).myPower, wounded)
  assert.equal(fight.calcDamage(40, b, 0, 1, gid, uid).power, wounded)
  assert.equal((await boss.attackHit({ hp: 100000, damage: {}, attackGid: {} }, uid, gid)).dmg, Math.round(wounded / 2))
  const p = npc(f, '伤员', { level: 40, bag: structuredClone(b), injury: { level: 3, at: NOW } })
  assert.equal(personPower(p), wounded)
  time += 480 * 60000
  assert.equal(fight.calcCombatPower(40, b, 1, gid, uid).power, base); assert.equal(await playerPower(f, gid, uid), base)
})

test('散修伤势同样生效，跨群不串伤；战力查询不会初始化新NPC世界', async t => {
  const { gid, f, uid } = fixture(); t.mock.method(Date, 'now', () => NOW); await level(gid, uid, 40)
  const b = equip.getBag(uid, gid), base = fight.calcCombatPower(40, b, 1, gid, uid).power
  f.injuries = { [uid]: { level: 2, at: NOW } }
  assert.equal(fight.calcCombatPower(40, b, 1, gid, uid).power, Math.round(base * 0.6))
  const other = gid + '_other', file = path.join(Save_Path, 'world', `fake_${other}.json`)
  assert.equal(fs.existsSync(file), false)
  assert.equal(fight.calcCombatPower(40, b, 1, other, uid).power, base); assert.equal(fs.existsSync(file), false)
})

test('未命中世界缓存时只读持久化伤势，不迁移或重写世界文件', async t => {
  const gid = `consistency_disk_${process.pid}_${++seq}`, uid = 'disk'; t.mock.method(Date, 'now', () => NOW)
  const file = path.join(Save_Path, 'world', `fake_${gid}.json`), original = JSON.stringify({ players: { [uid]: { injury: { level: 3, at: NOW } } } })
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, original)
  const b = bag(), base = fight.calcCombatPower(40, b, 1).power
  assert.equal(fight.calcCombatPower(40, b, 1, gid, uid).power, Math.round(base * 0.4))
  assert.equal(fs.readFileSync(file, 'utf8'), original)
  assert.equal(injuryState({ level: 3, at: NOW }, NOW + 480 * 60000).pct, 0)
})

test('灵兽守护胜率与统一守卫算法一致，相同比例不因绝对数值改变', () => {
  for (const [me, enemy] of [[10000, 11000], [100, 10000], [10000, 100], [5000, 5000]]) assert.equal(petData.parentWinRate(me, enemy), fight.guardWinRate(me, enemy))
  assert.equal(petData.parentWinRate(10000, 11000), 44)
  assert.equal(petData.parentWinRate(10000, 11000), petData.parentWinRate(100000, 110000))
})

test('灵兽守护实际捕获也按统一概率抽签，不把有概率的低胜率强制判负', t => {
  const { gid, uid } = fixture(), state = petData.getPetState(gid)
  state.encounter[uid] = { speciesId: species.SPECIES[0].id, quality: 1, region: 'center', mode: 'parent', parentPower: 100000, expireAt: Date.now() + 60000, maxAtk: 10, maxDef: 10, maxHp: 100 }
  t.mock.method(Math, 'random', () => 0.05)
  assert.equal(petData.resolveEncounter(state, uid, 1, Date.now(), 100).ok, true)
})
