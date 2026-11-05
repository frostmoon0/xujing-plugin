/* 玩家宗主宗门材料维护: 按名册人数每小区每次结算扣 1~9 件; 战后 3 小时材料×2/灵石×5 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Save_Path } from '../components/plugin.js'
import { sectTick } from '../components/sect/tick.js'
import { WAR_UPKEEP_MS, markSectWar, inWarUpkeep, AREA_RAID_REST_MS, markAreaRaid, areaInRaidRest } from '../components/sect/utils.js'
import { sectMemberCount, sectMatUpkeepPieces, deductVaultMatsByStock, facilityMaintPerHr, hourlyAreaOutput, maintFacilities } from '../components/sect/economy.js'

const NOW = 1_800_000_000_000
const person = (name, sect, extra = {}) => ({ name, sect, alive: true, status: 'sect', realmBusy: null, pos: 'dizi', ...extra })

function makeF (members, players = {}, owner = '10001') {
  const roster = {}
  for (const n of members) roster[n] = person(n, 's1')
  return {
    gid: 'test',
    roster,
    players,
    sects: {
      s1: {
        name: '测试宗',
        owner,
        facilities: { yanwu: 5, hushan: 5, lingmai: 5, yaoyuan: 5 },
        vault: { stones: 1000000, mats: { 月魄石: 100, 星璇石: 60, 星霜草: 20 }, pills: {}, equips: {}, gongfas: {} },
        lastWarAt: 0
      }
    },
    areas: {},
    areaOut: []
  }
}

test('人数口径: 按宗门名册总人数(秘境中/非在世都算), 另加玩家门人', () => {
  const f = makeF(['甲', '乙', '丙'])
  f.roster['丁'] = person('丁', 's1', { realmBusy: { realmId: 'r1' } }) // 秘境中: 名册里仍算
  f.roster['戊'] = person('戊', 's1', { alive: false }) // 死亡: 名册里仍算(实际死亡会从 roster 删除)
  f.roster['己'] = person('己', 's1', { status: 'scatter' }) // 已离宗: 不算
  f.players = { '10001': { name: '宗主', sect: 's1', pos: 'zongzhu' } }
  assert.equal(sectMemberCount(f, 's1'), 6) // 甲乙丙丁戊 + 玩家; 己(散修)不算
})

test('维护件数: 按人数占满员比例, 1 人=1 件、满员=9 件', () => {
  /* makeF 演武场 5 级 → 满员 = 20 + 5×10 = 70 */
  const mk = (n) => makeF(Array.from({ length: n }, (_, i) => `人${i}`))
  assert.equal(sectMatUpkeepPieces(mk(1), 's1', NOW), 1) // 1 人 1 件
  assert.equal(sectMatUpkeepPieces(mk(20), 's1', NOW), 3) // ceil(20×9/70)=3
  assert.equal(sectMatUpkeepPieces(mk(35), 's1', NOW), 5) // ceil(35×9/70)=5
  assert.equal(sectMatUpkeepPieces(mk(70), 's1', NOW), 9) // 满员 9 件
  assert.equal(sectMatUpkeepPieces(mk(250), 's1', NOW), 9) // 超员也封顶 9
  /* 演武场 0 级 → 满员 20: 20 人直接吃满 9 件 */
  const small = makeF(Array.from({ length: 20 }, (_, i) => `人${i}`))
  small.sects.s1.facilities.yanwu = 0
  assert.equal(sectMatUpkeepPieces(small, 's1', NOW), 9)
})

test('战后 3 小时内维护件数 ×2, 过点恢复', () => {
  const f = makeF(Array.from({ length: 250 }, (_, i) => `人${i}`))
  assert.equal(sectMatUpkeepPieces(f, 's1', NOW), 9)
  markSectWar(f, 's1', NOW)
  assert.equal(sectMatUpkeepPieces(f, 's1', NOW + 1000), 18)
  assert.equal(inWarUpkeep(f, 's1', NOW + WAR_UPKEEP_MS - 1), true)
  assert.equal(inWarUpkeep(f, 's1', NOW + WAR_UPKEEP_MS), false)
  assert.equal(sectMatUpkeepPieces(f, 's1', NOW + WAR_UPKEEP_MS), 9)
})

test('只保留最近一次参战时间', () => {
  const f = makeF(['甲'])
  assert.equal(inWarUpkeep(f, 's1', NOW), false)
  markSectWar(f, 's1', NOW)
  markSectWar(f, 's1', NOW - 5000) // 更早的不覆盖
  assert.equal(f.sects.s1.lastWarAt, NOW)
  markSectWar(f, 's1', NOW + 20000)
  assert.equal(f.sects.s1.lastWarAt, NOW + 20000)
})

test('扣料按库存最多优先, 不足扣到 0 不报错', () => {
  const f = makeF(['甲'])
  f.sects.s1.vault.mats = { 月魄石: 5, 星璇石: 20, 星霜草: 7 }
  assert.equal(deductVaultMatsByStock(f, 's1', 10), 10)
  assert.deepEqual(f.sects.s1.vault.mats, { 星璇石: 16, 星霜草: 4, 月魄石: 2 })
  /* 剩余 22 件, 要 1000 件只能扣到 0 */
  assert.equal(deductVaultMatsByStock(f, 's1', 1000), 22)
  assert.deepEqual(f.sects.s1.vault.mats, {})
  assert.equal(deductVaultMatsByStock(f, 's1', 3), 0)
})

test('战后 3 小时灵石维护 ×5(仅玩家宗主宗门)', () => {
  const f = makeF(['甲'])
  const base = facilityMaintPerHr(f, 's1', 'yanwu', 5)
  assert.equal(base, 3120)
  markSectWar(f, 's1', Date.now()) // facilityMaintPerHr 用当前时间判断窗口
  assert.equal(facilityMaintPerHr(f, 's1', 'yanwu', 5), base * 5)
  /* 伪玩家宗门(无 owner): 不享受战后翻倍 */
  const fake = makeF(['甲'], {}, null)
  const fakeBase = facilityMaintPerHr(fake, 's1', 'yanwu', 5)
  markSectWar(fake, 's1', Date.now())
  assert.equal(facilityMaintPerHr(fake, 's1', 'yanwu', 5), fakeBase)
})

test('宗门材料维护: 每小时一次(与小区数无关), 按宗门人数; 伪玩家宗门不收', () => {
  const totalMats = (vault) => Object.values(vault.mats).reduce((a, b) => a + b, 0)
  const mkF = (owner) => {
    const f = makeF(Array.from({ length: 25 }, (_, i) => `人${i}`), {}, owner)
    f.areas = { 甲区: 's1', 乙区: 's1' }
    return f
  }

  const player = mkF('10001')
  const before = totalMats(player.sects.s1.vault)
  const stonesBefore = player.sects.s1.vault.stones
  maintFacilities(player, NOW)
  /* 两个小区不影响维护: 25 人 / 满员 70 → ceil(25×9/70)=4 件 */
  assert.equal(totalMats(player.sects.s1.vault), before - 4)
  assert.ok(player.sects.s1.vault.stones < stonesBefore) // 灵石维护照扣

  /* 没有小区的玩家宗门也照收(维护是宗门的, 不是小区的) */
  const noArea = makeF(Array.from({ length: 25 }, (_, i) => `人${i}`))
  const noAreaBefore = totalMats(noArea.sects.s1.vault)
  maintFacilities(noArea, NOW)
  assert.equal(totalMats(noArea.sects.s1.vault), noAreaBefore - 4)

  /* 伪玩家宗门不收材料维护 */
  const fake = mkF(null)
  const fakeBefore = totalMats(fake.sects.s1.vault)
  maintFacilities(fake, NOW)
  assert.equal(totalMats(fake.sects.s1.vault), fakeBefore)
})

test('小区被打后 3 小时没有收益(灵石/材料都不产), 维护照收', () => {
  const f = makeF(Array.from({ length: 25 }, (_, i) => `人${i}`))
  f.areas = { 测试小区: 's1' }
  markAreaRaid(f, '测试小区', NOW)
  assert.equal(areaInRaidRest(f, '测试小区', NOW + 1000), true)
  assert.equal(areaInRaidRest(f, '测试小区', NOW + AREA_RAID_REST_MS), false)

  const stonesBefore = f.sects.s1.vault.stones
  const matsBefore = Object.values(f.sects.s1.vault.mats).reduce((a, b) => a + b, 0)
  hourlyAreaOutput(f, NOW + 1000, { prosperity: { 测试宗: 1000 } })
  assert.equal(f.sects.s1.vault.stones, stonesBefore) // 灵石没有收益
  assert.equal(Object.values(f.sects.s1.vault.mats).reduce((a, b) => a + b, 0), matsBefore) // 材料也没有收益
  assert.equal(f.areaOut.length, 0) // 没有产出记录

  /* 3 小时结束才开始累计, 再满30分钟才有第一笔 */
  hourlyAreaOutput(f, NOW + AREA_RAID_REST_MS, { prosperity: { 测试宗: 1000 } })
  hourlyAreaOutput(f, NOW + AREA_RAID_REST_MS + 30 * 60000 - 1, { prosperity: { 测试宗: 1000 } })
  assert.equal(f.areaOut.length, 0)
  hourlyAreaOutput(f, NOW + AREA_RAID_REST_MS + 30 * 60000, { prosperity: { 测试宗: 1000 } })
  assert.ok(f.sects.s1.vault.stones > stonesBefore)
  assert.equal(f.areaOut.length, 1)
  assert.equal(f.areaOut[0].area, '测试小区')
})

test('被打小区独立结算: 不受全群批次影响, 重启后不重复, 再次被打重新等待', () => {
  for (const owner of ['10001', null]) {
    let f = makeF(['甲'], {}, owner)
    f.areas = { 甲区: 's1', 乙区: 's1', 未被打区: 's1' }
    markAreaRaid(f, '甲区', NOW)
    markAreaRaid(f, '乙区', NOW + 10 * 60000)
    const first = NOW + AREA_RAID_REST_MS + 30 * 60000
    const w = { prosperity: { 测试宗: 1000 } }
    const tick = (t) => hourlyAreaOutput(f, t, w, { raidedOnly: true })
    assert.equal(tick(first - 1), false)
    assert.equal(tick(first), true)
    assert.deepEqual(f.areaOut.map(o => o.area), ['甲区'])
    f = JSON.parse(JSON.stringify(f)) // 模拟保存再加载
    assert.equal(tick(first), false)
    assert.equal(tick(first + 10 * 60000), true)
    assert.equal(tick(first + 30 * 60000 - 1), false)
    assert.equal(tick(first + 30 * 60000), true)
    assert.deepEqual(f.areaOut.map(o => o.area), ['甲区', '乙区', '甲区'])
    markAreaRaid(f, '甲区', first + 31 * 60000)
    const next = first + 31 * 60000 + AREA_RAID_REST_MS + 30 * 60000
    tick(next - 1)
    assert.equal(f.areaOut.filter(o => o.area === '甲区').length, 2)
    tick(next)
    assert.equal(f.areaOut.filter(o => o.area === '甲区').length, 3)
  }
})

test('旧档沿用产出记录; 没被打的小区保留原批次产出', () => {
  const f = makeF(['甲'])
  f.areas = { 甲区: 's1', 乙区: 's1' }
  markAreaRaid(f, '甲区', NOW)
  const previous = NOW + AREA_RAID_REST_MS + 5 * 60000
  f.areaOut = [{ t: previous, area: '甲区' }]
  const w = { prosperity: {} }
  hourlyAreaOutput(f, previous + 30 * 60000 - 1, w)
  assert.deepEqual(f.areaOut.map(o => o.area), ['甲区', '乙区'])
  hourlyAreaOutput(f, previous + 30 * 60000, w, { raidedOnly: true })
  assert.deepEqual(f.areaOut.map(o => o.area), ['甲区', '乙区', '甲区'])
  assert.equal(f.areaOutputAt['甲区'], previous + 30 * 60000)
})

test('定时推进在全群批次之间也结算到期小区并保存独立时间', async (t) => {
  const gid = `area_clock_${Date.now()}`
  t.after(() => {
    for (const name of [`fake_${gid}.json`, `world_${gid}.json`]) {
      for (const suffix of ['', '.bak']) fs.rmSync(`${Save_Path}/world/${name}${suffix}`, { force: true })
    }
  })
  const f = makeF([])
  f.gid = gid
  f.areas = { 甲区: 's1', 未被打区: 's1' }
  markAreaRaid(f, '甲区', NOW)
  const first = NOW + AREA_RAID_REST_MS + 30 * 60000
  f.lastAreaOut = first - 5 * 60000 // 全群结算还要等25分钟
  f.lastMaint = first
  f.lastDiplomacy = first
  f.sects.s1.lastSalaryAt = first
  f.sects.s1.salaryOwner = '10001'
  await sectTick(f, gid, first - 1)
  assert.equal(f.areaOut.length, 0)
  await sectTick(f, gid, first)
  assert.deepEqual(f.areaOut.map(o => o.area), ['甲区'])
  const saved = JSON.parse(fs.readFileSync(`${Save_Path}/world/fake_${gid}.json`, 'utf8'))
  assert.equal(saved.areaOutputAt['甲区'], first)
  assert.equal(f.lastAreaOut, first - 5 * 60000)
})
