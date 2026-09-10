import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanupFakeHistory } from '../components/fake_data.js'

const DAY = 86400000
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0)

/** 最小天下大事夹具: 只带 cleanupFakeHistory 需要的字段 */
function makeFake ({ roster = {}, byPerson = {}, deathRecords = {} } = {}) {
  return { gid: 'g', roster, byPerson, deathRecords, sects: {}, bySect: {} }
}
const ev = (t, txt = '事件') => ({ t, type: 'flavor', txt, major: false, who: [], region: 'center', sect: '' })

test('陨落记录: 超过 30 天的清掉, 近期的保留', () => {
  const f = makeFake({
    deathRecords: {
      新亡者: { t: NOW - 5 * DAY, txt: '战死' },
      旧亡者: { t: NOW - 45 * DAY, txt: '病故' }
    }
  })

  const r = cleanupFakeHistory(f, NOW)

  assert.equal(r.changed, true)
  assert.deepEqual(Object.keys(f.deathRecords), ['新亡者'])
})

test('陨落记录: 硬上限 5000 条, 保留最新的一批', () => {
  const deathRecords = {}
  for (let i = 0; i < 5100; i++) deathRecords[`p${i}`] = { t: NOW - i * 1000, txt: 'x' }

  cleanupFakeHistory(makeFake({ deathRecords }), NOW)

  assert.equal(Object.keys(deathRecords).length, 5000)
  assert.ok(deathRecords.p0, '最新的一条要留下')
  assert.ok(deathRecords.p4999, '第 5000 新的一条仍在')
  assert.equal(deathRecords.p5000, undefined, '第 5001 新起被裁掉')
  assert.equal(deathRecords.p5099, undefined, '最旧的被裁掉')
})

test('没有陨落时间的旧格式记录会被清掉', () => {
  const f = makeFake({ deathRecords: { 无时间者: { txt: '旧档' } } })

  cleanupFakeHistory(f, NOW)

  assert.deepEqual(Object.keys(f.deathRecords), [])
})

test('保留窗与 byPerson 一致: 死 10 天留摘要但清生平, 死 2 天两者都留', () => {
  const f = makeFake({
    byPerson: { 半老旧: [ev(NOW - 10 * DAY)], 新亡者: [ev(NOW - 2 * DAY)] },
    deathRecords: {
      半老旧: { t: NOW - 10 * DAY, txt: '战死' },
      新亡者: { t: NOW - 2 * DAY, txt: '战死' }
    }
  })

  cleanupFakeHistory(f, NOW)

  assert.ok(f.deathRecords.半老旧, '10 天 < 30 天, 陨落摘要保留')
  assert.equal(f.byPerson.半老旧, undefined, '10 天 > 3 天, 生平已清')
  assert.ok(f.deathRecords.新亡者, '2 天内摘要保留')
  assert.ok(f.byPerson.新亡者, '2 天内生平保留')
})

test('久亡者: 生平与陨落摘要同轮一起清掉, 不留孤儿', () => {
  const f = makeFake({
    byPerson: { 久亡者: [ev(NOW - 60 * DAY)] },
    deathRecords: { 久亡者: { t: NOW - 60 * DAY, txt: '战死' } }
  })

  cleanupFakeHistory(f, NOW)

  assert.equal(f.byPerson.久亡者, undefined)
  assert.equal(f.deathRecords.久亡者, undefined)
})

test('无可清理内容时不改动', () => {
  const f = makeFake({
    roster: { 活人: { alive: true } },
    byPerson: { 活人: [ev(NOW - 1000)] },
    deathRecords: { 新亡者: { t: NOW - DAY, txt: '战死' } }
  })
  const snapshot = JSON.stringify(f)

  const r = cleanupFakeHistory(f, NOW)

  assert.equal(r.changed, false)
  assert.equal(JSON.stringify(f), snapshot)
})
