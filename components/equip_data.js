import fs from 'fs'
import { writeJsonAtomic } from './json_store.js'
import { Plugin_Name, Save_Path } from './plugin.js'

const bagpath = `${Save_Path}/bag`

/** 品质定义: 1白 2绿 3蓝 4紫 5金 6红 7彩 */
export const QUALITY = {
  1: { icon: '⚪', name: '白色' },
  2: { icon: '🟢', name: '绿色' },
  3: { icon: '🔵', name: '蓝色' },
  4: { icon: '🟣', name: '紫色' },
  5: { icon: '🟡', name: '金色' },
  6: { icon: '🔴', name: '红色' },
  7: { icon: '🌈', name: '彩色' }
}

/** 统一物品图标: 消耗品沿用自身图标, 其余物品按品质图标展示 */
export function itemIcon (name) {
  if (name === '灵石') return '💰'
  if (typeof name === 'string' && name.startsWith('rainbow:')) return '🌈'
  if (name === '七彩神兵') return '🌈'
  if (ITEM_TPL[name]) return ITEM_TPL[name].icon || '📦'
  if (ARTIFACT_TPL[name]) return ARTIFACT_TPL[name].icon || '📦'
  if (name === '万魂幡') return '🏴'
  if (MATERIAL_TPL[name]) return QUALITY[MATERIAL_TPL[name].quality]?.icon || '📦'
  if (EQUIP_TPL[name]) return QUALITY[EQUIP_TPL[name].quality]?.icon || '📦'
  if (GONGFA_TPL[name]) return QUALITY[GONGFA_TPL[name].quality]?.icon || '📦'
  return '📦'
}

/** 统一物品文本: 每个物品名称前都带对应图标 */
export function fmtItem (name, count = null) {
  return `${itemIcon(name)}${name}${count === null || count === undefined ? '' : `×${count}`}`
}

/** 统一物品映射文本, 供成本/奖励/背包摘要复用 */
export function fmtItems (items, separator = '、') {
  return Object.entries(items || {}).map(([name, count]) => fmtItem(name, count)).join(separator)
}

/** 部位定义 */
export const PARTS = {
  weapon: '武器',
  helmet: '头盔',
  chest: '胸甲',
  pants: '裤子',
  shoes: '鞋子',
  ring: '戒指'
}

/** 装备模板: 名字 -> { type, quality, atk, def, hp } */
export const EQUIP_TPL = {
  // ===== 武器 =====
  '桃木剑': { type: 'weapon', quality: 1, atk: 4 },
  '素纱扇': { type: 'weapon', quality: 1, atk: 4 },
  '碧柳剑': { type: 'weapon', quality: 2, atk: 9 },
  '荷叶扇': { type: 'weapon', quality: 2, atk: 10 },
  '流霜剑': { type: 'weapon', quality: 3, atk: 18 },
  '水月扇': { type: 'weapon', quality: 3, atk: 20 },
  '紫霞剑': { type: 'weapon', quality: 4, atk: 36 },
  '星河扇': { type: 'weapon', quality: 4, atk: 40 },
  '流金剑': { type: 'weapon', quality: 5 },
  '月华扇': { type: 'weapon', quality: 5 },
  '霓裳剑': { type: 'weapon', quality: 6 },
  '朱雀扇': { type: 'weapon', quality: 6 },
  // ===== 头盔 =====
  '花布冠': { type: 'helmet', quality: 1, def: 2, hp: 8 },
  '素珠冠': { type: 'helmet', quality: 1, def: 3, hp: 5 },
  '柳叶冠': { type: 'helmet', quality: 2, def: 5, hp: 16 },
  '翠玉冠': { type: 'helmet', quality: 2, def: 4, hp: 20 },
  '水月冠': { type: 'helmet', quality: 3, def: 10, hp: 32 },
  '蓝晶冠': { type: 'helmet', quality: 3, def: 8, hp: 40 },
  '紫蝶冠': { type: 'helmet', quality: 4, def: 20, hp: 64 },
  '星辉冠': { type: 'helmet', quality: 4, def: 16, hp: 80 },
  '金花冠': { type: 'helmet', quality: 5 },
  '月华冠': { type: 'helmet', quality: 5 },
  '凤羽冠': { type: 'helmet', quality: 6 },
  '霓凰冠': { type: 'helmet', quality: 6 },
  // ===== 胸甲 =====
  '素纱衣': { type: 'chest', quality: 1, def: 3, hp: 12 },
  '棉软甲': { type: 'chest', quality: 1, def: 4, hp: 10 },
  '翠柳衣': { type: 'chest', quality: 2, def: 7, hp: 24 },
  '青鳞软甲': { type: 'chest', quality: 2, def: 6, hp: 30 },
  '水月衣': { type: 'chest', quality: 3, def: 14, hp: 48 },
  '蓝纹软甲': { type: 'chest', quality: 3, def: 12, hp: 60 },
  '紫霞衣': { type: 'chest', quality: 4, def: 28, hp: 96 },
  '星纹软甲': { type: 'chest', quality: 4, def: 24, hp: 120 },
  '金缕衣': { type: 'chest', quality: 5 },
  '月纹软甲': { type: 'chest', quality: 5 },
  '霓裳羽衣': { type: 'chest', quality: 6 },
  '凤凰软甲': { type: 'chest', quality: 6 },
  // ===== 裤子 =====
  '素纱裙': { type: 'pants', quality: 1, def: 2, hp: 10 },
  '棉布裤': { type: 'pants', quality: 1, def: 3, hp: 8 },
  '翠柳裙': { type: 'pants', quality: 2, def: 5, hp: 20 },
  '青纹裤': { type: 'pants', quality: 2, def: 6, hp: 16 },
  '水月裙': { type: 'pants', quality: 3, def: 10, hp: 40 },
  '蓝纹裤': { type: 'pants', quality: 3, def: 12, hp: 32 },
  '紫霞裙': { type: 'pants', quality: 4, def: 20, hp: 80 },
  '星纹裤': { type: 'pants', quality: 4, def: 24, hp: 64 },
  '金缕裙': { type: 'pants', quality: 5 },
  '月纹裤': { type: 'pants', quality: 5 },
  '霓裳裙': { type: 'pants', quality: 6 },
  '凤凰裤': { type: 'pants', quality: 6 },
  // ===== 鞋子 =====
  '素绣鞋': { type: 'shoes', quality: 1, def: 1, hp: 6 },
  '棉布靴': { type: 'shoes', quality: 1, def: 2, hp: 4 },
  '翠柳绣鞋': { type: 'shoes', quality: 2, def: 4, hp: 12 },
  '青纹靴': { type: 'shoes', quality: 2, def: 3, hp: 16 },
  '水月绣鞋': { type: 'shoes', quality: 3, def: 8, hp: 24 },
  '蓝纹靴': { type: 'shoes', quality: 3, def: 6, hp: 32 },
  '紫霞绣鞋': { type: 'shoes', quality: 4, def: 16, hp: 48 },
  '星纹靴': { type: 'shoes', quality: 4, def: 12, hp: 64 },
  '金缕绣鞋': { type: 'shoes', quality: 5 },
  '月纹靴': { type: 'shoes', quality: 5 },
  '霓裳绣鞋': { type: 'shoes', quality: 6 },
  '凤凰靴': { type: 'shoes', quality: 6 },
  // ===== 戒指 =====
  '白珠戒': { type: 'ring', quality: 1, atk: 1, def: 1, hp: 10 },
  '素玉戒': { type: 'ring', quality: 1, def: 2, hp: 8 },
  '翠玉戒': { type: 'ring', quality: 2, atk: 3, def: 2, hp: 20 },
  '柳叶戒': { type: 'ring', quality: 2, atk: 2, def: 3, hp: 16 },
  '蓝玉戒': { type: 'ring', quality: 3, atk: 6, def: 4, hp: 40 },
  '水月戒': { type: 'ring', quality: 3, atk: 4, def: 6, hp: 32 },
  '紫玉戒': { type: 'ring', quality: 4, atk: 12, def: 8, hp: 80 },
  '星辉戒': { type: 'ring', quality: 4, atk: 8, def: 12, hp: 64 },
  '金玉戒': { type: 'ring', quality: 5 },
  '月华戒': { type: 'ring', quality: 5 },
  '凤纹戒': { type: 'ring', quality: 6 },
  '霓虹戒': { type: 'ring', quality: 6 },
  // ===== 彩装(品质7, 属性=红装×3; 攻势系列一套6件, 由 #制造彩装: 6造梦神玉+1红装 随机合成) =====
  '攻势·武器': { type: 'weapon', quality: 7 },
  '攻势·头盔': { type: 'helmet', quality: 7 },
  '攻势·胸甲': { type: 'chest', quality: 7 },
  '攻势·裤子': { type: 'pants', quality: 7 },
  '攻势·鞋子': { type: 'shoes', quality: 7 },
  '攻势·戒指': { type: 'ring', quality: 7 }
}

/** 新手初始装备 */
export const STARTER_ITEMS = ['桃木剑', '花布冠', '素纱衣', '素纱裙', '素绣鞋', '白珠戒']

/** 黄/红/彩品质属性随机范围(衔接:紫最高=黄最低,黄最高=红最低; 彩装=红装×3) */
const RAND_ATK = { 5: [40, 120], 6: [120, 300], 7: [360, 900] }//武器攻击
const RAND_DEF = { 5: [28, 100], 6: [100, 260], 7: [300, 780] }//防具防御
const RAND_HP = { 5: [120, 400], 6: [400, 1000], 7: [1200, 3000] }//生命

function randVal([min, max]) {
  return min + Math.floor(Math.random() * (max - min + 1))
}
function halfRange([min, max]) {
  return [Math.ceil(min / 2), Math.floor(max / 2)]
}

/** 黄/红品质随机属性;紫及以下返回空(用模板固定值) */
export function rollEquipAttr(type, quality) {
  if (quality <= 4) return {}
  const attr = {}
  if (type === 'weapon') {
    attr.atk = randVal(RAND_ATK[quality])
  } else if (type === 'ring') {
    attr.atk = randVal(halfRange(RAND_ATK[quality]))
    attr.def = randVal(halfRange(RAND_DEF[quality]))
    attr.hp = randVal(RAND_HP[quality])
  } else {
    attr.def = randVal(RAND_DEF[quality])
    attr.hp = randVal(RAND_HP[quality])
  }
  return attr
}

/** 彩装产物完全随机: 只按品质7模板随机部位和属性, 不读取红装胚子 */
export function rollRandomColorEquip (names) {
  const pool = Array.isArray(names) && names.length
    ? names.filter(name => EQUIP_TPL[name]?.quality === 7)
    : Object.keys(EQUIP_TPL).filter(name => EQUIP_TPL[name]?.quality === 7)
  if (!pool.length) return null
  const name = pool[Math.floor(Math.random() * pool.length)]
  return { name, attr: rollEquipAttr(EQUIP_TPL[name].type, 7) }
}

/** 获取装备实际属性(优先背包已存attr;紫及以下用模板固定值,黄/红随机) */
export function getItemAttr(bag, name) {
  if (bag && bag.items && bag.items[name] && bag.items[name].attr) return bag.items[name].attr
  const t = EQUIP_TPL[name]
  if (!t) return {}
  const attr = {}
  if (t.atk) attr.atk = t.atk
  if (t.def) attr.def = t.def
  if (t.hp) attr.hp = t.hp
  return Object.keys(attr).length ? attr : rollEquipAttr(t.type, t.quality)
}

/** 属性战力 */
export function attrPower(attr) {
  return (attr.atk || 0) * 2 + (attr.def || 0) * 2 + Math.floor((attr.hp || 0) / 5)
}

/** 属性文本 */
export function fmtAttr(attr) {
  const list = []
  if (attr.atk) list.push(`攻击+${attr.atk}`)
  if (attr.def) list.push(`防御+${attr.def}`)
  if (attr.hp) list.push(`生命+${attr.hp}`)
  return list.join(' ')
}

/** 黄/红品质属性范围文本 */
export function fmtAttrRange(type, quality) {
  if (quality <= 4) return '属性固定'
  const q = quality
  if (type === 'weapon') return `攻击${RAND_ATK[q][0]}~${RAND_ATK[q][1]}`
  if (type === 'ring') {
    return `攻击${halfRange(RAND_ATK[q]).join('~')} 防御${halfRange(RAND_DEF[q]).join('~')} 生命${RAND_HP[q].join('~')}`
  }
  return `防御${RAND_DEF[q].join('~')} 生命${RAND_HP[q].join('~')}`
}

/** 道具模板(消耗品): 名字 -> { icon, desc } */
export const ITEM_TPL = {
  '修为丹': { icon: '🟢', desc: '服用后获得200灵力' },
  '破障丹': { icon: '🟣', desc: '渡劫时服用,突破成功率提升至90%' },
  '登仙令': { icon: '🏯', desc: '渡劫飞升凭证,突破成仙(人仙)时消耗1枚', bound: true },
  '魂石': { icon: '🔹', desc: '进入万魂窟后保护10分钟', bound: true },
  '还魂丹': { icon: '🕯️', desc: '解除失魂状态', bound: true },
  '仙帝丹': { icon: '👑', desc: '玩家不可服用；赠予伪玩家后自动服用，直接升至仙帝第10重（已达标者留在包中）' },
  '神游蛊': { icon: '🦋', desc: '南疆捕获的神异蛊虫，用于合成定仙游', bound: true },
  '惊鸿丹': { icon: '🔴', desc: '服用后攻击力+20%(持续1小时,丹阁不售)' },
  '灵宝盒': { icon: '🎁', desc: '开启后获得丰厚奖励' },
  // —— 新增丹药(效果互不冲突: 幸运/双修/挂机/好感; 配方均用非彩色药材 紫4/金5/红6) ——
  '聚宝丹': { icon: '🟠', desc: '服用后1小时内增加幸运值(副本/宝盒掉落概率提升,灵石不算)' },
  '灵犀丹': { icon: '💗', desc: '服用后1小时内双修收益翻倍' },
  '行运丹': { icon: '🍀', desc: '服用后1小时内挂机收益翻倍' },
  '同心丹': { icon: '💞', desc: '服用后与道侣好感度+1000' },
  // —— 战斗丹药(名字与效果对应,偏女性化; 配方均用非彩色药材 紫4/金5/红6) ——
  '玉甲丹': { icon: '🛡️', desc: '服用后1小时内防御+20%(决斗/幻境受伤减免)' },
  '凝露丹': { icon: '🌸', desc: '服用后1小时内生命+20%(决斗/幻境生存提升)' },
  '慧心丹': { icon: '⚡', desc: '服用后1小时内暴击率+30%(会心一击)' },
  '摄魂丹': { icon: '💥', desc: '服用后1小时内爆伤+50%(暴击伤害大幅提升)' },
  // —— 简月王朝(凡人王朝) ——
  '简月舆图': { icon: '🗺️', desc: '简月王朝舆图，使用后永久解锁进入简月王朝（遗蜕秘境特殊彩奖励可获得）', bound: true },
  '血炼阵图': { icon: '📜', desc: '血炼大阵布阵图纸，学会后永久掌握；布置需无主幽魂×1、阴魂砂×20、游魂骨×20、鬼火草×5、幽冥木×5、摄魂铁×5、万魂帝晶×1、万阵核心×1（遗蜕秘境特殊彩奖励可获得）', bound: true },
  // —— 遗蜕秘境 · 专属入口 ——
  '遗蜕古钥': { icon: '🗝️', desc: '上古遗蜕留下的秘钥，队长 #使用遗蜕古钥 可开启一座专属秘境（仅本队可入），每日每群最多产出2把', bound: true },
  '万阵核心': { icon: '🔮', desc: '万阵核心，布置任何阵法均需消耗1枚；由四种红色阵法材料与30万灵石合成', bound: true }
}

/** 法宝模板: 法宝不占六个常规装备栏，存放在 bag.artifacts 中。 */
export const ARTIFACT_TPL = {
  '定仙游': {
    icon: '🦋',
    desc: '装备后生命+10%；拥有即生效：万魂窟遇到阴魂时撤退成功率100%、可免费跨区传送',
    hp: 0.1,
    bound: true
  }
}

export const ARRAY_MATS = ['天衍阵纹', '乾坤阵晶', '太虚阵砂', '九幽阵髓']

/** 秘境材料: 药材/矿物 (type: herb药材 ore矿物, 品质: 4紫 5金 6红 7彩, 纯虚构仙侠风命名, 不带颜色词; 展示用品质图标) */
export const MATERIAL_TPL = {
  // —— 药材(6): 紫2 金2 红1 彩1 ——
  '星霜草': { type: 'herb', quality: 4 },
  '青鸾草': { type: 'herb', quality: 4 },
  '望舒花': { type: 'herb', quality: 5 },
  '月华芝': { type: 'herb', quality: 5 },
  '凤栖花': { type: 'herb', quality: 6 },
  '云裳仙蕊': { type: 'herb', quality: 7 },
  // —— 普通秘境矿物(紫2 金2 红1 彩1) ——
  '月魄石': { type: 'ore', quality: 4 },
  '星璇石': { type: 'ore', quality: 4 },
  '流光玉': { type: 'ore', quality: 5 },
  '织云石': { type: 'ore', quality: 5 },
  '凤羽玉': { type: 'ore', quality: 6 },
  '造梦神玉': { type: 'ore', quality: 7 },
  // —— 万魂窟材料(白到彩七档) ——
  '万魂幡残卷': { type: 'special', quality: 7, bound: true },
  '无主幽魂': { type: 'special', quality: 1, bound: true },
  '阴魂砂': { type: 'ore', quality: 1 },
  '游魂骨': { type: 'ore', quality: 1 },
  '鬼火草': { type: 'herb', quality: 2 },
  '幽冥木': { type: 'ore', quality: 2 },
  '摄魂铁': { type: 'ore', quality: 3 },
  '阴魂石': { type: 'ore', quality: 3 },
  '玄阴玉': { type: 'ore', quality: 4 },
  '镇魂晶': { type: 'ore', quality: 5 },
  '血煞髓': { type: 'ore', quality: 6 },
  '万魂帝晶': { type: 'ore', quality: 7 },
  // —— 阵法材料(红色品质6): 合成【万阵核心】, 各类阵法布置均需消耗万阵核心 ——
  '天衍阵纹': { type: 'special', quality: 6 },
  '乾坤阵晶': { type: 'special', quality: 6 },
  '太虚阵砂': { type: 'special', quality: 6 },
  '九幽阵髓': { type: 'special', quality: 6 },
  // —— 傀儡/功法分解材料(彩色品质7) ——
  '傀儡被动晶核': { type: 'special', quality: 7, bound: true },
  '功法残卷': { type: 'special', quality: 7, bound: true },
  // —— 妖丹(品质对应阶数 1~7): 世界Boss掉落, 傀儡打造/每阶升级所需材料 ——
  '一阶妖丹': { type: 'special', quality: 1 },
  '二阶妖丹': { type: 'special', quality: 2 },
  '三阶妖丹': { type: 'special', quality: 3 },
  '四阶妖丹': { type: 'special', quality: 4 },
  '五阶妖丹': { type: 'special', quality: 5 },
  '六阶妖丹': { type: 'special', quality: 6 },
  '七阶妖丹': { type: 'special', quality: 7 },
  // —— 残丹(白色品质1): 仅遗蜕秘境掉落; 5个可 #合成妖丹 随机凝成随机品质妖丹 ——
  '残丹': { type: 'special', quality: 1 }
}

/** 万魂窟专属材料: 仅由西域万魂窟掉落, 普通秘境/灵宝盒/藏宝阁不得产出 */
export const WANHUN_ONLY_MATS = new Set(['万魂幡残卷', '阴魂砂', '游魂骨', '鬼火草', '幽冥木', '摄魂铁', '阴魂石', '玄阴玉', '镇魂晶', '血煞髓', '万魂帝晶'])

/** 妖丹阶数中文名(品质与阶数一致): 世界Boss掉落, 傀儡打造/每阶升级所需 */
const YAODAN_CN = ['', '一', '二', '三', '四', '五', '六', '七']
export function yaodanName (tier) {
  const n = YAODAN_CN[Math.max(1, Math.min(7, Math.floor(Number(tier) || 1)))]
  return `${n}阶妖丹`
}
/** 是否妖丹材料 */
export function isYaodan (name) {
  return typeof name === 'string' && name.endsWith('阶妖丹')
}

/** 残丹凝练妖丹的阶位权重(低阶更常见, 合计100): 仅遗蜕秘境产出的残丹5个可#合成妖丹 */
export const YAODAN_REMNANT_WEIGHTS = { 1: 28, 2: 24, 3: 18, 4: 12, 5: 9, 6: 6, 7: 3 }
/** 按权重随机一个妖丹阶位(1~7), random 可注入以便单测 */
export function rollYaodanTierFromRemnant (random = Math.random) {
  const entries = Object.entries(YAODAN_REMNANT_WEIGHTS).map(([tier, weight]) => ({ tier: Number(tier), weight: Number(weight) }))
  const total = entries.reduce((sum, item) => sum + item.weight, 0)
  let cursor = random() * total
  for (const item of entries) {
    cursor -= item.weight
    if (cursor < 0) return item.tier
  }
  return entries[entries.length - 1].tier
}

/** 丹药价格(灵石) */
export const ITEM_PRICE = {
  '修为丹': 500,
  '破障丹': 1000
}

/**
 * 功法模板: 名字 -> { quality, desc, fx }
 * fx 各字段含义(一个功法可有多种效果,与丹药buff叠加):
 *   atk/def/hp : 百分比加成(0.05=+5%)
 *   crit/cdmg  : 暴击率/爆伤加成(0.05=+5%)
 *   lucky      : 秘境/宝盒掉落倍率(2=翻倍)
 *   afk        : 挂机收益倍率(2=翻倍)
 *   rob        : 抢劫灵石倍率(1.8=+80%)
 *   love       : 双修/好感倍率(1.8=+80%)
 *   break      : 突破成功率加成(8=+8%)
 * 品质梯度刻意拉大(低→高: 3%→7%→12%→20%→30%→40%→60%), 组合百花齐放:
 *   低品质偏单一属性, 中品质攻防血暴击爆伤两两组合, 高品质偏玩法特效(幸运/挂机/抢劫/双修/突破)
 * 数量分配: 常规功法28本 + 特殊解锁功法傀儡术3篇 = 31
 * 藏宝阁只售金(5)及以下; 红/彩需虚境秘境极低概率掉落
 */
export const GONGFA_TPL = {
  // ===== 白色(1) 入门 · 2本 =====
  '兰息诀': { quality: 1, desc: '幽兰吐息，气血微涨', fx: { hp: 0.04, love: 1.1 } },
  '凝霜诀': { quality: 1, desc: '凝霜为锋，锋芒初露', fx: { atk: 0.04, crit: 0.01 } },
  // ===== 绿色(2) 初级 · 2本 =====
  '春风诀': { quality: 2, desc: '春风化雨，生机勃发', fx: { hp: 0.09, love: 1.2 } },
  '沉香功': { quality: 2, desc: '沉静幽香，稳如磐石', fx: { def: 0.09, hp: 0.04 } },
  // ===== 蓝色(3) 中级 · 2本 =====
  '沧澜诀': { quality: 3, desc: '沧澜浩荡，气血如海', fx: { atk: 0.15, hp: 0.07 } },
  '流光步': { quality: 3, desc: '流光掠影，防不胜防', fx: { crit: 0.07, cdmg: 0.16 } },
  // ===== 紫色(4) 高级 · 7本 =====
  '紫霞功': { quality: 4, desc: '紫霞漫天，势如破竹', fx: { atk: 0.22, hp: 0.11 } },
  '紫电诀': { quality: 4, desc: '紫电破空，势不可挡', fx: { atk: 0.18, crit: 0.06 } },
  '幻蝶步': { quality: 4, desc: '幻蝶迷踪，真假难辨', fx: { crit: 0.09, cdmg: 0.22 } },
  '玄绡功': { quality: 4, desc: '玄绡护体，万邪不侵', fx: { def: 0.22, hp: 0.11 } },
  '碧波心法': { quality: 4, desc: '碧波荡漾，双修增益', fx: { hp: 0.18, love: 1.5 } },
  '拂柳诀': { quality: 4, desc: '拂柳如刀，攻守兼备', fx: { atk: 0.16, def: 0.11 } },
  '灵犀功': { quality: 4, desc: '灵犀一点，挂机助益', fx: { crit: 0.06, cdmg: 0.14, afk: 1.5 } },
  // ===== 金色(5) 稀有 · 7本 (藏宝阁可买; 属性碾压紫色, 另带玩法特效) =====
  '鸿运诀': { quality: 5, desc: '鸿运当头，奇遇连连', fx: { lucky: 2, atk: 0.26 } },
  '聚宝功': { quality: 5, desc: '财气护体，宝物自来', fx: { lucky: 2, hp: 0.3 } },
  '揽金诀': { quality: 5, desc: '纤手揽金，出手如风', fx: { rob: 1.8, atk: 0.3, crit: 0.06 } },
  '行运功': { quality: 5, desc: '行运加持，挂机翻倍', fx: { afk: 2, def: 0.26 } },
  '同心诀': { quality: 5, desc: '心有灵犀，双修情深', fx: { love: 1.8, hp: 0.3 } },
  '破晓诀': { quality: 5, desc: '破晓如神，突破大增', fx: { break: 8, atk: 0.28 } },
  '金缕诀': { quality: 5, desc: '金缕护体，攻守兼备', fx: { def: 0.3, hp: 0.15, crit: 0.05 } },
  // ===== 红色(6) 顶级 · 7本 (藏宝阁不售,秘境掉落; 属性碾压金色) =====
  '红莲神功': { quality: 6, desc: '红莲焚天，攻击无双', fx: { atk: 0.45, cdmg: 0.22 } },
  '凤凰涅槃诀': { quality: 6, desc: '浴火重生，情缘再续', fx: { hp: 0.45, def: 0.15, love: 1.8 } },
  '鸾音真诀': { quality: 6, desc: '鸾音震世，破境如神', fx: { crit: 0.14, cdmg: 0.45, break: 8 } },
  '不灭玉身': { quality: 6, desc: '玉身不灭，肉身成圣', fx: { def: 0.45, hp: 0.22 } },
  '冥蝶手': { quality: 6, desc: '冥蝶夺财，杀人越货', fx: { rob: 2.5, atk: 0.28, crit: 0.08 } },
  '万象归元': { quality: 6, desc: '万象归元，道法自然', fx: { atk: 0.32, def: 0.22, hp: 0.15 } },
  '璇玑衍算': { quality: 6, desc: '璇玑在握，无所不利', fx: { lucky: 2.5, afk: 2.5, atk: 0.2, hp: 0.08 } },
  // ===== 彩色(7) 神级 · 1本 (太阴月华, 集全部功法效果并+20%) =====
  '太阴月华诀': { quality: 7, desc: '太阴之力，月华归一（集全部功法效果并+20%）', fx: { atk: 0.54, def: 0.54, hp: 0.54, crit: 0.17, cdmg: 0.54, lucky: 3, afk: 3, rob: 3, love: 2.2, break: 10 } },
  // ===== 傀儡术(品质7, 功法但只用于解锁傀儡阶位) =====
  '傀儡术下篇': { quality: 7, desc: '傀儡术下篇，学会后可打造并升级一、二阶傀儡', fx: {}, puppetChapter: 'lower', bound: true },
  '傀儡术中篇': { quality: 7, desc: '傀儡术中篇，学会后可升级三至五阶傀儡', fx: {}, puppetChapter: 'middle', bound: true },
  '傀儡术上篇': { quality: 7, desc: '傀儡术上篇，学会后可升级六、七阶傀儡', fx: {}, puppetChapter: 'upper', bound: true }
}

/** 是否绑定道具(不可搜刮/不可抢夺走): 模板标记 bound:true, 或彩虹武器(rainbow: 引用);
 *  以后新增绑定道具只需在对应模板(ITEM_TPL/EQUIP_TPL/GONGFA_TPL/MATERIAL_TPL)加 bound:true 即可 */
export function isBound (name) {
  if (!name) return false
  if (String(name).startsWith('rainbow:')) return true
  return !!(ITEM_TPL[name] && ITEM_TPL[name].bound) ||
    !!(EQUIP_TPL[name] && EQUIP_TPL[name].bound) ||
    !!(GONGFA_TPL[name] && GONGFA_TPL[name].bound) ||
    !!(MATERIAL_TPL[name] && MATERIAL_TPL[name].bound) ||
    !!(ARTIFACT_TPL[name] && ARTIFACT_TPL[name].bound)
}

/** 是否拥有定仙游；拥有状态用于触发万魂窟撤退与跨区传送两个被动。 */
export function hasDingxianyou (bag) {
  const artifact = bag && bag.artifacts && bag.artifacts.dingxianyou
  return !!artifact && artifact.owned !== false
}

/** 定仙游装备状态：只有装备后才提供生命+10%，其他被动不受此状态影响。 */
export function isDingxianyouEquipped (bag) {
  const artifact = bag && bag.artifacts && bag.artifacts.dingxianyou
  return hasDingxianyou(bag) && artifact.equipped === true
}

export function dingxianyouInfo () {
  return ARTIFACT_TPL['定仙游']
}

/** 功法购买价(灵石): 藏宝阁只售金(5)及以下; 红/彩不售返回0; 价格与同品质装备一致 */
export function gongfaPrice(name) {
  const q = GONGFA_TPL[name]?.quality || 0
  /* 与同品质装备价格一致: 白200/绿1000/蓝4000/紫12000; 金=金装价值中枢30000(金装藏宝阁2.5万~6万) */
  return [0, 200, 1000, 4000, 12000, 30000, 0, 0][q] || 0
}

/** 功法书出售价(灵石): 半价回收 */
export function gongfaSellPrice(name) {
  return Math.floor((gongfaPrice(name) || 0) / 2)
}

/** 功法效果文本 */
const FX_CN = {
  atk: v => `攻击+${Math.round(v * 100)}%`,
  def: v => `防御+${Math.round(v * 100)}%`,
  hp: v => `生命+${Math.round(v * 100)}%`,
  crit: v => `暴击+${Math.round(v * 100)}%`,
  cdmg: v => `爆伤+${Math.round(v * 100)}%`,
  lucky: v => `幸运掉落×${v}`,
  afk: v => `挂机收益×${v}`,
  rob: v => `抢劫灵石×${v}`,
  love: v => `双修好感×${v}`,
  break: v => `突破成功率+${v}%`
}

/** 功法效果文本(按固定顺序输出) */
export function fmtGongfaFx(fx) {
  if (!fx) return ''
  const parts = []
  for (const k of ['atk', 'def', 'hp', 'crit', 'cdmg', 'lucky', 'afk', 'rob', 'love', 'break']) {
    if (fx[k]) parts.push(FX_CN[k](fx[k]))
  }
  return parts.join('、') || '无加成'
}

/* ===== 功法存储(全局按用户,与丹药buff同构): 已学会集合 + 当前运转 ===== */
const gongfaKey = uid => `xujing:gongfa:${uid}`
const gongfaActiveKey = uid => `xujing:gongfa-active:${uid}`

/** 已学会功法集合(redis JSON对象 {name:true}) */
export async function getLearnedGongfa(uid) {
  try { return JSON.parse((await redis.get(gongfaKey(uid))) || '{}') } catch (err) { return {} }
}
export async function isGongfaLearned(uid, name) {
  return !!(await getLearnedGongfa(uid))[name]
}
export async function learnGongfa(uid, name) {
  const set = await getLearnedGongfa(uid)
  set[name] = true
  await redis.set(gongfaKey(uid), JSON.stringify(set))
}
/** 当前运转功法的效果对象(未运转返回null) */
export async function getGongfaFx(uid) {
  try {
    const active = await redis.get(gongfaActiveKey(uid))
    if (active && GONGFA_TPL[active]) return GONGFA_TPL[active].fx || {}
  } catch (err) { }
  return null
}
/** 运转/取消功法(传空则取消) */
export async function setActiveGongfa(uid, name) {
  if (name) await redis.set(gongfaActiveKey(uid), name)
  else await redis.del(gongfaActiveKey(uid))
}

/** 灵石交易税(20%): 所有交易/获得灵石扣20%税, 返回实际到账 */
export function afterTax(money) {
  return Math.floor((Number(money) || 0) * 0.8)
}

/** 五大地域宗门(为宗门系统铺垫): 中州(中心)/东海(东)/西域(西)/南疆(南)/北境(北) */
export const SECTS = [
  { name: '中州', pos: '中心' },
  { name: '东海', pos: '东' },
  { name: '西域', pos: '西' },
  { name: '南疆', pos: '南' },
  { name: '北境', pos: '北' }
]
/** 随机返回一个地域宗门(税收上缴对象) */
export function taxSect() {
  return SECTS[Math.floor(Math.random() * SECTS.length)].name
}

/** 宗门宝库装备贡献价：品质1~7；普通弟子通过灵石上供可逐步负担 */
export const VAULT_EQUIP_CONTRIB = [0, 20, 40, 80, 120, 180, 260, 360]
export function vaultEquipContrib(name) {
  const q = EQUIP_TPL[name]?.quality || 0
  return VAULT_EQUIP_CONTRIB[q] || 0
}

/** 装备价格(灵石): 器阁只出售紫(4)及以下,黄(5)/红(6)需其他途径获取 */
export function equipPrice(name) {
  const q = EQUIP_TPL[name]?.quality || 0
  return [0, 200, 1000, 4000, 12000, 0, 0][q] || 0
}

/** 装备出售价(灵石)【出售一律打折】: 红(6)不可售返回0; 紫及以下=器阁买入价5折; 黄(5)=属性价值折价(不同属性价格不同) */
export function equipSellPrice(name, attr) {
  const t = EQUIP_TPL[name]
  if (!t) return 0
  const q = t.quality || 0
  if (q >= 6) return 0//红色不可出售
  if (q >= 5) return Math.max(10000, Math.round(attrPower(attr || {}) * 50))//黄装: 保底1w, 属性越好越贵(低于红但远超紫)
  return Math.floor((equipPrice(name) || 0) / 2)//紫及以下: 器阁买入价5折
}

/** 道具获得方式(未知则返回'未知'): 丹药-丹阁/配方台, 装备-器阁/新手礼包, 黄红暂未知 */
export function getItemSource(name) {
  if (ARTIFACT_TPL[name]) return `${itemIcon('神游蛊')}神游蛊×1 + ${itemIcon('玄阴玉')}玄阴玉×5 + ${itemIcon('镇魂晶')}镇魂晶×5 + ${itemIcon('血煞髓')}血煞髓×5 合成`
  if (name === '无主幽魂') return '万魂窟探索中随机遇到幽魂 · 回复1吸收获得'
  if (MATERIAL_TPL[name]) {
    if (name === '残丹') return '仅遗蜕秘境(公开/专属)探索掉落 · 5个可#合成妖丹随机凝成1颗随机品质妖丹'
    if (['天衍阵纹', '乾坤阵晶', '太虚阵砂', '九幽阵髓'].includes(name)) return '遗蜕秘境/每日秘境/藏宝阁洗劫掉落（红色阵法材料）'
    if (isYaodan(name)) return '世界Boss掉落（每只Boss掉1枚，归伤害最高者；1/2/3/4档Boss分别出1~3/2~4/3~6/6~7阶） · 或5个残丹#合成妖丹随机凝练'
    if (name === '傀儡被动晶核') return '分解傀儡固定返还1枚 · #傀儡晶核 查看'
    if (name === '功法残卷') return '分解重复傀儡术篇章获得 · #分解傀儡术 <篇章> [数量]'
    return '虚境秘境探索(药材/矿物)'
  }
  if (ITEM_TPL[name]) {
    if (name === '修为丹') return '丹阁购买500灵石 · 新手礼包 · 虚境秘境'
    if (name === '破障丹') return '丹阁购买1000灵石 · 新手礼包 · 虚境秘境'
    if (name === '魂石') return '魔窟商人兑换(灵石/材料/丹药/功法书) · #魔窟商人'
    if (name === '还魂丹') return `配方台合成(${itemIcon('玄阴玉')}玄阴玉×2+${itemIcon('镇魂晶')}镇魂晶×1+${itemIcon('血煞髓')}血煞髓×1+${itemIcon('云裳仙蕊')}云裳仙蕊×1) · 魔窟商人兑换(11~12格)`
    if (name === '仙帝丹') return `配方台合成(${itemIcon('云裳仙蕊')}云裳仙蕊×10 + 五种药材各×100 + ${itemIcon('万魂帝晶')}万魂帝晶×10 + 一至七阶妖丹共×28 + 30万灵石) · 玩家不可服用`
    if (name === '登仙令') return '世界Boss掉落 · 击杀后 #抢夺登仙令 夺得(同大区)'
    if (name === '惊鸿丹') return `配方台合成(${itemIcon('望舒花')}望舒花×1+${itemIcon('星霜草')}星霜草×2)`
    if (name === '灵宝盒') return '幻境试炼结算奖励(每日前5名5~1个 · 每周结算1~20个)'
    if (name === '聚宝丹') return `配方台合成(${itemIcon('凤栖花')}凤栖花×1+${itemIcon('青鸾草')}青鸾草×2)`
    if (name === '灵犀丹') return `配方台合成(${itemIcon('月华芝')}月华芝×1+${itemIcon('星霜草')}星霜草×2)`
    if (name === '行运丹') return `配方台合成(${itemIcon('望舒花')}望舒花×1+${itemIcon('月华芝')}月华芝×1)`
    if (name === '同心丹') return `配方台合成(${itemIcon('月华芝')}月华芝×1+${itemIcon('青鸾草')}青鸾草×2)`
    if (name === '玉甲丹') return `配方台合成(${itemIcon('凤栖花')}凤栖花×1+${itemIcon('月华芝')}月华芝×1)`
    if (name === '凝露丹') return `配方台合成(${itemIcon('凤栖花')}凤栖花×1+${itemIcon('星霜草')}星霜草×2)`
    if (name === '慧心丹') return `配方台合成(${itemIcon('凤栖花')}凤栖花×1+${itemIcon('望舒花')}望舒花×1)`
    if (name === '摄魂丹') return `配方台合成(${itemIcon('望舒花')}望舒花×1+${itemIcon('青鸾草')}青鸾草×2)`
    if (name === '神游蛊') return '南疆每日约现身一次、时辰不定 · #抓捕神游蛊'
    if (name === '万阵核心') return `四种红色阵法材料各1（${ARRAY_MATS.map(n => `${itemIcon(n)}${n}`).join('、')}） + 30万灵石合成`
    if (name === '遗蜕古钥') return '世界Boss/洗劫藏宝阁/每日秘境/万魂窟彩级概率掉落(每日每群最多2把)'
  }
  const t = EQUIP_TPL[name]
  if (GONGFA_TPL[name]) {
    if (GONGFA_TPL[name].puppetChapter) return '秘境探索小事件成功奖励或成功屠皇城时的稀有掉落'
    const gq = GONGFA_TPL[name].quality
    return gq <= 5 ? `藏宝阁购买${gongfaPrice(name)}灵石` : '虚境秘境极低概率掉落'
  }
  if (!t) return '未知'
  const parts = []
  if (t.quality <= 4) parts.push(`器阁购买${equipPrice(name)}灵石`)
  if (STARTER_ITEMS.includes(name)) parts.push('新手礼包')
  return parts.length ? parts.join(' · ') : '未知'
}

function normalizeBagCounts (bag) {
  let changed = false
  for (const [name, raw] of Object.entries((bag && bag.items) || {})) {
    if (typeof raw === 'number') {
      const count = Math.max(0, Math.floor(raw))
      if (count <= 0) delete bag.items[name]
      else bag.items[name] = { count, attr: getItemAttr(bag, name) }
      changed = true
      continue
    }
    if (!raw || typeof raw !== 'object') {
      delete bag.items[name]
      changed = true
      continue
    }
    const count = Math.max(0, Math.floor(Number(raw.count) || 0))
    if (raw.count !== count) { raw.count = count; changed = true }
    if (Array.isArray(raw.list)) {
      const before = raw.list
      const normalized = before.map(g => {
        const item = (g && typeof g === 'object') ? g : {}
        return { ...item, count: Math.max(0, Math.floor(Number(item.count) || 0)) }
      }).filter(g => g.count > 0)
      if (normalized.length !== before.length || normalized.some((g, i) => g.count !== Number(before[i].count))) changed = true
      raw.list = normalized
      const listCount = normalized.reduce((sum, g) => sum + g.count, 0)
      if (raw.count !== listCount) { raw.count = listCount; changed = true }
    }
    if (raw.count <= 0) { delete bag.items[name]; changed = true }
  }
  return changed
}

/** 修复已穿装备状态: 补全 equippedAttr(缺槽位), 并把穿上的那1件从背包扣回(分组安全), 返回是否变更 */
function repairEquippedState (bag, removeFromItems = true) {
  if (!bag || typeof bag !== 'object') return false
  let changed = false
  bag.equipped = bag.equipped || {}
  if (!bag.equippedAttr || typeof bag.equippedAttr !== 'object') { bag.equippedAttr = {}; changed = true }
  const its = bag.items || {}
  for (const [part, name] of Object.entries(bag.equipped)) {
    if (!name || !EQUIP_TPL[name]) continue
    if (bag.equippedAttr[part]) continue // 已记录(含空属性对象)不重复迁移
    const it = its[name]
    const attr = (it && ((it.list && it.list.length) ? it.list[0].attr : it.attr)) || getItemAttr(bag, name)
    bag.equippedAttr[part] = attr
    /* 把穿上的那1件从背包扣回(分组安全, 保持 count 与 list 一致) */
    if (removeFromItems && it && (it.count || 0) > 0) {
      consumeBagItem(bag, name, 1)
    }
    changed = true
  }
  return changed
}

/* ================= 背包单实例缓存(防并发覆盖丢装备) =================
 * 根因: 两条指令对同一玩家"读背包→改→存", 各自读到旧快照, 后保存的用旧数据覆盖新状态,
 *       导致装备/材料凭空消失(如 铸造特殊彩武 + 打造万魂幡 + 自动穿戴 同时进行时)。
 * 方案: 同一 (gid,uid) 的背包对象在进程内全局唯一(getBag 返回同一引用),
 *       所有读改写都落在同一对象上, saveBag 把它写盘 → 变更天然累积, 不存在旧快照覆盖。
 * 代价: 需要进程内持有各玩家背包(每档约1~3KB, 数百玩家仅数MB), 换取读改写原子性。
 */
export function ensureBagShape (bag, options = {}) {
  if (!bag || typeof bag !== 'object') return false
  let changed = false
  if (!bag.items || typeof bag.items !== 'object' || Array.isArray(bag.items)) {
    bag.items = {}
    changed = true
  }
  if (!bag.equipped || typeof bag.equipped !== 'object' || Array.isArray(bag.equipped)) {
    bag.equipped = {}
    changed = true
  }
  for (const part of Object.keys(PARTS)) {
    if (bag.equipped[part] === undefined) {
      bag.equipped[part] = ''
      changed = true
    }
  }
  if (!bag.equippedAttr || typeof bag.equippedAttr !== 'object' || Array.isArray(bag.equippedAttr)) {
    bag.equippedAttr = {}
    changed = true
  }
  if (!bag.artifacts || typeof bag.artifacts !== 'object' || Array.isArray(bag.artifacts)) {
    bag.artifacts = {}
    changed = true
  }
  if (normalizeBagCounts(bag)) changed = true
  /* 傀儡被动晶核: 不占背包物品位, 从 bag.items 迁出到 bag.artifacts.puppetCores(数字), #傀儡晶核 查看
   * (名字与 puppet_data.js 的 PUPPET_PASSIVE_CORE 保持一致) */
  const coreLegacy = bag.items?.['傀儡被动晶核']
  if (coreLegacy) {
    const n = Math.max(0, Math.floor(Number(coreLegacy?.count ?? coreLegacy) || 0))
    delete bag.items['傀儡被动晶核']
    bag.artifacts.puppetCores = Math.max(0, (Number(bag.artifacts.puppetCores) || 0)) + n
    changed = true
  }
  for (const [name, raw] of Object.entries(bag.items)) {
    if (!EQUIP_TPL[name] || !raw || typeof raw !== 'object') continue
    const fallback = () => getItemAttr(null, name)
    if (Array.isArray(raw.list) && raw.list.length) {
      for (const group of raw.list) {
        if (!group.attr || typeof group.attr !== 'object') {
          group.attr = raw.attr && typeof raw.attr === 'object' ? { ...raw.attr } : fallback()
          changed = true
        }
      }
      const first = raw.list[0] && raw.list[0].attr
      if ((!raw.attr || typeof raw.attr !== 'object') && first) {
        raw.attr = { ...first }
        changed = true
      }
    } else if (!raw.attr || typeof raw.attr !== 'object') {
      raw.attr = fallback()
      changed = true
    }
  }
  if (repairEquippedState(bag, options.removeEquippedFromItems !== false)) changed = true
  return changed
}

const _bagCache = new Map()
const _bagKey = (uid, gid) => `${gid}|${String(uid)}`

/** 测试/管理用: 清空单实例缓存(下次 getBag 重新读盘) */
export function resetBagCache() {
    _bagCache.clear()
}

/** 读取背包(gid=群号, 默认 global; 该群首次访问自动迁移旧全局档; 不存在则创建并发放新手装备) */
export function getBag(user_id, gid = 'global') {
    const key = _bagKey(user_id, gid)
    const hit = _bagCache.get(key)
    if (hit) return hit
    const dir = `${bagpath}/${gid}`
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = `${dir}/${user_id}.json`
    if (fs.existsSync(file)) {
        let bag
        try {
            bag = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch (err) {
            throw new Error(`[虚境]背包存档读取失败，已停止覆盖：${file}`)
        }
        let changed = false
        if (ensureBagShape(bag)) changed = true
        _bagCache.set(key, bag)
        if (changed) saveBag(user_id, bag, gid)
        return bag
    }
    // 兼容旧全局档: 该群首次访问自动迁移
    if (gid !== 'global') {
        const gfile = `${bagpath}/global/${user_id}.json`
        if (fs.existsSync(gfile)) {
            try {
                const old = JSON.parse(fs.readFileSync(gfile, 'utf8'))
                ensureBagShape(old)
                _bagCache.set(key, old)
                writeJsonAtomic(file, old)
                return old
            } catch (err) {
                throw new Error(`[虚境]旧全局背包存档读取失败，已停止覆盖：${gfile}`)
            }
        }
    }
    const bag = {
        items: {},
        equipped: { weapon: '', helmet: '', chest: '', pants: '', shoes: '', ring: '' },
        equippedAttr: {},
        artifacts: {}
    }
    for (const name of STARTER_ITEMS) {
        bag.items[name] = { count: 1, attr: getItemAttr(bag, name) }
    }
    // 新手礼包附赠丹药(获取方式后续补充)
    bag.items['修为丹'] = { count: 3 }
    bag.items['破障丹'] = { count: 2 }
    autoEquipBest(bag)//新手礼包自动穿好
    _bagCache.set(key, bag)
    writeJsonAtomic(file, bag)
    return bag
}

/** 保存背包(写盘; 由于同一玩家背包是单实例, 本次写入天然包含此前所有未覆盖的变更) */
export function saveBag(user_id, bag, gid = 'global') {
    const dir = `${bagpath}/${gid}`
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    _bagCache.set(_bagKey(user_id, gid), bag)
    writeJsonAtomic(`${dir}/${user_id}.json`, bag)
}

/** 计算穿戴总属性与战力 */
export function getTotalAttr(bag) {
  let atk = 0, def = 0, hp = 0
  const equipped = bag.equipped || {}
  const equippedAttr = bag.equippedAttr || {}
  for (const [slot, name] of Object.entries(equipped)) {
    if (name && EQUIP_TPL[name]) {
      const ea = equippedAttr[slot]
      const attr = (ea && Object.keys(ea).length) ? ea : getItemAttr(bag, name)
      atk += attr.atk || 0
      def += attr.def || 0
      hp += attr.hp || 0
    } else if (isRainbowRef(name)) {
      const w = getRainbowByRef(bag, name)
      if (w) atk += rainbowAtk(w)
    }
  }
  const wanhun = bag && bag.artifacts && bag.artifacts.wanhun
  if (wanhun && wanhun.equipped) atk += Math.max(0, Math.floor(Number(wanhun.attack) || 0))
  return { atk, def, hp, hpPct: isDingxianyouEquipped(bag) ? 0.1 : 0, power: atk * 2 + def * 2 + Math.floor(hp / 5) }
}

/** 穿上装备(从背包扣1件对应属性组, 记录穿上的属性到 equippedAttr; 返回穿的属性, 背包不足返回null)
 *  可选 wantAttr: 指定穿哪组属性(同名多属性时取最优组); 不传则默认取第一组 */
export function equipTake(bag, part, name, wantAttr = null) {
  if (!name || !EQUIP_TPL[name] || isRainbowRef(name)) return null
  const items = bag.items || {}
  const it = items[name]
  if (!it || (it.count || 0) < 1) return null
  bag.equipped = bag.equipped || {}
  bag.equippedAttr = bag.equippedAttr || {}
  let attr = null
  if (wantAttr && Object.keys(wantAttr).length && it.list && it.list.length) {
    /* 指定属性组: 从匹配组扣1(找不到说明该组已被穿过/不存在, 不穿) */
    const g = it.list.find(x => JSON.stringify(x.attr) === JSON.stringify(wantAttr) && (x.count || 0) > 0)
    if (!g || (g.count || 0) < 1) return null
    g.count -= 1
    attr = g.attr
    if (g.count <= 0) it.list = it.list.filter(x => x !== g)
  } else if (it.list && it.list.length) {
    /* 未指定: 默认取第一组 */
    attr = it.list[0].attr
    it.list[0].count -= 1
    if (it.list[0].count <= 0) it.list.shift()
    if (!it.list.length) delete it.list
  } else {
    attr = it.attr || {}
  }
  it.count -= 1
  if (it.count <= 0) {
    delete items[name]
  } else {
    /* 更新默认属性为剩余第一组(修复陈旧 attr 导致显示/排序错乱) */
    it.attr = (it.list && it.list.length) ? it.list[0].attr : (it.attr || {})
  }
  bag.equipped[part] = name
  bag.equippedAttr[part] = attr
  return attr
}

/** 脱下装备(把穿的那件按原属性还回背包, 清 equippedAttr; 彩虹/非装备只清穿着不还回) */
export function unequipReturn(bag, part) {
  const name = bag.equipped && bag.equipped[part]
  if (!name) return null
  const attr = (bag.equippedAttr && bag.equippedAttr[part]) || null
  bag.equipped[part] = ''
  if (bag.equippedAttr) bag.equippedAttr[part] = null
  if (!EQUIP_TPL[name] || isRainbowRef(name)) return null
  const items = bag.items || {}
  if (attr && Object.keys(attr).length) {
    if (!items[name]) items[name] = { count: 0, attr }
    const it = items[name]
    if (!it.list) it.list = [{ count: it.count || 0, attr: it.attr || attr }]
    const g = it.list.find(x => JSON.stringify(x.attr) === JSON.stringify(attr))
    if (g) g.count += 1
    else it.list.push({ count: 1, attr })
    it.count = (it.count || 0) + 1
    it.attr = it.list[0].attr
  } else {
    const it = items[name]
    if (it) {
      /* 无记录属性时取背包里该装备的既有属性, 避免 q7 每次随机且让 count 与 list 脱节 */
      const fallback = (it.list && it.list.length) ? it.list[0].attr : (it.attr || {})
      const a = (fallback && Object.keys(fallback).length) ? fallback : getItemAttr(bag, name)
      if (it.list && it.list.length) {
        const g = it.list.find(x => JSON.stringify(x.attr) === JSON.stringify(a))
        if (g) g.count += 1
        else it.list.push({ count: 1, attr: a })
        it.count = (it.count || 0) + 1
        it.attr = it.list[0].attr
      } else {
        it.count = (it.count || 0) + 1
        if (!it.attr || !Object.keys(it.attr).length) it.attr = a
      }
    } else {
      items[name] = { count: 1, attr: getItemAttr(bag, name) }
    }
  }
  return name
}

/** 每个小境界约100战力;装备最多等效3个大境界(12小境界) */
const POWER_PER_LEVEL = 100
const MAX_EQUIP_LEVEL = 12

/** 装备战力换算为等效境界等级(封顶3大境界) */
export function getEquipLevel(bag) {
  const { power } = getTotalAttr(bag)
  return Math.min(MAX_EQUIP_LEVEL, Math.floor(power / POWER_PER_LEVEL))
}

/** 决斗用装备等效等级(带±2随机浮动,保留0~12上限) */
export function getEquipLevelRand(bag) {
  const base = getEquipLevel(bag)
  const min = Math.max(0, base - 2)
  const max = Math.min(MAX_EQUIP_LEVEL, base + 2)
  return Math.round(min + Math.random() * (max - min))
}

/** 境界战力差: 大境界权重更高(每大境界=6个小境界),避免低境界靠装备暴打高境界 */
export function realmPowerDiff(a, b) {
  a = Number(a) || 0
  b = Number(b) || 0
  const ra = Math.floor(a / 4), rb = Math.floor(b / 4)
  return (a % 4 - b % 4) + (ra - rb) * 6
}

/** 格式化单件装备描述 */
export function fmtEquip(name, count = 1, attr) {
  const t = EQUIP_TPL[name]
  if (!t) return ''
  const q = QUALITY[t.quality]
  const text = attr ? fmtAttr(attr) : ''
  return `${q.icon}${name}（${PARTS[t.type]}）${text}${count > 1 ? ` ×${count}` : ''}`
}

/** 装备综合评分(用于同品质排序) */
function equipScore(attr) {
  return attrPower(attr)
}

/** 自动穿上背包中每个部位最好的装备,返回本次新穿上的装备名列表(穿上扣背包1件, 旧装备还回背包)
 *  修复: ①候选包含当前穿着的(防止已穿最好的却被背包次品替换=一键降级/来回换)
 *  ②同名多属性按最优属性组穿戴(不再固定取第一组) */
export function autoEquipBest(bag) {
  bag.equipped = bag.equipped || {}
  bag.equippedAttr = bag.equippedAttr || {}
  const items = bag.items || {}
  const changed = []
  for (const part of Object.keys(PARTS)) {
    /* 彩虹武器已装备时,不再自动替换该部位(成长型神兵由玩家手动穿脱) */
    if (part === 'weapon' && isRainbowRef(bag.equipped[part])) continue
    /* 候选 = 背包该部位每件(按属性分组) + 当前穿着(已扣背包的那件) */
    const options = []
    for (const n of Object.keys(items)) {
      const t = EQUIP_TPL[n]
      if (!t || t.type !== part) continue
      const it = items[n]
      const groups = (it && Array.isArray(it.list) && it.list.length)
        ? it.list.map(g => ({ name: n, attr: g.attr || {}, count: g.count }))
        : [{ name: n, attr: (it && it.attr) || {}, count: it ? it.count : 0 }]
      for (const g of groups) if ((g.count || 0) > 0) options.push(g)
    }
    /* 当前穿着参与比较: 防止已穿最好的却被背包次品替换(一键降级/来回换) */
    const curName = bag.equipped[part]
    let cur = null
    if (curName && EQUIP_TPL[curName]) {
      const ea = bag.equippedAttr && bag.equippedAttr[part]
      cur = { name: curName, attr: (ea && Object.keys(ea).length) ? ea : getItemAttr(bag, curName), count: 1, equipped: true }
      options.push(cur)
    }
    if (!options.length) continue
    options.sort((a, b) => {
      const qa = EQUIP_TPL[a.name].quality, qb = EQUIP_TPL[b.name].quality
      if (qb !== qa) return qb - qa
      const pa = attrPower(a.attr), pb = attrPower(b.attr)
      if (pb !== pa) return pb - pa
      /* 全等时优先当前穿着, 避免无意义换装 */
      if (a.equipped && !b.equipped) return -1
      if (b.equipped && !a.equipped) return 1
      return 0
    })
    const best = options[0]
    /* 已是最优穿着 → 无需换 */
    if (best === cur) continue
    /* 换装: 先尝试扣除目标装备，成功后再归还旧装备；失败时保留原穿戴，避免装备栏被清空。
     * 归还旧装备包在 try/finally 里: 即使归还过程异常, 装备栏也必然落回新装备, 旧装备尽量还回 */
    const oldName = curName
    const oldAttr = cur && cur.attr
    const attr = equipTake(bag, part, best.name, best.attr)
    if (!attr) continue
    if (oldName) {
      const newName = bag.equipped[part]
      const newAttr = bag.equippedAttr[part]
      try {
        bag.equipped[part] = oldName
        bag.equippedAttr[part] = oldAttr
        unequipReturn(bag, part)
      } finally {
        bag.equipped[part] = newName
        bag.equippedAttr[part] = newAttr
      }
    }
    changed.push(best.name)
  }
  return changed
}

/** 将物品加入已加载的背包,返回自动穿戴产生的变更；调用方负责保存 */
export function addItemToBag (bag, name, count = 1, attr = null, autoEquip = true) {
  count = Math.floor(Number(count) || 0)
  if (count <= 0 || !bag || (!EQUIP_TPL[name] && !ITEM_TPL[name] && !MATERIAL_TPL[name] && !GONGFA_TPL[name])) return []
  /* 傀儡被动晶核是法宝专用计数，不占普通背包；避免缓存命中时重新写回 items。 */
  if (name === '傀儡被动晶核') {
    bag.artifacts = bag.artifacts || {}
    bag.artifacts.puppetCores = Math.max(0, Math.floor(Number(bag.artifacts.puppetCores) || 0)) + count
    return []
  }
  bag.items = bag.items || {}
  const tpl = EQUIP_TPL[name]
  const isEquip = !!tpl
  /* 黄/红/彩装备未指定属性时每次重新随机(不同属性分组存); 紫及以下用模板固定值 */
  const isRand = isEquip && (tpl.quality || 0) > 4
  const a = attr || (isRand
    ? rollEquipAttr(tpl.type, tpl.quality)
    : ((bag.items[name] && bag.items[name].attr) || getItemAttr(bag, name)))
  if (!bag.items[name] || typeof bag.items[name] !== 'object') {
    const oldCount = Number(bag.items[name]) || 0
    bag.items[name] = { count: oldCount, attr: a }
  }
  const it = bag.items[name]
  if (isEquip) {
    // 装备: 按属性分组存储；新建物品不保留零数量占位组
    if (!it.list) it.list = it.count > 0 ? [{ count: it.count, attr: it.attr }] : []
    else it.list = it.list.filter(x => x && (x.count || 0) > 0)
    /* 兼容异常: list 被清空但 count 仍 > 0 时, 先把存量重建为分组, 避免 count 与 list 脱节导致下次读取被清掉 */
    if (!it.list.length && it.count > 0) {
      it.list = [{ count: it.count, attr: it.attr || a }]
    }
    const g = it.list.find(x => JSON.stringify(x.attr) === JSON.stringify(a) && (x.count || 0) > 0)
    if (g) g.count += count
    else it.list.push({ count, attr: a })
    it.count += count
    it.attr = it.list[0].attr//默认取第一组
  } else {
    it.count += count
  }
  return autoEquip && isEquip ? autoEquipBest(bag) : []
}

/** 获得物品:加入背包并自动穿上最优装备(手动脱下不受影响,仅获得时触发)
 *  同名装备属性不同时按属性分组存储(list), 供赠送/上架时按编号选择 */
export function addItem(user_id, name, count = 1, attr = null, gid = 'global') {
  count = Math.floor(Number(count) || 0)
  if (count <= 0) return null
  if (!EQUIP_TPL[name] && !ITEM_TPL[name] && !MATERIAL_TPL[name] && !GONGFA_TPL[name]) return null
  const bag = getBag(user_id, gid)
  const changed = addItemToBag(bag, name, count, attr, true)
  saveBag(user_id, bag, gid)
  return { bag, changed }
}

/** 从已加载的背包消耗物品,成功返回true; 调用方负责保存 */
export function consumeBagItem (bag, name, count = 1, attr = null) {
  count = Math.floor(Number(count) || 0)
  if (count <= 0 || !bag || !bag.items) return false
  const it = bag.items[name]
  if (!it || it.count < count) return false
  if (attr && it.list) {
    const g = it.list.find(x => JSON.stringify(x.attr) === JSON.stringify(attr) && (x.count || 0) >= count)
    if (!g) return false
    g.count -= count
    it.count -= count
    if (g.count <= 0) it.list = it.list.filter(x => x !== g)
    if (it.list.length) it.attr = it.list[0].attr
    if (it.count <= 0) delete bag.items[name]
  } else if (it.list) {
    // attr 未指定但有分组: 从各组按序扣减, 保持 list 总数与 count 一致
    const available = it.list.reduce((sum, g) => sum + Math.max(0, Number(g.count) || 0), 0)
    if (available < count) return false
    let remain = count
    for (const g of it.list) {
      if (remain <= 0) break
      const take = Math.min(g.count, remain)
      g.count -= take
      remain -= take
    }
    it.count -= count
    it.list = it.list.filter(g => g.count > 0)
    if (it.list.length) it.attr = it.list[0].attr
    else delete bag.items[name]
  } else {
    it.count -= count
    if (it.count <= 0) delete bag.items[name]
  }
  return true
}

/** 消耗道具(从背包扣除),不足返回false; 传 attr 时按属性分组扣(装备用) */
export function consumeItem(user_id, name, count = 1, attr = null, gid = 'global') {
  const bag = getBag(user_id, gid)
  if (!consumeBagItem(bag, name, count, attr)) return false
  saveBag(user_id, bag, gid)
  return true
}

/* ---------- 遗蜕古钥: 每日每群上限2把, 产出概率与"彩色"同级 ---------- */
export const SECRET_KEY = '遗蜕古钥'
export const ARRAY_CORE = '万阵核心'
const SECRET_KEY_DAILY = 2
const SECRET_KEY_CHANCE = 0.01 // 每次产出口概率1%(与彩色同级)
const localSecretKeyCounts = new Map()
function secretKeyDate () {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function issueLocalSecretKey (gid, uid, date, chance) {
  const key = `${gid}:${date}`
  const used = localSecretKeyCounts.get(key) || 0
  if (used >= SECRET_KEY_DAILY || Math.random() >= chance) return false
  localSecretKeyCounts.set(key, used + 1)
  addItem(uid, SECRET_KEY, 1, null, gid)
  return true
}
/** 尝试产出遗蜕古钥: 每日每群上限2把; 命中则发到玩家背包并返回 true */
export async function tryGiveSecretKey (gid, uid, chance = SECRET_KEY_CHANCE) {
  const date = secretKeyDate()
  const key = `xujing:realm-key:${gid}:${date}`
  try {
    if (Math.random() >= chance) return false
    if (typeof redis === 'undefined' || typeof redis.incr !== 'function') return issueLocalSecretKey(gid, uid, date, 1)
    const next = Number(await redis.incr(key)) || 0
    if (next > SECRET_KEY_DAILY) { try { await redis.decr(key) } catch (err) {} ; return false }
    try { await redis.expire(key, 36 * 3600) } catch (err) {}
    addItem(uid, SECRET_KEY, 1, null, gid)
    return true
  } catch (err) {
    /* Redis 暂不可用时仍遵守本进程内每日上限, 不静默吞掉已发放结果 */
    return issueLocalSecretKey(gid, uid, date, 1)
  }
}
/** 查询某群今日已产出的古钥数量 */
export async function secretKeyToday (gid) {
  try { return Number(await redis.get(`xujing:realm-key:${gid}:${secretKeyDate()}`)) || 0 } catch (err) { return 0 }
}

/** 消耗1枚万阵核心; 所有未来阵法入口统一调用此函数 */
export function consumeArrayCore (user_id, gid = 'global') {
  return consumeItem(user_id, ARRAY_CORE, 1, null, gid)
}

/** 查询是否有万阵核心 */
export function hasArrayCore (user_id, gid = 'global') {
  const bag = getBag(user_id, gid)
  return Number(bag.items?.[ARRAY_CORE]?.count) >= 1
}

/** 背包装备可展示条目: 每件展开, 不修改背包状态 */
export function getBagEquipEntries (bag) {
  const entries = []
  for (const [name, it] of Object.entries((bag && bag.items) || {})) {
    if (!EQUIP_TPL[name] || !it || typeof it !== 'object') continue
    const rawGroups = Array.isArray(it.list) && it.list.length
      ? it.list
      : [{ count: it.count, attr: it.attr }]
    for (const group of rawGroups) {
      const count = Math.max(0, Math.floor(Number(group && group.count) || 0))
      if (!count) continue
      const attr = (group && group.attr) || (it.attr || {})
      for (let i = 0; i < count; i++) entries.push({ name, attr })
    }
  }
  return entries
}

/** 某道具的属性分组列表 [{count, attr}] (无分组时返回单一组) */
export function getItemGroups(user_id, name, gid = 'global') {
  const bag = getBag(user_id, gid)
  const it = bag.items[name]
  if (!it) return []
  if (it.list && it.list.length) return it.list.map(x => ({ count: x.count, attr: x.attr }))
  return [{ count: it.count, attr: it.attr || {} }]
}

/* ================= 彩虹武器(成长型绑定神兵) =================
 * 铸造: 6 个彩色药材(云裳仙蕊) + 1 件红武器(品质6)
 * 成长: 每1小时成长一次(每把独立按 bornAt 计时), 1年(8760小时)后攻击随机达到2000~3000, 且全局不超过3000
 * 绑定: 只存 bag.rainbows(不在 bag.items), 交易/赠送/出售/拍卖天然无法操作
 */
export const RAINBOW_HERB = '云裳仙蕊'
export const RAINBOW_HERB_NEED = 6
export const RAINBOW_GROW_HOURS = 365 * 24 // 1年 = 8760小时
export const RAINBOW_MAX_MULTIPLIER = 10
export const RAINBOW_MAX_ATK = RAND_ATK[6][1] * RAINBOW_MAX_MULTIPLIER // 红武攻击上限300 × 10
export const RAINBOW_CRAFT_MIN_ATK = 2000
export const RAINBOW_CRAFT_MAX_ATK = 3000
const RAINBOW_PREFIX = 'rainbow:'

/** 将彩虹武器攻击限制在合法范围内(兼容历史异常存档) */
function clampRainbowAtk (value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(RAINBOW_MAX_ATK, Math.max(0, n))
}

/** 彩虹武器存档中的成长上限(历史上限超过3000时按新规则封顶) */
export function rainbowMaxAtk (w) {
  if (!w) return 0
  const base = clampRainbowAtk(w.baseAtk)
  const rawMax = Number(w.maxAtk)
  const max = Number.isFinite(rawMax) ? rawMax : base
  return Math.max(base, clampRainbowAtk(max))
}

/** 彩虹武器当前攻击(按已过小时数计算, 每把独立计时, 每1小时成长一次) */
export function rainbowAtk (w) {
  if (!w) return 0
  const base = clampRainbowAtk(w.baseAtk)
  const max = rainbowMaxAtk(w)
  if (max <= base) return base
  const hours = Math.max(0, Math.floor((Date.now() - (w.bornAt || Date.now())) / 3600000))
  const ratio = Math.min(1, hours / RAINBOW_GROW_HOURS)
  return Math.min(max, Math.round(base + (max - base) * ratio))
}
/** 彩虹武器单件战力(武器只有攻击) */
export function rainbowPower (w) {
  return rainbowAtk(w) * 2
}
/** 是否彩虹武器槽位引用(rainbow:<id>) */
export function isRainbowRef (name) {
  return typeof name === 'string' && name.indexOf(RAINBOW_PREFIX) === 0
}
/** 按槽位引用取背包里的彩虹武器 */
export function getRainbowByRef (bag, ref) {
  if (!isRainbowRef(ref)) return null
  return ((bag && bag.rainbows) || []).find(x => x && x.id === ref.slice(RAINBOW_PREFIX.length)) || null
}
/** 彩虹武器展示文本 */
export function fmtRainbow (w) {
  if (!w) return ''
  const cur = rainbowAtk(w)
  const max = rainbowMaxAtk(w)
  const hours = Math.max(0, Math.floor((Date.now() - (w.bornAt || Date.now())) / 3600000))
  const pct = Math.min(100, Math.round(hours / RAINBOW_GROW_HOURS * 1000) / 10)
  return `🌈【${w.name}】攻击+${cur}（成长${pct}%，满成长+${max}）`
}
/** 彩虹武器信息文本(多行) */
export function rainbowInfoLines (bag) {
  const arr = (bag && bag.rainbows) || []
  if (!arr.length) return ['你还没有彩虹神兵~ 集齐 6 个 🌈云裳仙蕊 + 1 件红武器后 #铸造特殊彩武']
  const equippedRefs = Object.values((bag && bag.equipped) || {})
  const lines = []
  for (const w of arr) {
    const cur = rainbowAtk(w)
    const max = rainbowMaxAtk(w)
    const base = Math.min(max, clampRainbowAtk(w.baseAtk))
    const hours = Math.max(0, Math.floor((Date.now() - (w.bornAt || Date.now())) / 3600000))
    const remainH = Math.max(0, RAINBOW_GROW_HOURS - hours)
    const pct = Math.min(100, Math.round(hours / RAINBOW_GROW_HOURS * 1000) / 10)
    lines.push(`🌈【${w.name}】${equippedRefs.includes('rainbow:' + w.id) ? '（已装备）' : '（未装备）'}\n攻击+${cur}｜初始+${base} → 满成长+${max}｜成长 ${pct}%\n每1小时成长一次｜剩 ${Math.floor(remainH / 24)}天${remainH % 24}小时长满｜绑定不可赠送`)
  }
  lines.push('', '#彩武命名 <名字> 可改名 · #更换武器 穿/脱')
  return lines
}

/** 铸造/打造可用的红色武器候选(装备栏 + 背包, 去重), 供选择器与 craftRainbow 共用 */
export function ownedRedWeapons (bag) {
  const equipped = bag && bag.equipped
  const eqRed = (EQUIP_TPL[equipped && equipped.weapon] && EQUIP_TPL[equipped.weapon].quality === 6 && EQUIP_TPL[equipped.weapon].type === 'weapon') ? equipped.weapon : ''
  const owned = eqRed ? [eqRed] : []
  for (const n of Object.keys((bag && bag.items) || {})) {
    if (EQUIP_TPL[n] && EQUIP_TPL[n].quality === 6 && EQUIP_TPL[n].type === 'weapon' && !owned.includes(n)) owned.push(n)
  }
  return owned
}

/** 铸造彩虹武器: 消耗 6 云裳仙蕊 + 1 件红武器 → 自动装备彩虹武器 */
export function craftRainbow (user_id, gid, redName) {
  const bag = getBag(user_id, gid)
  /* 1. 彩色药材数量 */
  const herbIt = bag.items && bag.items[RAINBOW_HERB]
  const have = herbIt ? (Number(herbIt.count) || 0) : 0
  if (have < RAINBOW_HERB_NEED) {
    return { ok: false, msg: `铸造彩武需要 ${RAINBOW_HERB_NEED} 个 🌈${RAINBOW_HERB}（你只有 ${have} 个），先去虚境秘境收集吧~` }
  }
  /* 2. 确认红武器(品质6武器; 装备栏/背包均可) */
  const equipped = bag.equipped || {}
  const owned = ownedRedWeapons(bag)
  let red = null
  if (redName) {
    const exact = owned.find(n => n === redName)
    const partial = !exact ? owned.filter(n => n.includes(redName)) : []
    if (exact) red = exact
    else if (partial.length === 1) red = partial[0]
    else if (partial.length > 1) return { ok: false, msg: `多件红武器匹配，请指定：#铸造特殊彩武 ${owned.join(' / ')}` }
  } else if (owned.length === 1) {
    red = owned[0]
  }
  if (!red) {
    if (!owned.length) return { ok: false, msg: '铸造彩武还需要 1 件红色武器（🔴霓裳剑/朱雀扇），去虚境秘境或拍卖行获取吧~' }
    return { ok: false, msg: `你有多件红武器，请选择用哪一件：#铸造特殊彩武 <红武器名>` }
  }
  /* 3. 扣除材料与红武器(直接改内存一次保存, 避免多次读写背包)
   *    若用的是穿着的红武器(新逻辑下穿上已不在背包): 属性取 equippedAttr, 无需再扣背包 */
  const wasEq = (equipped.weapon === red)
  const oldWeapon = equipped.weapon
  const ea = (bag.equippedAttr && bag.equippedAttr.weapon && Object.keys(bag.equippedAttr.weapon).length) ? bag.equippedAttr.weapon : null
  const redAttr = (wasEq && ea) ? ea : getItemAttr(bag, red)
  if (wasEq) {
    bag.equipped.weapon = ''
    if (bag.equippedAttr) bag.equippedAttr.weapon = null
  } else if (oldWeapon && EQUIP_TPL[oldWeapon]) {
    /* 选用背包红武时,先归还原来穿着的普通武器,避免覆盖装备栏导致第二把武器丢失 */
    unequipReturn(bag, 'weapon')
  }
  herbIt.count -= RAINBOW_HERB_NEED
  if (herbIt.count <= 0) delete bag.items[RAINBOW_HERB]
  if (!wasEq) {
    const rit = bag.items[red]
    if (rit) {
      if (rit.list && rit.list.length) {
        /* 匹配对应属性组, 匹配不到取第一组兜底(避免 count 与 list 不一致) */
        let g = rit.list.find(x => JSON.stringify(x.attr) === JSON.stringify(redAttr))
        if (!g) g = rit.list[0]
        g.count -= 1
        if (g.count <= 0) rit.list = rit.list.filter(x => x !== g)
        rit.count -= 1
        if (rit.list.length) rit.attr = rit.list[0].attr
        else delete bag.items[red]
      } else {
        rit.count -= 1
        if (rit.count <= 0) delete bag.items[red]
      }
    }
  }
  /* 4. 创建彩虹武器(每把独立计时, 初始攻击1)并自动装备 */
  const id = 'w' + Date.now() + Math.floor(Math.random() * 10000)
  const maxAtk = RAINBOW_CRAFT_MIN_ATK + Math.floor(Math.random() * (RAINBOW_CRAFT_MAX_ATK - RAINBOW_CRAFT_MIN_ATK + 1))
  const w = { id, name: '七彩神兵', bornAt: Date.now(), baseAtk: 1, maxAtk }
  bag.rainbows = bag.rainbows || []
  bag.rainbows.push(w)
  bag.equipped.weapon = 'rainbow:' + id
  saveBag(user_id, bag, gid)
  return {
    ok: true, msg: `🌈 铸造成功！七彩神兵【${w.name}】已自动装备\n当前攻击+${rainbowAtk(w)}，将随时间成长（每1小时一次，满成长攻击+${w.maxAtk}，2000~3000随机，约需1年）\n可 #彩武命名 <名字> 改名，绑定道具不可赠送`
  }
}

/** 彩虹武器改名(优先当前装备的; 未装备则改第一把) */
export function renameRainbow (user_id, gid, name) {
  const bag = getBag(user_id, gid)
  const ref = bag.equipped && bag.equipped.weapon
  let w = getRainbowByRef(bag, ref)
  if (!w) w = ((bag.rainbows || [])[0]) || null
  if (!w) return { ok: false, msg: '你还没有彩虹武器~（#铸造特殊彩武 获得）' }
  name = String(name || '').trim().replace(/[#＃]/g, '').slice(0, 8)
  if (!name) return { ok: false, msg: '用法：#彩武命名 <名字>（最多8字，如：#彩武命名 天玄神兵）' }
  w.name = name
  saveBag(user_id, bag, gid)
  return { ok: true, msg: `✅ 已命名为【${name}】（绑定不可赠送）` }
}
