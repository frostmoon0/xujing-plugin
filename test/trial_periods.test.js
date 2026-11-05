import test from 'node:test'
import assert from 'node:assert/strict'
import { rotateTrialPeriods, settleTrialPeriods, trialDay, trialWeek } from '../components/trial_periods.js'
import { syncCaveNightClock } from '../components/cave_clock.js'
import { getBag, grantItemOnce, consumeBagItems } from '../components/equip_data.js'

const at = text => new Date(`2026-11-${text}`).getTime()
const rank = uid => ({ g: { [uid]: { dmg: 999, total: 999 } } })

test('午夜挑战归档昨日，日结算只奖昨日并保留今日成绩，重试不再发奖', () => {
  const data = { date: '2026-11-04', groups: rank('yesterday'), week: '2026-10-31', weekSchema: 2, weekGroups: {} }
  rotateTrialPeriods(data, '2026-11-05', '2026-10-31')
  data.groups = rank('earlyPlayer')
  const gifts = []; const grant = (...args) => gifts.push(args)
  const options = { today: '2026-11-05', week: '2026-10-31' }
  settleTrialPeriods(data, ['g'], grant, options)
  assert.deepEqual(gifts.map(g => [g[1], g[2], g[3]]), [['yesterday', '灵宝盒', 5], ['yesterday', '修为丹', 1]])
  assert.ok(data.groups.g.earlyPlayer)
  assert.equal(settleTrialPeriods(data, ['g'], grant, options).length, 0)
  assert.equal(gifts.length, 2)
})

test('周六发上期周奖，周末成绩在周一保留并进入下周六奖励', () => {
  assert.equal(trialWeek(at('06T23:59:59')), '2026-10-31')
  assert.equal(trialWeek(at('07T00:00:00')), '2026-11-07')
  assert.equal(trialWeek(at('09T00:05:00')), '2026-11-07')
  const data = { date: '2026-11-06', groups: {}, week: '2026-11-02', weekGroups: rank('lastWeek') }
  rotateTrialPeriods(data, '2026-11-06', '2026-10-31')
  assert.ok(data.weekGroups.g.lastWeek, '旧周一格式迁移保留成绩')
  const gifts = []; const grant = (...args) => gifts.push(args)
  settleTrialPeriods(data, ['g'], grant, { today: '2026-11-07', week: '2026-11-07' })
  assert.equal(gifts.filter(g => g[1] === 'lastWeek' && g[2] === '灵宝盒')[0][3], 20)
  data.weekGroups = rank('weekend')
  rotateTrialPeriods(data, '2026-11-09', '2026-11-07')
  assert.ok(data.weekGroups.g.weekend)
  settleTrialPeriods(data, ['g'], grant, { today: '2026-11-14', week: '2026-11-14' })
  assert.equal(gifts.filter(g => g[1] === 'weekend').length, 1)
})

test('停机数日后待结算成绩仍保留，不重复发已完成的群', () => {
  const data = { date: '2026-11-01', groups: rank('old'), week: '2026-10-31', weekSchema: 2, weekGroups: {} }
  const gifts = []; const grant = (...args) => gifts.push(args)
  const options = { today: '2026-11-05', week: '2026-10-31' }
  rotateTrialPeriods(data, options.today, options.week)
  assert.ok(data.dailyArchive['2026-11-01'].g.old)
  settleTrialPeriods(data, ['g'], grant, options)
  settleTrialPeriods(data, ['g'], grant, options)
  assert.equal(gifts.length, 2)
})

test('旧版周末未结算成绩迁移后留在本期，周一不抹除', () => {
  const data = { date: '2026-11-08', groups: {}, week: '2026-11-02', weekGroups: rank('sunday') }
  rotateTrialPeriods(data, '2026-11-09', '2026-11-07')
  assert.equal(data.week, '2026-11-07')
  assert.ok(data.weekGroups.g.sunday)
  assert.deepEqual(data.weeklyArchive, {})
})

test('发奖中断保留待结算状态；背包领取记录保证重试只到账一次', () => {
  const g = `trial_receipt_${process.pid}`; const uid = '900001'; const bag = getBag(uid, g)
  const before = Number(bag.items.灵宝盒?.count) || 0
  const data = { date: '2026-11-04', groups: { [g]: { [uid]: { dmg: 123 } } }, week: '2026-10-31', weekSchema: 2 }
  const opts = { today: '2026-11-05', week: '2026-10-31' }; let stop = true
  const grant = (gid, id, name, count, receipt) => {
    if (name === '修为丹' && stop) throw Error('disk unavailable')
    grantItemOnce(id, name, count, gid, receipt)
  }
  assert.throws(() => settleTrialPeriods(data, [g], grant, opts))
  assert.equal(bag.items.灵宝盒.count - before, 5)
  stop = false; settleTrialPeriods(data, [g], grant, opts)
  assert.equal(bag.items.灵宝盒.count - before, 5)
  assert.equal(data.dailyPaid['2026-11-04'][g], true)
})

test('批量扣材料有一种不足时，其他材料数量及装备属性组均保持', () => {
  const bag = { items: { 星霜草: { count: 2 }, 青鸾草: { count: 1 } } }
  const before = structuredClone(bag)
  assert.equal(consumeBagItems(bag, { 星霜草: 2, 青鸾草: 2 }), false)
  assert.deepEqual(bag, before)
  assert.equal(consumeBagItems(bag, { 星霜草: 2, 青鸾草: 1 }), true)
  assert.deepEqual(bag.items, {})
})

test('万魂夜间补时持久化后不重复，窟内时长与保护/遭遇一起顺延', () => {
  let cave = { inCave: true, enteredAt: at('05T00:50:00'), nightClockAt: at('05T00:59:00'), protectionUntil: at('05T01:05:00'), nextEncounterAt: at('05T01:01:00'), nextRealmDropAt: 0 }
  assert.equal(syncCaveNightClock(cave, at('05T06:00:00')), true)
  assert.equal(cave.enteredAt, at('05T05:50:00'))
  assert.equal(cave.protectionUntil, at('05T06:05:00'))
  assert.equal(cave.nextEncounterAt, at('05T06:01:00'))
  assert.equal(cave.nextRealmDropAt, 0)
  cave = JSON.parse(JSON.stringify(cave))
  assert.equal(syncCaveNightClock(cave, at('05T06:00:15')), false)
  assert.equal(cave.protectionUntil, at('05T06:05:00'))
  assert.equal(trialDay(at('05T06:00:00')), '2026-11-05')
})
