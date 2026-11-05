import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { withGameLock } from '../components/game_lock.js'
import { Save_Path, Plugin_Path, Plugin_Name } from '../components/plugin.js'
import * as equip from '../components/equip_data.js'
import * as world from '../components/world_data.js'
import * as interact from '../components/interact.js'
import * as boss from '../components/boss_data.js'
import * as guards from '../components/action_lock.js'
import * as shop from '../components/shop_data.js'
import { Wanhun, parseWanhunNamedCmd, wanhunNamedCmdReg } from '../components/wanhun_data.js'
import * as realm from '../components/realm_data.js'
import { getFake, saveFake } from '../components/fake_data.js'
import { getPetState, savePetState } from '../components/pet_data.js'
import { calcDamage, getBuffs } from '../components/fight.js'
import xujing_data from '../components/xujing_data.js'
import { teleportPass } from '../components/teleport_pass.js'
import { trialDay, trialWeek, rotateTrialPeriods, settleTrialPeriods } from '../components/trial_periods.js'
import { writeJsonAtomic } from '../components/json_store.js'
import * as zhenhai from '../components/zhenhai_data.js'

const mem = new Map(); const hashes = new Map()
global.redis = {
  get: async k => mem.get(k) ?? null,
  set: async (k, v) => { mem.set(k, v); return 'OK' },
  del: async k => mem.delete(k),
  incr: async k => { const n = Number(mem.get(k) || 0) + 1; mem.set(k, String(n)); return n },
  decr: async k => { const n = Number(mem.get(k) || 0) - 1; mem.set(k, String(n)); return n },
  expire: async () => 1,
  hSet: async (k, f, v) => { hashes.set(k, { ...(hashes.get(k) || {}), [f]: v }) },
  hGetAll: async k => hashes.get(k) || {}, hDel: async () => 1
}
global.Bot = { uin: 1, nickname: 'test', pickGroup: () => ({ sendMsg: async () => {} }), pickUser: () => ({ sendMsg: async () => {} }) }
global.segment = { at: String }; global.logger = { error: () => {}, info: () => {} }
let seq = 0
const gid = () => `integrity_${process.pid}_${++seq}`
const event = (g, uid, msg) => ({ group_id: g, user_id: uid, msg, message: [{ type: 'text', text: msg }], reply: () => {} })
async function money (g, uid, amount) {
  const home = await xujing_data.getQQYUserHome(uid, null, `${g}.json`, false)
  if (amount !== undefined) { home[uid].money = amount; await xujing_data.getQQYUserHome(uid, home, `${g}.json`, true) }
  return home[uid].money
}

// 执行整个真实应用类；仅替换 Yunzai 插件基类、渲染和消息发送。
function app (file, expression, overrides = {}) {
  const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?from\s*['"][^'"]+['"];?\r?$/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '').replace(/^export /gm, '')
  return vm.runInNewContext(`${text}\n;(${expression})`, {
    ...equip, ...world, ...interact, ...boss, ...guards, ...shop,
    fs, path, console, structuredClone, setInterval, setTimeout, clearTimeout, redis: global.redis,
    Save_Path, Plugin_Path, Plugin_Name, withGameLock, xujing_data, Wanhun, teleportPass,
    parseWanhunNamedCmd, wanhunNamedCmdReg, global: {},
    getFake, saveFake, playerSectName: () => null, getNick: async (_g, uid) => String(uid),
    logPlayerTrade: () => {}, Bot: global.Bot, segment: global.segment, logger: global.logger,
    textToImg: async () => null, schedule: { scheduleJob: () => {} },
    plugin: class { constructor (cfg) { Object.assign(this, cfg) } }, ...overrides
  })
}

test('共用群锁串行、允许嵌套，异常后释放；其他群不受阻塞', async () => {
  const g = gid(); let release; const gate = new Promise(r => { release = r }); const order = []
  const a = withGameLock(g, async () => { order.push('a'); await withGameLock(g, async () => order.push('nested')); await gate; order.push('end') })
  const b = withGameLock(g, async () => order.push('b'))
  await withGameLock(`${g}_other`, async () => order.push('other'))
  assert.equal(order.includes('b'), false)
  release(); await Promise.all([a, b])
  assert.ok(order.indexOf('b') > order.indexOf('end'))
  await assert.rejects(withGameLock(g, async () => { throw Error('retry') }))
  assert.equal(await withGameLock(g, async () => 42), 42)
})

test('已结束指令留下的异步回调不能凭旧上下文绕过群锁', async () => {
  const g = gid(); let trigger; let child; let ran = false
  const later = new Promise(resolve => { trigger = resolve })
  await withGameLock(g, async () => { child = later.then(() => withGameLock(g, async () => { ran = true })) })
  let release; const gate = new Promise(resolve => { release = resolve })
  const holding = withGameLock(g, async () => { await gate })
  trigger(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(ran, false)
  release(); await Promise.all([holding, child]); assert.equal(ran, true)
})

test('拍卖最后一件并发购买只成交一次，所有扣款保留', async () => {
  const g = gid(); const { trade } = app('apps/user/trade.js', '{ trade }'); const t = new trade()
  for (const uid of ['901', '902']) await money(g, uid, 1000)
  fs.mkdirSync(path.join(Save_Path, 'auction'), { recursive: true })
  fs.writeFileSync(path.join(Save_Path, 'auction', `${g}.json`), JSON.stringify({ _seq: 1, 1: { seller: '藏宝阁', name: '修为丹', count: 1, buyNow: 100, highestBid: 0, endTime: Date.now() + 3600000 } }))
  const before = ['901', '902'].map(uid => equip.getBag(uid, g).items.修为丹.count)
  await Promise.all(['901', '902'].map(uid => t.buyNow(event(g, uid, '#虚境一口价 1'))))
  const received = ['901', '902'].reduce((n, uid, i) => n + equip.getBag(uid, g).items.修为丹.count - before[i], 0)
  assert.equal(received, 1)
  assert.equal((await money(g, '901')) + (await money(g, '902')), 1900)
})

test('两个买家购买不同拍品时，不覆盖前一个买家的扣款', async () => {
  const g = gid(); const { trade } = app('apps/user/trade.js', '{ trade }'); const t = new trade()
  for (const uid of ['901', '902']) await money(g, uid, 1000)
  const item = { seller: '藏宝阁', name: '修为丹', count: 1, buyNow: 100, highestBid: 0, endTime: Date.now() + 3600000 }
  fs.writeFileSync(path.join(Save_Path, 'auction', `${g}.json`), JSON.stringify({ _seq: 2, 1: item, 2: item }))
  await Promise.all(['901', '902'].map(uid => t.buyNow(event(g, uid, '#虚境一口价 1'))))
  assert.equal(await money(g, '901'), 900); assert.equal(await money(g, '902'), 900)
})

test('一份仙帝丹成本并发合成只产一颗；费用不足不扣材料', async () => {
  const g = gid(); const { MIX, recipes } = app('apps/user/mix.js', '{ MIX, recipes: RECIPES }')
  const bag = equip.getBag('901', g); bag.items = Object.fromEntries(recipes.仙帝丹.mats.map(m => [m.name, { count: m.count }]))
  equip.saveBag('901', bag, g); await money(g, '901', 300000)
  const mix = new MIX(); await Promise.all([mix.mixCraft(event(g, '901', '#合成仙帝丹')), mix.mixCraft(event(g, '901', '#合成仙帝丹'))])
  assert.equal(bag.items.仙帝丹.count, 1); assert.equal(await money(g, '901'), 0)
  bag.items = Object.fromEntries(recipes.仙帝丹.mats.map(m => [m.name, { count: m.count }]))
  const before = JSON.stringify(bag.items); await mix.mixCraft(event(g, '901', '#合成仙帝丹'))
  assert.equal(JSON.stringify(bag.items), before)
})

test('幻境后台发奖与合成共用锁，不被合成的背包副本覆盖', async () => {
  const g = gid(); let resume; let entered
  const gate = new Promise(resolve => { resume = resolve }); const ready = new Promise(resolve => { entered = resolve })
  const delayed = { ...xujing_data, getQQYUserHome: async (...args) => { if (args[3]) { entered(); await gate }; return xujing_data.getQQYUserHome(...args) } }
  const { MIX, recipes } = app('apps/user/mix.js', '{ MIX, recipes: RECIPES }', { xujing_data: delayed })
  const bag = equip.getBag('901', g); bag.items = Object.fromEntries(recipes.仙帝丹.mats.map(m => [m.name, { count: m.count }]))
  equip.saveBag('901', bag, g); await money(g, '901', 300000)
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1)
  fs.writeFileSync(path.join(Save_Path, 'trial.json'), JSON.stringify({ date: trialDay(yesterday), groups: { [g]: { 901: { dmg: 123 } } }, week: trialWeek(), weekSchema: 2, weekGroups: {} }))
  const { settleStoredTrials } = app('apps/user/trial.js', '{ settleStoredTrials }', {
    trialWeek, rotateTrialPeriods, settleTrialPeriods, writeJsonAtomic,
    command: { getConfig: async (_section, key) => key === 'trial_group' ? [g] : key === 'trial_notice' ? 'T' : 2 }
  })
  const crafting = new MIX().mixCraft(event(g, '901', '#合成仙帝丹')); await ready
  const settling = settleStoredTrials(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(bag.items.灵宝盒, undefined)
  resume(); await Promise.all([crafting, settling])
  assert.equal(bag.items.仙帝丹.count, 1); assert.equal(bag.items.灵宝盒.count, 5)
})

test('镇海珠同类材料付费打造并发时只执行一次', async () => {
  const g = gid(); const { zhenhai: Zhenhai } = app('apps/user/zhenhai.js', '{ zhenhai }', zhenhai)
  const recipe = zhenhai.ZHENHAI_RECIPES.craft; const bag = equip.getBag('901', g)
  bag.items = Object.fromEntries(Object.entries(recipe.mats).map(([name, count]) => [name, { count }]))
  equip.saveBag('901', bag, g); await money(g, '901', recipe.money)
  const messages = []; const e = event(g, '901', '#打造镇海珠'); e.reply = msg => messages.push(String(msg))
  const a = new Zhenhai(); await Promise.all([a.craft(e), a.craft(e)])
  assert.equal(messages.filter(m => m.includes('打造成功')).length, 1)
  assert.equal(await money(g, '901'), 0); assert.ok(zhenhai.getZhenhai(bag))
})

test('三阁最后一件只售一次；补货与购买共享同一把锁', async () => {
  const g = gid(); mem.set(`xujing:shop-next:dange:${g}:east`, String(Date.now() + 3600000))
  mem.set(`xujing:shop-stock:dange:${g}:east`, JSON.stringify({ 修为丹: 1 }))
  const results = await Promise.all([shop.buyStock(g, 'dange', '修为丹', 1, 'east'), shop.buyStock(g, 'dange', '修为丹', 1, 'east'), shop.ensureRestock(g, 'dange', 'east')])
  assert.equal(results.slice(0, 2).reduce((n, r) => n + r.count, 0), 1)
  assert.deepEqual(JSON.parse(mem.get(`xujing:shop-stock:dange:${g}:east`)), {})
})

function caveFile (g, users) {
  const file = path.join(Save_Path, 'wanhun', `wanhun_${g}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ users, shops: {} })); return file
}
function caveUser (at) {
  return { cave: { inCave: true, enteredAt: at - 60000, nightClockAt: at, protectionUntil: at + 3600000, nextEncounterAt: 0, nextRealmDropAt: 0, unprotected: false, pending: { id: 'same-enemy', type: 'battle', name: 'test', power: 1 }, loot: {} }, lostUntil: 0, lostInCave: false, realmDrop: { count: 0, nextRecoverAt: 0 } }
}
test('同一阴魂并发操作只结算一次；同群其他人的遭遇不丢失', async () => {
  const g = gid(); const oldNow = Date.now; const oldRandom = Math.random
  const at = new Date(2026, 10, 5, 12).getTime(); Date.now = () => at; Math.random = () => 0.5
  try {
    for (const uid of ['901', '902']) { const b = await xujing_data.getQQYUserBattle(uid, null, false, `${g}.json`); b[uid].level = 567; await xujing_data.getQQYUserBattle(uid, b, true, `${g}.json`) }
    const file = caveFile(g, { 901: caveUser(at), 902: caveUser(at) })
    const results = await Promise.all([Wanhun.resolveCave('901', g, 'fight'), Wanhun.resolveCave('901', g, 'fight'), Wanhun.resolveCave('902', g, 'fight')])
    assert.equal(results.filter(r => r.ok).length, 2)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.users['901'].cave.pending, null); assert.equal(saved.users['902'].cave.pending, null)
    assert.deepEqual(saved.users['901'].cave.loot, saved.users['902'].cave.loot)
  } finally { Date.now = oldNow; Math.random = oldRandom }
})

test('玩家万魂窟凌晨不扣魂石、不掉境界，早晨补偿夜间时间', async () => {
  const g = gid(); const oldNow = Date.now
  const at = new Date(2026, 10, 6, 0, 59).getTime(); let now = at; Date.now = () => now
  try {
    const u = caveUser(at); u.cave.pending = null; u.cave.nextEncounterAt = at + 10 * 60000; u.cave.protectionUntil = at + 3 * 60000
    caveFile(g, { 901: u }); const b = await xujing_data.getQQYUserBattle('901', null, false, `${g}.json`); b['901'].level = 10; await xujing_data.getQQYUserBattle('901', b, true, `${g}.json`)
    const bag = equip.getBag('901', g); bag.items.魂石 = { count: 2 }; equip.saveBag('901', bag, g)
    now = new Date(2026, 10, 6, 3).getTime(); await Wanhun.tickCave('901', g, () => {})
    assert.equal(bag.items.魂石.count, 2)
    assert.equal((await xujing_data.getQQYUserBattle('901', null, false, `${g}.json`))['901'].level, 10)
    now = new Date(2026, 10, 6, 6).getTime(); await Wanhun.tickCave('901', g, () => {})
    assert.equal(Wanhun.getCave('901', g).cave.protectionUntil, at + 3 * 60000 + 5 * 3600000)
    assert.equal(bag.items.魂石.count, 2)
  } finally { Date.now = oldNow }
})

for (const entry of ['scroll', 'treasure-event', 'terrain-event']) {
  test(`秘境 ${entry} 奖励按玩家和NPC分别占用名额`, async () => {
    const old = Math.random; Math.random = () => 0
    try {
      for (const kind of ['fake', 'player']) {
        const g = gid(); const st = Object.assign(realm._testEmptyRealm(), { gid: g, phase: 'explore', region: 'center', terrain: 'dongtian', diff: 'huang', specialPending: true, specialGranted: 0, fakeSpecialPending: true, fakeSpecialGranted: 0 })
        const t = { id: 't', kind, leader: '901', members: ['901'], name: 'test', pool: [], contrib: {}, combatPower: 1000, lives: 3 }; st.teams.t = t
        if (entry === 'scroll') { t.node = { type: 'scroll', actor: '901', choices: [{ n: 1 }], data: {} }; await realm.resolveNode(st, g, t, t.node, 1, {}) }
        else realm.applyEvent(st, g, entry === 'treasure-event' ? { kind: 'treasure', name: 'test' } : { kind: 'terrain', name: '灵脉暴走' })
        assert.ok(st[kind === 'fake' ? 'fakeSpecialGranted' : 'specialGranted'] > 0)
        assert.equal(st[kind === 'fake' ? 'specialGranted' : 'fakeSpecialGranted'], 0)
      }
    } finally { Math.random = old }
  })
}

test('Boss 实际伤害包含本群灵兽和万魂幡，与统一战斗计算相同', async () => {
  const g = gid(); const old = Math.random; Math.random = () => 0.5
  try {
    const b = await xujing_data.getQQYUserBattle('901', null, false, `${g}.json`); b['901'].level = 10; await xujing_data.getQQYUserBattle('901', b, true, `${g}.json`)
    const bag = equip.getBag('901', g); bag.artifacts.wanhun = { rank: 9, equipped: true, deployed: true, souls: 100, aidUntil: Date.now() + 3600000 }; equip.saveBag('901', bag, g)
    const pets = getPetState(g); pets.bag['901'] = [{ pid: 1, speciesId: 'test', quality: 4, stage: '成年', maxAtk: 100, maxDef: 100, maxHp: 10000 }]; pets.active['901'] = 1; savePetState(pets)
    const buffs = await getBuffs('901', g); assert.equal(buffs.atk, 2)
    const expected = calcDamage(10, bag, 0.15, buffs, g, '901').dmg
    const withoutPet = calcDamage(10, bag, 0.15, buffs, g).dmg; assert.ok(expected > withoutPet)
    const hit = await boss.attackHit({ damage: {}, attackGid: {}, hp: 100000 }, '901', g)
    assert.equal(hit.dmg, expected)
  } finally { Math.random = old }
})

test('登仙令抢夺也使用持令者本群的万魂增益', async () => {
  const g = gid(); const old = Math.random; Math.random = () => 0.7
  try {
    for (const uid of ['901', '902']) {
      const b = await xujing_data.getQQYUserBattle(uid, null, false, `${g}.json`)
      b[uid].level = 10; await xujing_data.getQQYUserBattle(uid, b, true, `${g}.json`)
      const bag = equip.getBag(uid, g); bag.equipped = {}; bag.equippedAttr = {}; bag.artifacts = {}
      if (uid === '901') bag.artifacts.wanhun = { rank: 9, equipped: true, deployed: true, souls: 100, aidUntil: Date.now() + 3600000 }
      equip.saveBag(uid, bag, g)
    }
    const st = { token: { holder: '901', end: Date.now() + 60000, defended: 0, excluded: [] } }
    assert.equal((await boss.stealGrab(st, '902', g)).ok, false)
    assert.equal(st.token.holder, '901'); assert.equal(st.token.defended, 1)
  } finally { Math.random = old }
})

test('跨区菜单打开后被俘，数字不能移动；仅豁免持令不会豁免被俘', async () => {
  const g = gid(); const { world: World } = app('apps/user/world.js', '{ world }'); const wapp = new World()
  await money(g, '901', 10000); await wapp.go(event(g, '901', '#去东海'))
  const f = getFake(g); f.sectJails ||= {}; f.sectJails.test = [{ uid: '901', at: Date.now() }]; saveFake(f, g)
  await wapp.goPick(event(g, '901', '2'))
  assert.equal(world.getLoc(world.getWorld(g), '901'), 'center'); assert.equal(await money(g, '901'), 10000)
  assert.equal(await guards.isPlayerActionLocked(g, '901', { skipToken: true }), true)
  delete f.sectJails.test; saveFake(f, g)
  const bs = boss.getBoss(g); bs.token = { holder: '901', end: Date.now() + 60000 }; boss.saveBoss(bs, g)
  assert.equal(await guards.isPlayerActionLocked(g, '901'), true)
  assert.equal(await guards.isPlayerActionLocked(g, '901', { skipToken: true }), false)
})

test('万魂打造及商人数字菜单在被俘后不再执行；窟内正常兑换仍放行', async () => {
  const g = gid(); let crafted = 0; let bought = 0
  const wh = Object.create(Wanhun); wh.craft = () => { crafted++; return { msg: '' } }; wh.buyShop = async () => { bought++; return { msg: '' } }
  const { wanhun, pending } = app('apps/user/wanhun.js', '{ wanhun, pending }', { Wanhun: wh })
  const a = new wanhun(); const f = getFake(g); f.sectJails ||= {}; f.sectJails.test = [{ uid: '901' }]; saveFake(f, g)
  pending.set(`${g}:901`, { type: 'craftWeapon', at: Date.now(), list: [{ id: 'w1' }] }); await interact.forceLock(g, '901', 'wanhun-craft')
  await a.pick(event(g, '901', '1')); assert.equal(crafted, 0)
  pending.set(`${g}:901`, { type: 'shop', at: Date.now() }); await interact.forceLock(g, '901', 'wanhun-shop')
  await a.pick(event(g, '901', '1')); assert.equal(bought, 0)
  delete f.sectJails.test; saveFake(f, g)
  caveFile(g, { 901: { ...caveUser(Date.now()), cave: { ...caveUser(Date.now()).cave, pending: null } } })
  await a.pick(event(g, '901', '1')); assert.equal(bought, 1)
})

test('指令入口把真实所在大区传给商店活跃统计', async () => {
  const g = gid(); world.setLoc(world.getWorld(g), '901', 'east')
  const { YuePlugin } = app('model/api/api.js', '{ YuePlugin }', {
    BotApi: {}, AlemonApi: {}, recordLastCmd: async () => {},
    Date: class extends Date { getHours () { return 12 } },
    captiveOf: async () => null, rescuingOf: async () => null, dynastyReadActive: () => null,
    ambushActiveOf: async () => null, isSectWarParticipant: () => false, playerInRealm: () => false,
    getRaid: async () => null, getJailRemain: async () => 0,
    xujing_data: { isBlacklisted: async () => false }
  })
  class Probe extends YuePlugin { constructor () { super({ rule: [{ fnc: 'probe' }] }) } async probe () { return true } }
  assert.equal(await new Probe().probe(event(g, '901', '#测试')), true)
  assert.equal(await shop.countActive(g, 0, 'east'), 1); assert.equal(await shop.countActive(g, 0, 'center'), 0)
})
