import test from 'node:test'
import assert from 'node:assert/strict'
import { areaTxtOf, sectTxtOf, warTargetTxt, targetRawTxt } from '../components/sect/utils.js'
import { joinSectFight, respondDefend, sectReinforce, resolveJoinSide, startSectAttack, isSectWarParticipant, quitRogueParticipation, sectForceAdjust } from '../components/sect/war.js'

/** 构造最小宗门世界夹具(仅展示/选择逻辑所需字段, 不落盘) */
function makeFake () {
  return {
    gid: 'g',
    sects: {
      s1: { name: '青云宗', region: 'center', owner: '100', enemies: [], allies: [], vault: { stones: 100000 } },
      s2: { name: '太虚门', region: 'center', owner: null, enemies: [], allies: [], vault: { stones: 100000 } }
    },
    sectMap: { s1: { taishang: [] }, s2: { taishang: [] } },
    areas: { 天墉城: 's2', 白鹿原: 's2' },
    areaDef: {},
    sectDeadNames: {},
    players: {
      '100': { name: '甲', sect: 's1', pos: 'zongzhu', contribution: 0 },
      '200': { name: '乙', sect: 's1', pos: 'dizi', contribution: 0 }
    },
    roster: {},
    sectAttacks: [],
    sectJails: {},
    raidJail: [],
    sectMines: {},
    targetCd: {},
    sectSeq: 0
  }
}

function war (id, overrides) {
  return Object.assign({
    id, phase: 'prep', targetType: 'area', target: '天墉城', atkSect: 's1',
    atkPlayers: [], defPlayers: [], atkFakes: [], defFakes: [], defended: false,
    defenderDecided: false, wanhunParticipants: { atk: [], def: [] }, captives: { fakes: [], players: [] }
  }, overrides)
}

/** 造一个可参战的伪玩家门人(在 target 区外 → 属"在外门人") */
function mkPerson (name, loc = 'east') {
  return { name, alive: true, realmBusy: false, sect: 's1', status: 'sect', loc, trait: '普通', loyalty: 60, act: '普通', money: 0 }
}

/* ---------- 战争目标完整显示名(小区名 + 宗门名) ---------- */

test('areaTxtOf: 小区名带占领宗门名; 无主/原宗已灭显示无主', () => {
  const f = makeFake()
  assert.equal(areaTxtOf(f, '天墉城'), '【天墉城】（太虚门）')
  assert.equal(areaTxtOf(f, '冰渊'), '【冰渊】（无主）')
  /* 占领宗门已灭门 → 视为无主 */
  const f2 = makeFake()
  f2.sects.s2.wipeAt = Date.now() - 1000
  assert.equal(areaTxtOf(f2, '天墉城'), '【天墉城】（无主）')
})

test('sectTxtOf: 宗门名带大区与地盘小区; 永久除名只剩名', () => {
  const f = makeFake()
  assert.equal(sectTxtOf(f, 's2'), '【太虚门】（中州·天墉城、白鹿原）')
  /* 已灭门永久除名(对象删除): 只显示宗门名 */
  const f2 = makeFake()
  delete f2.sects.s2
  f2.sectDeadNames.s2 = '太虚门'
  assert.equal(sectTxtOf(f2, 's2'), '【太虚门】')
})

test('warTargetTxt: 按目标类型分派, 小区/宗门都带上', () => {
  const f = makeFake()
  assert.equal(warTargetTxt(f, { targetType: 'area', target: '天墉城' }), '【天墉城】（太虚门）')
  assert.equal(warTargetTxt(f, { targetType: 'sect', target: 's2' }), '【太虚门】（中州·天墉城、白鹿原）')
})

test('targetRawTxt: 用户输入的 小区名/宗门名 → 完整显示名', () => {
  const f = makeFake()
  assert.equal(targetRawTxt(f, '天墉城'), '【天墉城】（太虚门）')
  assert.equal(targetRawTxt(f, '太虚门'), '【太虚门】（中州·天墉城、白鹿原）')
  assert.equal(targetRawTxt(f, '不存在的目标'), '【不存在的目标】')
  assert.equal(targetRawTxt(f, ''), '')
})

/* ---------- 参与攻打/宗门防守: 多处战事 → 列出 小区+宗门名 与 人数 ---------- */

test('joinSectFight: 多处攻打未指定目标 → 列出可选(小区+宗门名+人数)', () => {
  const f = makeFake()
  f.sectAttacks = [
    war(1, { target: '天墉城', atkFakes: [], atkPlayers: [] }),
    war(2, { target: '白鹿原', atkFakes: ['张三'], atkPlayers: ['200'] })
  ]
  const r = joinSectFight(f, 'g', '200', 'atk', false)
  assert.equal(r.ok, false)
  assert.equal(r.needChoice, true)
  /* 小区目标带占领宗门名 + 人数 */
  assert.match(r.msg, /【天墉城】（太虚门）/)
  assert.match(r.msg, /【白鹿原】（太虚门）/)
  assert.match(r.msg, /参战 0 人/)
  assert.match(r.msg, /参战 2 人/)
  assert.match(r.msg, /#参与攻打 \[目标名\]/)
})

test('joinSectFight: 指定目标但无该处战事 → 带完整目标名的报错', () => {
  const f = makeFake()
  f.sectAttacks = [war(1, { target: '天墉城' })]
  const r = joinSectFight(f, 'g', '200', 'atk', false, '白鹿原')
  assert.equal(r.ok, false)
  assert.match(r.msg, /本宗没有正在攻打【白鹿原】（太虚门）/)
})

test('joinSectFight: 无进行中战事 → 原报错文案', () => {
  const f = makeFake()
  const r = joinSectFight(f, 'g', '200', 'atk', false)
  assert.equal(r.ok, false)
  assert.equal(r.needChoice, undefined)
  assert.match(r.msg, /本宗当前没有进行中的攻打/)
})

/* ---------- 守: 多处被攻 → 宗主逐处决策 ---------- */

test('respondDefend: 多处被攻未指定 → 列出可选(小区+宗门名+人数), 指令示例带目标', () => {
  const f = makeFake()
  f.areas['白鹿原'] = 's1' // s1 正在守 白鹿原(自家地盘)
  f.sectAttacks = [
    war(1, { target: '白鹿原', atkSect: 's2', defFakes: [], defPlayers: ['200'] }),
    war(2, { targetType: 'sect', target: 's1', atkSect: 's2' })
  ]
  const r = respondDefend(f, 'g', '100', true)
  assert.equal(r.ok, false)
  assert.equal(r.needChoice, true)
  /* 小区目标带占领宗门名; 宗门目标带大区+地盘 */
  assert.match(r.msg, /【白鹿原】（青云宗）/)
  assert.match(r.msg, /【青云宗】（中州·白鹿原）/)
  assert.match(r.msg, /参战 1 人/)
  assert.match(r.msg, /#守 \[目标名\]/)
})

test('respondDefend: 指定目标但无该处待回应攻打 → 带完整目标名的报错', () => {
  const f = makeFake()
  f.areas['白鹿原'] = 's1' // s1 正在守白鹿原(有1处待回应), 但指定的是别处天墉城
  f.sectAttacks = [war(1, { target: '白鹿原', atkSect: 's2' })]
  const r = respondDefend(f, 'g', '100', true, '天墉城')
  assert.equal(r.ok, false)
  assert.equal(r.needChoice, undefined)
  assert.match(r.msg, /当前没有正在攻打【天墉城】（太虚门）的待回应战事/)
})

test('respondDefend: 无待回应攻打 → 原报错文案', () => {
  const f = makeFake()
  const r = respondDefend(f, 'g', '100', true)
  assert.equal(r.ok, false)
  assert.match(r.msg, /当前没有待回应的攻打/)
})

/* ---------- 驰援/集结仆从: 多处战事列出 打/守 + 小区+宗门名 + 人数 ---------- */

test('sectReinforce: 多处战事 → 列出 打/守 + 小区+宗门名 + 人数', () => {
  const f = makeFake()
  f.areas['白鹿原'] = 's1' // s1 守白鹿原, 同时进攻天墉城(太虚门地盘)
  f.sectAttacks = [
    war(1, { target: '天墉城', atkSect: 's1', atkFakes: [], atkPlayers: [] }),
    war(2, { target: '白鹿原', atkSect: 's2', defFakes: ['王五'], defPlayers: ['200'] })
  ]
  const r = sectReinforce(f, 'g', '100')
  assert.equal(r.ok, false)
  assert.equal(r.needChoice, true)
  assert.match(r.msg, /进攻【天墉城】（太虚门） · 参战 0 人/)
  assert.match(r.msg, /防守【白鹿原】（青云宗） · 参战 2 人/)
})

test('sectReinforce: 指定目标但无该战事 → 带完整目标名的报错', () => {
  const f = makeFake()
  f.areas['白鹿原'] = 's1'
  f.sectAttacks = [
    war(1, { target: '天墉城', atkSect: 's1' })
  ]
  const r = sectReinforce(f, 'g', '100', '白鹿原')
  assert.equal(r.ok, false)
  assert.match(r.msg, /没有正在攻打【白鹿原】（青云宗）的战事/)
})

/* ---------- 指定人数(#驰援 天墉城 3): 按人数调派 ---------- */

test('sectReinforce 指定人数 → 只调派指定人数', () => {
  const f = makeFake()
  f.sects.s1.owner = '100'
  f.sects.s1.vault = { stones: 200000 } // 传送费充足
  f.roster = {
    '甲一': mkPerson('甲一', 'east'),
    '甲二': mkPerson('甲二', 'east'),
    '甲三': mkPerson('甲三', 'east'),
    '甲四': mkPerson('甲四', 'east')
  }
  f.sectAttacks = [war(1, { target: '天墉城', atkSect: 's1' })]
  const r = sectReinforce(f, 'g', '100', '天墉城', 2)
  assert.equal(r.ok, true)
  /* 只派 2 人入攻军, 而非全部 4 人 */
  assert.equal(f.sectAttacks[0].atkFakes.length, 2)
  assert.match(r.msg, /按你指定 2 人/)
  /* 其余人仍留原大区, 未被误调 */
  assert.equal(f.roster['甲三'].loc, 'east')
  assert.equal(f.roster['甲四'].loc, 'east')
})

test('sectReinforce 指定人数超出可派 → 明确告知不足', () => {
  const f = makeFake()
  f.sects.s1.owner = '100'
  f.sects.s1.vault = { stones: 0 } // 无传送费 → can=0
  f.roster = {
    '甲一': mkPerson('甲一', 'east'),
    '甲二': mkPerson('甲二', 'east')
  }
  f.sectAttacks = [war(1, { target: '天墉城', atkSect: 's1' })]
  const r = sectReinforce(f, 'g', '100', '天墉城', 5)
  assert.equal(r.ok, false)
  assert.match(r.msg, /指定的 5 人无法全部调派（可调门人 2 人，宝库可支付 0 人传送费）/)
  assert.equal(f.sectAttacks[0].atkFakes.length, 0)
})

/* ---------- #参战/#退战 自动分边 ---------- */

test('resolveJoinSide: 自动分边 攻/守/both/none', () => {
  /* 本宗正在攻打 → atk */
  const f = makeFake()
  f.sectAttacks = [war(1, { target: '天墉城', atkSect: 's1' })]
  assert.equal(resolveJoinSide(f, '200', false), 'atk')
  /* 本宗被攻打(守白鹿原) → def */
  const f2 = makeFake()
  f2.areas['白鹿原'] = 's1'
  f2.sectAttacks = [war(1, { target: '白鹿原', atkSect: 's2' })]
  assert.equal(resolveJoinSide(f2, '200', false), 'def')
  /* 攻+守都有 → both */
  const f3 = makeFake()
  f3.areas['白鹿原'] = 's1'
  f3.sectAttacks = [
    war(1, { target: '天墉城', atkSect: 's1' }),
    war(2, { target: '白鹿原', atkSect: 's2' })
  ]
  assert.equal(resolveJoinSide(f3, '200', false), 'both')
  /* 都无 → none */
  const f4 = makeFake()
  assert.equal(resolveJoinSide(f4, '200', false), 'none')
  /* 指定目标 → 按目标分边 */
  assert.equal(resolveJoinSide(f, '200', false, '天墉城'), 'atk')
  assert.equal(resolveJoinSide(f, '200', false, '白鹿原'), 'none')
})

test('joinSectFight auto: 既有攻打又有被攻打 → 列出 打/守 可选(小区+宗门名+人数)', () => {
  const f = makeFake()
  f.areas['白鹿原'] = 's1'
  f.sectAttacks = [
    war(1, { target: '天墉城', atkSect: 's1', atkFakes: ['张三'] }),
    war(2, { target: '白鹿原', atkSect: 's2', defFakes: ['李四'] })
  ]
  const r = joinSectFight(f, 'g', '200', 'auto', false)
  assert.equal(r.ok, false)
  assert.equal(r.needChoice, true)
  assert.match(r.msg, /进攻【天墉城】（太虚门） · 参战 1 人/)
  assert.match(r.msg, /防守【白鹿原】（青云宗） · 参战 1 人/)
  assert.match(r.msg, /#参战 \[目标名\]/)
})

test('joinSectFight auto: 无战事 → 提示; 退战无参战 → 提示', () => {
  const f = makeFake()
  const r1 = joinSectFight(f, 'g', '200', 'auto', false)
  assert.equal(r1.ok, false)
  assert.match(r1.msg, /本宗当前没有进行中的攻打或被攻打/)
  const r2 = joinSectFight(f, 'g', '200', 'auto', true)
  assert.equal(r2.ok, false)
  assert.match(r2.msg, /你当前没有可退出的参战/)
})

/* ---------- #攻打 宗门名/小区名 都能解析 ---------- */

test('0人攻打不允许发起，扣费会退回', async () => {
  const f = makeFake()
  f.sects.s1.owner = '100'
  f.sects.s2.owner = '300'
  f.players['300'] = { name: '丙', sect: 's2', pos: 'zongzhu' }
  f.roster = {
    丙一: { name: '丙一', alive: true, realmBusy: false, sect: 's2', status: 'sect', loc: 'center', trait: '普通', loyalty: 60, act: '普通' }
  }
  const before = f.sects.s1.vault.stones
  const r = await startSectAttack(f, 'g', 's1', '太虚门', 'player')
  assert.equal(r.ok, false)
  assert.equal(f.sectAttacks.length, 0)
  assert.equal(f.sects.s1.vault.stones, before)
})

test('减兵可撤下伪玩家门人，减到0直接终止', async () => {
  const f = makeFake()
  f.sects.s1.owner = '100'
  f.roster = { 甲: mkPerson('甲', 'center'), 乙: mkPerson('乙', 'center') }
  f.sectAttacks = [war(1, { atkSect: 's1', target: '天墉城', targetType: 'area', atkFakes: ['甲', '乙'] })]
  const r1 = await sectForceAdjust(f, 'g', '100', null, -1)
  assert.equal(r1.ok, true)
  assert.equal(f.sectAttacks[0].atkFakes.length, 1)
  const r2 = await sectForceAdjust(f, 'g', '100', null, -1)
  assert.equal(r2.ok, true)
  assert.equal(f.sectAttacks[0].phase, 'done')
})

test('startSectAttack: 输入宗门名可发起攻打(targetType=sect)', async () => {
  const f = makeFake()
  f.sects.s1.owner = '100'
  f.sects.s2.owner = '300' // 目标玩家主导 → 跳过 AI 自动决策
  f.players['300'] = { name: '丙', sect: 's2', pos: 'zongzhu' }
  /* 目标宗门有在世门人(防空壳校验: sectAlive>0 才可攻打) */
  f.roster = {
    '甲': mkPerson('甲'),
    '丙一': { name: '丙一', alive: true, realmBusy: false, sect: 's2', status: 'sect', loc: 'center', trait: '普通', loyalty: 60, act: '普通' },
    '丙二': { name: '丙二', alive: true, realmBusy: false, sect: 's2', status: 'sect', loc: 'center', trait: '普通', loyalty: 60, act: '普通' }
  }
  const r = await startSectAttack(f, 'g', 's1', '太虚门', 'player')
  assert.equal(r.ok, true)
  assert.equal(r.atk.targetType, 'sect')
  assert.equal(r.atk.target, 's2')
  assert.match(r.msg, /已对【太虚门】/)
})

test('startSectAttack: 输入小区名可发起攻打(targetType=area)', async () => {
  const f = makeFake()
  f.sects.s1.owner = '100'
  f.roster = { 甲: mkPerson('甲') }
  const r = await startSectAttack(f, 'g', 's1', '天墉城', 'player')
  assert.equal(r.ok, true)
  assert.equal(r.atk.targetType, 'area')
  assert.equal(r.atk.target, '天墉城')
})

test('startSectAttack: 不能攻打自家宗门', async () => {
  const f = makeFake()
  const r = await startSectAttack(f, 'g', 's1', '青云宗', 'player')
  assert.equal(r.ok, false)
  assert.match(r.msg, /不能攻打自家/)
})

/* ---------- 战争参与状态(统一 Proxy 拦截依据) ---------- */

test('isSectWarParticipant: 攻/守名单中为真, 战争结束/未参战为假', () => {
  const f = makeFake()
  f.sectAttacks = [
    { phase: 'prep', atkPlayers: ['100'], defPlayers: [] },
    { phase: 'fight', atkPlayers: [], defPlayers: ['200'] },
    { phase: 'done', atkPlayers: ['300'], defPlayers: [] }
  ]
  assert.equal(isSectWarParticipant(f, '100'), true) // 准备期攻军
  assert.equal(isSectWarParticipant(f, '200'), true) // 开战期守军
  assert.equal(isSectWarParticipant(f, '300'), false) // 已结束
  assert.equal(isSectWarParticipant(f, '400'), false) // 未参战
})

test('quitRogueParticipation: 散修可 #退战 退出小队攻打(战争期锁可解除)', () => {
  const f = makeFake()
  f.sectAttacks = [
    { id: 1, phase: 'prep', by: 'rogue', targetType: 'sect', target: 's2', atkPlayers: ['500', '501'], atkFakes: [], defFakes: [], defPlayers: [], wanhunParticipants: { atk: ['500', '501'], def: [] }, log: [] }
  ]
  const r = quitRogueParticipation(f, 'g', '500', '太虚门')
  assert.equal(r.ok, true)
  assert.deepEqual(f.sectAttacks[0].atkPlayers, ['501'])
  assert.equal(isSectWarParticipant(f, '500'), false) // 退出后锁解除
  /* 未参战的散修 → 明确提示 */
  const r2 = quitRogueParticipation(f, 'g', '999', '太虚门')
  assert.equal(r2.ok, false)
  assert.match(r2.msg, /你当前没有可退出的参战/)
})
