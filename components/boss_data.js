import { wearPlayerTaichu, wearNpcTaichu } from './taichu_combat.js'
/* ============================================================
 * 世界Boss系统 - 数据与核心逻辑
 * 生成: 繁荣度倒数3名大区随机 / 每次1个 / 2天周期≥1≤3次
 * 血量: 按白名单群交互玩家数+平均境界动态调整
 * 战斗: 同大区攻击, 1小时未死逃跑(冷却1~3h, 随机大区重生), 夜间1~6点暂停
 * 掉落: 按伤害占比分赃 + 登仙令现场抢夺(1分钟, 可@争夺, 同大区)
 * ============================================================ */
import fs from 'fs'
import { Plugin_Name, Save_Path } from './plugin.js'
import xujing_data from './xujing_data.js'
import { REGIONS, REGION_KEYS, getWorld, getLoc, regionNameOf, bossOf } from './world_data.js'
import { getBuffs, calcDamage, calcCombatPower, absoluteWinRate } from './fight.js'
import { getBag, addItem, itemIcon, yaodanName } from './equip_data.js'
import { DAILY_RANDOM_SPAWN_MIN, DAILY_RANDOM_SPAWN_MAX } from './spawn_schedule.js'

const BOSS_DIR = `${Save_Path}/world`
const BOSS_FILE = `${BOSS_DIR}/boss.json` // 旧全局档(仅首次迁移用)

/** 每群独立存档: data/.../world/boss_{gid}.json */
function bossFile (gid) { return `${BOSS_DIR}/boss_${gid}.json` }
/** 从存档文件名提取需要由 Boss 调度器维护的群号。 */
export function mergeBossGroupIds (names) {
  return [...new Set((names || [])
    .filter(name => /^(?:boss|world)_\d+\.json$/.test(name))
    .map(name => name.replace(/^(?:boss|world)_|\.json$/g, '')))]
}
/** 所有活跃群(已有世界档或Boss独立档的群) */
export function activeBossGroups () {
  try {
    if (!fs.existsSync(BOSS_DIR)) return []
    return mergeBossGroupIds(fs.readdirSync(BOSS_DIR))
  } catch (err) { return [] }
}

/* ---------- 常量 ---------- */
export const BOSS_LIFE_MIN = 60 // 存在1小时
export const TOKEN_SEC = 60 // 登仙令抢夺1分钟
/** 持令者战力系数: 初始不减(1), 每成功防守一次按 TOKEN_HOLDER_POWER_DROP 削减(累积) */
export const TOKEN_HOLDER_POWER = 1
/** 持令者每次成功防守削减5%战力 */
export const TOKEN_HOLDER_POWER_DROP = 0.05
export const MAX_SPAWN_PER_CYCLE = 3 // 每2天周期最多3次
export const CYCLE_MS = 2 * 24 * 3600 * 1000 // 2天
export const NIGHT_START = 1 // 夜间暂停(凌晨1~6点)
export const NIGHT_END = 6
export const ATTACK_CD = 20 // 攻击冷却(秒)
export const GRAB_CD = 20 // 抢夺失败冷却(秒)
export const BCAST_MIN = 10 // 每10分钟播报
export const FLEE_MIN = [60, 180] // 逃跑冷却1~3小时(分钟)
export const REGEN_PER_HOUR = 0.15 // 逃跑回血: 重生时每小时恢复最大血量15%
export const FIRST_SPAWN_MIN = [6 * 60, 36 * 60] // 周期首刷 6~36小时(确保2天内≥1)
export const NEXT_SPAWN_MIN = [DAILY_RANDOM_SPAWN_MIN, DAILY_RANDOM_SPAWN_MAX] // 击杀后下次 3~24小时
export const BOSS_SOON_DELAY = 60 * 1000

/* ---------- Boss类型(四百余种) ---------- */
// [名称, tier]  tier: 1普通/2精英/3王级/4传说
export const BOSS_TYPES = [
  // 传说(4)
  ['混沌古兽·饕餮', 4], ['太初神凰', 4], ['洪荒祖龙', 4], ['幽冥鬼帝', 4], ['灭世天魔', 4],
  ['亘古玄武', 4], ['虚境吞噬者', 4], ['无上剑魔', 4], ['寂灭佛魔', 4], ['轮回之主', 4],
  ['太上魔尊', 4], ['九天玄蛇', 4], ['星辰古猿', 4], ['万劫雷皇', 4], ['不朽骨龙', 4],
  ['吞天妖皇', 4], ['灭世烛龙', 4], ['玄冥鬼王', 4], ['蚀骨魔尊', 4], ['不灭尸皇', 4],
  ['焚天炎尊', 4], ['万象妖主', 4], ['九幽之主', 4],
  ['混沌神兽·穷奇', 4], ['上古凶兽·梼杌', 4], ['太古凶兽·九婴', 4], ['洪荒妖圣·相柳', 4], ['吞天金乌', 4],
  ['焚天毕方', 4], ['噬月应龙', 4], ['镇世青龙', 4], ['守界白虎', 4], ['离火朱雀', 4],
  ['沧溟玄武', 4], ['九首神蛟', 4], ['裂天夔牛', 4], ['撼世禺疆', 4], ['擎天陆吾', 4],
  ['开明神兽', 4], ['混沌祖魔', 4], ['太虚魔尊', 4], ['无极剑尊', 4], ['紫霄雷帝', 4],
  ['玄天剑尊', 4], ['碧落神君', 4], ['幽冥魔帝', 4], ['赤霄火帝', 4], ['沧溟水帝', 4],
  ['荒古妖帝', 4], ['太古魔帝', 4], ['混沌魔祖', 4], ['吞天魔祖', 4], ['灭世妖祖', 4],
  ['万妖之祖', 4], ['万魔之尊', 4], ['烛龙·魔君', 4], ['太古神猿', 4], ['五爪金龙', 4],
  ['九彩神凰', 4], ['蚀骨冥龙', 4], ['万古毒祖', 4], ['噬魂鬼母', 4], ['幽冥鬼后', 4],
  ['血海魔君', 4], ['千手妖僧', 4], ['枯骨魔王', 4], ['七窍魔君', 4], ['六道之主', 4],
  ['阴阳老祖', 4], ['太阴老祖', 4], ['混元道祖', 4],
  // 王级(3)
  ['赤炎魔龙', 3], ['玄冰妖狐', 3], ['九幽噬魂兽', 3], ['裂空蛟龙', 3], ['蚀月天狼', 3],
  ['噬血修罗', 3], ['通天猿王', 3], ['裂天神鹏', 3], ['深海玄龟', 3], ['紫电雷蛟', 3],
  ['赤焰麒麟', 3], ['玄影灵豹', 3], ['熔岩兽王', 3], ['玄冰巨猿', 3], ['万毒蛊王', 3],
  ['血瞳魔猿', 3], ['疾风鲲鹏', 3], ['玄铁甲龙', 3], ['幽影罗刹', 3], ['赤金神雕', 3],
  ['碧眼火狮', 3], ['霜雪灵鹤', 3], ['岩浆龙蜥', 3], ['黑水玄蛇', 3], ['琉璃灵兽', 3],
  ['五色神牛', 3], ['噬骨毒蟒', 3], ['三首魔犬', 3], ['赤焰犀王', 3], ['玄霜冰蛟', 3],
  ['玄背蜈蚣王', 3], ['紫纹玄虎', 3],
  ['紫电魔鹰', 3], ['玄风魔鹰', 3], ['赤羽金雕', 3], ['铁翼魔雕', 3], ['玄冰魔狼', 3],
  ['黑风狼王', 3], ['碧血狼王', 3], ['啸月天狼', 3], ['裂地熊王', 3], ['撼山熊罴', 3],
  ['镇岳神象', 3], ['踏云神象', 3], ['翻江巨象', 3], ['碧海龙龟', 3], ['玄甲龙龟', 3],
  ['赤炎龟王', 3], ['翻江蛟王', 3], ['黑鳞蛟王', 3], ['青鳞蛟龙', 3], ['血鳞蛟龙', 3],
  ['独角火犀', 3], ['铁背犀王', 3], ['金刚犀王', 3], ['玄冰灵犀', 3], ['六眼魔蛛', 3],
  ['铁爪蛛王', 3], ['金丝蛛王', 3], ['八足毒王', 3], ['千足毒蜈', 3], ['毒冠蝎王', 3],
  ['紫背蝎王', 3], ['赤链蛇王', 3], ['青鳞巨蟒', 3], ['血纹巨蟒', 3], ['吞雾蟒王', 3],
  ['玄毒蛇王', 3], ['碧眼蟾王', 3], ['赤冠蟾王', 3], ['三眼蟾尊', 3], ['噬心螳螂', 3],
  ['刀臂螳王', 3], ['蚀骨蚁后', 3], ['黄蜂妖王', 3], ['玉蜂王', 3], ['玉蝉王', 3],
  ['玄蝉妖王', 3], ['花蝶妖后', 3], ['赤目蛇雕', 3], ['玄羽妖鹤', 3], ['黑羽魔鹤', 3],
  ['白眉妖猿', 3], ['赤瞳魔猿', 3], ['黑面猿王', 3], ['赤背猿王', 3], ['银臂神猿', 3],
  ['独目妖王', 3], ['三瞳妖王', 3], ['四目神獒', 3], ['铁牙犬王', 3], ['赤鬃狮王', 3],
  ['玄鬃狮王', 3], ['裂山狮王', 3], ['白虎王', 3], ['玄斑虎王', 3], ['赤纹虎王', 3],
  ['墨玉麒麟', 3], ['紫鳞麒麟', 3], ['玄灵麒麟', 3], ['赤面狮虎', 3], ['玄獠兽王', 3],
  ['裂风兽王', 3], ['黑煞兽王', 3], ['赤煞兽王', 3], ['玄风狸', 3], ['赤影风狸', 3],
  // 精英(2)
  ['疾风狼王', 2], ['铁甲蛮牛', 2], ['双头火蛇', 2], ['岩石傀儡', 2], ['暗夜蝙蝠王', 2],
  ['剧毒蜘蛛后', 2], ['狂暴野猪王', 2], ['雪域白熊', 2], ['沙暴蝎王', 2], ['雷电鹰王', 2],
  ['沼泽巨鳄', 2], ['烈焰狮王', 2], ['冰晶雪鹿', 2], ['土岩穿山甲', 2], ['水灵鱼妖', 2],
  ['旋风暴君', 2], ['金甲巨蜥', 2], ['幽冥火鸦', 2], ['裂地蛮熊', 2], ['银月狼灵', 2],
  ['剧毒花妖', 2], ['赤炎火灵', 2], ['寒潭水灵', 2], ['沙海蜃妖', 2], ['翠林藤妖', 2],
  ['雷光隼王', 2], ['疾风影狐', 2], ['七彩毒蟾', 2], ['银鳞巨蟒', 2], ['血翼蝠王', 2],
  ['赤练毒蛇', 2], ['白玉灵犀', 2], ['雷角羚王', 2],
  ['风刃狼王', 2], ['烈焰狼王', 2], ['岩甲狼王', 2], ['黑铁狼王', 2], ['疾风豹王', 2],
  ['黑纹豹王', 2], ['烈焰豹王', 2], ['玄冰豹王', 2], ['利爪虎王', 2], ['风纹虎王', 2],
  ['山岩虎王', 2], ['赤目虎王', 2], ['铁背熊王', 2], ['黑水熊王', 2], ['玄木熊王', 2],
  ['裂石熊王', 2], ['奔雷牛王', 2], ['铁角牛王', 2], ['玄铁牛王', 2], ['赤角牛王', 2],
  ['疾风鹿王', 2], ['灵纹鹿王', 2], ['霜角鹿王', 2], ['玄风羊王', 2], ['黑岩羊王', 2],
  ['赤鬃羊王', 2], ['烈风猪王', 2], ['铁牙猪王', 2], ['玄纹猪王', 2], ['三眼狼王', 2],
  ['赤瞳狼王', 2], ['玄影狼王', 2], ['疾影狸王', 2], ['黑纹狸王', 2], ['赤纹狸王', 2],
  ['金纹蛇王', 2], ['玄纹蛇王', 2], ['赤环蛇王', 2], ['毒牙蟒王', 2], ['铁鳞蟒王', 2],
  ['花鳞蟒王', 2], ['玄鳞蟒王', 2], ['寒冰蟾王', 2], ['烈焰蟾王', 2], ['玄冰蟾王', 2],
  ['赤火蟾王', 2], ['毒液蛛王', 2], ['玄丝蛛王', 2], ['赤目蛛王', 2], ['铁甲蜈蚣', 2],
  ['赤链蜈蚣', 2], ['黑背蜈蚣', 2], ['金甲蝎王', 2], ['玄甲蝎王', 2], ['紫毒蝎王', 2],
  ['铁尾蝎王', 2], ['赤尾蝎王', 2], ['疾风隼王', 2], ['玄翼隼王', 2], ['赤羽隼王', 2],
  ['黑翼鹰王', 2], ['金爪鹰王', 2], ['铁爪鹰王', 2], ['玄羽鹰王', 2], ['赤目鸦王', 2],
  ['铁嘴鸦王', 2], ['黑羽鸦王', 2], ['银羽雕王', 2], ['玄羽雕王', 2], ['赤目雕王', 2],
  ['疾风鹤王', 2], ['玄羽鹤王', 2], ['赤顶鹤王', 2], ['银鳞鱼王', 2], ['金鳞鱼王', 2],
  ['玄甲鱼王', 2], ['赤甲虾王', 2], ['玄铁蟹王', 2], ['赤甲蟹王', 2], ['玄甲蟹王', 2],
  ['灵纹蟹王', 2], ['玄冰蛟王', 2], ['赤炎蛟王', 2], ['黑水蛟王', 2], ['疾风蛟王', 2],
  // 普通(1)
  ['森林狼王', 1], ['野山猪王', 1], ['大角鹿王', 1], ['灰熊首领', 1], ['毒蛇王', 1],
  ['巨蟒妖', 1], ['秃鹫王', 1], ['野牛首领', 1], ['鬣狗王', 1], ['山猫王', 1],
  ['獠牙虎', 1], ['沼泽蜥蜴王', 1], ['冰原狼王', 1], ['沙漠狐王', 1], ['石头蟹王', 1],
  ['红眼兔妖', 1], ['铁嘴鸦', 1], ['泥沼蟾王', 1], ['荒原马王', 1], ['林间鹿妖', 1],
  ['青蛇精', 1], ['黄羊妖', 1], ['花豹妖', 1], ['灵猫妖', 1], ['牦牛妖', 1],
  ['黄鼠狼妖', 1], ['锦鸡妖', 1], ['白猿妖', 1],
  ['灰狼妖', 1], ['赤狼妖', 1], ['玄狼妖', 1], ['黑狼妖', 1], ['赤狐妖', 1],
  ['灰狐妖', 1], ['白狐妖', 1], ['黑豹妖', 1], ['赤豹妖', 1], ['玄豹妖', 1],
  ['灰豹妖', 1], ['白虎妖', 1], ['黑虎妖', 1], ['黄虎妖', 1], ['赤虎妖', 1],
  ['黑熊妖', 1], ['棕熊妖', 1], ['白熊妖', 1], ['黑猪妖', 1], ['赤猪妖', 1],
  ['青猪妖', 1], ['黄牛妖', 1], ['花牛妖', 1], ['黑牛妖', 1], ['赤牛妖', 1],
  ['白羊妖', 1], ['黑羊妖', 1], ['赤羊妖', 1], ['野鹿妖', 1], ['花鹿妖', 1],
  ['白鹿妖', 1], ['赤鹿妖', 1], ['灰兔妖', 1], ['白兔妖', 1], ['赤兔妖', 1],
  ['红蛇妖', 1], ['花蛇妖', 1], ['黑蛇妖', 1], ['白蛇妖', 1], ['青蟒妖', 1],
  ['黑蟒妖', 1], ['花蟒妖', 1], ['金蟾妖', 1], ['青蟾妖', 1], ['赤蟾妖', 1],
  ['赤蝎妖', 1], ['青蝎妖', 1], ['黑蝎妖', 1], ['黑蛛妖', 1], ['花蛛妖', 1],
  ['赤蛛妖', 1], ['青蜈蚣', 1], ['赤蜈蚣', 1], ['黑蜈蚣', 1], ['绿蜥妖', 1],
  ['灰蜥妖', 1], ['赤蜥妖', 1], ['青蟹妖', 1], ['赤蟹妖', 1], ['山龟妖', 1],
  ['青龟妖', 1], ['赤鲤妖', 1], ['银鲤妖', 1], ['黑鲤妖', 1], ['青虾妖', 1],
  ['赤虾妖', 1], ['秃鹰妖', 1], ['灰鹰妖', 1], ['黑鹰妖', 1], ['赤鹰妖', 1],
  ['青隼妖', 1], ['赤隼妖', 1], ['黑鸦妖', 1], ['灰鸦妖', 1], ['赤鸦妖', 1],
  ['花雕妖', 1], ['赤雕妖', 1], ['黑雕妖', 1], ['灰鹫妖', 1], ['白鹤妖', 1],
  ['灰鹤妖', 1], ['赤鹤妖', 1], ['青鹭妖', 1], ['白鹭妖', 1], ['孤雁妖', 1],
  ['灰雁妖', 1], ['山雀妖', 1], ['赤雀妖', 1], ['锦雉妖', 1], ['野雉妖', 1],
  ['白鸽妖', 1], ['血蝠妖', 1], ['赤蝠妖', 1], ['黑蝠妖', 1], ['刺猬妖', 1],
  ['黄鼬妖', 1], ['白鼬妖', 1], ['水獭妖', 1], ['野猫妖', 1], ['花猫妖', 1],
  ['黑猫妖', 1], ['白獾妖', 1], ['黑獾妖', 1], ['竹鼠妖', 1], ['田鼠妖', 1],
  ['麂妖', 1], ['獐妖', 1], ['野猴妖', 1], ['灰猿妖', 1], ['黑猿妖', 1],
  ['牛蛙妖', 1], ['赤蛙妖', 1], ['青蛙妖', 1], ['水鳄妖', 1], ['黑鳄妖', 1],
  ['青鳄妖', 1], ['野马妖', 1], ['黑马妖', 1], ['赤马妖', 1]
]
/* ---------- 档位权重(越强越稀有) ---------- */
/** 各档位被抽中的权重(总和100): 普通45 / 精英30 / 王级20 / 传说5 */
export const TIER_WEIGHTS = { 1: 45, 2: 30, 3: 20, 4: 5 }

/** 按档位权重随机取一个Boss类型; 同一档内等概率 */
export function randomBossType (rand = Math.random) {
  const r = rand() * 100
  let acc = 0
  for (const [t, w] of Object.entries(TIER_WEIGHTS)) {
    acc += w
    if (r < acc) {
      const tier = Number(t)
      const pool = BOSS_TYPES.filter(x => x[1] === tier)
      const [name] = pool[Math.floor(rand() * pool.length)]
      return { name, tier }
    }
  }
  /* 兜底(浮点边界) */
  const pool = BOSS_TYPES.filter(x => x[1] === 4)
  const [name] = pool[Math.floor(rand() * pool.length)]
  return { name, tier: 4 }
}

/* ---------- 掉落池(按tier) ---------- */
/* 彩材不走随机池: 各档整场固定掉落(见 FIXED_COLOR_CNT), 池内只留"乱七八糟"的随机物 */
const DROP_POOLS = {
  1: ['修为丹', '破障丹', '星霜草', '青鸾草', '月魄石', '星璇石'],
  2: ['修为丹', '破障丹', '聚宝丹', '灵犀丹', '望舒花', '月华芝', '流光玉', '织云石'],
  3: ['聚宝丹', '灵犀丹', '行运丹', '同心丹', '玉甲丹', '凝露丹', '凤栖花', '流光玉', '织云石'],
  4: ['玉甲丹', '凝露丹', '慧心丹', '摄魂丹', '惊鸿丹', '凤栖花', '凤羽玉']
}
/** 基础血量(tier) */
const BASE_HP = { 1: 150000, 2: 350000, 3: 800000, 4: 2000000 }

/* ---------- 妖丹掉落(按Boss档位) ---------- */
/** 每只世界Boss整场只掉1枚妖丹; 掉落阶数范围按档位: 1/2/3/4 → 1~3/2~4/3~6/6~7 */
export const BOSS_YAODAN_RANGES = { 1: [1, 3], 2: [2, 4], 3: [3, 6], 4: [6, 7] }
/** 随机一个妖丹阶数(按Boss档位) */
export function rollBossYaodanTier (tier, rand = Math.random) {
  const range = BOSS_YAODAN_RANGES[tier] || BOSS_YAODAN_RANGES[1]
  return range[0] + Math.floor(rand() * (range[1] - range[0] + 1))
}

/* ---------- Boss状态 (每群独立) ---------- */
function emptyBoss () {
  return {
    gid: null, region: null, typeName: '', tier: 1, maxHp: 0, hp: 0,
    end: 0, fleeEnd: 0, fleeCount: 0, spawnCount: 0, cycleStart: 0, nextSpawn: 0,
    damage: {}, attackGid: {}, lastBcast: 0, token: null,
    auto: {}, // 持续讨伐: uid -> { gid, start, lastHit }
    fleeHpRatio: 0, fleeAt: 0, // 逃跑残血: 剩余血量比例 + 逃跑时间戳(重生按逃跑时长回血)
    forceSpawnAt: 0
  }
}
export function getBoss (gid) {
  const g = String(gid || '')
  const file = bossFile(g)
  try {
    if (!fs.existsSync(file)) {
      /* 旧全局档迁移: 只检查是否已有独立 Boss 档，不能用 activeBossGroups()（它现在也包含 world_<gid>.json） */
      const hasBossFile = fs.readdirSync(BOSS_DIR).some(n => /^boss_\d+\.json$/.test(n))
      if (fs.existsSync(BOSS_FILE) && !hasBossFile) {
        try { fs.renameSync(BOSS_FILE, file) } catch (err) { }
      }
      if (!fs.existsSync(file)) {
        const st = emptyBoss()
        st.gid = g
        st.cycleStart = Date.now()
        st.nextSpawn = Date.now() + rand(FIRST_SPAWN_MIN) * 60000
        saveBoss(st, g)
        return st
      }
    }
    const st = Object.assign(emptyBoss(), JSON.parse(fs.readFileSync(file, 'utf8')))
    st.gid = g
    return st
  } catch (err) {
    const st = emptyBoss()
    st.gid = g
    return st
  }
}
export function saveBoss (st, gid) {
  try {
    if (!fs.existsSync(BOSS_DIR)) fs.mkdirSync(BOSS_DIR, { recursive: true })
    fs.writeFileSync(bossFile(gid || st.gid || ''), JSON.stringify(st, null, '\t'))
  } catch (err) { console.log('[世界boss]状态保存失败:', err && err.message) }
}

/* ---------- 持续讨伐(自动攻击, 无前摇后摇) ---------- */
/** 加入持续讨伐(记录所属群, 立即开始) */
export function addAutoAtk (st, uid, gid) {
  if (!st.auto) st.auto = {}
  st.auto[String(uid)] = { gid: String(gid), start: Date.now(), lastHit: Date.now() }
}
/** 退出持续讨伐 */
export function delAutoAtk (st, uid) {
  if (!st.auto) return
  delete st.auto[String(uid)]
}

/** 随机整数区间 */
function rand ([a, b]) { return a + Math.floor(Math.random() * (b - a + 1)) }

export function scheduleBossSoon (st, delayMs = BOSS_SOON_DELAY, at = Date.now()) {
  if (!st || st.region || Number(st.fleeEnd) > at) return false
  const delay = Math.max(1000, Number(delayMs) || BOSS_SOON_DELAY)
  st.forceSpawnAt = at + delay
  return true
}

/* ---------- 夜间判断 ---------- */
export function isNight (now = new Date()) {
  const h = now.getHours()
  return h >= NIGHT_START && h < NIGHT_END
}

/* ---------- 繁荣度倒数3名大区 ---------- */
function bottomRegions (w) {
  const scores = REGION_KEYS.filter(k => !(REGIONS[k] && REGIONS[k].special)).map(k => { // 特殊大区(简月王朝)不作为Boss刷新点
    const boss = bossOf(w, k)
    let v = 0
    if (boss) v = Number(w.prosperity[boss]) || 0
    else {
      const set = new Set()
      for (const a of REGIONS[k].areas) if (w.sectMap[a]) set.add(w.sectMap[a])
      let s = 0, n = 0
      for (const x of set) { s += Number(w.prosperity[x]) || 0; n++ }
      v = n ? s / n : 0
    }
    return { k, v }
  })
  scores.sort((a, b) => a.v - b.v)
  return scores.slice(0, 3).map(x => x.k)
}

/* ---------- 血量: 按本群交互玩家数+平均境界 ---------- */
export async function calcBossHp (gid, baseHp) {
  let count = 0
  let levelSum = 0
  try {
    const battle = await xujing_data.getQQYUserBattle('0', null, false, `${gid}.json`)
    for (const uid of Object.keys(battle)) {
      const lv = Number(battle[uid] && battle[uid].level) || 0
      if (lv > 0) { count++; levelSum += lv }
    }
  } catch (err) { }
  const avg = count ? Math.round(levelSum / count) : 0
  /* 血量 = 基础 × (1+人数×3%) × (1+均境×2%) × 2(用户要求翻一倍) */
  const hp = Math.round(baseHp * (1 + count * 0.03) * (1 + avg * 0.02)) * 2
  return { hp, count, avg }
}

/* ---------- 生成/重生 ---------- */
export async function spawnBoss (st, gid, region = null, respawn = false) {
  const w = getWorld(gid)
  const bottom = bottomRegions(w)
  const target = region || bottom[Math.floor(Math.random() * bottom.length)] || REGION_KEYS[0]
  /* 重生(逃跑后)保留同一Boss与逃遁计数; 全新Boss重置逃遁计数 */
  const { name, tier } = (respawn && st.typeName) ? { name: st.typeName, tier: st.tier } : randomBossType()
  if (!respawn) {
    st.fleeCount = 0
    st.fleeHpRatio = 0
    st.fleeAt = 0
  }
  const { hp, count, avg } = await calcBossHp(gid, BASE_HP[tier])
  /* 手动安排(如手动刷boss)可带一次性血量缩放系数(如 2/3): 只对本次生效, 刷完即清 */
  const scale = Number(st.hpScale) || 1
  const realHp = Math.max(1, Math.round(hp * scale))
  st.hpScale = undefined
  let startHp = realHp
  if (respawn) {
    /* 重生保留上次剩余血量比例 + 按逃跑时长回血(每小时恢复 REGEN_PER_HOUR); 旧档无记录→满血 */
    const fleeAt = Number(st.fleeAt) || 0
    let ratio = Number(st.fleeHpRatio) || 0
    if (fleeAt > 0) {
      const fleeDurH = Math.max(0, (Date.now() - fleeAt) / 3600000)
      ratio = Math.min(1, ratio + fleeDurH * REGEN_PER_HOUR)
    } else {
      ratio = 1
    }
    startHp = Math.max(1, Math.round(realHp * ratio))
    st.fleeHpRatio = 0
    st.fleeAt = 0
  }
  st.region = target
  st.typeName = name
  st.tier = tier
  st.maxHp = realHp
  st.hp = startHp
  st.end = Date.now() + BOSS_LIFE_MIN * 60000
  st.fleeEnd = 0
  st.damage = {}
  st.attackGid = {}
  st.lastBcast = Date.now()
  return { target, name, tier, hp, count, avg, startHp }
}

/* ---------- 攻击(单人一次伤害) ---------- */
export async function attackHit (st, uid, gid) {
  if (!(Number(st.hp) > 0)) return { dmg: 0, level: 0 }
  const battle = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
  const level = Number(battle[uid] && battle[uid].level) || 0
  const bag = getBag(uid, gid)
  const buff = await getBuffs(uid, gid)
  const rolled = calcDamage(level, bag, 0.15, buff, gid, uid)
  const dmg = Math.min(st.hp, Math.max(0, rolled.dmg))
  st.damage[String(uid)] = (st.damage[String(uid)] || 0) + dmg
  st.attackGid[String(uid)] = String(gid)
  st.hp = Math.max(0, st.hp - dmg)
  // 每次现世整场只扣一次；20秒自动连击复用本次Boss结束时间作为回执。
  if (dmg > 0) wearPlayerTaichu(gid, uid, `boss:${st.end}:${st.typeName}`, 3)
  return { dmg, level }
}

/* ---------- 击杀掉落: 按伤害占比分赃(本群) ---------- */
/** 世界Boss彩材: 固定掉落只出这两种(品质7, 与藏宝阁出彩池一致) */
export const COLOR_MATS = ['云裳仙蕊', '造梦神玉']
/** 每档(难度)整场固定掉的彩材总量: 1/2/3/4档 → 1/3/6/10(彩掉落固定, 其余随机) */
export const FIXED_COLOR_CNT = { 1: 1, 2: 3, 3: 6, 4: 10 }

/** 纯函数: 规划一次Boss击杀的掉落明细(不上背包, 便于测试)。
 * 彩材: 整场总量按档固定, 再按伤害占比瓜分(最大余数法, 各参与者合计恰好=固定值)。
 * 妖丹: 整场只掉1枚, 归伤害最高者(并列取先出手者), 阶数按Boss档位随机。
 * 其余: 从该档随机池按原逻辑随机。 */
export function planBossLoot (st, rand = Math.random) {
  const total = Object.values(st.damage).reduce((a, b) => a + b, 0) || 1
  const pool = DROP_POOLS[st.tier] || DROP_POOLS[1]
  const colorTotal = FIXED_COLOR_CNT[st.tier] || 0
  const participants = Object.keys(st.damage)
  /* 固定彩材: 按伤害占比分(先向下取整, 余量按小数最大者补足, 保证总数恰好=colorTotal) */
  const colorShare = {}
  let given = 0
  for (const uid of participants) {
    const raw = (st.damage[uid] / total) * colorTotal
    colorShare[uid] = Math.floor(raw)
    given += colorShare[uid]
  }
  let rest = colorTotal - given
  const byFrac = [...participants].sort((a, b) =>
    (((st.damage[b] / total) * colorTotal) % 1) - (((st.damage[a] / total) * colorTotal) % 1))
  for (const uid of byFrac) {
    if (rest <= 0) break
    colorShare[uid]++
    rest--
  }
  /* 妖丹: 整场只掉1枚, 归伤害最高者 */
  const topUid = participants.slice().sort((a, b) => (st.damage[b] || 0) - (st.damage[a] || 0))[0] || null
  const pillName = topUid ? yaodanName(rollBossYaodanTier(st.tier, rand)) : ''
  const results = []
  for (const uid of participants) {
    const n = Math.max(1, Math.round((st.damage[uid] / total) * participants.length * 2))
    const got = []
    for (let i = 0; i < n; i++) got.push(pool[Math.floor(rand() * pool.length)])
    for (let i = 0; i < (colorShare[uid] || 0); i++) got.push(COLOR_MATS[Math.floor(rand() * COLOR_MATS.length)])
    if (uid === topUid && pillName) got.push(pillName)
    results.push({ uid, got })
  }
  return results
}

export async function distributeLoot (st, gid) {
  const plan = planBossLoot(st)
  const results = []
  for (const { uid, got } of plan) {
    for (const item of got) addItem(uid, item, 1, null, gid)
    results.push({ uid, got })
  }
  return results
}

/* ---------- 登仙令抢夺 ---------- */
/** Boss死亡: 生成登仙令现世状态(记录掉落大区) */
export function startToken (st, region) {
  st.token = { holder: null, end: Date.now() + TOKEN_SEC * 1000, excluded: [], defended: 0, holderGid: null, region: region || null }
}
/** 第一个抢到(须与登仙令掉落同大区) */
export function firstGrab (st, uid, gid) {
  if (!st.token) return { ok: false, msg: `当前没有现世的${itemIcon('登仙令')}登仙令~` }
  if (!(Number(st.token.end) > Date.now())) return { ok: false, msg: '本轮登仙令争夺已结束。' }
  if (st.token.holder) return { ok: false, msg: `${itemIcon('登仙令')}登仙令已被他人夺得，输入 #抢夺登仙令 @他 继续抢夺！` }
  if (st.token.region) {
    const w = getWorld(gid)
    if (getLoc(w, uid) !== st.token.region) return { ok: false, msg: `${itemIcon('登仙令')}登仙令掉落在【${regionNameOf(st.token.region)}】，你不在该大区，无法抢夺！` }
  }
  st.token.holder = String(uid)
  st.token.holderGid = String(gid)
  return { ok: true }
}
/** @争夺: 同大区+未排除, 双方按境界/战力概率(持令者初始不减, 每次守住-5%), 打赢接手并继承剩余时间 */
export async function stealGrab (st, challengerUid, gid) {
  const t = st.token
  if (!t || !t.holder) return { ok: false, msg: `当前没有可抢夺的${itemIcon('登仙令')}登仙令~` }
  if (!(Number(t.end) > Date.now())) return { ok: false, msg: '本轮登仙令争夺已结束，归属已确定。' }
  if (String(t.holder) === String(challengerUid)) return { ok: false, msg: `${itemIcon('登仙令')}登仙令就在你手上，抢什么~` }
  if ((t.excluded || []).includes(String(challengerUid))) return { ok: false, msg: '你已抢夺失败过一次，无缘再争此令~' }
  const holderUid = t.holder
  /* 同大区校验 */
  const w = getWorld(gid)
  if (getLocOf(w, challengerUid) !== getLocOf(w, holderUid)) return { ok: false, msg: '你与被抢者不在同一大区，无法抢夺~' }
  /* 比拼: 持令者初始战力不减, 每成功防守一次削减5%(累积) */
  const hb = await getBuffs(holderUid, gid)
  const cb = await getBuffs(challengerUid, gid)
  const hLevel = await levelOf(holderUid, gid)
  const cLevel = await levelOf(challengerUid, gid)
  const powerFactor = Math.max(0, TOKEN_HOLDER_POWER - TOKEN_HOLDER_POWER_DROP * (Number(t.defended) || 0))
  const holderWin = winChance(hLevel, cLevel, holderUid, challengerUid, hb, cb, gid, powerFactor)
  const challengerWin = Math.random() * 100 >= holderWin
  const receipt = `boss-token:${t.end}:${holderUid}:${challengerUid}:${t.defended || 0}`
  wearPlayerTaichu(gid, holderUid, receipt, challengerWin ? 4 : 2)
  wearPlayerTaichu(gid, challengerUid, receipt, challengerWin ? 2 : 4)
  if (!challengerWin) {
    /* 持令者守住: 战力再削5%(累积), 挑战者失败进冷却 */
    t.defended = (Number(t.defended) || 0) + 1
    try { await redis.set(`xujing:boss-grab-cd:${challengerUid}`, 1, { EX: GRAB_CD }) } catch (err) { }
    return { ok: false, msg: `抢夺失败！对方护令如命，你没能得手~（${GRAB_CD}秒后可再试）` }
  }
  /* 成功: 原持令者被排除, 挑战者接手(继承剩余时间) */
  t.excluded = (t.excluded || []).concat(String(holderUid))
  t.holder = String(challengerUid)
  t.holderGid = String(gid)
  return { ok: true, holder: String(challengerUid), prev: String(holderUid) }
}
/** 倒计时结束: 收入囊中, 返回持令者 */
export function settleToken (st) {
  const t = st.token
  if (!t || !t.holder) return null
  if (Date.now() < t.end) return null
  const holder = String(t.holder)
  st.token = null
  return { holder, gid: t.holderGid }
}

/** 玩家所在大区 */
function getLocOf (w, uid) {
  return getLoc(w, uid)
}
/** 等级 */
async function levelOf (uid, gid) {
  try {
    const b = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
    return Number(b[uid] && b[uid].level) || 0
  } catch (err) { return 0 }
}
/** 抢夺胜率(持令者buff×powerFactor) */
function winChance (hLevel, cLevel, holderUid, challengerUid, hb, cb, gid, powerFactor) {
  const holder = calcCombatPower(hLevel, getBag(holderUid, gid), hb, gid, holderUid).power
  const challenger = calcCombatPower(cLevel, getBag(challengerUid, gid), cb, gid, challengerUid).power
  const factor = Number.isFinite(Number(powerFactor)) ? Math.max(0, Number(powerFactor)) : 1
  const scaled = holder * factor
  return scaled > 0 ? absoluteWinRate(scaled, challenger) : (challenger > 0 ? 0 : 50)
}
