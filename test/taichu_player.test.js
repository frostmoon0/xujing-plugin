import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { validateTaichuStore } from '../components/taichu_store.js'
import * as dungeon from '../components/taichu_dungeon.js'

// 对真实模块正文注入存储故障；不启动Yunzai或修改用户开关、真实存档。
function loadModule (file, deps, names) {
  const body = fs.readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
  return Function('deps', `const {${Object.keys(deps).join(',')}} = deps;\n${body}\nreturn {${names.join(',')}}`)(deps)
}

function fixture () {
  const disk = new Map(), bags = {}, stores = {}, home = { u: { money: 1000 } }, f = { players: { u: { contribution: 50 } } }
  const writes = []
  const deps = {
    fs: { existsSync: file => disk.has(file), readFileSync: file => { if (!disk.has(file)) throw new Error('ENOENT'); return disk.get(file) } },
    path, createHash, randomUUID, validateTaichuStore, withImmediateSaveContext: fn => fn(), Save_Path: 'memory-save',
    writeJsonAtomic: (file, value) => { disk.set(file, JSON.stringify(value)); writes.push(['journal', structuredClone(value)]) },
    getBag: uid => bags[uid] || { items: {} },
    saveBag: (uid, bag) => { bags[uid] = structuredClone(bag); writes.push(['bag', uid]) },
    getFake: () => f,
    saveFake: () => { writes.push(['fake']) },
    xujing_data: {
      getQQYUserHome: async (uid, value, file, write) => { if (write) { home[uid] = structuredClone(value[uid]); writes.push(['money', home[uid].money]); return true }; return structuredClone(home) },
      getQQYUserBattle: async uid => ({ [uid]: { level: 50 } })
    },
    saveTaichuStore: (gid, state, opts) => { assert.equal(opts.enabled, true); stores[gid] = structuredClone(state); writes.push(['store']) }
  }
  const mod = loadModule('../components/taichu_player.js', deps, ['commitTaichuPlayerTransaction', 'recoverTaichuPlayerTransactions', 'taichuPlayerSnapshot'])
  return { ...mod, deps, disk, bags, stores, home, f, writes }
}

test('太初事务同时更新灵石、背包、贡献与副本，恢复重复执行不重复扣费', async () => {
  const fix = fixture()
  const transaction = { uid: 'u', money: 800, bag: { items: { 太初印: { count: 1 } } }, contribution: 40, store: { version: 1, runs: {}, ledger: {} } }
  await fix.commitTaichuPlayerTransaction('group', transaction)
  assert.equal(fix.home.u.money, 800)
  assert.equal(fix.bags.u.items.太初印.count, 1)
  assert.equal(fix.f.players.u.contribution, 40)
  assert.deepEqual(fix.stores.group, transaction.store)
  const firstWrites = fix.writes.length
  assert.equal(await fix.recoverTaichuPlayerTransactions('group'), false)
  assert.equal(fix.writes.length, firstWrites)
  const snapshot = await fix.taichuPlayerSnapshot('group', 'u')
  snapshot.bag.items.太初印.count = 999
  assert.equal(fix.bags.u.items.太初印.count, 1)
})

test('扣钱后存包失败保留redo日志，重启后重放为绝对状态且不重复发奖', async () => {
  const fix = fixture(), original = fix.deps.saveBag
  // 加载另一个闭包以注入一次写失败，磁盘/主页与首次模块共享。
  let fail = true
  fix.deps.saveBag = (...args) => { if (fail) throw new Error('模拟背包写入失败'); return original(...args) }
  const failed = loadModule('../components/taichu_player.js', fix.deps, ['commitTaichuPlayerTransaction', 'recoverTaichuPlayerTransactions'])
  const bag = { items: { 太初印: { count: 1 } } }
  await assert.rejects(failed.commitTaichuPlayerTransaction('g', { uid: 'u', money: 800, bag, contribution: 40, store: { runs: {} } }), /模拟背包/)
  assert.equal(fix.home.u.money, 800)
  assert.equal([...fix.disk.values()].some(value => JSON.parse(value).uid === 'u'), true)
  fail = false
  assert.equal(await failed.recoverTaichuPlayerTransactions('g'), true)
  assert.equal(fix.home.u.money, 800)
  assert.equal(fix.bags.u.items.太初印.count, 1)
  assert.equal(await failed.recoverTaichuPlayerTransactions('g'), false)
})

test('默认关闭时前端所有公开业务指令静默返回，不进入锁或读写存档', async () => {
  let guarded = 0
  const deps = { plugin: class { constructor (options) { this.rule = options.rule } }, isTaichuEnabled: () => false, withGameLock: () => { guarded++; throw new Error('关闭时不应获取业务锁') } }
  const { taichu } = loadModule('../apps/user/taichu.js', deps, ['taichu'])
  const app = new taichu(), event = { group_id: 'g', user_id: 'u', msg: '#进入古墟 普通', reply: () => { throw new Error('关闭时不应回复新玩法') } }
  for (const { fnc } of app.rule || []) {
    if (typeof app[fnc] === 'function') assert.equal(await app[fnc](event), false)
  }
  // 显式覆盖最主要的命令入口，确保未来正则调整后仍有关闭检查。
  for (const fnc of ['taichuStart', 'taichuJoin', 'taichuStatus', 'taichuAct', 'taichuLeave', 'taichuClaim', 'taichuCraft', 'taichuRepair', 'taichuPick', 'taichuGuide', 'taichuRecipes']) assert.equal(await app[fnc](event), false)
  assert.equal(guarded, 0)
})

test('无效扣费/贡献/副本/路径在写redo前拒绝，账户与磁盘均无改动', async () => {
  const fix = fixture()
  for (const transaction of [
    { uid: 'u', money: -1 }, { uid: 'u', money: NaN }, { uid: 'u', contribution: -1 },
    { uid: 'missing', contribution: 0 }, { uid: 'u', store: { runs: [] } }, { uid: 'u', bag: [] },
    { uid: '../u', money: 1 }, { uid: null, money: 1 }
  ]) await assert.rejects(fix.commitTaichuPlayerTransaction('g', transaction))
  await assert.rejects(fix.commitTaichuPlayerTransaction('../g', { uid: 'u', money: 1 }))
  assert.equal(fix.disk.size, 0)
  assert.equal(fix.writes.length, 0)
  assert.equal(fix.home.u.money, 1000)
})

test('主redo损坏时备份可恢复，完成主档不会被旧备份重复重放，双坏失败关闭', async () => {
  const fix = fixture(), original = fix.deps.saveBag
  fix.deps.saveBag = () => { throw new Error('首次保存失败') }
  const mod = loadModule('../components/taichu_player.js', fix.deps, ['commitTaichuPlayerTransaction', 'recoverTaichuPlayerTransactions'])
  await assert.rejects(mod.commitTaichuPlayerTransaction('g', { uid: 'u', money: 700, bag: { items: {} } }))
  const file = [...fix.disk.keys()].find(name => name.endsWith('.json'))
  const acceptedBackup = fix.disk.get(`${file}.bak`)
  fix.disk.set(file, '{broken')
  fix.deps.saveBag = original
  const recovered = loadModule('../components/taichu_player.js', fix.deps, ['recoverTaichuPlayerTransactions'])
  assert.equal(await recovered.recoverTaichuPlayerTransactions('g'), true)
  assert.equal(fix.home.u.money, 700)
  fix.disk.set(`${file}.bak`, acceptedBackup)
  const writes = fix.writes.length
  assert.equal(await recovered.recoverTaichuPlayerTransactions('g'), false)
  assert.equal(fix.writes.slice(writes).every(([kind]) => kind === 'journal'), true)
  assert.equal(JSON.parse(fix.disk.get(`${file}.bak`)).uid, undefined)
  fix.disk.set(file, '{broken')
  fix.disk.set(`${file}.bak`, '{broken')
  await assert.rejects(recovered.recoverTaichuPlayerTransactions('g'), /日志及备份损坏/)
})

test('副本保存返回false不清redo，恢复时总开关关闭也完成已接受事务', async () => {
  const fix = fixture(), original = fix.deps.saveTaichuStore
  fix.deps.saveTaichuStore = () => false
  const mod = loadModule('../components/taichu_player.js', fix.deps, ['commitTaichuPlayerTransaction', 'recoverTaichuPlayerTransactions'])
  await assert.rejects(mod.commitTaichuPlayerTransaction('g', { uid: 'u', money: 700, store: { runs: {} } }), /副本保存失败/)
  assert.equal([...fix.disk.values()].some(value => JSON.parse(value).uid === 'u'), true)
  fix.deps.saveTaichuStore = original
  const recovered = loadModule('../components/taichu_player.js', fix.deps, ['recoverTaichuPlayerTransactions'])
  assert.equal(await recovered.recoverTaichuPlayerTransactions('g'), true)
  assert.equal(fix.home.u.money, 700)
})

test('前端双人开局扣费、全员行动、18步通关、各自领奖与消息重放幂等', async () => {
  let state = { version: 1, runs: {}, ledger: {} }, sequence = 0
  const accounts = Object.fromEntries(['u1', 'u2'].map(id => [id, { money: 100000, level: 50, bag: { items: {}, equipped: {}, equippedAttr: {} } }]))
  const replies = []
  const deps = {
    ...dungeon,
    plugin: class { constructor (options) { this.rule = options.rule } },
    isTaichuEnabled: () => true,
    withGameLock: async (gid, fn) => fn(), guardActionLocked: async () => false,
    forceLock: async () => {}, isCurrent: async () => true, unlock: async () => {},
    recoverTaichuPlayerTransactions: async () => false,
    readTaichuStore: () => structuredClone(state),
    taichuPlayerSnapshot: async (gid, uid) => structuredClone(accounts[uid]),
    commitTaichuPlayerTransaction: async (gid, tx) => {
      if (tx.money !== undefined) accounts[tx.uid].money = tx.money
      if (tx.bag) accounts[tx.uid].bag = structuredClone(tx.bag)
      if (tx.store) state = structuredClone(tx.store)
    },
    getBuffs: async () => ({}), calcCombatPower: () => ({ power: 100000 }),
    getWorld: () => ({}), getLoc: () => 'center',
    taichuExplorationEffects: () => ({}), wearTaichuLoadout: () => false,
    consumeBagItems: () => true,
    addItemToBag: (bag, name, count) => { bag.items[name] ||= { count: 0 }; bag.items[name].count += count },
    fmtItems: items => Object.entries(items).map(([name, count]) => `${name}×${count}`).join('、')
  }
  deps.createTaichuRun = input => dungeon.createTaichuRun(input, { enabled: true, rng: () => 0 })
  deps.joinTaichuRun = (run, actor) => dungeon.joinTaichuRun(run, actor, { enabled: true })
  deps.actTaichuRun = (run, id, action, actor) => dungeon.actTaichuRun(run, id, action, actor, { enabled: true, rng: () => 0 })
  deps.supplyTaichuRun = (run, id) => dungeon.supplyTaichuRun(run, id, { enabled: true })
  deps.getTaichuSettlement = (run, id, ledger) => dungeon.getTaichuSettlement(run, id, ledger, Date.now(), { enabled: true })
  deps.commitTaichuSettlement = (run, id, ledger) => dungeon.commitTaichuSettlement(run, id, ledger, Date.now(), { enabled: true })
  const { taichu } = loadModule('../apps/user/taichu.js', deps, ['taichu'])
  const app = new taichu()
  const event = (uid, msg, other = {}) => ({ group_id: 'g', user_id: uid, sender: { nickname: uid }, msg, message_id: `msg${++sequence}`, reply: async value => replies.push(value), ...other })
  await app.taichuStart(event('u1', '#进入古墟 普通'))
  await app.taichuJoin(event('u2', '#加入古墟', { at: ['u1'] }))
  assert.equal(accounts.u1.money, 80000)
  assert.equal(accounts.u2.money, 80000)
  let run = Object.values(state.runs)[0]
  assert.equal(Object.keys(run.members).length, 2)
  let rounds = 0
  while (run.phase === 'active' && rounds++ < 20) {
    const action = run.node.kind === 'route' ? 'forge' : run.node.kind === 'array' ? `disarm:${run.node.answer}` : run.node.kind === 'remnant' ? 'search' : ({ shield: 'break', charge: 'interrupt', summon: 'attack', mark: 'guard' })[run.node.threat]
    for (const id of ['u1', 'u2']) {
      if (run.members[id].energy < 12) await app.taichuSupply(event(id, '#古墟补给'))
      const e = event(id, `#古墟行动 ${action}`)
      await app.taichuAct(e)
      const checkpoint = structuredClone(state)
      await app.taichuAct(e)
      assert.deepEqual(state, checkpoint)
    }
    run = Object.values(state.runs)[0]
  }
  assert.equal(run.phase, 'cleared', replies.slice(-3).join('\n'))
  for (const id of ['u1', 'u2']) {
    await app.taichuClaim(event(id, '#领取古墟奖励'))
    const first = structuredClone(accounts[id].bag)
    await app.taichuClaim(event(id, '#领取古墟奖励'))
    assert.deepEqual(accounts[id].bag, first)
    assert.equal(accounts[id].bag.items.太初印.count, 1)
    assert.equal(accounts[id].bag.taichu.routeClears.forge, 1)
    assert.equal(state.ledger[id].coreCount, 1)
  }
})
