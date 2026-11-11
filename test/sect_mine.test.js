import test from 'node:test'
import assert from 'node:assert/strict'
import { MINE_MAX_DAYS, mineDeathRate, mineStonesPerHr, mineTick } from '../components/sect/economy.js'

const HOUR = 3600000
const DAY = 24 * HOUR
const START = 1_800_000_000_000

function fixture (level = 68, at = START) {
  const p = { name: '测试矿工', alive: true, status: 'mine', sect: null, mineOf: 's1', mineSince: at, level, money: 0 }
  const miner = { name: p.name, at, outStones: 0, outMats: {}, colorHit: 0 }
  const vault = { stones: 0, mats: {}, pills: {}, equips: {}, gongfas: {} }
  const f = { gid: 'mine_test', roster: { [p.name]: p }, sects: { s1: { name: '测试宗', vault } }, sectMines: { s1: [miner] }, pool: [], poolPriority: [] }
  return { f, p, miner, vault }
}

function closeTo (actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} 应接近 ${expected}`)
}

test('68级矿难基准按服役整小时推进，累计每天增加5%，20天封顶', () => {
  assert.equal(MINE_MAX_DAYS, 20)
  assert.equal(mineDeathRate(0), 0)
  assert.equal(mineDeathRate(HOUR - 1), 0)
  closeTo(mineDeathRate(HOUR), 1 / 480)
  closeTo(mineDeathRate(DAY), 0.05)
  closeTo(mineDeathRate(10 * DAY), 0.5)
  assert.equal(mineDeathRate(20 * DAY), 1)
  assert.equal(mineDeathRate(25 * DAY), 1)
})

test('68级基准逐小时条件死亡率递增，反复结算后的累计死亡率按天数增长', () => {
  let survival = 1
  let previousRate = 0
  for (let hour = 1; hour <= 480; hour++) {
    const rate = mineDeathRate(hour * HOUR, (hour - 1) * HOUR)
    assert.ok(rate > previousRate, `第${hour}小时风险应高于前一小时`)
    survival *= 1 - rate
    if (hour % 24 === 0) closeTo(1 - survival, hour / 480)
    previousRate = rate
  }
  assert.equal(survival, 0)
})

test('同等服役时间下境界越低越易死，仙帝以上仍逐重降低风险', () => {
  for (const duration of [DAY, 10 * DAY, 19 * DAY]) {
    for (const levels of [[1, 20, 68, 78, 567], [68, 69, 78, 168, 567]]) {
      const rates = levels.map(level => mineDeathRate(duration, 0, level))
      for (let i = 1; i < levels.length; i++) {
        assert.ok(rates[i - 1] > rates[i], `服役${duration / DAY}天时，${levels[i - 1]}级应比${levels[i]}级更易死亡`)
      }
      assert.ok(rates.at(-1) > 0, '最高境界也不能免疫矿难')
    }
    closeTo(mineDeathRate(duration, 0, 68), mineDeathRate(duration))
  }
})

test('各境界每小时条件风险随服役时间递增，累计分布与整段离线一致', () => {
  for (const level of [1, 20, 68, 78, 567]) {
    let survival = 1
    let previousRate = 0
    let offlineSurvival = 1
    for (let hour = 1; hour <= 480; hour++) {
      const rate = mineDeathRate(hour * HOUR, (hour - 1) * HOUR, level)
      assert.ok(rate > previousRate, `${level}级第${hour}小时的条件死亡率应继续增加`)
      survival *= 1 - rate
      if (hour > 8 * 24 && hour <= 10 * 24) offlineSurvival *= 1 - rate
      if (hour % 24 === 0) {
        const expectedCdf = 1 - Math.pow(1 - hour / 480, Math.sqrt(68 / level))
        closeTo(1 - survival, expectedCdf)
        closeTo(mineDeathRate(hour * HOUR, 0, level), expectedCdf)
      }
      previousRate = rate
    }
    closeTo(mineDeathRate(10 * DAY, 8 * DAY, level), 1 - offlineSurvival)
    assert.equal(survival, 0, `${level}级至第20天应必死`)
    assert.equal(mineDeathRate(25 * DAY, 0, level), 1)
    assert.equal(mineDeathRate(DAY, DAY, level), 0)
  }
})

test('矿山实际使用人物境界，同服役时长和抽签下低境界死而高境界存活', t => {
  t.mock.method(Math, 'random', () => 0.5)
  const low = fixture(1)
  const high = fixture(567)

  mineTick(low.f, START + 10 * DAY)
  mineTick(high.f, START + 10 * DAY)

  assert.equal(low.f.roster[low.p.name], undefined)
  assert.deepEqual(low.f.sectMines.s1, [])
  assert.equal(low.vault.stones, 0)
  assert.equal(high.f.roster[high.p.name], high.p)
  assert.deepEqual(high.f.sectMines.s1, [high.miner])
  assert.equal(high.vault.stones, 100000)
})

test('离线跨度按已检查时长计算条件风险，同一服役小时没有新增风险', () => {
  closeTo(mineDeathRate(10 * DAY, 8 * DAY), 1 / 6)
  assert.equal(mineDeathRate(DAY + HOUR - 1, DAY), 0)
  assert.equal(mineDeathRate(DAY, DAY), 0)
})

test('存活矿工保留每小时产出并记录风险检查时间', t => {
  t.mock.method(Math, 'random', () => 0.5)
  const { f, p, miner, vault } = fixture()
  mineTick(f, START + HOUR)

  assert.equal(f.roster[p.name], p)
  assert.equal(f.sectMines.s1[0], miner)
  assert.equal(vault.stones, 100000)
  assert.equal(vault.stones, Math.floor(mineStonesPerHr(p.level) * 2 / 3))
  assert.equal(miner.outStones, vault.stones)
  assert.equal(Object.values(vault.mats).reduce((a, b) => a + b, 0), 1)
  assert.deepEqual(miner.outMats, vault.mats)
  assert.equal(miner.lastDeathCheckAt, START + HOUR)
  assert.equal(f.mineEvents.at(-1).type, 'work')
})

test('已检查时钟保存重载后，同一小时不重复抽死亡，下一小时仍推进', t => {
  let random = 0.99
  t.mock.method(Math, 'random', () => random)
  const { f, p } = fixture()
  mineTick(f, START + HOUR)
  const restored = JSON.parse(JSON.stringify(f))
  random = 0
  mineTick(restored, START + HOUR + 30 * 60000)
  assert.ok(restored.roster[p.name]?.alive)
  assert.equal(Math.floor((restored.sectMines.s1[0].lastDeathCheckAt - START) / HOUR), 1)
  mineTick(restored, START + 2 * HOUR)
  assert.equal(restored.roster[p.name], undefined)
  assert.deepEqual(restored.sectMines.s1, [])
})

test('首次离线结算覆盖累计风险，后续仅补算上次检查后的跨度', t => {
  let random = 0.49
  t.mock.method(Math, 'random', () => random)
  const first = fixture()
  mineTick(first.f, START + 10 * DAY)
  assert.equal(first.f.roster[first.p.name], undefined)

  const checked = fixture()
  checked.miner.lastDeathCheckAt = START + 8 * DAY
  random = 0.2
  mineTick(checked.f, START + 10 * DAY)
  assert.ok(checked.f.roster[checked.p.name]?.alive)
  assert.equal(checked.vault.stones, 100000, '离线不补发多小时产出')
  mineTick(checked.f, START + 16 * DAY)
  assert.equal(checked.f.roster[checked.p.name], undefined)
})

test('低境界及仙帝以上均在服役满20天时强制死亡并清理留档', t => {
  t.mock.method(Math, 'random', () => 1) // 必死分支不能依赖随机数恰好小于1
  for (const level of [1, 20, 65, 68, 78, 567]) {
    const { f, p, miner } = fixture(level)
    mineTick(f, START + 20 * DAY)
    assert.equal(p.alive, false, `level=${level}`)
    assert.equal(f.roster[p.name], undefined)
    assert.deepEqual(f.sectMines.s1, [])
    assert.equal(f.deathRecords[p.name].t, START + 20 * DAY)
    assert.match(f.deathRecords[p.name].txt, /矿难/)
    const event = f.mineEvents.find(x => x.type === 'death')
    assert.ok(event)
    assert.equal(event.duration, 20 * DAY)
    assert.equal(event.at, START)
    assert.equal(event.stones, miner.outStones)
    assert.ok(f.byPerson[p.name].some(x => x.type === 'death'))
  }
})

test('超过20天才恢复结算，死亡记录仍封顶在服役第20天', t => {
  t.mock.method(Math, 'random', () => 0.99)
  const { f, p } = fixture(567)
  mineTick(f, START + 25 * DAY)
  assert.equal(f.roster[p.name], undefined)
  assert.equal(f.deathRecords[p.name].t, START + 20 * DAY)
  const event = f.mineEvents.find(x => x.type === 'death')
  assert.equal(event.t, START + 20 * DAY)
  assert.equal(event.duration, 20 * DAY)
})

test('随机矿难及超期强制死亡均先于产出，宝库和历史累计不增加', t => {
  t.mock.method(Math, 'random', () => 0) // 若错误继续挖矿，必定触发彩材料产出
  for (const duration of [HOUR, 25 * DAY]) {
    const { f, p, miner, vault } = fixture(567)
    vault.stones = 500
    vault.mats = { 月魄石: 100, 云裳仙蕊: 6 }
    miner.outStones = 1234
    miner.outMats = { 月魄石: 3, 云裳仙蕊: 2 }
    miner.colorHit = 2
    const beforeVault = structuredClone(vault)
    const beforeOutput = { stones: miner.outStones, mats: structuredClone(miner.outMats), colorHit: miner.colorHit }

    mineTick(f, START + duration)

    assert.equal(f.roster[p.name], undefined)
    assert.deepEqual(f.sectMines.s1, [])
    assert.deepEqual(vault, beforeVault, '死亡当次不能再往宝库添加灵石、普通材料或彩材料')
    assert.equal(miner.outStones, beforeOutput.stones)
    assert.deepEqual(miner.outMats, beforeOutput.mats)
    assert.equal(miner.colorHit, beforeOutput.colorHit)
    assert.deepEqual(f.mineEvents.map(x => x.type), ['death'])
    assert.equal(f.mineEvents[0].stones, beforeOutput.stones)
    assert.deepEqual(f.mineEvents[0].mats, beforeOutput.mats)
    assert.equal(f.mineEvents[0].colorHit, beforeOutput.colorHit)
    assert.ok(![...(f.major || []), ...(f.minor || [])].some(x => /【矿彩】|【挖矿】/.test(x.txt)))
  }
})

test('同批一名矿工死亡后，其他存活矿工仍正常产出和留在矿山', t => {
  t.mock.method(Math, 'random', () => 0.5)
  const { f, p, miner, vault } = fixture(567)
  const now = START + 20 * DAY
  const survivor = { ...p, name: '存活矿工', mineSince: now - HOUR }
  const survivorMine = { name: survivor.name, at: survivor.mineSince, outStones: 0, outMats: {}, colorHit: 0 }
  f.roster[survivor.name] = survivor
  f.sectMines.s1.push(survivorMine)

  mineTick(f, now)

  assert.equal(f.roster[p.name], undefined)
  assert.equal(f.roster[survivor.name], survivor)
  assert.equal(survivor.alive, true)
  assert.deepEqual(f.sectMines.s1, [survivorMine])
  assert.equal(miner.outStones, 0)
  assert.equal(survivorMine.outStones, 100000)
  assert.equal(vault.stones, survivorMine.outStones)
  assert.equal(Object.values(vault.mats).reduce((a, b) => a + b, 0), 1)
  assert.deepEqual(f.mineEvents.map(x => [x.name, x.type]), [[p.name, 'death'], [survivor.name, 'work']])
})

test('旧矿工缺少入矿时间时回退人物mineSince，仍受20天上限约束', t => {
  t.mock.method(Math, 'random', () => 0.99)
  const { f, p, miner } = fixture(567)
  delete miner.at
  mineTick(f, START + HOUR)
  assert.equal(miner.at, START)
  mineTick(f, START + 20 * DAY)
  assert.equal(f.roster[p.name], undefined)
})

test('旧档完全缺少入矿时间时首次固定起点，后续不会无限重置', t => {
  t.mock.method(Math, 'random', () => 0.99)
  const { f, p, miner } = fixture(567)
  delete miner.at
  delete p.mineSince
  mineTick(f, START)
  assert.equal(miner.at, START)
  assert.ok(f.roster[p.name]?.alive)
  mineTick(f, START + 20 * DAY)
  assert.equal(f.roster[p.name], undefined)
})

test('有效的0时间戳不会被当作缺失，矿工at优先于人物mineSince', t => {
  t.mock.method(Math, 'random', () => 0.99)
  const zero = fixture(567, 0)
  mineTick(zero.f, 20 * DAY)
  assert.equal(zero.f.roster[zero.p.name], undefined)
  assert.equal(zero.f.deathRecords[zero.p.name].t, 20 * DAY)

  const preferred = fixture(567)
  preferred.p.mineSince = START - 20 * DAY
  mineTick(preferred.f, START + HOUR)
  assert.equal(preferred.miner.at, START)
  assert.ok(preferred.f.roster[preferred.p.name]?.alive)
})
