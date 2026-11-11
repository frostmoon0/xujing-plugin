import test from 'node:test'
import assert from 'node:assert/strict'
import { accrueSectDuty, dutyDay, dutyEarnedToday, donationCredit, VAULT_EQUIP_PRICES, VAULT_PILL_PRICES } from '../components/sect/vault_rules.js'
import { settleSectContributions } from '../components/sect/contribution.js'
import { vaultReserve } from '../components/sect/treasury.js'
import { getVault, MAT_COMMON, CFG } from '../components/sect/utils.js'
import { offer, exchange, takeFromVault, autoRefine, yaoyuanOutput } from '../components/sect/economy.js'
import { fakeSubThreshold, fakeVaultSupply, settleFakeVaultSupply, planFakeVaultSupply, saveFake, runPersonActs } from '../components/fake_data.js'
import { EQUIP_TPL, vaultEquipContrib, addItemToBag, autoEquipBest, getBag, getTotalAttr } from '../components/equip_data.js'
import { depositWarLoot, ensureVaultEquipAttrs } from '../components/sect/war_loot.js'
import xujing_data from '../components/xujing_data.js'
import { getWorld } from '../components/world_data.js'
import { Wanhun } from '../components/wanhun_data.js'
import { lastCmdKey } from '../components/idle_cleanup.js'

const HOUR = 3600000, MINUTE = 60000, NOW = +new Date(2026, 10, 6, 0)
global.logger ||= { error: () => {}, info: () => {} }
global.redis ||= { get: async () => null, set: async () => 'OK', del: async () => 1 }
let seq = 0
const bag = () => ({ items: {}, equipped: {}, equippedAttr: {}, artifacts: {} })
const person = (name, extra = {}) => ({ name, alive: true, status: 'sect', sect: 's', pos: 'dizi', level: 5, exp: 0, money: 0, contribution: 100, bag: bag(), ...extra })
function fixture (n = 1, owner = null) {
  const f = { gid: `vault_${process.pid}_${++seq}`, players: {}, roster: {}, sectMap: { s: {} }, areas: {}, areaDef: {}, sectAttacks: [],
    sects: { s: { name: '测试宗', owner, facilities: { yanwu: 5, hushan: 8, lingmai: 8, yaoyuan: 5 }, vault: { stones: 1000000, mats: {}, pills: {}, equips: {}, gongfas: {} } } } }
  for (let i = 0; i < n; i++) f.roster[`弟子${i}`] = person(`弟子${i}`)
  return f
}
async function playerFixture (pos = 'dizi') {
  const f = fixture(0, '101')
  f.players['101'] = { name: '玩家', sect: 's', pos, contribution: 100, joinAt: NOW }
  saveFake(f, f.gid)
  const home = await xujing_data.getQQYUserHome('101', null, `${f.gid}.json`, false)
  home['101'].money = 1000000
  await xujing_data.getQQYUserHome('101', home, `${f.gid}.json`, true)
  return f
}
const equipName = (q, slot = 'weapon') => Object.keys(EQUIP_TPL).find(n => EQUIP_TPL[n].quality === q && EQUIP_TPL[n].type === slot)
const first = f => Object.values(f.roster)[0]

test('所有品质、所有丹药使用同一份真人/伪玩家贡献价格', () => {
  assert.deepEqual(VAULT_EQUIP_PRICES.slice(1), [2, 4, 6, 8, 12, 20, 36])
  for (let q = 1; q <= 7; q++) assert.equal(vaultEquipContrib(equipName(q)), VAULT_EQUIP_PRICES[q])
  for (const [name, price] of Object.entries(VAULT_PILL_PRICES)) assert.equal(CFG.EXCHANGE[name].cost, price)
  assert.equal(VAULT_PILL_PRICES.修为丹, 1); assert.equal(VAULT_PILL_PRICES.破障丹, 2)
  assert.equal(VAULT_PILL_PRICES.聚宝丹, 3)
})

test('基础贡献每连续小时1点，每日最多12点；次日恢复，重试不重复', () => {
  const p = { contribution: 20 }
  accrueSectDuty(p, 's', NOW, true)
  for (let m = 1; m <= 24 * 60 - 1; m++) accrueSectDuty(p, 's', NOW + m * MINUTE, true)
  assert.equal(p.contribution, 32); assert.equal(dutyEarnedToday(p, NOW + HOUR), 12)
  const at = NOW + 24 * HOUR
  accrueSectDuty(p, 's', at, true)
  const balance = p.contribution
  assert.equal(accrueSectDuty(p, 's', at, true), 0)
  assert.ok(balance >= 32); assert.equal(dutyDay(at), dutyDay(NOW + 86400000))
  for (let m = 1; m <= 60; m++) accrueSectDuty(p, 's', at + m * MINUTE, true)
  assert.ok(p.contribution > balance)
})

test('首次上线、停机间隔、无法履职均不追补；换宗不重置当天额度', () => {
  const p = { contribution: 0, joinAt: NOW - 100 * HOUR }
  accrueSectDuty(p, 's', NOW, true)
  assert.equal(accrueSectDuty(p, 's', NOW + 10 * HOUR, true), 0)
  for (let m = 1; m <= 60; m++) accrueSectDuty(p, 's', NOW + 10 * HOUR + m * MINUTE, false)
  assert.equal(p.contribution, 0)
  p.sectDuty.earned = 12; p.joinAt = NOW
  assert.equal(accrueSectDuty(p, 'other', NOW + 12 * HOUR, true), 0)
  assert.equal(p.sectDuty.earned, 12)
})

test('真人活跃收入与正常门人一致，被俘/矿工/仆从/在途/失魂均不领', async () => {
  const f = fixture(1)
  first(f).contribution = 0
  f.players = { '101': { sect: 's', contribution: 0 }, '102': { sect: 's', contribution: 0 }, '103': { sect: 's', contribution: 0 } }
  const blocked = { 俘虏: {}, 矿工: { mineOf: 'other' }, 仆从: { servantOf: 'other' }, 在途: { fakeTravel: { end: NOW + 2 * HOUR } }, 失魂: { fakeLostUntil: NOW + 2 * HOUR } }
  for (const [name, extra] of Object.entries(blocked)) f.roster[name] = person(name, { contribution: 0, ...extra })
  f.sectAttacks = [{ phase: 'done', captives: { fakes: ['俘虏'], players: ['103'] } }]
  for (let m = 0; m <= 60; m++) await settleSectContributions(f, f.gid, NOW + m * MINUTE, {
    activity: { '101': NOW + m * MINUTE, '102': NOW - 3 * HOUR, '103': NOW + m * MINUTE }, playerEligible: async () => true
  })
  assert.equal(first(f).contribution, 1); assert.equal(f.players['101'].contribution, 1)
  for (const name of Object.keys(blocked)) assert.equal(f.roster[name].contribution, 0, name)
  assert.equal(f.players['102'].contribution, 0); assert.equal(f.players['103'].contribution, 0)
  delete f.players['101']
  f.players['101'] = { sect: 's', contribution: 0, joinAt: NOW + HOUR }
  await settleSectContributions(f, f.gid, NOW + 61 * MINUTE, { activity: { '101': NOW + 61 * MINUTE }, playerEligible: async () => true })
  assert.equal(f.players['101'].sectDuty.earned, 1, '重新入宗仍保留当天已发额度')
})

test('真人停止发指令两小时后暂停基础贡献', async () => {
  const f = fixture(0)
  f.players['101'] = { sect: 's', contribution: 0 }
  for (let m = 0; m <= 5 * 60; m++) await settleSectContributions(f, f.gid, NOW + m * MINUTE, { activity: { '101': NOW }, playerEligible: async () => true })
  assert.equal(f.players['101'].contribution, 2)
})

test('正式活跃表读取与真人在途/失魂状态检查生效', async () => {
  const f = fixture(0), world = getWorld(f.gid), oldRedis = global.redis, locked = Wanhun.isLocked
  for (const uid of ['101', '102', '103']) f.players[uid] = { sect: 's', contribution: 0 }
  world.moving['102'] = { end: NOW + 2 * HOUR }
  let at = NOW, reads = 0
  global.redis = { ...oldRedis, hGetAll: async key => {
    assert.equal(key, lastCmdKey(f.gid)); reads++
    return { '101': at, '102': at, '103': at }
  } }
  Wanhun.isLocked = uid => uid === '103'
  try {
    for (let m = 0; m <= 60; m++) { at = NOW + m * MINUTE; await settleSectContributions(f, f.gid, at) }
    assert.equal(reads, 61)
    assert.equal(f.players['101'].contribution, 1)
    assert.equal(f.players['102'].contribution, 0); assert.equal(f.players['103'].contribution, 0)
  } finally { global.redis = oldRedis; Wanhun.isLocked = locked }
})

test('玩家上供保留100灵石=1贡献，所有职位均可获得且不占基础上限', async () => {
  for (const pos of ['dizi', 'zhishi', 'fuzong', 'zongzhu', 'taishang']) {
    const f = await playerFixture(pos), p = f.players['101'], v = getVault(f, 's')
    p.sectDuty = { day: dutyDay(NOW), earned: 12 }
    const before = v.stones
    const res = await offer(f.gid, '101', 1500)
    assert.equal(res.ok, true); assert.equal(p.contribution, 115, pos)
    assert.equal(v.stones, before + 1500)
    assert.equal((await xujing_data.getQQYUserHome('101', null, `${f.gid}.json`, false))['101'].money, 998500)
    assert.equal(p.sectDuty.earned, 12)
  }
})

test('玩家兑换新价格生效，失败不扣贡献，库存与属性精确扣除', async () => {
  const f = await playerFixture(), v = getVault(f, 's'), p = f.players['101']
  v.pills.聚宝丹 = 2
  assert.equal((await exchange(f.gid, '101', '聚宝丹', 2)).ok, true)
  assert.equal(p.contribution, 94); assert.equal(v.pills.聚宝丹, undefined)
  const red = equipName(6), attr = { atk: 123, def: 4, hp: 55 }
  depositWarLoot(v, [{ name: red, count: 1, attr }])
  assert.equal((await exchange(f.gid, '101', red, 1)).ok, true)
  assert.equal(p.contribution, 74); assert.equal(getBag('101', f.gid).equipped.weapon, red)
  assert.deepEqual(getBag('101', f.gid).equippedAttr.weapon, attr)
  assert.equal((await exchange(f.gid, '101', red, 1)).ok, false)
  assert.equal(p.contribution, 74)
})

test('现金和建材储备同时约束玩家兑换及核心取用', async () => {
  const f = await playerFixture('zongzhu'), v = getVault(f, 's'), reserve = vaultReserve(f, 's')
  v.stones = reserve.stones
  assert.equal((await exchange(f.gid, '101', '灵石', 1)).ok, false)
  assert.equal(f.players['101'].contribution, 100)
  v.stones += 500
  assert.equal((await takeFromVault(f, f.gid, '101', '灵石', 'all')).ok, true)
  assert.equal(v.stones, reserve.stones)
  f.sects.s.facilities.yanwu = 4
  const reserve2 = vaultReserve(f, 's')
  v.mats.月魄石 = reserve2.mats.月魄石
  assert.equal((await exchange(f.gid, '101', '月魄石', 1)).ok, false)
  assert.equal((await takeFromVault(f, f.gid, '101', '月魄石', 1)).ok, false)
})

test('无偿提取的灵石再上供不重复刷贡献，退宗后重入也保留归还记录', async () => {
  const f = await playerFixture('zongzhu'), v = getVault(f, 's')
  v.stones = vaultReserve(f, 's').stones + 1000
  assert.equal((await takeFromVault(f, f.gid, '101', '灵石', 1000)).ok, true)
  f.players['101'] = { name: '玩家', pos: 'zongzhu', sect: 's', contribution: 100 }
  assert.equal((await offer(f.gid, '101', 1500)).ok, true)
  assert.equal(f.players['101'].contribution, 105)
  assert.equal(f.vaultStoneDraws['101'], 0)
  assert.deepEqual(donationCredit(200, 100), { drawn: 100, contribution: 0 })
})

test('伪玩家优先突破刚需，其次修炼；一次半小时只能兑换一件', () => {
  const f = fixture(), p = first(f), v = getVault(f, 's')
  Object.assign(v.pills, { 修为丹: 4, 破障丹: 4, 惊鸿丹: 4 })
  p.exp = fakeSubThreshold(p.level + 1)
  assert.equal(planFakeVaultSupply(f, p, NOW).name, '破障丹')
  assert.equal(fakeVaultSupply(f, p, NOW), true); assert.equal(p.contribution, 98)
  assert.equal(fakeVaultSupply(f, p, NOW + MINUTE), false)
  p.exp = 0
  assert.equal(fakeVaultSupply(f, p, NOW + HOUR / 2), true)
  assert.equal(p.bag.items.修为丹.count, 1)
})

test('伪玩家不会闲时买增益丹，备战只补一颗；被俘和战斗时不买', () => {
  const f = fixture(), p = first(f), v = getVault(f, 's')
  v.pills.惊鸿丹 = 4
  assert.equal(planFakeVaultSupply(f, p, NOW), null)
  f.sectAttacks.push({ id: 1, phase: 'prep', atkSect: 's', atkFakes: [p.name] })
  assert.equal(fakeVaultSupply(f, p, NOW), true)
  assert.equal(planFakeVaultSupply(f, p, NOW + HOUR), null)
  f.sectAttacks[0].phase = 'fight'
  assert.equal(fakeVaultSupply(f, p, NOW + HOUR), false)
  f.sectAttacks[0] = { phase: 'done', captives: { fakes: [p.name], players: [] } }
  assert.equal(fakeVaultSupply(f, p, NOW + HOUR), false)
})

test('备战不会购买无战斗效果的生活丹药', () => {
  const f = fixture(), p = first(f), v = getVault(f, 's')
  v.pills.聚宝丹 = 2; v.pills.灵犀丹 = 2
  f.sectAttacks.push({ id: 1, phase: 'prep', atkSect: 's', atkFakes: [p.name] })
  assert.equal(planFakeVaultSupply(f, p, NOW), null)
})

test('装备按真实属性增益购买，高品质弱装备不替换强装备，精确发出所选属性组', () => {
  const f = fixture(), p = first(f), v = getVault(f, 's')
  const low = equipName(5), red = equipName(6)
  addItemToBag(p.bag, low, 1, { atk: 100, def: 0, hp: 0 })
  depositWarLoot(v, [{ name: red, count: 1, attr: { atk: 10 } }])
  assert.equal(planFakeVaultSupply(f, p, NOW), null)
  const strong = { atk: 200, def: 10, hp: 20 }
  depositWarLoot(v, [{ name: red, count: 1, attr: strong }])
  const before = getTotalAttr(p.bag).power
  assert.equal(fakeVaultSupply(f, p, NOW), true)
  assert.ok(getTotalAttr(p.bag).power > before)
  assert.deepEqual(p.bag.equippedAttr.weapon, strong)
  assert.deepEqual(v.equipAttrs[red], [{ count: 1, attr: { atk: 10 } }])
  addItemToBag(p.bag, equipName(7), 1, { atk: 1 }, false)
  assert.deepEqual(autoEquipBest(p.bag), [])
})

test('低贡献优先填空缺，并按照实际增益/贡献挑装备，不透支', () => {
  const f = fixture(), p = first(f), v = getVault(f, 's')
  p.contribution = 4
  const cheap = equipName(1), expensive = equipName(6), cheap2 = equipName(2, 'helmet')
  depositWarLoot(v, [{ name: cheap, count: 1, attr: { atk: 10 } }, { name: expensive, count: 1, attr: { atk: 500 } }, { name: cheap2, count: 1, attr: { def: 30 } }])
  assert.equal(planFakeVaultSupply(f, p, NOW).name, cheap2)
  assert.equal(fakeVaultSupply(f, p, NOW), true); assert.equal(p.contribution, 0)
})

test('修为丹每日只用6点贡献，给低收入成员留下装备积蓄；突破不受此额度限制', () => {
  const f = fixture(), p = first(f), v = getVault(f, 's')
  v.pills.修为丹 = 20
  for (let i = 0; i < 6; i++) {
    assert.equal(fakeVaultSupply(f, p, NOW + i * HOUR / 2), true)
    delete p.bag.items.修为丹
  }
  assert.equal(planFakeVaultSupply(f, p, NOW + 6 * HOUR / 2), null)
  p.exp = fakeSubThreshold(p.level + 1); v.pills.破障丹 = 1
  assert.equal(fakeVaultSupply(f, p, NOW + 6 * HOUR / 2), true)
  p.exp = 0
  assert.equal(fakeVaultSupply(f, p, NOW + 24 * HOUR), true)
})

test('缺货时轮流领取，相同需求不会让固定名册前排长期霸占', () => {
  const f = fixture(10), v = getVault(f, 's'), served = new Set()
  for (let i = 0; i < 10; i++) {
    v.pills.修为丹 = 1
    settleFakeVaultSupply(f, NOW + i * HOUR / 2)
    for (const p of Object.values(f.roster)) if (p.vaultExchangeAt === NOW + i * HOUR / 2) served.add(p.name)
    assert.equal(settleFakeVaultSupply(f, NOW + i * HOUR / 2 + MINUTE), false)
  }
  assert.equal(served.size, 10)
})

test('旧库存属性只生成一次，连续选货不重新抽属性', () => {
  const f = fixture(), v = getVault(f, 's'), red = equipName(6)
  v.equips[red] = 2
  assert.equal(ensureVaultEquipAttrs(v), true)
  const attrs = structuredClone(v.equipAttrs)
  assert.equal(ensureVaultEquipAttrs(v), false)
  assert.deepEqual(v.equipAttrs, attrs)
})

test('自动炼制保留建材和两小时维护，有限生产且优先补缺部位', () => {
  const f = fixture(5, '101'), v = getVault(f, 's')
  f.sects.s.facilities.yanwu = 4
  const reserve = vaultReserve(f, 's')
  Object.assign(v.mats, reserve.mats)
  autoRefine(f)
  assert.deepEqual(v.equips, {}); assert.deepEqual(v.pills, {})
  for (const m of MAT_COMMON.concat(['凤栖花', '凤羽玉', '造梦神玉'])) v.mats[m] = 1000
  const full = Object.keys(EQUIP_TPL).filter(n => EQUIP_TPL[n].quality === 6)
  for (const p of Object.values(f.roster)) for (const slot of ['weapon', 'helmet', 'chest', 'pants', 'shoes']) {
    const name = full.find(n => EQUIP_TPL[n].type === slot)
    addItemToBag(p.bag, name, 1, { atk: 100, def: 100, hp: 100 })
  }
  autoRefine(f)
  const red = Object.keys(v.equips).find(n => EQUIP_TPL[n].quality === 6)
  assert.equal(EQUIP_TPL[red].type, 'ring')
  assert.equal(v.equipAttrs[red][0].count, 1)
  assert.ok(v.mats.凤羽玉 < 1000)
  for (let i = 0; i < 100; i++) autoRefine(f)
  assert.ok(Object.entries(v.equips).filter(([n]) => EQUIP_TPL[n].quality === 6).reduce((n, [, c]) => n + c, 0) <= 2)
  assert.ok(Object.values(v.pills).every(n => n <= 1))
})

test('药园总产量有限、按突破需求分配，满仓停止，不删除旧库存', () => {
  const f = fixture(10), v = getVault(f, 's')
  f.sects.s.facilities.yaoyuan = 1
  for (const p of Object.values(f.roster)) p.exp = fakeSubThreshold(p.level + 1)
  yaoyuanOutput(f, NOW)
  assert.equal((v.pills.修为丹 || 0) + (v.pills.破障丹 || 0), 8)
  assert.ok(v.pills.破障丹 > (v.pills.修为丹 || 0))
  v.pills = { 修为丹: 500, 破障丹: 500 }
  yaoyuanOutput(f, NOW + HOUR)
  assert.deepEqual(v.pills, { 修为丹: 500, 破障丹: 500 })
})

test('NPC核心取款不会侵占维护、出征与升级储备', async () => {
  const f = fixture(), p = first(f), v = getVault(f, 's')
  p.pos = 'zongzhu'
  const inactive = Number.MAX_SAFE_INTEGER
  p.activities = Object.fromEntries(['lastCultivate2', 'lastPill2', 'lastStall2', 'lastEquip2', 'lastOffer2'].map(k => [k, inactive]))
  p.activities.lastVaultTake = 0
  const reserve = vaultReserve(f, 's', NOW)
  v.stones = reserve.stones + 500
  await runPersonActs(f, NOW)
  assert.equal(v.stones, reserve.stones)
  assert.equal(p.money, 500); assert.equal(p.vaultStoneDrawn, 500)
  p.money = 10000
  p.activities.lastOffer2 = 0; p.activities.lastVaultTake = inactive
  const random = Math.random
  try { Math.random = () => 0; await runPersonActs(f, NOW + MINUTE) } finally { Math.random = random }
  assert.equal(p.contribution, 100, '将取出的500灵石重新上供，不得刷出5贡献')
  assert.equal(p.vaultStoneDrawn, 0)
})
