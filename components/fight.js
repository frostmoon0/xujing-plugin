import { getBag, getEquipLevelRand, getTotalAttr, getGongfaFx, isDingxianyouEquipped } from './equip_data.js'
import { getPuppetBattleBuff, getPuppetPower } from './puppet_data.js'
import { getWanhunBattleBuff, getWanhunSoulPower } from './wanhun_data.js'
import { getActivePetPower } from './pet_data.js'
import { REALM_MAX_LEVEL } from './realm_cap.js'

/**
 * 全游戏统一绝对战力体系：决斗、幻境试炼、守卫/伏击、宗门战斗必须复用本文件的战力计算，禁止各玩法另起一套战力。
 * 每个等效小境界的战力基数(与装备 POWER_PER_LEVEL=100 一致)
 */
export const POWER_PER_LEVEL = 100
export const MAX_WIN_RATE = 100

/**
 * 境界战力: 每小境界100战力; 大境界权重更高(每大境界=6个小境界,与 realmPowerDiff 一致)
 * @param {number} level 境界等级(0=无灵力)
 * @returns {number}
 */
export function realmPower (level) {
  /* 境界硬上限: 仙帝第499重(567级); 超出的旧档/异常档不再继续涨战力 */
  level = Math.min(Number(level) || 0, REALM_MAX_LEVEL)
  return ((level % 4) + Math.floor(level / 4) * 6) * POWER_PER_LEVEL
}

/** buff 归一化: 支持对象 {atk,def,hp,crit,cdmg} 或纯攻击倍率(兼容旧调用) */
export function normalizeBuff (buff) {
  if (buff && typeof buff === 'object') {
    return {
      atk: Number(buff.atk) || 1,
      def: Number(buff.def) || 1,
      hp: Number(buff.hp) || 1,
      crit: Number(buff.crit) || 0,
      cdmg: Number(buff.cdmg) || 0
    }
  }
  const atk = Number(buff) || 1
  return { atk, def: 1, hp: 1, crit: 0, cdmg: 0 }
}

/**
 * 读取玩家全部战斗buff(redis): 攻击/防御/生命/暴击率/爆伤
 * 惊鸿丹=攻击+20% / 玉甲丹=防御+20% / 凝露丹=生命+20% / 慧心丹=暴击率+30% / 摄魂丹=爆伤+50%
 * @param {number|string} uid 玩家qq
 * @returns {Promise<{atk:number,def:number,hp:number,crit:number,cdmg:number}>}
 */
export async function getBuffs (uid, gid = 'global') {
  const b = { atk: 1, def: 1, hp: 1, crit: 0, cdmg: 0 }
  try {
    if (uid) {
      if (await redis.get(`xujing:atk-buff:${uid}`)) b.atk = 1.2
      if (await redis.get(`xujing:def-buff:${uid}`)) b.def = 1.2
      if (await redis.get(`xujing:hp-buff:${uid}`)) b.hp = 1.2
      if (await redis.get(`xujing:crit-buff:${uid}`)) b.crit = 0.3
      if (await redis.get(`xujing:cdmg-buff:${uid}`)) b.cdmg = 0.5
      // 功法加成(当前运转功法,与丹药buff叠加): 攻/防/血 加百分比, 暴击/爆伤 加概率
      const gfx = await getGongfaFx(uid)
      if (gfx) {
        b.atk += gfx.atk || 0
        b.def += gfx.def || 0
        b.hp += gfx.hp || 0
        b.crit += gfx.crit || 0
        b.cdmg += gfx.cdmg || 0
      }
      const wanhun = getWanhunBattleBuff(uid, gid)
      b.atk *= wanhun.atk || 1
      b.def *= wanhun.def || 1
      b.hp *= wanhun.hp || 1
      if (isDingxianyouEquipped(getBag(uid, gid))) b.hp *= 1.1
      const puppet = getPuppetBattleBuff(getBag(uid, gid))
      b.atk *= puppet.atk || 1
      b.def *= puppet.def || 1
      b.hp *= puppet.hp || 1
      b.crit += puppet.crit || 0
      b.cdmg += puppet.cdmg || 0
    }
  } catch (err) { }
  return b
}

/**
 * 攻击增益倍率(惊鸿丹+20%): 兼容旧调用,返回攻击倍率
 * @param {number|string} uid 玩家qq
 * @returns {Promise<number>}
 */
export async function getAttackBuff (uid) {
  return (await getBuffs(uid)).atk
}

/**
 * 综合战力: 境界战力 + 装备战力 + 出战宠物战力 + 万魂 (乘攻 buff)
 * 决斗胜率 / 幻境试炼伤害 / 守卫/伏击/宗门 共用同一套战力体系
 * gid/uid 可选: 传入后计入该玩家出战宠物的战力(未出战/幼崽/蛋为 0)
 * @param {number} level 境界等级
 * @param {object} bag 背包对象(缺省视为无装备)
 * @param {object|number} buff 完整buff对象或攻击倍率(默认1)
 * @param {string} [gid] 群号(查出战宠物用)
 * @param {string|number} [uid] 玩家qq(查出战宠物用)
 * @returns {{ realmPower:number, equipPower:number, power:number }}
 */
export function calcCombatPower (level, bag, buff = 1, gid = 'global', uid = '') {
  const rp = realmPower(level)
  const { power: equipPower } = getTotalAttr(bag || {})
  const { atk } = normalizeBuff(buff)
  let petPower = 0
  if (uid) {
    try { petPower = getActivePetPower(gid, uid) } catch (err) { petPower = 0 }
  }
  let puppetPower = 0
  try { puppetPower = getPuppetPower(bag || {}) } catch (err) { puppetPower = 0 }
  return { realmPower: rp, equipPower, puppetPower, power: Math.round((rp + equipPower + getWanhunSoulPower(bag, level) + petPower + puppetPower) * (atk || 1)) }
}

/**
 * 单次伤害计算(带随机浮动 + 暴击): 暴击率crit命中则伤害×(1.5+爆伤cdmg)
 * @param {number} level 境界等级
 * @param {object} bag 背包对象
 * @param {number} variance 随机浮动比例,默认±15%
 * @param {object|number} buff 完整buff对象或攻击倍率(默认1)
 * @param {string} [gid] 群号(算出战宠物战力)
 * @param {string|number} [uid] 玩家qq(算出战宠物战力)
 * @returns {{ dmg:number, base:number, power:number, crit:boolean }}
 */
export function calcDamage (level, bag, variance = 0.15, buff = 1, gid = 'global', uid = '') {
  const b = normalizeBuff(buff)
  const { power } = calcCombatPower(level, bag, b, gid, uid)
  const base = Math.max(10, Math.round(power / 2))
  let dmg = Math.round(base * (1 - variance + Math.random() * variance * 2))
  let crit = false
  if (b.crit > 0 && Math.random() < b.crit) {
    dmg = Math.round(dmg * (1.5 + b.cdmg))
    crit = true
  }
  return { dmg, base, power, crit }
}

/**
 * 生成每次调用都会随机波动的伤害函数(用于战斗回合/幻境试炼,含暴击)
 * @param {number} level 境界等级
 * @param {number|string} user_id 我方qq
 * @param {number} variance 随机浮动比例,默认±15%
 * @param {object|number} buff 完整buff对象或攻击倍率(默认1)
 * @returns {() => number}
 */
export function makeDamageFn (level, user_id, variance = 0.15, buff = 1, gid = 'global') {
  const bag = getBag(user_id, gid)
  return () => calcDamage(level, bag, variance, buff, gid, user_id).dmg
}

/**
 * 单局胜率(0~100),与全游戏绝对战力体系一致
 * @param {number} level 我方境界
 * @param {number} level2 对方境界
 * @param {number|string} user_id 我方qq
 * @param {number|string} user_id2 对方qq
 * @param {number} Magnification 兼容旧配置参数,转换为绝对战力比敏感度
 * @returns {{ win:number, myEquip:number, oppEquip:number, myPower:number, oppPower:number }}
 */
export function fightWinRate (level, level2, user_id, user_id2, Magnification = 8, myBuff = 1, oppBuff = 1, gid = 'global') {
  level = Number(level) || 0
  level2 = Number(level2) || 0
  const mb = normalizeBuff(myBuff)
  const ob = normalizeBuff(oppBuff)
  const myBag = getBag(user_id, gid)
  const oppBag = getBag(user_id2, gid)
  /* 决斗也必须直接使用统一绝对战力: 境界/装备/灵兽/万魂/攻击增益全部从 calcCombatPower 进入。
   * 正反方向只交换双方参数；高打低可到100%, 低打高对应为0%, 不再保留单边5%地板。 */
  const myPower = calcCombatPower(level, myBag, mb, gid, user_id).power
  const oppPower = calcCombatPower(level2, oppBag, ob, gid, user_id2).power
  const myEquip = Math.round(getEquipLevelRand(myBag))
  const oppEquip = Math.round(getEquipLevelRand(oppBag))
  const win = absoluteWinRate(myPower, oppPower, 0, (Number(Magnification) || 8) * 5)
  return { win, myEquip, oppEquip, myPower, oppPower }
}

/**
 * 绝对战力比转单局胜率: 战力相当=五五开, 强弱差距通过对数映射, 上限允许100%
 * @param {number} playerPower 我方绝对战力
 * @param {number} opponentPower 对方绝对战力
 * @param {number} min 最低胜率
 * @param {number} sensitivity 战力比敏感度,默认40
 * @returns {number} 0~100
 */
export function absoluteWinRate (playerPower, opponentPower, min = 0, sensitivity = 40) {
  const ratio = (Number(playerPower) || 1) / (Number(opponentPower) || 1)
  const scale = Number(sensitivity) || 40
  const win = Math.round(50 + scale * Math.log2(ratio))
  return Math.max(min, Math.min(MAX_WIN_RATE, win))
}

/** 守卫单局胜率: 按玩家/守卫绝对战力比映射,战力相当=五五开,碾压/被碾压封顶100%/10% */
export function guardWinRate (playerPower, guardPower) {
  return absoluteWinRate(playerPower, guardPower, 10)
}

/**
 * 五局三胜模拟:先胜3局者获胜,最多5局
 * @param {number} win 单局胜率(0~100)
 * @param {object} [opts] 可选
 *  - dmgMe/dmgOpp 每局伤害函数(返回本局伤害数字),仅胜者出伤害
 * @returns {{ myWin:number, oppWin:number, rounds:Array, winner:'me'|'opp' }}
 */
export function fightBestOf5 (win, opts = {}) {
  const { dmgMe, dmgOpp, defMe = 1 } = opts
  const dmgOf = (w) => {
    if (w === 'me') return dmgMe ? dmgMe() : 0
    // 对方胜的回合: 对方打出伤害, 我方防御倍率减免(护元丹防御+20% → 受伤÷1.2)
    return dmgOpp ? Math.round(dmgOpp() / (defMe || 1)) : 0
  }
  let myWin = 0
  let oppWin = 0
  const rounds = []
  for (let r = 1; r <= 5 && myWin < 3 && oppWin < 3; r++) {
    const isWin = Math.random() * 100 < win
    if (isWin) myWin++
    else oppWin++
    rounds.push({
      round: r,
      winner: isWin ? 'me' : 'opp',
      myWin,
      oppWin,
      dmg: dmgOf(isWin ? 'me' : 'opp')
    })
  }
  return { myWin, oppWin, rounds, winner: myWin >= 3 ? 'me' : 'opp' }
}

/**
 * 构建五局三胜战斗的合并转发记录节点
 * @param {object} opt
 *  - myName/oppName 双方昵称, myId/oppId 双方qq
 *  - myLevel/oppLevel 双方境界名, myEquip/oppEquip 双方装备等效境界
 *  - win 我方单局胜率, result fightBestOf5 的结果
 *  - extra 开场附加说明, footer 最终结果附加说明
 * @returns {Array<{message, nickname, user_id}>}
 */
export function buildFightRecord ({
  myName = '你', oppName = '对方', myId = Bot.uin, oppId = Bot.uin,
  myLevel = '', oppLevel = '', myEquip = 0, oppEquip = 0,
  win = 50, result, extra = '', footer = ''
}) {
  const nodes = []
  const bot = (message) => ({ message, nickname: Bot.nickname, user_id: Bot.uin })
  const fighter = (message, winner) => ({
    message,
    nickname: winner === 'me' ? myName : oppName,
    user_id: Number(winner === 'me' ? myId : oppId) || Bot.uin
  })

  nodes.push(bot(`⚔️ 决斗开始！五局三胜制，先胜3局者获胜！${extra ? `\n${extra}` : ''}`))
  nodes.push(bot(`你：${myLevel}（装备+${myEquip}境界）\n${oppName}：${oppLevel}（装备+${oppEquip}境界）\n你单局获胜概率：${win}%`))

  for (const rd of result.rounds) {
    const isMe = rd.winner === 'me'
    const desc = rd.dmg
      ? fightDesc(rd.round - 1, rd.dmg, isMe ? '你' : oppName, isMe ? oppName : '你')
      : ''
    nodes.push(fighter(
      `第${rd.round}回合 · ${desc || '获胜！'}\n当前比分 ${rd.myWin} : ${rd.oppWin}`,
      rd.winner
    ))
  }

  const meWin = result.winner === 'me'
  nodes.push(bot(
    `🏆 最终结果：${meWin ? myName : oppName} 以 ${meWin ? result.myWin : result.oppWin} : ${meWin ? result.oppWin : result.myWin} 获胜！${footer ? `\n${footer}` : ''}`
  ))
  return nodes
}

/* 战斗招式描述(按轮次轮换): 决斗/幻境试炼等战斗记录共用 */
const FIGHT_LINES = [
  (t) => '凝聚全身灵力，一记重击轰在' + t + '身上',
  (t) => '身形如电，连环攻势如暴雨般倾泻在' + t + '身上',
  (t) => '祭出一道凌厉灵光，直取' + t + '要害',
  (t) => '脚踏罡步，术法光芒在' + t + '身前轰然炸开',
  (t) => '一声断喝，气浪翻涌重创' + t,
  (t) => '将全身灵力化作璀璨光柱，贯穿' + t + '防线',
  (t) => '身法诡谲，绕至' + t + '身后一击命中',
  (t) => '双手结印，符文流转，阵光轰然压下',
  (t) => '腾空而起，凌空重击当头砸向' + t,
  (t) => '以气驭剑，剑气纵横，撕开' + t + '护体罡气',
  (t) => '掌心凝聚一团烈焰，狠狠拍向' + t,
  (t) => '召唤漫天风刃，如雨点般切割' + t,
  (t) => '祭出一道雷霆，轰然劈落在' + t + '身上',
  (t) => '灵力化作巨型掌印，从天而降拍向' + t,
  (t) => '凝聚冰霜之力，寒气席卷冻结' + t,
  (t) => '一记回旋踢横扫而出，正中' + t,
  (t) => '以指为剑，一道剑气直刺' + t,
  (t) => '祭出灵火长鞭，狠狠抽在' + t + '身上',
  (t) => '身影化作残影，连续重击' + t,
  (t) => '运转玄功，一拳轰出气浪撕裂空气打向' + t,
  (t) => '祭起宝光护体，反手一击重创' + t,
  (t) => '凝聚山河之力，一座山岳虚影砸向' + t,
  (t) => '施展御剑术，剑光如虹直贯' + t,
  (t) => '双掌齐出，一道金色掌影轰在' + t + '身上',
  (t) => '凝聚星辰之力，星光如柱轰击' + t,
  (t) => '身形一旋，一记鞭腿扫在' + t + '腰际',
  (t) => '祭出摄魂铃音，震得' + t + '身形一滞随即重创',
  (t) => '以气化盾后猛然反震，将' + t + '震飞',
  (t) => '凝聚雷火之力，双拳轰出雷火交加砸向' + t,
  (t) => '施展瞬身术，出现在' + t + '面前一拳轰出',
  (t) => '灵力化为万千针雨，铺天盖地射向' + t,
  (t) => '一声长啸，声浪如潮冲击' + t,
  (t) => '祭出飞剑绕体一周，猛然斩向' + t,
  (t) => '凝聚阴阳二气，化作太极图轰然压下' + t,
  (t) => '脚踏莲花步法，连续三掌拍在' + t + '身上',
  (t) => '以魂为引，一道灵魂冲击直击' + t + '识海',
  (t) => '凝聚庚金之气，一柄金剑凭空凝现刺向' + t,
  (t) => '施展火龙术，一条火龙缠绕着' + t + '轰然炸开',
  (t) => '双手合十，一道圣光柱从天空落下轰中' + t,
  (t) => '凝聚混沌之力，一掌拍出天崩地裂轰在' + t + '身上'
]

/**
 * 生成带招式描述的伤害文本(战斗记录用)
 * @param {number} i 轮次索引(从0开始, 用于轮换招式)
 * @param {number} dmg 本次伤害
 * @param {string} subject 出招主语(如'你'或对方昵称)
 * @param {string} target 被击目标(如'对手'/'幻境守卫')
 * @returns {string}
 */
export function fightDesc (i, dmg, subject = '你', target = '对手') {
  const line = FIGHT_LINES[i % FIGHT_LINES.length]
  return `${subject}${line(target)}，造成 ${dmg} 点伤害！`
}
