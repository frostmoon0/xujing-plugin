import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tickFakeTaichu, planFakeTaichuEquipment, fakeTaichuMaterialNeeds } from '../components/taichu_ai.js'
import { createTaichuRun, TAICHU_ENTRY_COST, taichuWeek } from '../components/taichu_dungeon.js'
import { TAICHU_RECIPES } from '../components/taichu_data.js'
import { addItemToBag, consumeBagItem } from '../components/equip_data.js'
import { CFG, activeFacilityKeys, taichuWorkshopLevel, facilityCost } from '../components/sect/utils.js'
import { upgradeFacility, fakeBuildFacilities } from '../components/sect/economy.js'
import { facilityMaintenance, vaultReserve } from '../components/sect/treasury.js'
import { npcCanAct } from '../components/npc_action.js'

const MINUTE = 60000
const NOW = Date.UTC(2026, 10, 9, 2)
const person = extra => ({ name: '试炼者', alive: true, sect: 's', status: 'sect', level: 200, money: 50000000, contribution: 5000,
  bag: { items: {}, equipped: {}, equippedAttr: {}, artifacts: {} }, ...extra })
const world = p => ({ roster: { [p.name]: p }, sects: { s: { facilities: {} } } })
const deps = extra => ({ enabled: true, powerOf: () => 100000, canAct: (_f, p) => !p.realmBusy && !p.captive,
  workshopLevel: () => 0, addItem: addItemToBag, takeItem: consumeBagItem, autoEquip: () => {}, ...extra })

test('总开关关闭不创建AI目标、存档字段或消耗钱物，设施也隐藏', () => {
  const p = person(), f = world(p), before = structuredClone(f)
  assert.equal(tickFakeTaichu(f, 'g', NOW, deps({ enabled: false })), false)
  assert.deepEqual(f, before)
  assert.equal(CFG.FACILITIES.tiangong, undefined)
  assert.equal(activeFacilityKeys().includes('tiangong'), false)
  assert.equal(facilityCost('tiangong', 1), null)
  f.sects.s.facilities.tiangong = 5
  assert.equal(taichuWorkshopLevel(f, p), 0)
  assert.equal(facilityMaintenance(f, 's', 'tiangong', 5), 0)
  const snapshot = structuredClone(f)
  assert.equal(upgradeFacility(f, 's', 'tiangong').ok, false)
  assert.deepEqual(f, snapshot)
  const reserveWith = vaultReserve(f, 's', NOW)
  delete f.sects.s.facilities.tiangong
  assert.deepEqual(vaultReserve(f, 's', NOW), reserveWith)
})

test('AI不透支入场，低战力与被占用的人不进入', () => {
  for (const [extra, options] of [[{ money: 100 }, {}], [{}, { powerOf: () => 1000 }], [{ captive: true }, {}]]) {
    const p = person(extra), f = world(p), money = p.money
    tickFakeTaichu(f, 'g', NOW, deps(options))
    assert.equal(p.money, money)
    assert.equal(p.taichuRun, undefined)
    assert.equal(p.realmBusy, undefined)
  }
})

test('开关开启即显示天工坊，玩家与AI同价建造且AI保留战争维护储备', t => {
  const read = fs.readFileSync.bind(fs)
  t.mock.method(fs, 'readFileSync', (file, ...args) => String(file).replace(/\\/g, '/').endsWith('/config/taichu.json') ? '{"enabled":true}' : read(file, ...args))
  assert.ok(CFG.FACILITIES.tiangong)
  const f = world(person())
  f.players = {}; f.sectMap = {}; f.areas = {}; f.areaDef = {}
  f.sects.s.name = '测试宗'
  f.sects.s.facilities = { yanwu: 5, hushan: 8, lingmai: 8, yaoyuan: 5 }
  f.sects.s.vault = { stones: 10000000, mats: { 凤羽玉: 1000, 造梦神玉: 1000, 乾坤阵晶: 1000 } }
  const cost = facilityCost('tiangong', 1)
  const player = structuredClone(f)
  player.sects.s.owner = '1'
  const playerMoney = player.sects.s.vault.stones
  assert.equal(upgradeFacility(player, 's', 'tiangong').ok, true)
  assert.equal(playerMoney - player.sects.s.vault.stones, cost.stones)
  const aiMoney = f.sects.s.vault.stones
  fakeBuildFacilities(f, NOW)
  assert.equal(f.sects.s.facilities.tiangong, 1)
  assert.equal(aiMoney - f.sects.s.vault.stones, cost.stones)
  assert.equal(taichuWorkshopLevel(f, f.roster['试炼者']), 1)
  assert.equal(f.sects.s.vault.mats['凤羽玉'], 1000 - cost.mats['凤羽玉'])
  const poor = structuredClone(f)
  poor.sects.s.facilities.tiangong = 0
  poor.sects.s.vault.stones = cost.stones
  fakeBuildFacilities(poor, NOW)
  assert.equal(poor.sects.s.facilities.tiangong, 0)
  assert.equal(poor.sects.s.vault.stones, cost.stones)
})

test('AI完整同规则探索，重启快照可续跑，周核心只领两次', () => {
  let f = world(person()), now = NOW
  for (let trip = 0; trip < 3; trip++) {
    let p = f.roster['试炼者']
    p.taichuNextAt = 0
    const money = p.money
    tickFakeTaichu(f, 'g', now, deps())
    assert.equal(p.money, money - TAICHU_ENTRY_COST.normal)
    assert.ok(p.realmBusy.realmId.startsWith('taichu:'))
    for (let step = 0; step < 30 && p.taichuRun; step++) {
      now += MINUTE
      f = JSON.parse(JSON.stringify(f))
      p = f.roster['试炼者']
      tickFakeTaichu(f, 'g', now, deps())
    }
    assert.equal(p.taichuRun, undefined)
    assert.equal(p.realmBusy, undefined)
    assert.equal(p.taichuLastTrip.phase, 'cleared')
    assert.equal(p.bag.taichu.routeClears.forge, trip + 1)
    assert.equal(p.bag.items['太初印'].count, Math.min(2, trip + 1))
    assert.equal(p.taichuLedger[p.name].week, taichuWeek(now))
    assert.equal(p.taichuLedger[p.name].coreCount, Math.min(2, trip + 1))
    const count = p.bag.items['太初印'].count
    tickFakeTaichu(f, 'g', now, deps())
    assert.equal(p.bag.items['太初印'].count, count)
    now += 61 * MINUTE
  }
})

test('超时按副本败退结算，仅保留封存，不遗留占用锁', () => {
  const p = person(), f = world(p)
  const run = createTaichuRun({ gid: 'g', leader: p.name, members: [{ id: p.name, kind: 'fake' }], now: NOW }, { enabled: true })
  run.members[p.name].sealed = { 月魄石: 3 }
  run.members[p.name].loot = { 凤羽玉: 7 }
  p.taichuRun = run
  p.realmBusy = { realmId: `taichu:${run.id}` }
  tickFakeTaichu(f, 'g', NOW + 7 * 3600000, deps())
  assert.equal(p.taichuRun, undefined)
  assert.equal(p.realmBusy, undefined)
  assert.equal(p.bag.items['月魄石'].count, 3)
  assert.equal(p.bag.items['凤羽玉'], undefined)
})

test('关闭后释放自己的锁，重新开启遇到被俘则等待', () => {
  const p = person(), other = person({ name: '别的秘境', realmBusy: { realmId: 'realm:other' } }), f = world(p)
  f.roster[other.name] = other
  tickFakeTaichu(f, 'g', NOW, deps())
  tickFakeTaichu(f, 'g', NOW, deps({ enabled: false }))
  assert.equal(p.realmBusy, undefined)
  assert.equal(other.realmBusy.realmId, 'realm:other')
  const before = structuredClone(p.taichuRun)
  p.captive = true
  tickFakeTaichu(f, 'g', NOW + MINUTE, deps())
  assert.deepEqual(p.taichuRun, before)
  p.captive = false
  tickFakeTaichu(f, 'g', NOW + MINUTE, deps())
  assert.ok(p.realmBusy)
  assert.equal(p.taichuRun.step, 1)
})

test('已有自身古墟锁也逐次复查被俘、在途、失魂和战争资格', () => {
  for (const mode of ['travel', 'lost', 'mine', 'jail', 'war']) {
    const p = person(), f = world(p)
    tickFakeTaichu(f, 'g', NOW, deps({ canAct: npcCanAct }))
    const before = structuredClone(p.taichuRun)
    if (mode === 'travel') p.fakeTravel = { endAt: NOW + 10 * MINUTE }
    if (mode === 'lost') p.fakeLostUntil = NOW + 10 * MINUTE
    if (mode === 'mine') p.mineOf = 's'
    if (mode === 'jail') f.sectJails = { s: [{ name: p.name, until: NOW + 10 * MINUTE }] }
    if (mode === 'war') f.sectAttacks = [{ id: 1, phase: 'fight', atkFakes: [p.name] }]
    const lock = structuredClone(p.realmBusy)
    tickFakeTaichu(f, 'g', NOW + MINUTE, deps({ canAct: npcCanAct }))
    assert.deepEqual(p.taichuRun, before, mode)
    assert.deepEqual(p.realmBusy, lock, mode)
    delete p.fakeTravel; delete p.fakeLostUntil; delete p.mineOf; delete f.sectJails; delete f.sectAttacks
    tickFakeTaichu(f, 'g', NOW + 2 * MINUTE, deps({ canAct: npcCanAct }))
    assert.equal(p.taichuRun.step, 1, mode)
  }
})

test('目标保留完整需求，未参与者不囤太初配方材料', () => {
  const p = person()
  assert.deepEqual(fakeTaichuMaterialNeeds(p, { enabled: true }), {})
  const plan = planFakeTaichuEquipment(p, { enabled: true })
  p.taichuTarget = plan.name
  const before = fakeTaichuMaterialNeeds(p, { enabled: true })
  addItemToBag(p.bag, '凤羽玉', before['凤羽玉'], null, false)
  assert.deepEqual(fakeTaichuMaterialNeeds(p, { enabled: true }), before)
  assert.equal(planFakeTaichuEquipment(p, { enabled: true }).missing['凤羽玉'], undefined)
})

test('AI天工坊同配方打造，真实扣钱、贡献和全部材料', () => {
  const p = person(), f = world(p)
  p.taichuTarget = '太初·断界'
  const recipe = TAICHU_RECIPES[p.taichuTarget]
  for (const [name, count] of Object.entries(recipe.materials)) addItemToBag(p.bag, name, count, null, false)
  addItemToBag(p.bag, recipe.base, 1, { atk: 1000 }, false)
  p.bag.taichu = { routeClears: { forge: 1 } }
  const money = p.money, contribution = p.contribution
  tickFakeTaichu(f, 'g', NOW, deps({ workshopLevel: () => 1 }))
  assert.equal(p.money, money - recipe.stones)
  assert.equal(p.contribution, contribution - recipe.contribution)
  assert.equal(p.bag.items['太初·断界'].count, 1)
  assert.equal(p.bag.items[recipe.base], undefined)
  assert.equal(p.bag.items['太初印'], undefined)
  assert.equal(p.taichuRun, undefined)
})
