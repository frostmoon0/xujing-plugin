import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { syncRealmNightClock } from '../components/realm_clock.js'

const at = text => new Date(`2026-11-${text}`).getTime()
const HOUR = 3600000
function realm (phase = 'explore') {
  return {
    phase, nightClockAt: at('04T00:59:00'), startAt: at('04T00:40:00'), endAt: at('04T01:20:00'),
    ambushAt: at('04T00:58:00'), ambushChoiceEnd: at('04T01:00:30'),
    teams: {
      p: { kind: 'player', nextActionAt: at('04T01:01:00'), lastActionAt: at('04T00:59:00'), exposedUntil: at('04T01:09:00'), encounterLockUntil: 0, node: { type: 'treasure' } },
      f: { kind: 'fake', arrivalAt: at('04T01:03:00'), lastBarrierHit: at('04T00:59:50') }
    },
    barrier: { hp: 500, auto: { 1: { lastHit: at('04T00:59:50') } } }
  }
}

test('跨过整个夜间，玩家/伪玩家和围剿计时统一顺延5小时', () => {
  const st = realm()
  assert.equal(syncRealmNightClock(st, at('04T06:00:00')).paused, 5 * HOUR)
  assert.equal(st.endAt, at('04T06:20:00'))
  assert.equal(st.ambushChoiceEnd, at('04T06:00:30'))
  assert.equal(st.teams.p.lastActionAt, at('04T05:59:00'))
  assert.equal(st.teams.p.exposedUntil, at('04T06:09:00'))
  assert.equal(st.teams.p.encounterLockUntil, 0)
  assert.equal(st.teams.f.arrivalAt, at('04T06:03:00'))
  assert.equal(st.barrier.auto[1].lastHit, at('04T05:59:50'))
  assert.equal(st.nightResumePending, true)
  assert.deepEqual(st.teams.p.node, { type: 'treasure' })
  assert.equal(st.barrier.hp, 500)
})

test('夜间逐分钟检查和序列化重启不会重复补时；凌晨1点/6点边界准确', () => {
  let st = realm()
  assert.equal(syncRealmNightClock(st, at('04T01:00:00')).paused, 0)
  assert.equal(syncRealmNightClock(st, at('04T02:00:00')).paused, HOUR)
  st = JSON.parse(JSON.stringify(st))
  assert.equal(syncRealmNightClock(st, at('04T06:00:00')).paused, 4 * HOUR)
  const end = st.endAt
  assert.equal(syncRealmNightClock(st, at('04T06:01:00')).paused, 0)
  assert.equal(st.endAt, end)
})

test('屏障阶段停机跨夜不累积自动破界攻击次数', () => {
  const st = realm('barrier')
  st.endAt = 0
  syncRealmNightClock(st, at('04T06:00:00'))
  assert.equal(st.endAt, 0)
  assert.equal(at('04T06:00:00') - st.barrier.auto[1].lastHit, 10000)
  assert.equal(st.teams.f.lastBarrierHit, st.barrier.auto[1].lastHit)
})

test('旧档补默认检查点，公开/专属使用相同的夜间计时', () => {
  for (const privateRealm of [false, true]) {
    const st = realm()
    delete st.nightClockAt
    st.private = privateRealm
    syncRealmNightClock(st, at('04T06:00:00'))
    assert.equal(st.endAt, at('04T06:20:00'))
  }
})

test('关服前已经到期的秘境不复活；空闲期不顺延刷新', () => {
  const st = realm()
  st.endAt = at('04T00:59:30')
  assert.equal(syncRealmNightClock(st, at('04T06:00:00')).paused, 0)
  assert.equal(st.endAt, at('04T00:59:30'))
  const idle = { phase: 'idle', nextSpawn: 123 }
  assert.equal(syncRealmNightClock(idle, at('04T06:00:00')).changed, false)
  assert.equal(idle.nextSpawn, 123)
})

test('停机多日只补尚未结束时经历的夜间，不把白天离线算作暂停', () => {
  const st = realm()
  assert.equal(syncRealmNightClock(st, at('06T08:00:00')).paused, 5 * HOUR)
  assert.equal(st.endAt, at('04T06:20:00'))
})

test('真实秘境调度夜间不推进；6点公开/专属恢复菜单且只恢复一次', async () => {
  const source = fs.readFileSync(new URL('../apps/user/realm.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\r?$/gm, '')
    .replace('export class ', 'class ')
  let now = at('04T02:00:00')
  class FakeDate extends Date {
    constructor (...args) { super(...(args.length ? args : [now])) }
    static now () { return now }
  }
  const pub = realm(); const priv = realm()
  pub.gid = '1'; priv.gid = '2'; priv.private = true
  for (const st of [pub, priv]) {
    st.teams.p.members = ['player']; st.teams.p.leader = 'player'
  }
  const saved = []; const progressed = []; const menus = []; const locks = []
  const load = st => { syncRealmNightClock(st, now); return st }
  const context = vm.createContext({
    plugin: class {}, Plugin_Name: 'test', Date: FakeDate,
    getRealmCfg: async () => ({ enable: 'T', group: ['1'] }),
    activeRealmGroups: () => ['1'], activePrivateRealms: () => [{ gid: '2', id: 'p' }],
    withRealmLock: (gid, fn) => fn(), withFakeLock: (gid, fn) => fn(),
    getRealm: () => load(pub), getPrivateRealm: () => load(priv),
    saveRealm: st => saved.push(st.gid), savePrivateRealm: st => saved.push(st.gid),
    isNight: date => date.getHours() >= 1 && date.getHours() < 6,
    syncPlayerTeam: () => {}, reconcileFakeBusy: () => {},
    forceLock: async (...args) => locks.push(args), menuText: () => '待选菜单',
    onExplore: st => progressed.push(st.gid), onNotify: (gid, uid, text) => menus.push([gid, uid, text]),
    logger: { error: error => assert.fail(error) }
  })
  vm.runInContext(`${source}\nprocessExplore = async st => onExplore(st); notifyAt = async (...args) => onNotify(...args); globalThis.tick = realmTick`, context)
  await context.tick()
  assert.deepEqual(progressed, [])
  assert.deepEqual(menus, [])
  assert.deepEqual(saved, ['1', '2'])
  now = at('04T06:00:00')
  await context.tick()
  assert.deepEqual(progressed, ['1', '2'])
  assert.equal(menus.length, 2)
  assert.equal(locks.length, 2)
  assert.equal(pub.endAt, at('04T06:20:00'))
  assert.equal(priv.endAt, pub.endAt)
  await context.tick()
  assert.equal(menus.length, 2)
})

test('恢复后调度尚未重发菜单时，单人队长可继续数字选择；其它交互仍优先', async () => {
  const source = fs.readFileSync(new URL('../apps/user/realm.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\r?$/gm, '')
    .replace('export class ', 'class ')
  const st = realm()
  st.nightResumePending = true
  st.teams.p.leader = 'player'; st.teams.p.members = ['player']
  let current = { type: 'pet' }; let resolved = 0; let locked = 0
  const context = vm.createContext({
    plugin: class {}, Plugin_Name: 'test',
    isCurrent: async () => false, currentInteract: async () => current,
    getPrivateRealms: () => [], getRealm: () => st,
    teamOf: (state, uid) => uid === 'player' ? state.teams.p : null,
    partyInfoOf: () => null, guardActionLocked: async () => false,
    withRealmLock: (gid, fn) => fn(), withFakeLock: (gid, fn) => fn(),
    forceLock: async () => { locked++ }, unlock: async () => {},
    getRealmCfg: async () => ({}), saveRealm: () => {},
    resolveNode: async () => { resolved++; st.teams.p.node = null; return { valid: true, msgs: [] } }
  })
  vm.runInContext(`${source}\nglobalThis.pick = realm.prototype.pick`, context)
  const event = { group_id: '1', user_id: 'player', msg: '1' }
  assert.equal(await context.pick(event), false)
  assert.equal(locked, 0)
  current = null
  assert.equal(await context.pick(event), true)
  assert.equal(locked, 1)
  assert.equal(resolved, 1)
})
