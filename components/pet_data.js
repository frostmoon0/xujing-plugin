/* ============================================================
 * 虚境灵兽(宠物) - 核心逻辑
 * 纯逻辑层: 存档读写 / 属性随机 / 战力 / 搜寻状态机 / 捕抓判定 /
 *   成长孵化推进 / 红彩窗口 / 图鉴 / 交易。不触碰 Bot/redis 全局,
 *   node:test 可直接测试(通知由 apps/user/pet.js 的 I/O 层发送)。
 * ============================================================ */
import fs from 'fs'
import { saveOrDefer } from './deferred_save.js'
import { Plugin_Name, Save_Path } from './plugin.js'
import {
  LEAN_BIAS, ARCH_BIAS, ARCH_NAME, PET_QUALITY, qualityNameOf, petRegionNameOf,
  bloodlineOf, speciesMeta, speciesPoolOf, allSpecies
} from './pet_species.js'

const SAVE_DIR = `${Save_Path}/pet`
const petCache = new Map()
const petCacheKey = (gid, kind) => `${String(gid || '')}|${normalizePetKind(kind)}`
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
export const PET_SEARCH_CMD_REG = '^[#＃]?(搜寻宠物|搜寻灵兽|寻找宠物|寻找灵兽)\\s*$'

/** 随机取文案(同一流程每次不必重复同一句) */
function pickText (list) {
  return list[Math.floor(Math.random() * list.length)]
}

const SEARCH_OPEN_LINES = [
  '你御风而行，遁入【{region}】，神念如潮水般铺展开去，搜寻那隐于灵脉之间的一缕兽息……',
  '你踏入【{region}】的灵脉深处，闭目凝神，以神识拨开层层雾霭，寻觅尚未认主的妖兽……',
  '【{region}】山河入眼，草木皆有灵息。你收敛气机，沿着若有若无的兽痕一路追寻……',
  '你在【{region}】寻了一处灵气汇聚之所，撒下引灵香，静候山野之间的回应……',
  '云气掠过山巅，你已悄然潜入【{region}】。此行不问归期，只问能否与一只灵兽结缘……',
  '你循着夜风中的低鸣赶往【{region}】，灵光在林间明灭，似有一场机缘正在前方等候……',
  '你将神念铺过【{region}】的溪谷、荒岭与古道，所有细微的灵力波动都未能逃过感知……',
  '一枚寻兽符在掌心燃起，你立于【{region}】灵脉之上，等待符火为你指向有缘之兽……'
]
const EGG_ENCOUNTER_OPEN = [
  '你于【{zone}】的灵草根下寻得一枚灵兽蛋，蛋壳之上灵纹流转，隐有霞光吞吐——',
  '碎石之间忽然传来心跳般的震动。拨开苔痕，你在【{zone}】发现一枚沉睡的灵兽蛋——',
  '一缕温热灵息自地底升起，你循息掘开浅土，竟见一枚灵兽蛋静卧其中——',
  '林间灵蝶齐齐避让，露出被枝叶掩住的蛋壳。你在【{zone}】撞见了一桩尚未破壳的机缘——',
  '风过荒草，蛋壳上的古老纹路忽然亮了一瞬。你在【{zone}】遇见了一枚等待出世的灵兽蛋——'
]
const NEST_ENCOUNTER_OPEN = [
  '你于【{zone}】寻得一处空巢，巢中灵兽幼崽正酣然入梦，四周竟无看守——',
  '【{zone}】林影深处，一座巢穴静静悬着。灵兽幼崽蜷在其中，守护双亲不知去了何方——',
  '你循着细微的幼兽呼吸声前行，在【{zone}】发现一处无人照看的巢穴——',
  '一阵风吹开遮掩巢穴的灵叶，巢中幼崽毫无防备，正是难得的空巢机缘——'
]
const PARENT_ENCOUNTER_OPEN = [
  '你于【{zone}】寻得一只灵兽幼崽，然其双亲正盘旋在侧，目光森然——',
  '幼崽的低鸣刚传入耳中，两道庞大兽影便自云后压下。此处是【{zone}】，也是它双亲的领地——',
  '你在【{zone}】与幼崽四目相对，下一刻山风骤止，守护它的双亲已从两侧封住退路——',
  '灵兽幼崽躲在岩后瑟缩不前，而【{zone}】上空已响起震怒的兽吼，双亲显然不许外人靠近——'
]
const CUB_ENCOUNTER_OPEN = [
  '你于【{zone}】偶遇一只灵兽幼崽，正蜷在灵草丛中，怯生生地望向你——',
  '一双湿润的兽瞳从叶影后探出。你在【{zone}】遇见了刚离巢不久的灵兽幼崽——',
  '【{zone}】的溪畔传来细弱呜鸣，你循声而去，只见一只幼崽正努力追逐飘落的灵叶——',
  '灵兽幼崽的气息尚显稚嫩，却已露出不凡灵光。它在【{zone}】与你意外相逢——'
]
const EGG_RELEASE_LINES = [
  '你收回法力，蛋壳上的灵纹渐渐黯淡，灵兽蛋顺着草叶滚入【{zone}】深处；蛋中灵息亦随之远去……',
  '你没有伸手相取，只见那枚灵兽蛋被一阵山风卷入苔影，微弱的生命气息渐渐沉入【{zone}】地脉……',
  '你拂袖退开，灵兽蛋上的光芒一闪，借着地势滚向【{zone}】的密林深处，再寻不得踪迹……'
]
const NEST_RELEASE_LINES = [
  '你收起法力，空巢中的幼崽翻了个身，随后被一阵灵风卷入【{zone}】深处……',
  '你不愿惊扰巢中小兽，转身离去。身后的细微兽息很快融入【{zone}】的草木灵气……',
  '你放下伸出的手，空巢仍安静地悬在枝间，幼崽在睡梦中避过了这场机缘……'
]
const CUB_RELEASE_LINES = [
  '你拂袖散去法力，幼崽警觉地竖起耳羽，转瞬隐入【{zone}】深处……',
  '你松开指间灵光，幼崽跌跌撞撞退入草影，片刻后只剩一串浅浅的兽爪印……',
  '你没有强求这段缘法，幼崽轻鸣一声，借着林叶掩护消失在【{zone}】的暮色里……'
]
const PARENT_RELEASE_LINES = [
  '你收起法器，不再惊扰那对守护双亲。它们护着幼崽隐入【{zone}】深处，兽息渐不可闻……',
  '你与那双兽瞳对视片刻，终究退开一步。双亲低声长鸣，带着幼崽消失在【{zone}】云雾之后……',
  '你散去周身战意，守护双亲的敌意这才稍减；它们护着幼崽退入山谷，留下回荡不绝的兽吼……'
]
const CAPTURE_FAIL_LINES = [
  '你出手如电，然【{name}】灵觉过人，身形一晃避过，转瞬窜入【{zone}】深处不见踪影……',
  '灵光即将落下之际，【{name}】忽然借着地脉遁走，只留一缕兽息在风中散去……',
  '你指诀已成，却被【{name}】提前察觉。它化作一道残影掠过林梢，机缘就此错失……',
  '捕兽网落了个空，【{name}】踏着灵叶远去，回首的兽鸣仿佛在嘲笑你的迟疑……'
]
const EGG_CAPTURE_LINES = [
  '你手掐法诀，以灵力将【{name}】的蛋小心裹起，纳入灵兽袋中以灵气温养……',
  '你以三重柔光护住蛋壳，将【{name}】的蛋从尘土中托起，灵兽袋内顿时多了一缕新生灵息……',
  '你没有触碰蛋壳，而是以神念引动灵气，蛋壳自行化作一道流光，安稳落入你的灵兽袋……'
]
const PET_CAPTURE_LINES = [
  '你催动法力，灵光一闪，将【{name}】收入灵兽袋！',
  '你袖中灵光翻涌，恰在【{name}】挣扎之前将其稳稳收服，契约之纹随即浮现……',
  '你以神念压住【{name}】的灵性，指尖一点，驯灵印落下，收服顺利完成……',
  '一道驯灵光环自掌中铺开，【{name}】的气息渐渐平复，终于认下了这段主仆缘法……'
]

/* ============================================================
 * 可配置项(调平衡入口)
 * ============================================================ */
export const PET_CFG = {
  huntMin: 0,            // 搜寻最短等待(分钟)
  huntMax: 30,           // 搜寻最长等待(分钟)
  bagCap: 10,            // 灵兽袋容量
  encounterMin: 10,      // 遇宠决策窗口(分钟), 超时宠物离去
  /* 品质上下限(满成长属性基准, archetype/lean 只在范围内偏移) */
  attrBound: {
    1: { atk: [5, 15],    def: [3, 10],   hp: [20, 60] },
    2: { atk: [12, 30],   def: [8, 22],   hp: [50, 140] },
    3: { atk: [25, 60],   def: [18, 45],  hp: [110, 300] },
    4: { atk: [55, 130],  def: [40, 95],  hp: [240, 650] },
    5: { atk: [120, 280], def: [85, 200], hp: [520, 1400] },
    6: { atk: [250, 600], def: [180, 430], hp: [1100, 3000] },
    7: { atk: [500, 1100], def: [360, 800], hp: [2200, 5500] }
  },
  /* 满roll战力上限(含阶段, 品质越高越强; 彩蜕变≈9k, 低于顶配玩家) */
  powerTarget: {
    1: { 少年: 300, 成年: 500, 完全体: 700, 蜕变: 1000 },
    2: { 少年: 500, 成年: 800, 完全体: 1300, 蜕变: 2000 },
    3: { 少年: 800, 成年: 1200, 完全体: 2000, 蜕变: 3000 },
    4: { 少年: 1100, 成年: 1800, 完全体: 2900, 蜕变: 4000 },
    5: { 少年: 1800, 成年: 2900, 完全体: 4500, 蜕变: 6000 },
    6: { 少年: 2600, 成年: 4300, 完全体: 6000, 蜕变: 7000 },
    7: { 少年: 3200, 成年: 5500, 完全体: 7500, 蜕变: 9000 }
  },
  /* 阶段倍率(当前属性 = 满成长 × 倍率; 蜕变略超完全体=化形增益) */
  stageMultiplier: { egg: 0, baby: 0.2, 少年: 0.45, 成年: 0.75, 完全体: 1.0, 蜕变: 1.25 },
  /* 成长阶段天数: baby→少年→成年→完全体→蜕变 (合计30天, 第15天成成年) */
  stages: [2, 5, 8, 10],
  /* 卵生物种孵化天数(按品质) */
  eggHatchDays: { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 7 },
  /* 品质抽卡基础权重(与物种 rarityWeight 同量纲) */
  tierWeight: { 1: 30, 2: 25, 3: 18, 4: 10, 5: 6, 6: 3, 7: 1 },
  /* 品质权重倍率: 金调至约8%全池概率, 红/彩基础权重翻倍(红彩窗口另行叠加) */
  qualityWeightBoost: { 5: 1.37, 6: 2, 7: 2 },
  /* 红/彩概率加成窗口: 红一天一刷(24h), 彩5天一刷; 刷新间隔上下随机波动
     红 ±6h(18~30h), 彩 ±24h(96~144h); 先到先得, 非独占 */
  redEveryMs: 24 * 60 * 60 * 1000,
  redJitterMs: 6 * 60 * 60 * 1000,
  rainbowEveryMs: 5 * 24 * 60 * 60 * 1000,
  rainbowJitterMs: 24 * 60 * 60 * 1000,
  redBoost: 20,
  rainbowBoost: 40,
  /* 捕抓成功率(普通空巢/幼崽: 逃跑率固定10%; 蛋必得; 父母守护按战力对决) */
  captureRate: {
    nest: [0.90, 0.90, 0.90, 0.90, 0.90, 0.90, 0.90],
    cub: [0.90, 0.90, 0.90, 0.90, 0.90, 0.90, 0.90]
  },
  /* 父母守护: 双亲合力 = 子兽满成长战力 × 双倍(各相当满成长) × (1+配偶加成20%) */
  parentPowerBase: 2,
  parentMateBonus: 0.2,
  /* 遇宠形态权重: 高品质 → 父母守护更常见 */
  modeWeights: {
    eggLow: { egg: 35, cub: 22, nest: 20, parent: 23 },
    eggMid: { egg: 28, cub: 20, nest: 17, parent: 35 },
    eggHigh: { egg: 18, cub: 15, nest: 12, parent: 55 },
    nonEggLow: { cub: 40, nest: 32, parent: 28 },
    nonEggMid: { cub: 32, nest: 25, parent: 43 },
    nonEggHigh: { cub: 22, nest: 18, parent: 60 }
  }
}

/* 阶段顺序与战斗阶段 */
export const PET_STAGES = ['egg', 'baby', '少年', '成年', '完全体', '蜕变']
const BATTLE_STAGES = ['少年', '成年', '完全体', '蜕变']
export function stageNameOf (stage) {
  if (stage === 'egg') return '蛋'
  if (stage === 'baby') return '幼崽'
  return stage
}
export function canBattle (stage) {
  return stage === '少年' || stage === '成年' || stage === '完全体' || stage === '蜕变'
}

/* 预计算: 各品质各阶段的「阶段基数」(满roll战力上限 - 满属性属性战力) */
function attrUpperPower (tier, stage) {
  const b = PET_CFG.attrBound[tier]
  const m = PET_CFG.stageMultiplier[stage]
  const atk = b.atk[1] * m
  const def = b.def[1] * m
  const hp = b.hp[1] * m
  return atk * 2 + def * 2 + Math.floor(hp / 5)
}
const stageBase = {}
for (const t of Object.keys(PET_CFG.attrBound)) {
  stageBase[t] = {}
  for (const st of BATTLE_STAGES) {
    stageBase[t][st] = Math.max(0, Math.round((PET_CFG.powerTarget[t]?.[st] || 0) - attrUpperPower(t, st)))
  }
}

/* ============================================================
 * 属性与战力
 * ============================================================ */
/** 随机满成长属性(在品质上下限内, lean/archetype 只偏移位置, 不越界) */
export function rollMaxAttr (quality, bloodlineId, archetype) {
  const b = PET_CFG.attrBound[quality] || PET_CFG.attrBound[1]
  const bl = bloodlineId ? bloodlineOf(bloodlineId) : null
  const lean = (bl && LEAN_BIAS[bl.lean]) || LEAN_BIAS.balanced
  const arch = ARCH_BIAS[archetype] || ARCH_BIAS.beast
  const out = {}
  for (const s of ['atk', 'def', 'hp']) {
    const [lo, hi] = b[s]
    let bias = 0.5 + ((lean[s] || 0) + (arch[s] || 0)) * 0.16
    bias = Math.max(0.08, Math.min(0.92, bias + (Math.random() - 0.5) * 0.4))
    out[s] = Math.round(lo + (hi - lo) * bias)
  }
  return out
}

/** 按品质+阶段+满成长属性计算战力(与玩家同体系: 属性战力 atk*2+def*2+hp/5) */
export function powerOfAttr (maxAttr, quality, stage) {
  if (stage === 'egg' || stage === 'baby') return 0
  const m = PET_CFG.stageMultiplier[stage] || 1
  const atk = Math.round(maxAttr.atk * m)
  const def = Math.round(maxAttr.def * m)
  const hp = Math.round(maxAttr.hp * m)
  const attr = atk * 2 + def * 2 + Math.floor(hp / 5)
  return Math.round((stageBase[quality]?.[stage] || 0) + attr)
}

/** 当前属性(满成长 × 阶段倍率) */
export function currentAttr (pet) {
  const m = PET_CFG.stageMultiplier[pet.stage] ?? 1
  return {
    atk: Math.round(pet.maxAtk * m),
    def: Math.round(pet.maxDef * m),
    hp: Math.round(pet.maxHp * m)
  }
}

/** 宠物当前战力(幼崽/蛋不可战斗=0) */
export function petPower (pet) {
  return powerOfAttr({ atk: pet.maxAtk, def: pet.maxDef, hp: pet.maxHp }, pet.quality, pet.stage)
}
/** 宠物满成长(蜕变)战力 */
export function petMaxPower (pet) {
  return powerOfAttr({ atk: pet.maxAtk, def: pet.maxDef, hp: pet.maxHp }, pet.quality, '蜕变')
}

/**
 * 直接催熟为满成长(蜕变): 伪玩家捕获即满成长, 旧伪玩家灵兽也用它补齐。
 * 只改成长阶段, 不动捕获时定死的满成长资质(maxAtk/maxDef/maxHp)。
 */
export function maturePet (pet, now = Date.now()) {
  if (!pet) return pet
  pet.stage = '蜕变'
  pet.hatchStart = 0
  pet.hatchProgress = 100
  pet.growthStart = pet.growthStart || now
  pet.lastAt = now
  return pet
}

/* ============================================================
 * 存档(按群独立, 原子写)
 * ============================================================ */
function normalizePetKind (kind) {
  return kind === 'fake' ? 'fake' : 'player'
}
function petFile (gid, kind = 'player') {
  const g = String(gid || 'global')
  return normalizePetKind(kind) === 'fake' ? `${SAVE_DIR}/pet_fake_${g}.json` : `${SAVE_DIR}/pet_${g}.json`
}
function ensureDir () {
  if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true })
}
function ensurePetStateShape (state, gid, kind = 'player') {
  const k = normalizePetKind(kind)
  const n = emptyPetState(gid, k)
  let dirty = false
  for (const key of Object.keys(n)) {
    if (state[key] === undefined) { state[key] = n[key]; dirty = true }
  }
  if (state.kind !== k) { state.kind = k; dirty = true }
  state.gid = String(gid || 'global')
  state.bag = state.bag || {}
  state.search = state.search || {}
  state.encounter = state.encounter || {}
  state.pokedex = state.pokedex || {}
  state.active = state.active || {}
  state.nextPetId = Number(state.nextPetId) || 1
  return dirty
}
export function emptyPetState (gid, kind = 'player') {
  return {
    gid: String(gid || 'global'),
    kind: normalizePetKind(kind),
    version: 1,
    nextPetId: 1,
    bag: {},
    search: {},
    encounter: {},
    pokedex: {},
    active: {},
    redWindow: null,
    rainbowWindow: null,
    nextRedAt: 0,
    nextRainbowAt: 0
  }
}
export function getPetState (gid, kind = 'player') {
  ensureDir()
  const k = normalizePetKind(kind)
  const cacheKey = petCacheKey(gid, k)
  const cached = petCache.get(cacheKey)
  if (cached) return cached
  const file = petFile(gid, k)
  let state = null
  let dirty = false
  try {
    state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  } catch (err) {
    state = null
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    state = emptyPetState(gid, k)
    dirty = true
  }
  dirty = ensurePetStateShape(state, gid, k) || dirty
  petCache.set(cacheKey, state)
  if (!fs.existsSync(file) || dirty) savePetState(state)
  return state
}
export function savePetState (state) {
  ensureDir()
  const file = petFile(state.gid, state.kind)
  petCache.set(petCacheKey(state.gid, state.kind), state)
  const write = () => {
    const tmp = `${file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, '\t'))
      fs.renameSync(tmp, file)
      return true
    } catch (err) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (e) { }
      throw err
    }
  }
  try {
    return saveOrDefer(file, write)
  } catch (err) {
    return false
  }
}
/** 已有指定类型宠物存档的群 */
export function activePetGroups (kind = 'player') {
  try {
    if (!fs.existsSync(SAVE_DIR)) return []
    const k = normalizePetKind(kind)
    const re = k === 'fake' ? /^pet_fake_\d+\.json$/ : /^pet_\d+\.json$/
    const prefix = k === 'fake' ? /^pet_fake_|\.json$/g : /^pet_|\.json$/g
    return fs.readdirSync(SAVE_DIR)
      .filter(n => re.test(n))
      .map(n => n.replace(prefix, ''))
  } catch (err) {
    return []
  }
}

/* ============================================================
 * 成长 / 孵化推进(惰性结算)
 * ============================================================ */
/**
 * 结算一只宠物的成长/孵化(按 elapsed)。返回 { hatched, upgraded }。
 * 蛋: hatchProgress 推进到 100% 破壳 → baby; 阶段: 到点自动晋级(可连跳)。
 */
export function settlePet (pet, now = Date.now()) {
  const species = speciesMeta(pet.speciesId)
  const growth = (species && species.species && species.species.growth) || 1
  if (pet.stage === 'egg') {
    const days = PET_CFG.eggHatchDays[pet.quality] || 2
    const start = pet.hatchStart || pet.obtainedAt || now
    const daysElapsed = (now - start) / DAY_MS
    if (daysElapsed >= days) {
      pet.stage = 'baby'
      pet.growthStart = now
      pet.hatchProgress = 100
      pet.lastAt = now
      return { hatched: true, upgraded: false }
    }
    pet.hatchProgress = Math.round(Math.min(99.9, daysElapsed / days * 1000)) / 10
    pet.lastAt = now
    return { hatched: false, upgraded: false }
  }
  if (pet.stage === '蜕变') {
    pet.lastAt = now
    return { hatched: false, upgraded: false }
  }
  const order = ['baby', '少年', '成年', '完全体', '蜕变']
  let idx = order.indexOf(pet.stage)
  let start = pet.growthStart || pet.obtainedAt || now
  let upgraded = false
  let guard = 0
  while (guard++ < 10 && idx >= 0 && idx < order.length - 1) {
    const durMs = (PET_CFG.stages[idx] || 1) * DAY_MS * growth
    if (now - start >= durMs) {
      idx++
      start += durMs
      upgraded = true
    } else break
  }
  pet.stage = order[idx]
  pet.growthStart = start
  pet.lastAt = now
  return { hatched: false, upgraded }
}

/** 离下一阶段/破壳剩余时长文本 */
export function growthRemainText (pet, now = Date.now()) {
  const fmt = (remain) => {
    if (remain <= 0) return '即将'
    const h = Math.ceil(remain / (60 * 60 * 1000))
    if (h < 24) return `约${h}小时后`
    const d = Math.floor(h / 24)
    const hh = h % 24
    return hh ? `约${d}天${hh}小时后` : `约${d}天后`
  }
  if (pet.stage === 'egg') {
    const days = PET_CFG.eggHatchDays[pet.quality] || 2
    const remain = (pet.hatchStart || pet.obtainedAt || now) + days * DAY_MS - now
    return `${fmt(remain)}破壳`
  }
  const species = speciesMeta(pet.speciesId)
  const growth = (species && species.species && species.species.growth) || 1
  const order = ['baby', '少年', '成年', '完全体', '蜕变']
  const idx = order.indexOf(pet.stage)
  if (idx < 0 || idx >= order.length - 1) return pet.stage === '蜕变' ? '已至蜕变，成长圆满' : '—'
  const durMs = (PET_CFG.stages[idx] || 1) * DAY_MS * growth
  const remain = (pet.growthStart || pet.obtainedAt || now) + durMs - now
  return `${fmt(remain)}晋级`
}

/* ============================================================
 * 红彩概率加成窗口(每日红 / 5日彩, 先到先得: 谁捕获即关窗, 等下次刷新)
 * ============================================================ */
/** 基准时长 + 上下波动(±jitter) 随机取一次, 下限 1 小时 */
function jittered (baseMs, jitterMs) {
  const v = Math.round(baseMs + (Math.random() * 2 - 1) * jitterMs)
  return Math.max(60 * 60 * 1000, v)
}
function newWindow (durMs, now, quality) {
  const zones = ['center', 'east', 'west', 'north', 'south', 'mixed']
  /* 只选有该品质物种的大区(含混池), 保证窗口真正有效 */
  const hasQ = zones.filter(z => allSpecies().some(s => s.zone === z && bloodlineOf(s.bloodline).quality === quality))
  const pool = hasQ.length ? hasQ : zones
  return { region: pool[Math.floor(Math.random() * pool.length)], startAt: now, endAt: now + durMs, announcedAt: 0, lockUid: null }
}
/** 确保红/彩窗口存在且未过期; 新开窗返回公告 notice(announcedAt 置为 now, 只播一次) */
export function ensureWindows (state, now = Date.now()) {
  const notices = []
  /* 红窗口: 无窗口且到了下次刷新时间 → 开新窗; 自然到期 → 关窗排下次 */
  if (!state.redWindow && now >= (state.nextRedAt || 0)) {
    state.redWindow = newWindow(jittered(PET_CFG.redEveryMs, PET_CFG.redJitterMs), now, 6)
    state.nextRedAt = 0
  }
  if (state.redWindow && now >= state.redWindow.endAt) {
    state.redWindow = null
    state.nextRedAt = now + jittered(PET_CFG.redEveryMs, PET_CFG.redJitterMs)
  }
  /* 彩窗口: 同理, 5日一刷 */
  if (!state.rainbowWindow && now >= (state.nextRainbowAt || 0)) {
    state.rainbowWindow = newWindow(jittered(PET_CFG.rainbowEveryMs, PET_CFG.rainbowJitterMs), now, 7)
    state.nextRainbowAt = 0
  }
  if (state.rainbowWindow && now >= state.rainbowWindow.endAt) {
    state.rainbowWindow = null
    state.nextRainbowAt = now + jittered(PET_CFG.rainbowEveryMs, PET_CFG.rainbowJitterMs)
  }
  if (state.redWindow && state.redWindow.announcedAt === 0 && now >= state.redWindow.startAt) {
    state.redWindow.announcedAt = now
    notices.push({ type: 'red-window', region: state.redWindow.region })
  }
  if (state.rainbowWindow && state.rainbowWindow.announcedAt === 0 && now >= state.rainbowWindow.startAt) {
    state.rainbowWindow.announcedAt = now
    notices.push({ type: 'rainbow-window', region: state.rainbowWindow.region })
  }
  return notices
}

/** 触发锁定: 遇宠 roll 出红/彩品且窗口开放(未锁定) → 锁定给该玩家, 全区恢复基础概率 */
export function tryLockWindow (state, uid, quality, region, speciesZone, now) {
  const hit = (win, r) => (win.region === r || (win.region === 'mixed' && speciesZone === 'mixed'))
  if (quality === 6 && state.redWindow && !state.redWindow.lockUid && now < state.redWindow.endAt && hit(state.redWindow, region)) {
    state.redWindow.lockUid = String(uid)
    return 'red'
  }
  if (quality === 7 && state.rainbowWindow && !state.rainbowWindow.lockUid && now < state.rainbowWindow.endAt && hit(state.rainbowWindow, region)) {
    state.rainbowWindow.lockUid = String(uid)
    return 'rainbow'
  }
  return null
}
/** 捕获成功: 锁定红/彩品归该玩家 → 窗口彻底结束, 等下次刷新 */
export function closeWindowIfLocked (state, uid, enc, now) {
  if (enc.windowLocked === 'red' && state.redWindow && state.redWindow.lockUid === String(uid)) {
    state.redWindow = null
    state.nextRedAt = now + jittered(PET_CFG.redEveryMs, PET_CFG.redJitterMs)
    return 'red'
  }
  if (enc.windowLocked === 'rainbow' && state.rainbowWindow && state.rainbowWindow.lockUid === String(uid)) {
    state.rainbowWindow = null
    state.nextRainbowAt = now + jittered(PET_CFG.rainbowEveryMs, PET_CFG.rainbowJitterMs)
    return 'rainbow'
  }
  return null
}
/** 放弃(放走/失败): 解锁, 红/彩品重新放回窗口, 下一个人继续吃概率 */
export function unlockWindow (state, enc) {
  if (enc.windowLocked === 'red' && state.redWindow) state.redWindow.lockUid = null
  if (enc.windowLocked === 'rainbow' && state.rainbowWindow) state.rainbowWindow.lockUid = null
}

/** 红彩窗口文案 */
export function redWindowText (region) {
  const r = petRegionNameOf(region)
  const tail = '先到先得，谁先夺得红气即散，明日天机再启（他修仍可凭机缘偶遇）。'
  const lines = region === 'mixed'
    ? [
        '四方混池血气翻涌，赤色灵光贯穿云层，红品妖兽现世之兆大盛！',
        '混池深处传来沉重兽吼，连山河灵脉都为之震动，红品机缘正在靠近！',
        '天机盘忽然转动，四方混池红云压境，似有一尊红品妖兽即将现世！',
        '地脉赤光冲霄，混池灵息乱作一团，今日或有红品灵兽破土而出！'
      ]
    : [
        `【${r}】灵脉血气冲天，赤色霞光染遍山河，红品妖兽现世之兆大盛！`,
        `【${r}】深处传来震天兽吼，草木灵气尽数朝一处汇聚，红品机缘正在靠近！`,
        `天机落在【${r}】！赤云压山，兽息横贯长空，似有红品灵兽将要出世！`,
        `【${r}】地脉忽然震鸣，赤色灵光自裂隙中透出，今日红品机缘不可错过！`
      ]
  return `🔴 天机示警！${pickText(lines)}\n此时搜寻，红品现身之机大增——${tail}`
}
export function rainbowWindowText (region) {
  const r = petRegionNameOf(region)
  const tail = '先到先得，谁先夺得祥瑞即散，五日后再现（他修仍可凭机缘偶遇）。'
  const lines = region === 'mixed'
    ? [
        '五彩祥云铺满四方混池，云端隐有凤鸣龙吟，连星光都为之失色！',
        '混池上空霞光倒卷，灵兽万类俯首，传说中的彩色血脉正在回应天机！',
        '一道七彩天光落入混池，山川河流皆映出异色，五彩神兽的气息已经降临！',
        '天边浮现古老兽影，彩霞如潮漫过混池，今日或有神兽与有缘人相逢！'
      ]
    : [
        `五彩祥云降临【${r}】，云端隐有凤鸣龙吟，万灵皆向此处低首！`,
        `【${r}】上空霞光倒卷，灵脉如龙翻身，传说中的彩色血脉正在回应天机！`,
        `一道七彩天光落入【${r}】，山川河流尽染异色，五彩神兽气息已然降临！`,
        `【${r}】天边浮现古老兽影，彩霞漫过群山，今日或有神兽与有缘人相逢！`
      ]
  return `🌈 霞光万丈！${pickText(lines)}\n此时搜寻，彩品现身之机大增——${tail}`
}

/* ============================================================
 * 搜寻 → 遇宠
 * ============================================================ */
/** 发起搜寻(0~30 分钟随机后遇宠) */
export function startSearch (state, uid, region, now = Date.now()) {
  const cur = state.search[uid]
  if (cur && cur.readyAt > now) {
    return { ok: false, msg: `你已在【${petRegionNameOf(cur.region)}】觅兽，约 ${Math.ceil((cur.readyAt - now) / MINUTE_MS)} 分钟后自有分晓，且静候片刻~` }
  }
  const enc = state.encounter[uid]
  if (enc && enc.expireAt > now) {
    return { ok: false, msg: '你已寻得一只灵兽，快回复 1 捕获 / 2 放走 定夺（或 #搜寻状态 观之）~' }
  }
  const readyAt = now + PET_CFG.huntMin * MINUTE_MS + Math.floor(Math.random() * (PET_CFG.huntMax - PET_CFG.huntMin + 1)) * MINUTE_MS
  state.search[uid] = { startAt: now, readyAt, region }
  savePetState(state)
  const minutes = Math.max(1, Math.ceil((readyAt - now) / MINUTE_MS))
  const hint = minutes <= 1
    ? pickText([
        '你方一闭目凝神，便觉天地灵机奔涌，似是片刻之间便有分晓……',
        '寻兽符刚刚燃尽，远处便传来一声若有若无的兽鸣，机缘似乎近在咫尺……',
        '灵草无风自动，山石间隐有灵光闪烁，此行或许很快便会有回应……'
      ])
    : pickText([
        `约 ${minutes} 分钟后自有分晓。期间你可自在行事，届时天音自会相告。`,
        `约 ${minutes} 分钟后，寻兽灵息或将显现。你可先行他事，莫要错过届时的天机。`,
        `天机尚在酝酿，约 ${minutes} 分钟后才会有回应。静候即可，灵兽不会凭空错过有缘之人。`,
        `兽息尚远，约 ${minutes} 分钟后方能锁定踪迹。你且宽心，寻兽符会替你守着这份机缘。`
      ])
  return {
    ok: true,
    readyAt,
    region,
    msg: `${pickText(SEARCH_OPEN_LINES).replace('{region}', petRegionNameOf(region))}\n${hint}`
  }
}

/** 搜寻进度/遇宠状态文本 */
export function searchStatus (state, uid, now = Date.now()) {
  const enc = state.encounter[uid]
  if (enc && enc.expireAt > now) {
    return `${pickText(['🐾 灵机忽现！', '🐾 兽息已定！', '🐾 天机落目！', '🐾 有缘之兽现身！'])}\n${encounterText(enc)}\n（${Math.ceil((enc.expireAt - now) / MINUTE_MS)} 分钟内有效）`
  }
  const cur = state.search[uid]
  if (cur && cur.readyAt > now) {
    return `${pickText(['🔍 你的神念仍在山河间游走。', '🔍 寻兽符尚未传回消息。', '🔍 灵脉深处仍有兽息未曾显形。', '🔍 这场觅兽之行还在继续。'])}\n你正在【${petRegionNameOf(cur.region)}】觅兽，约 ${Math.ceil((cur.readyAt - now) / MINUTE_MS)} 分钟后自有分晓，稍安勿躁~`
  }
  return pickText([
    '你眼下并无觅兽之行，发 #搜寻宠物 自可启程~',
    '寻兽符尚未燃起。发 #搜寻宠物，去山河之间寻一份灵兽缘法吧~',
    '灵兽袋静候新主。发 #搜寻宠物，或许下一道兽息便来自你的脚下~'
  ])
}

/** 品质权重随机抽物种(带红彩窗口加成) */
function pickSpecies (state, region, now) {
  const pool = speciesPoolOf(region)
  if (!pool.length) return null
  const red = state.redWindow
  const rb = state.rainbowWindow
  /* 锁定中(有人遇宠出红/彩品待处理) → 全区恢复基础概率, 不给提升 */
  const redActive = red && !red.lockUid && now >= red.startAt && now < red.endAt
  const rbActive = rb && !rb.lockUid && now >= rb.startAt && now < rb.endAt
  const weight = (s) => {
    const bl = bloodlineOf(s.bloodline)
    const q = bl ? bl.quality : 1
    let w = s.rarityWeight * (PET_CFG.qualityWeightBoost[q] || 1)
    const zoneHit = (win) => (win.region === region || (win.region === 'mixed' && s.zone === 'mixed'))
    if (q === 6 && redActive && zoneHit(red)) w *= PET_CFG.redBoost
    if (q === 7 && rbActive && zoneHit(rb)) w *= PET_CFG.rainbowBoost
    return w
  }
  const total = pool.reduce((a, s) => a + weight(s), 0)
  if (total <= 0) return null
  let r = Math.random() * total
  for (const s of pool) {
    r -= weight(s)
    if (r <= 0) return speciesMeta(s.id)
  }
  return speciesMeta(pool[pool.length - 1].id)
}

/** 遇宠形态(空巢/幼崽/蛋/父母守护) */
function rollMode (species, quality) {
  const key = species.eggLaying
    ? (quality >= 5 ? 'eggHigh' : quality >= 3 ? 'eggMid' : 'eggLow')
    : (quality >= 5 ? 'nonEggHigh' : quality >= 3 ? 'nonEggMid' : 'nonEggLow')
  const w = PET_CFG.modeWeights[key]
  const keys = Object.keys(w)
  const total = keys.reduce((a, k) => a + w[k], 0)
  let r = Math.random() * total
  for (const k of keys) {
    r -= w[k]
    if (r <= 0) return k
  }
  return keys[keys.length - 1]
}

/** 遇宠文案 */
export function encounterText (enc) {
  const meta = speciesMeta(enc.speciesId)
  const name = meta ? meta.species.name : enc.speciesId
  const q = qualityNameOf(enc.quality)
  const bl = meta && meta.bloodline ? meta.bloodline.name : ''
  const zoneName = petRegionNameOf(enc.region)
  const m = PET_CFG.stageMultiplier.baby
  const cur = { atk: Math.round(enc.maxAtk * m), def: Math.round(enc.maxDef * m), hp: Math.round(enc.maxHp * m) }
  const max = powerOfAttr({ atk: enc.maxAtk, def: enc.maxDef, hp: enc.maxHp }, enc.quality, '蜕变')
  const hatchDays = PET_CFG.eggHatchDays[enc.quality] || 2
  /* 开篇: 依形态各有意境, 同一形态也会随机变化 */
  let open
  if (enc.mode === 'egg') {
    open = pickText(EGG_ENCOUNTER_OPEN).replace('{zone}', zoneName)
  } else if (enc.mode === 'nest') {
    open = pickText(NEST_ENCOUNTER_OPEN).replace('{zone}', zoneName)
  } else if (enc.mode === 'parent') {
    open = pickText(PARENT_ENCOUNTER_OPEN).replace('{zone}', zoneName)
  } else {
    open = pickText(CUB_ENCOUNTER_OPEN).replace('{zone}', zoneName)
  }
  /* 形态提示 */
  let form
  if (enc.mode === 'egg') {
    form = pickText([
      `（蛋可带走，以灵力温养，约 ${hatchDays} 日后灵光破壳）`,
      `（卵中灵息尚稳，带回温养约 ${hatchDays} 日可破壳）`,
      `（此蛋与您有缘，纳入灵兽袋后约 ${hatchDays} 日见雏）`
    ])
  } else if (enc.mode === 'nest') {
    form = pickText(['（空巢无主，正是收服良机）', '（四下无护，灵兽尚未察觉你的到来）', '（看守双亲不在，机缘稍纵即逝）'])
  } else if (enc.mode === 'parent') {
    form = pickText([
      `（双亲合力约 ${enc.parentPower}，须以战力慑服方可得手）`,
      `（守护双亲一攻一守，合力约 ${enc.parentPower}，强取须慎）`,
      `（双亲护子心切，战力约 ${enc.parentPower}，胜之方能带走幼崽）`
    ])
  } else {
    form = pickText(['（幼崽身弱，捕捉略有难度）', '（幼崽尚未长成，须以灵力稳住其身形）', '（它虽年幼，灵觉却不弱，出手不可迟疑）'])
  }
  const lines = [
    `🐾 ${open}`,
    `　【${name}】· 血脉【${bl}】· ${q}`,
    `　当前：攻${cur.atk} 防${cur.def} 血${cur.hp}`,
    `　满成长：攻${enc.maxAtk} 防${enc.maxDef} 血${enc.maxHp} · 满成长战力约 ${max}`,
    `　${form}`,
    '回复 1 捕获 / 2 放走'
  ]
  return lines.join('\n')
}

/** 搜寻到点 → 生成遇宠(返回 encounter 或 null) */
export function rollEncounter (state, gid, uid, now = Date.now()) {
  const search = state.search[uid]
  if (!search || now < search.readyAt) return null
  const region = search.region
  const meta = pickSpecies(state, region, now)
  if (!meta) {
    delete state.search[uid]
    savePetState(state)
    return null
  }
  const { species, bloodline, quality } = meta
  const maxAttr = rollMaxAttr(quality, bloodline.id, species.archetype)
  const mode = rollMode(species, quality)
  let parentPower = 0
  if (mode === 'parent') {
    parentPower = parentPowerFor(maxAttr, quality)
  }
  const enc = {
    speciesId: species.id,
    quality,
    mode,
    maxAtk: maxAttr.atk,
    maxDef: maxAttr.def,
    maxHp: maxAttr.hp,
    parentPower,
    region,
    expireAt: now + PET_CFG.encounterMin * MINUTE_MS,
    announcedAt: 0
  }
  /* 触发锁定: 遇宠 roll 出红/彩品且窗口开放 → 锁定给该玩家, 全区恢复基础概率 */
  enc.windowLocked = tryLockWindow(state, uid, quality, region, species.zone, now)
  state.encounter[uid] = enc
  delete state.search[uid]
  savePetState(state)
  return enc
}

/* ============================================================
 * 捕抓判定 / 放走 / 入袋
 * ============================================================ */
/** 父母守护战力: 双亲合力 = 子兽满成长战力 × 2(各相当满成长) × (1+配偶加成) */
export function parentPowerFor (maxAttr, quality) {
  const fullPower = powerOfAttr(maxAttr, quality, '蜕变')
  return Math.round(fullPower * PET_CFG.parentPowerBase * (1 + PET_CFG.parentMateBonus))
}

/** 玩家战力 vs 守护父母战力 → 胜率(与决斗同源: 战力÷100折算小境界当量, 按战斗力意义系数线性映射) */
export function parentWinRate (playerPower, parentPower) {
  /* POWER_PER_LEVEL=100 与 fight.js 一致(每小境界100战力); Magnification=8 与决斗默认战斗力意义系数一致 */
  const gap = ((playerPower || 0) - (parentPower || 1)) / 100
  const win = 50 + 8 * gap
  return Math.max(5, Math.min(100, win)) // 统一绝对战力胜率 clamp 5~100
}

/**
 * 处理遇宠: choice=1 捕获, 2 放走
 * playerPower: 父母守护形态时玩家战力(应用层传入)
 * opts.instantGrow: 捕获即满成长(蜕变), 供伪玩家使用; 玩家默认走正常成长
 */
export function resolveEncounter (state, uid, choice, now = Date.now(), playerPower = 0, opts = {}) {
  const enc = state.encounter[uid]
  if (!enc) return { ok: false, msg: '你眼下并无待定夺的灵兽~' }
  if (enc.expireAt < now) {
    delete state.encounter[uid]
    savePetState(state)
    return { ok: false, msg: '那只灵兽早已隐去踪迹，重新搜寻吧~' }
  }
  const meta = speciesMeta(enc.speciesId)
  if (!meta) {
    delete state.encounter[uid]
    savePetState(state)
    return { ok: false, msg: '此物种来历异常，未能成行，重新搜寻吧~' }
  }
  const name = meta.species.name
  const zoneName = enc.region === 'mixed' ? '山野水泽' : petRegionNameOf(enc.region)

  /* 放走 */
  if (choice === 2) {
    unlockWindow(state, enc) // 放弃 → 解锁, 红/彩品重放窗口给下一个人
    delete state.encounter[uid]
    savePetState(state)
    const releasePool = enc.mode === 'egg' ? EGG_RELEASE_LINES : enc.mode === 'parent' ? PARENT_RELEASE_LINES : enc.mode === 'nest' ? NEST_RELEASE_LINES : CUB_RELEASE_LINES
    const releaseText = pickText(releasePool).replaceAll('{zone}', zoneName).replaceAll('{name}', name)
    return { ok: false, release: true, msg: `${releaseText}\n${pickText(['缘法未至，莫要强求，重新搜寻吧。', '今日无缘，且将这份念想留在山野之间，改日再来。', '灵兽自有灵性，既不愿随行，便让它归于天地。重新搜寻吧。'])}` }
  }

  /* 捕获 */
  const bag = state.bag[uid] || (state.bag[uid] = [])
  if (bag.length >= PET_CFG.bagCap) {
    return { ok: false, msg: `灵兽袋已满（${PET_CFG.bagCap} 只），灵兽无处安放！且放生一只腾出位置，再来收服~` }
  }
  let success = false
  let failText = ''
  if (enc.mode === 'egg') {
    success = true // 蛋必得, 带走孵化
  } else if (enc.mode === 'nest') {
    success = Math.random() < (PET_CFG.captureRate.nest[enc.quality - 1] || 0.9)
  } else if (enc.mode === 'cub') {
    success = Math.random() < (PET_CFG.captureRate.cub[enc.quality - 1] || 0.7)
  } else if (enc.mode === 'parent') {
    const win = parentWinRate(playerPower, enc.parentPower)
    if (win <= 10) {
      failText = `你抬眼一望，那守护双亲的战力（约 ${enc.parentPower}）远在你之上（${playerPower}），强行出手无异于以卵击石，只得悻悻作罢……`
    } else {
      success = Math.random() * 100 < win
    }
  }

  if (!success) {
    unlockWindow(state, enc) // 抓不到 → 解锁, 红/彩品重放窗口给下一个人
    delete state.encounter[uid]
    savePetState(state)
    return {
      ok: false,
      msg: failText || (enc.mode === 'parent'
        ? pickText([
            `你与守护双亲缠斗片刻，灵力震荡间终究不敌，只得望着【${name}】被父母护着遁入云雾深处……\n此行作罢，他日再来。`,
            `双亲一前一后封住退路，合击之势如山倾海啸。你被迫收招，【${name}】已随父母远去……\n强取不可，改日再寻。`,
            `你与两头守护妖兽交手数合，终于明白此番实力尚有差距。兽吼远去，【${name}】也消失在山谷尽头……`
          ])
        : pickText(CAPTURE_FAIL_LINES).replace('{name}', name).replace('{zone}', zoneName))
    }
  }

  /* 成功 → 入袋 */
  const instantGrow = !!opts.instantGrow
  const pet = {
    pid: state.nextPetId++,
    speciesId: enc.speciesId,
    bloodlineId: meta.bloodline.id,
    quality: enc.quality,
    customName: '',
    stage: instantGrow ? '蜕变' : (enc.mode === 'egg' ? 'egg' : 'baby'),
    maxAtk: enc.maxAtk,
    maxDef: enc.maxDef,
    maxHp: enc.maxHp,
    growthStart: now,
    lastAt: now,
    obtainedAt: now,
    hatchStart: instantGrow ? 0 : (enc.mode === 'egg' ? now : 0),
    hatchProgress: instantGrow ? 100 : 0,
    origin: meta.species.zone === 'mixed' ? 'mixed' : 'region'
  }
  bag.push(pet)
  /* 捕获成功: 锁定红/彩品归该玩家 → 窗口彻底结束, 等下次刷新 */
  closeWindowIfLocked(state, uid, enc, now)
  delete state.encounter[uid]
  savePetState(state)
  const q = qualityNameOf(enc.quality)
  const hatchDays = PET_CFG.eggHatchDays[enc.quality] || 2
  const captureText = enc.mode === 'egg'
    ? pickText(EGG_CAPTURE_LINES).replace('{name}', name)
    : pickText(PET_CAPTURE_LINES).replace('{name}', name)
  if (instantGrow) {
    return { ok: true, pet, msg: `🦁 ${captureText}\n灵兽已直接成长至蜕变，无需再等岁月淬炼。` }
  }
  const eggTail = pickText([
    `约 ${hatchDays} 日后灵光破壳，届时自会相告。`,
    `再温养 ${hatchDays} 日，蛋中小兽便可破壳而出。`,
    `待满 ${hatchDays} 日孵化之期，便知蛋中究竟是哪般灵兽。`
  ])
  const petTail = pickText([
    `其满成长战力约 ${petMaxPower(pet)}，假以时日，必成大器。`,
    `满成长战力约 ${petMaxPower(pet)}，只待岁月淬炼，便可成为一方助力。`,
    `资质已收入掌中，满成长战力约 ${petMaxPower(pet)}，莫负这段相逢之缘。`,
    `灵兽袋中灵光微鸣，满成长战力约 ${petMaxPower(pet)}，此后便是你的同道战友。`
  ])
  return {
    ok: true,
    pet,
    msg: enc.mode === 'egg'
      ? `🥚 ${captureText}\n${eggTail}`
      : `🦁 ${captureText}\n${petTail}`
  }
}

/* ============================================================
 * 灵兽袋管理
 * ============================================================ */
export function getPetByIdx (state, uid, idx) {
  const bag = state.bag[uid] || []
  const i = Number(idx) - 1
  if (i < 0 || i >= bag.length) return null
  return bag[i]
}
export function releasePet (state, uid, idx) {
  const bag = state.bag[uid] || []
  const i = Number(idx) - 1
  if (i < 0 || i >= bag.length) return { ok: false, msg: '序号超出范围~' }
  const pet = bag[i]
  const name = pet.customName || speciesMeta(pet.speciesId)?.species.name || pet.speciesId
  bag.splice(i, 1)
  savePetState(state)
  return { ok: true, msg: pickText([
    `你轻抚【${name}】额间，解下契约，道一声去吧。【${name}】绕你三匝，低鸣一声，化作一道灵光遁入山野……\n灵兽袋空出一位。`,
    `契约灵光在你掌中散去，【${name}】最后看了你一眼，转身奔入山林。此后山高水长，各自珍重。\n灵兽袋空出一位。`,
    `你撤去认主法印，放【${name}】归还天地。它踏着草叶远去，兽息融入群山，再未回首。\n灵兽袋空出一位。`,
    `一缕灵光从【${name}】眉心脱落，主仆契约就此解除。它在你身侧盘旋片刻，随后消失于远方云雾。\n灵兽袋空出一位。`
  ]) }
}
export function renamePet (state, uid, idx, name) {
  const pet = getPetByIdx(state, uid, idx)
  if (!pet) return { ok: false, msg: '序号超出范围~' }
  const n = String(name || '').trim()
  if (!n) return { ok: false, msg: '名字不可为空~' }
  if (n.length > 8) return { ok: false, msg: '名字最长八字~' }
  pet.customName = n
  savePetState(state)
  return { ok: true, msg: pickText([
    `自此【${petDisplayNameOf(pet)}】名唤【${n}】，主仆相契，号令随心~`,
    `你以灵力在契约上落下新名：【${n}】。从今往后，山河万里，唤此名便知是它。`,
    `一笔灵光划过，【${petDisplayNameOf(pet)}】有了新的名号——【${n}】。灵兽似有所觉，亲昵地蹭了蹭你的掌心。`,
    `你为【${petDisplayNameOf(pet)}】重新定名【${n}】，名字随契约落定，今后便以此名相伴。`
  ]) }
}

/** 宠物显示名(改名后优先) */
function petDisplayNameOf (pet) {
  if (pet.customName) return pet.customName
  const meta = speciesMeta(pet.speciesId)
  return meta ? meta.species.name : pet.speciesId
}

/** 交易/赠送: 仅蛋或幼崽可赠; 接收方灵兽袋未满 */
export function giftPet (state, uid, targetUid, idx) {
  if (String(uid) === String(targetUid)) return { ok: false, msg: '灵兽不可自赠~' }
  const pet = getPetByIdx(state, uid, idx)
  if (!pet) return { ok: false, msg: '序号超出范围~' }
  if (pet.stage !== 'egg' && pet.stage !== 'baby') {
    return { ok: false, msg: `${pet.stage === 'baby' ? '幼崽' : '已成长'}的灵兽已认主，血脉相契，不可转赠！唯有蛋与幼崽可解契相赠~` }
  }
  const targetBag = state.bag[targetUid] || (state.bag[targetUid] = [])
  if (targetBag.length >= PET_CFG.bagCap) {
    return { ok: false, msg: '对方灵兽袋已满，无法接收~' }
  }
  const name = pet.customName || speciesMeta(pet.speciesId)?.species.name || pet.speciesId
  targetBag.push(pet)
  state.bag[uid].splice(Number(idx) - 1, 1)
  savePetState(state)
  return { ok: true, msg: pickText([
    `你手结法印，将【${name}】的气息引渡至对方识海……\n它在新主人怀中探首四顾，好奇地打量着这方天地。`,
    `一道契约灵光在两人之间交替闪过，【${name}】的气息已换了归处。它缩在新主人身侧，渐渐安下心来。`,
    `你将【${name}】托入对方怀中，灵兽袋里的兽息随之换主。愿它此后一生，仍得善待。`,
    `法印落下，灵兽缘法悄然转移。【${name}】嗅了嗅新主人的气息，尾巴轻摆，似乎并不抗拒。`
  ]) }
}

/* ---------- 出战/收回(出战才计入玩家战力) ---------- */
/** 当前出战宠物(pid) */
export function activePetOf (state, uid) {
  const pid = state.active && state.active[String(uid)]
  if (!pid) return null
  return (state.bag[String(uid)] || []).find(p => p.pid === pid) || null
}
/** 出战宠物当前战力(未出战/幼崽/蛋 = 0; 供 fight.calcCombatPower 计入玩家战力) */
export function getActivePetPower (gid, uid, kind = 'player') {
  try {
    const info = getActivePetInfo(gid, uid, kind)
    return info ? info.power : 0
  } catch (err) {
    return 0
  }
}
/** 只读: 出战宠物信息(无档/未出战返回 null); kind=fake 时 uid 为伪玩家名字
 *  走 getPetState 内存缓存: savePetState 会同步更新缓存, 避免读到延迟保存前的旧档
 *  (伪玩家灵兽由 fakePetTick 在延迟保存上下文里自动出战, 若直读文件, 每次推进后的
 *  1 分钟内 personPower/查人 都会漏算新出战灵兽战力, 表现为灵兽"不出战") */
export function getActivePetInfo (gid, uid, kind = 'player') {
  try {
    const file = petFile(gid, kind)
    if (!fs.existsSync(file)) return null
    const state = getPetState(gid, kind)
    const pid = state.active && state.active[String(uid)]
    if (!pid) return null
    const pet = (state.bag && state.bag[String(uid)] || []).find(p => p.pid === pid)
    if (!pet) return null
    const name = pet.customName || speciesMeta(pet.speciesId)?.species.name || pet.speciesId
    return { name, stage: stageNameOf(pet.stage), power: petPower(pet) }
  } catch (err) {
    return null
  }
}
/** 宠物当前阶段成长/孵化进度(0~100, 只读展示用) */
function petProgress (pet, now = Date.now()) {
  if (pet.stage === 'egg') return Math.min(100, pet.hatchProgress || 0)
  const order = ['baby', '少年', '成年', '完全体', '蜕变']
  const idx = order.indexOf(pet.stage)
  if (idx < 0 || idx >= order.length - 1) return 100
  const meta = speciesMeta(pet.speciesId)
  const growth = (meta && meta.species && meta.species.growth) || 1
  const durMs = (PET_CFG.stages[idx] || 1) * DAY_MS * growth
  const elapsed = now - (pet.growthStart || pet.obtainedAt || now)
  return Math.max(0, Math.min(100, Math.round(elapsed / durMs * 100)))
}
/** 只读: 本群灵兽榜数据(按当前战力降序, 不可参战排后; 无档返回空) */
export function groupPetRank (gid, n = 20, kind = 'player') {
  try {
    const file = petFile(gid, kind)
    if (!fs.existsSync(file)) return []
    const now = Date.now()
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    const out = []
    for (const [uid, bag] of Object.entries(state.bag || {})) {
      for (const pet of bag || []) {
        settlePet(pet, now) // 纯内存结算, 不写盘
        const meta = speciesMeta(pet.speciesId)
        const bl = pet.bloodlineId ? bloodlineOf(pet.bloodlineId) : null
        out.push({
          uid,
          pid: pet.pid,
          name: pet.customName || (meta && meta.species.name) || pet.speciesId,
          quality: pet.quality,
          bloodline: bl ? bl.name : pet.bloodlineId,
          stageKey: pet.stage,
          stage: stageNameOf(pet.stage),
          canBattle: canBattle(pet.stage),
          power: petPower(pet),
          maxPower: petMaxPower(pet),
          progress: petProgress(pet, now),
          hatch: pet.stage === 'egg'
        })
      }
    }
    /* 战力降序; 不可参战(幼崽/蛋)排最后 */
    out.sort((a, b) => (b.power - a.power) || (Number(b.canBattle) - Number(a.canBattle)) || (b.maxPower - a.maxPower))
    return out.slice(0, n)
  } catch (err) {
    return []
  }
}
/** 出战: 仅可战斗(少年及以上)的灵兽可出阵 */
export function deployPet (state, uid, idx) {
  const pet = getPetByIdx(state, uid, idx)
  if (!pet) return { ok: false, msg: '序号超出范围~' }
  if (!canBattle(pet.stage)) {
    return { ok: false, msg: `${stageNameOf(pet.stage)}尚不能出战（唯少年及以上方可出阵）~` }
  }
  const name = pet.customName || speciesMeta(pet.speciesId)?.species.name || pet.speciesId
  state.active = state.active || {}
  state.active[String(uid)] = pet.pid
  savePetState(state)
  return { ok: true, msg: pickText([
    `⚔️ 【${name}】出阵！其战力（${petPower(pet)}）已计入你的战力，与你并肩而战。`,
    `⚔️ 你解开灵兽袋封印，【${name}】踏光而出，护在你身侧。出战战力：${petPower(pet)}。`,
    `⚔️ 一声长啸，【${name}】响应召唤！它的战意与你相合，战力 ${petPower(pet)} 已纳入你的战力。`,
    `⚔️ 契约灵光大盛，【${name}】现身护道。此刻起，它便是你身前的第一道锋芒（战力 ${petPower(pet)}）。`
  ]) }
}
/** 收回: 出战的灵兽归袋, 战力不再计入 */
export function recallPet (state, uid) {
  const pet = activePetOf(state, uid)
  if (!pet) return { ok: false, msg: '你当前并无出战的灵兽~' }
  const name = pet.customName || speciesMeta(pet.speciesId)?.species.name || pet.speciesId
  state.active = state.active || {}
  delete state.active[String(uid)]
  savePetState(state)
  return { ok: true, msg: pickText([
    `【${name}】已收回灵兽袋，其战力不再计入你的战力。`,
    `你抬手收回灵光，【${name}】化作一道流光归入袋中。此后战力不再计入自身。`,
    `战斗暂歇，你解下出战契约，将【${name}】收回灵兽袋，待下一次召唤。`,
    `【${name}】低鸣一声退回灵兽袋，护道之功暂歇，战力也随之从你的战力中撤下。`
  ]) }
}

/* ============================================================
 * 展示文本
 * ============================================================ */
export function petBriefLine (pet, idx, now = Date.now()) {
  const species = speciesMeta(pet.speciesId)?.species
  const name = pet.customName || (species ? species.name : pet.speciesId)
  const q = qualityNameOf(pet.quality)
  const st = stageNameOf(pet.stage)
  const extra = pet.stage === 'egg'
    ? `孵化${pet.hatchProgress || 0}%`
    : `战力 ${petPower(pet)}`
  return `${idx}. ${q}【${name}】· ${st} · ${extra}`
}

export function petDetailText (pet, now = Date.now()) {
  const species = speciesMeta(pet.speciesId)?.species
  const bl = bloodlineOf(pet.bloodlineId)
  const name = pet.customName || (species ? species.name : pet.speciesId)
  const q = qualityNameOf(pet.quality)
  const st = stageNameOf(pet.stage)
  const cur = currentAttr(pet)
  const canFight = canBattle(pet.stage)
  const lines = [
    `━━━ 🐾 ${q}【${name}】 ━━━`,
    `物种：${species ? species.name : pet.speciesId}${species && species.desc ? `\n　　${species.desc}` : ''}`,
    `血脉：${bl ? bl.name : pet.bloodlineId}${bl && bl.desc ? `\n　　${bl.desc}` : ''}`,
    `阶段：${st}${canFight ? '（可参战）' : '（尚幼，不可参战）'}`,
    `属性：攻${cur.atk} 防${cur.def} 血${cur.hp}`,
    `满成长：攻${pet.maxAtk} 防${pet.maxDef} 血${pet.maxHp}`,
    `战力：${canFight ? petPower(pet) : 0}（大成约 ${petMaxPower(pet)}）`,
    `成长：${growthRemainText(pet, now)}`
  ]
  if (pet.stage === 'egg') lines.push(`孵化进度：${pet.hatchProgress || 0}%`)
  lines.push(`来源：${pet.origin === 'secret' ? '特殊秘境' : pet.origin === 'mixed' ? '混池游荡' : petRegionNameOf(pet.origin === 'mixed' ? 'mixed' : (species ? species.zone : 'mixed'))}所得`)
  return lines.join('\n')
}

export function petBagText (state, uid, now = Date.now()) {
  const bag = state.bag[uid] || []
  if (!bag.length) return '灵兽袋空空如也，发 #搜寻宠物 觅一只有缘灵兽吧~'
  const active = state.active && state.active[String(uid)]
  const lines = [
    `🧺 灵兽袋（${bag.length}/${PET_CFG.bagCap} 位）`,
    ...bag.map((p, i) => petBriefLine(p, i + 1, now) + (p.pid === active ? '（⚔️出战中）' : '')),
    '',
    '回 #宠物详情 <序号> 观细 · #宠物出战 <序号> · #收回宠物 · #宠物改名 <序号> 名 · #放生 <序号> · #赠送宠物 @玩家 <序号>'
  ]
  return lines.join('\n')
}

/** 物种资质详情(目录按名查看用): 血脉/品质/种族/出没/倾向/满成长 */
export function speciesDetailText (species) {
  const bl = bloodlineOf(species.bloodline)
  if (!bl) return '此物种来历异常~'
  const q = bl.quality
  const qName = qualityNameOf(q)
  const leanText = { atk: '攻强守弱，锋芒毕露', def: '守坚攻缓，皮骨如铁', hp: '气血绵长，底蕴深厚', balanced: '攻守均衡，中正平和' }[bl.lean] || '中正平和'
  const bound = PET_CFG.attrBound[q]
  const maxLo = powerOfAttr({ atk: bound.atk[0], def: bound.def[0], hp: bound.hp[0] }, q, '蜕变')
  const maxHi = powerOfAttr({ atk: bound.atk[1], def: bound.def[1], hp: bound.hp[1] }, q, '蜕变')
  const lines = [
    `━━━ ${qName}【${species.name}】 ━━━`,
    `种族：${ARCH_NAME[species.archetype] || '妖兽'}${species.eggLaying ? ' · 卵生' : ' · 胎生'}`,
    `血脉：${bl.name}${bl.desc ? `\n　　${bl.desc}` : ''}`,
    `出没：${petRegionNameOf(species.zone)}${species.zone !== 'mixed' ? '（混池亦有踪迹）' : '（任意大区搜寻可见）'}`,
    `资质倾向：${leanText}`,
    `满成长属性：攻${bound.atk[0]}~${bound.atk[1]} · 防${bound.def[0]}~${bound.def[1]} · 血${bound.hp[0]}~${bound.hp[1]}`,
    `满成长战力：约 ${maxLo} ~ ${maxHi}`
  ]
  if (species.desc) lines.push(`\n　${species.desc}`)
  return lines.join('\n')
}

/** 品质倒序(彩→白)排序 */
function sortByQualityDesc (list) {
  return [...list].sort((a, b) => (bloodlineOf(b.bloodline)?.quality || 0) - (bloodlineOf(a.bloodline)?.quality || 0))
}

/** 灵兽目录: 查看全部物种(非收集系统, 纯图鉴目录), filter 可为 大区/品质/名称 */
export function catalogText (state, uid, filter = '') {
  const f = String(filter || '').trim()

  /* 无筛选: 按大区+品质汇总(数量), 品质自彩至白 */
  if (!f) {
    const lines = ['📖 灵兽目录']
    for (const zone of ['center', 'east', 'west', 'north', 'south', 'mixed']) {
      const zoneSp = allSpecies().filter(s => s.zone === zone)
      if (!zoneSp.length) continue
      lines.push(`▸ ${petRegionNameOf(zone)}（${zoneSp.length} 种）`)
      for (const q of [7, 6, 5, 4, 3, 2, 1]) {
        const qSp = zoneSp.filter(s => bloodlineOf(s.bloodline).quality === q)
        if (!qSp.length) continue
        lines.push(`　${PET_QUALITY[q].icon}${PET_QUALITY[q].name} ${qSp.length} 种`)
      }
    }
    lines.push('', `共计 ${allSpecies().length} 种灵兽`, '查看：#宠物目录 <大区/品质/名称>')
    return lines.join('\n')
  }

  /* 品质筛选 */
  const qMap = { 白: 1, 绿: 2, 蓝: 3, 紫: 4, 金: 5, 红: 6, 彩: 7, 白色: 1, 绿色: 2, 蓝色: 3, 紫色: 4, 金色: 5, 红色: 6, 彩色: 7, 彩虹: 7 }
  if (qMap[f] !== undefined) {
    const q = qMap[f]
    const list = allSpecies().filter(s => bloodlineOf(s.bloodline).quality === q)
    const qn = qualityNameOf(q)
    const lines = [`📖 灵兽目录 · ${qn}（${list.length} 种）`]
    for (const s of list) {
      lines.push(`${s.name}【${petRegionNameOf(s.zone)}】`)
    }
    return lines.join('\n')
  }

  /* 大区筛选: 混池灵兽在任意大区搜寻均可见, 一并列出; 品质自彩至白 */
  const zMap = { 中州: 'center', 东海: 'east', 西域: 'west', 北境: 'north', 南疆: 'south', 混池: 'mixed' }
  if (zMap[f] !== undefined) {
    const zone = zMap[f]
    const own = sortByQualityDesc(allSpecies().filter(s => s.zone === zone))
    const lines = [`📖 灵兽目录 · ${petRegionNameOf(zone)}（${own.length} 种）`]
    for (const s of own) {
      const q = bloodlineOf(s.bloodline).quality
      lines.push(`${PET_QUALITY[q].icon}${s.name}${s.eggLaying ? '🥚' : ''}`)
    }
    /* 非混池大区: 追加混池(任意大区可见) */
    if (zone !== 'mixed') {
      const mix = sortByQualityDesc(allSpecies().filter(s => s.zone === 'mixed'))
      lines.push('', `┄ 混池 · 任意大区搜寻可见（${mix.length} 种）┄`)
      for (const s of mix) {
        const q = bloodlineOf(s.bloodline).quality
        lines.push(`${PET_QUALITY[q].icon}${s.name}${s.eggLaying ? '🥚' : ''}`)
      }
    }
    return lines.join('\n')
  }

  /* 名称筛选: 精确命中 → 资质详情; 否则列出模糊匹配(品质自彩至白) */
  const exact = allSpecies().filter(s => s.name === f)
  if (exact.length === 1) return speciesDetailText(exact[0])
  const list = sortByQualityDesc(allSpecies().filter(s => s.name.includes(f)))
  if (list.length) {
    const lines = [`📖 灵兽目录 · 搜索「${f}」（${list.length} 种）`]
    for (const s of list) {
      const q = bloodlineOf(s.bloodline).quality
      lines.push(`${PET_QUALITY[q].icon}${s.name}【${petRegionNameOf(s.zone)}】${s.eggLaying ? '🥚' : ''}`)
    }
    return lines.join('\n')
  }
  return `未找到与「${f}」相关的灵兽，试试 #宠物目录 看全貌吧~`
}

export function settlePlayerSearch (state, gid, uid, now = Date.now()) {
  let changed = false
  const enc = state.encounter[uid]
  if (enc && enc.expireAt <= now) {
    unlockWindow(state, enc)
    delete state.encounter[uid]
    changed = true
  }
  const search = state.search[uid]
  if (search && search.readyAt <= now) return rollEncounter(state, gid, uid, now)
  if (changed) savePetState(state)
  return null
}

/* ============================================================
 * 每分钟推进(纯逻辑, 返回通知, 由应用层发送)
 * ============================================================ */
export function tickPetGroup (state, gid, now = Date.now()) {
  const notices = []
  /* 红彩窗口 */
  notices.push(...ensureWindows(state, now))
  /* 搜寻到点 → 遇宠 */
  for (const uid of Object.keys(state.search)) {
    if (now >= state.search[uid].readyAt) {
      const enc = rollEncounter(state, gid, uid, now)
      if (enc) notices.push({ type: 'encounter', uid, enc })
    }
  }
  /* 遇宠过期清理(过期应答则解锁窗口, 避免锁死占位) */
  for (const uid of Object.keys(state.encounter)) {
    if (state.encounter[uid].expireAt < now) {
      unlockWindow(state, state.encounter[uid])
      delete state.encounter[uid]
      notices.push({ type: 'encounter-expire', uid })
    }
  }
  /* 成长/孵化推进 */
  for (const uid of Object.keys(state.bag)) {
    for (const pet of state.bag[uid]) {
      const r = settlePet(pet, now)
      if (r.hatched) notices.push({ type: 'hatched', uid, pet })
      else if (r.upgraded) notices.push({ type: 'upgraded', uid, pet })
    }
  }
  return notices
}

/* 玩法说明 */
export function guideText () {
  return [
    '━━━ 🐾 灵兽之道 ━━━',
    '【灵兽与品质】',
    '· 灵兽 = 血脉 × 物种。血脉定品质（白/绿/蓝/紫/金/红/彩）与属性倾向；物种定形态、大区与繁殖。',
    '· 每只灵兽属性随机（同种两只亦各不相同），捕获时定死满成长资质，破壳/成长不改变。',
    '',
    '【搜寻】#搜寻宠物 / #搜寻灵兽',
    '· 在所在大区觅兽，0~30 分钟自有分晓；宠物池 = 所在大区 + 混池。',
    '· #搜寻状态 观进度；遇宠后回复 1 捕获 / 2 放走。',
    '',
    '【遇宠四形态】',
    '· 空巢：无人看守，唾手可得',
    '· 幼崽：身弱，捕捉略有难度',
    '· 灵蛋：卵生妖兽才有，必得，带走以灵力温养孵化',
    '· 双亲守护：须以战力慑服，败则灵兽被护着遁走',
    '',
    '【捕抓】',
    '· 捕抓免费；普通空巢/幼崽仅有10%逃跑率，灵蛋必得，父母守护则须以战力慑服。失败灵兽逃逸，本次作废。',
    '· 灵兽袋容量 10，满员须 #放生 <序号> 腾位。',
    '',
    '【成长】幼崽→少年→成年→完全体→蜕变',
    '· 随岁月自动精进，约三十日臻至圆满；幼崽与灵蛋不可参战。',
    '· 灵蛋孵化按品质 1~7 天，破壳成幼崽（#宠物详情 <序号> 观孵化进度）。',
    '',
    '【交易】#赠送宠物 @玩家 <序号>',
    '· 唯有灵蛋与幼崽可解契转赠；少年及以上已认主，不可交易。',
    '',
    '【出战】#宠物出战 <序号> / #收回宠物',
    '· 出战灵兽（少年及以上）的战力计入你的战力，用于守卫/幻境/伏击/宗门等战斗；收回即不计入。',
    '',
    '【查看】',
    '· #灵兽袋：我的灵兽 · #宠物详情 <序号>：细观资质与成长',
    '· #宠物改名 <序号> <名> · #放生 <序号>',
    '· #宠物目录（可跟 大区/品质/名称 筛选）：#宠物目录 彩 / #宠物目录 应龙 观完整资质',
    '',
    '【稀有】',
    '· 红品妖兽极难寻觅，彩品更是可遇不可求。',
    '· 每日/每五日天机示警某大区红彩之气大盛，现身之机大增——先到先得，谁先夺得红彩即散，须待下次天机再启（仍可凭机缘偶遇）。',
    '· 全池基础遇宠概率参考：金约8.01%、红约1.09%、彩约0.67%；不同大区因物种池不同会有浮动。',
    '· 灵兽战力上限低于顶配修士，养成均衡不超模。'
  ].join('\n')
}
