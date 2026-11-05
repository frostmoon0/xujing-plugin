import { sectMemberCapacity, sectOccupancy } from '../../components/sect/capacity.js'
/* ============================================================
 * 玩家宗门系统 · 指令层 (第二步~第七步)
 * 设施/宝库/上供/兑换/创建/任命/传位/问退位/夺权
 * 宣战/议和/攻打/守/参与/俘虏/天下小区/护城阵/维护
 * ============================================================ */
import { plugin } from '../../model/api/api.js'
import { getFake, saveFake, sectName, sectIdByName, sectAlive, getNick, rewashFake, withFakeLock } from '../../components/fake_data.js'
import { getBag, consumeItem, MATERIAL_TPL, addItem, itemIcon } from '../../components/equip_data.js'
import { getWorld, saveWorld, regionNameOf, getLoc, regionKeyOf, REGIONS, levelNameOf } from '../../components/world_data.js'
import {
  CFG, inWarUpkeep, WAR_UPKEEP_MS, sectRegion, areaDefLevel, getVault, regionOfArea, warTargetTxt, sectTxtOf, areaTxtOf, targetRawTxt, offer, offerAllGongfa, exchange, injuryInfo,
  createPlayerSect, renameSectName, relocateSect, upgradeFacility, upgradeAreaDef, abandonArea, declareWar, makePeace, startSectAttack, startRogueAttack,
  abortSectAttack,
  respondDefend, joinSectFight, quitRogueParticipation, sectReinforce, sectForceAdjust, sectServantRally, handleCaptives, appointTo, abdicateTo, askAbdicate, seizePower, autoPromote, leavePlayerSect, joinPlayerSect,
  sectJailList, releaseSectJail, playerEscape, escapeRateOf, startRescue,
  rogueTeamOf, createRogueTeam, inviteRogue, agreeRogue, applyRogue, respondApply, kickRogue, transferRogue, quitRogue, disbandRogue,
  resetAreaTruce, buyPillFromVault, answerSectJoin, claimSalary, takeFromVault, parseVaultTake,
  allySect, breakAlly, allyAssist, recruitFakeToSect, poachFakeFromSect, pendingCaptivesForSect
} from '../../components/sect_system.js'
import { readCfg, isEnabled } from '../../components/sect/config.js'
import { fmtTime, replyLines, getPlayer, posCn, sameRegion, relTxt } from '../../components/sect/helpers.js'
import { currentInteract } from '../../components/interact.js'

/** 临时开关: true=禁止玩家发起/参与宗门战争(宣战/攻打/守/参与攻打/助战 全部拦截); 日后恢复改回 false */
const WAR_BLOCKED = false

/** 组队/世界状态统一串行，避免命令与每分钟推演互相覆盖存档。 */
async function withTeamLock (gid, fn) {
  let result
  await withFakeLock(gid, async () => { result = await fn(getFake(gid)) })
  return result
}

export class sect_system extends plugin {
  constructor () {
    super({
      name: '宗门系统',
      dsc: '玩家宗门系统-进阶',
      event: 'message',
      priority: 260,
      rule: [
        { reg: '^[#＃]?我的宗门$', fnc: 'mySect' },
        { reg: '^[#＃]?创建宗门\\s*(\\S*)(?:\\s*(中州|东海|西域|北境|南疆))?$', fnc: 'createSect' },
        { reg: '^[#＃]?加入宗门\\s*(\\S*)$', fnc: 'joinPlayerSectCmd' },
        { reg: '^[#＃]?(退出宗门|退宗)$', fnc: 'leavePlayerSectCmd' },
        { reg: '^[#＃]?上供\\s*([0-9０-９]*)$', fnc: 'offerCmd' },
        { reg: '^[#＃]?上供\\s*([^0-9０-９\\s]+)\\s*([0-9０-９]*)$', fnc: 'offerMatCmd' },
        { reg: '^[#＃]?我的贡献$', fnc: 'myContribution' },
        { reg: '^[#＃]?宗门兑换\\s*(\\S*)\\s*([0-9０-９]*)$', fnc: 'exchangeCmd' },
        { reg: '^[#＃]?(宗门购丹|宝库购丹|宗门买丹)\\s*(\\S*)\\s*([0-9０-９]*)$', fnc: 'buyPillCmd' },
        { reg: '^[#＃]?(宗门购装备|宝库购装备|宗门买装备)\\s*(\\S*)\\s*([0-9０-９]*)$', fnc: 'buyVaultEquipCmd' },
        { reg: '^[#＃]?(领俸禄|俸禄|领取俸禄)$', fnc: 'salaryCmd' },
        { reg: '^[#＃]?取用宝库\\s*(.*)$', fnc: 'takeVaultCmd' },
        { reg: '^[#＃]?(宗门宝库|宗门金库|宗门仓库)$', fnc: 'sectVault' },
        { reg: '^[#＃]?晋升\\s*(\\S*)$', fnc: 'promoteCmd' },
        { reg: '^[#＃]?(宗门设施|宗门建筑)$', fnc: 'sectFacilities' },
        { reg: '^[#＃]?升级设施\\s*(\\S*)$', fnc: 'upgradeFacilityCmd' },
        { reg: '^[#＃]?升级护城阵\\s*(\\S*)$', fnc: 'upgradeAreaDefCmd' },
        { reg: '^[#＃]?(宗门放弃小区|放弃小区)\\s*(\\S*)$', fnc: 'abandonAreaCmd' },
        { reg: '^[#＃]?护城阵$', fnc: 'areaDefInfo' },
        { reg: '^[#＃]?(天下小区|小区面板)$', fnc: 'areaPanel' },
        { reg: '^[#＃]?(同意入宗|接纳散修|同意加入)\\s*(\\S*)$', fnc: 'acceptJoin' },
        { reg: '^[#＃]?(拒绝入宗|婉拒散修|拒绝加入)\\s*(\\S*)$', fnc: 'refuseJoin' },
        { reg: '^[#＃]?(入宗申请|投奔申请|想入宗的人|入宗名单)$', fnc: 'joinReqs' },
        { reg: '^[#＃]?宗门成员$', fnc: 'sectMembers' },
        { reg: '^[#＃]?宗门职位$', fnc: 'sectPositions' },
        { reg: '^[#＃]?宗门关系$', fnc: 'sectRelations' },
        { reg: '^[#＃]?结盟\\s*(\\S*)$', fnc: 'allyCmd' },
        { reg: '^[#＃]?(退盟|解除结盟|解除同盟)\\s*(\\S*)$', fnc: 'breakAllyCmd' },
        { reg: '^[#＃]?(盟友助战|盟友驰援|驰援盟友|驰援帮忙)\\s*(\\S*?)(?:\\s+([0-9０-９]+))?\\s*$', fnc: 'allyAssistCmd' },
        { reg: '^[#＃]?任命\\s*(\\S*)\\s*@?([0-9０-９]*)$', fnc: 'appoint' },
        { reg: '^[#＃]?传位\\s*@?([0-9０-９]*)$', fnc: 'abdicate' },
        { reg: '^[#＃]?问退位$', fnc: 'askAbdicateCmd' },
        { reg: '^[#＃]?夺权$', fnc: 'seizePowerCmd' },
        { reg: '^[#＃]?(宗门宣战|宣战)\\s*(\\S*)$', fnc: 'declareWarCmd' },
        { reg: '^[#＃]?(议和|罢兵)\\s*(\\S*)$', fnc: 'makePeaceCmd' },
        { reg: '^[#＃]?(宗门攻打|攻打宗门|攻打)\\s*(\\S*)$', fnc: 'attackCmd' },
        { reg: '^[#＃]?守\\s*(\\S*)$', fnc: 'defendCmd' },
        { reg: '^[#＃]?不守(?:\\s+(\\S+))?$', fnc: 'notDefendCmd' },
        /* #参战 自动分边加入攻打/防守; #参与攻打/#宗门防守/#攻 为明确分边的旧别名(隐藏) */
        { reg: '^[#＃]?参战\\s*(\\S*)$', fnc: 'joinFightCmd' },
        { reg: '^[#＃]?(?!攻击|攻打|攻占)攻\\s*(\\S*)$', fnc: 'joinAttackCmd' },
        { reg: '^[#＃]?(参与攻打|加入攻打)\\s*(\\S*)$', fnc: 'joinAttackCmd' },
        { reg: '^[#＃]?(宗门防守|加入防守)\\s*(\\S*)$', fnc: 'joinDefendCmd' },
        { reg: '^[#＃]?(退战|退出参战|退出攻打|退出战斗|退出防守|退出守御)(?:\\s+(\\S*))?$', fnc: 'quitFightCmd' },
        { reg: '^[#＃]?(驰援功法|宗门驰援|驰援)\\s*(\\S*?)(?:\\s+([0-9０-９]+))?\\s*$', fnc: 'sectReinforceCmd' },
        { reg: '^[#＃]?(派兵|添兵|减兵|撤兵)\\s*(\\S*?)(?:\\s+([0-9０-９]+))?\\s*$', fnc: 'sectForceCmd' },
        { reg: '^[#＃]?(集结仆从|仆从集结)\\s*(\\S*?)(?:\\s+([0-9０-９]+))?\\s*$', fnc: 'sectServantRallyCmd' },
        { reg: '^[#＃]?处置俘虏\\s*(\\S*)\\s*(收编|全杀|搜刮再杀|全放|搜刮再放|关天牢|送矿山|送往矿山)?$', fnc: 'handleCaptivesCmd' },
        /* 处置界面后可直接回复裸数字 1~7 处置; 无待处置俘虏/无权限/有其他数字交互进行中则放行, 不与其他序号指令(逛街/丹阁/跨区/赠送)冲突 */
        { reg: '^[#＃]?[0-9０-９]+$', fnc: 'captivePickCmd' },
        { reg: '^[#＃]?宗门矿山$', fnc: 'sectMineCmd' },
        { reg: '^[#＃]?天下矿山$', fnc: 'allMinesCmd' },
        { reg: '^[#＃]?维护宗门\\s*([0-9０-９]*)$', fnc: 'maintainCmd' },
        { reg: '^[#＃]?创建队伍\\s*(\\S*)$', fnc: 'createTeamCmd' },
        { reg: '^[#＃]?(邀请入队|拉人入队|邀请)\\s*@?([0-9０-９]*)$', fnc: 'inviteTeamCmd' },
        { reg: '^[#＃]?同意进队$', fnc: 'agreeTeamCmd' },
        { reg: '^[#＃]?拒绝进队$', fnc: 'refuseTeamCmd' },
        { reg: '^[#＃]?(申请进队|申请加入)\\s*@?([0-9０-９]*)$', fnc: 'applyTeamCmd' },
        { reg: '^[#＃]?同意申请$', fnc: 'agreeApplyCmd' },
        { reg: '^[#＃]?拒绝申请$', fnc: 'refuseApplyCmd' },
        { reg: '^[#＃]?(踢出队伍|踢人出队)\\s*@?([0-9０-９]*)$', fnc: 'kickTeamCmd' },
        { reg: '^[#＃]?(转让队长|移交队长)\\s*@?([0-9０-９]*)$', fnc: 'transferTeamCmd' },
        { reg: '^[#＃]?退出队伍$', fnc: 'quitTeamCmd' },
        { reg: '^[#＃]?(解散队伍|解散小队)$', fnc: 'disbandTeamCmd' },
        { reg: '^[#＃]?(我的队伍|队伍状态)$', fnc: 'teamInfoCmd' },
        { reg: '^[#＃]?(组队玩法|组队攻略|组队指南)$', fnc: 'rogueGuide' },
        { reg: '^[#＃]?(宗门玩法|宗门攻略|宗门指南)$', fnc: 'sectGuide' },
        { reg: '^[#＃]?(宗门系统|宗门帮助)$', fnc: 'sectHelp' },
        { reg: '^[#＃]?(重洗天下|重置天下|重演天下|重开天下|洗白天下)$', fnc: 'rewashWorld', auth: 'master' },
        { reg: '^[#＃]?(重置休战|重置休战期|清空休战|清空休战期)$', fnc: 'resetTruceCmd', auth: 'master' },
        { reg: '^[#＃]?(宗门天牢|查看天牢|天牢)$', fnc: 'sectJailCmd' },
        { reg: '^[#＃]?越狱$', fnc: 'escapeCmd' },
        { reg: '^[#＃]?拯救\\s*(@?\\S*)$', fnc: 'rescueCmd' },
        { reg: '^[#＃]?释放俘虏\\s*(\\S+)$', fnc: 'releaseCaptiveCmd' },
        { reg: '^[#＃]?(拉人入宗|招收弟子|招人入宗)\\s*(\\S*)$', fnc: 'recruitFakeCmd' },
        { reg: '^[#＃]?挖角\\s*(\\S*)$', fnc: 'poachFakeCmd' },
        { reg: '^[#＃]?(撤退|撤兵|终止攻打|收兵|停止攻打|撤军)$', fnc: 'abortAttackCmd' },
        { reg: '^[#＃]?(宗门改名|改名宗门|宗门更名)\\s*(\\S*)$', fnc: 'renameSectCmd' },
        { reg: '^[#＃]?迁宗\\s*(中州|东海|西域|北境|南疆)?$', fnc: 'relocateSectCmd' },
        { reg: '^[#＃]?一键上供功法$', fnc: 'offerAllGongfaCmd' }
      ]
    })
  }

  /** 白名单闸门 */
  gate (e) {
    if (!e.group_id) { e.reply('需在群内使用'); return true }
    if (!isEnabled(e.group_id)) { e.reply('🛡️ 本群未开启宗门系统，请联系主人开启'); return true }
    return false
  }

  /** 战争拦截闸门: WAR_BLOCKED=true 时禁止玩家发起/参与宗门战争(日后去掉即可恢复) */
  warBlock (e) {
    if (WAR_BLOCKED) { e.reply('🛡️ 宗门战争系统暂时关闭（维护中），无法发起/参与攻打，请稍后再试'); return true }
    return false
  }

  /* ---- #创建宗门 [名] [大区] ---- */
  async createSect (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const m = String(e.msg || '').match(/创建宗门\s*(\S*)(?:\s*(中州|东海|西域|北境|南疆))?/)
      const name = (m && m[1]) ? m[1] : ''
      const regName = (m && m[2]) || ''
      const rk = regName ? regionKeyOf(regName) : null
      const r = await createPlayerSect(f, gid, e.user_id, name, rk, e.nickname)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]创建异常:' + (err && err.stack))
      e.reply('创建宗门出错了，请稍后再试')
      return true
    }
  }

  /* ---- #加入宗门 [名]: 普通玩家拜入目标宗门；原宗退出后7天禁入，其他宗门可立即加入 ---- */
  async joinPlayerSectCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const m = String(e.msg || '').match(/加入宗门\s*(\S*)/)
      const name = (m && m[1]) || ''
      if (!name) { e.reply('用法：#加入宗门 [宗门名]（退出原宗后7天内不可回原宗，其他宗门可立即加入）'); return true }
      const f = getFake(gid)
      const r = joinPlayerSect(f, gid, e.user_id, e.nickname || String(e.user_id), name)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]加入异常:' + (err && err.stack))
      e.reply('加入宗门出错了，请稍后再试')
      return true
    }
  }

  /* ---- #退出宗门 / #退宗: 立即退出；仅原宗门禁入7天 ---- */
  async leavePlayerSectCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const r = leavePlayerSect(f, gid, e.user_id)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]退宗异常:' + (err && err.stack))
      e.reply('退出宗门出错了，请稍后再试')
      return true
    }
  }

  /* ---- #宗门改名 [新名字] ---- */
  async renameSectCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p) { e.reply('你不是宗门成员'); return true }
      if (p.pos !== 'zongzhu' && p.pos !== 'fuzong' && p.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以改名'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const m = String(e.msg || '').match(/(?:宗门改名|改名宗门|宗门更名)\s*(\S*)/)
      const name = (m && m[1]) ? m[1] : ''
      const r = renameSectName(f, gid, p.sect, name)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]改名异常:' + (err && err.stack))
      e.reply('宗门改名出错了，请稍后再试')
      return true
    }
  }

  /* ---- #迁宗 (中州|东海|西域|北境|南疆) ---- */
  async relocateSectCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p || !p.sect) { e.reply('你不是宗门成员'); return true }
      if (p.pos !== 'zongzhu' && p.pos !== 'fuzong' && p.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以迁宗'); return true }
      const w = getWorld(gid)
      const m = String(e.msg || '').match(/迁宗\s*(中州|东海|西域|北境|南疆)/)
      const regName = (m && m[1]) || ''
      const rk = regName ? regionKeyOf(regName) : null
      if (!rk) { e.reply('用法：#迁宗 (中州|东海|西域|北境|南疆)，如：#迁宗 东海'); return true }
      const myLoc = getLoc(w, e.user_id)
      if (myLoc !== rk) { e.reply(`你当前在【${regionNameOf(myLoc)}】，请先前往【${regionNameOf(rk)}】再迁宗（须到新址奠基）`); return true }
      const r = relocateSect(f, gid, p.sect, rk)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]迁宗异常:' + (err && err.stack))
      e.reply('迁宗出错了，请稍后再试')
      return true
    }
  }

  /* ---- #上供 [材料名] [数量]: 上供材料给宗门宝库(无贡献点) ---- */
  async offerMatCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const cd = await redis.ttl(`xujing:sect-offer-cd:${gid}:${uid}`)
      if (cd !== -2 && cd > 0) { e.reply(`上供冷却中：${Math.ceil(cd / 60)} 分钟后再试`); return true }
      const m = String(e.msg || '').match(/上供\s*([^\d\s]+)\s*(\d*)/)
      const name = (m && m[1]) ? m[1].trim() : ''
      const count = Math.max(1, Math.floor(Number((m && m[2]) || 1)))
      const real = Object.keys(MATERIAL_TPL).find(n => n === name || n.includes(name) || name.includes(n))
      if (!real) { e.reply(`没有找到材料「${name}」，可用材料如 星霜草/月魄石/流光玉/望舒花 等`); return true }
      const bag = getBag(uid, gid)
      const have = (bag.items && bag.items[real]) ? bag.items[real].count : 0
      if (have < count) { e.reply(`背包里 ${real} 只有 ${have} 个，不够上供 ${count} 个`); return true }
      consumeItem(uid, real, count, null, gid)
      const vault = getVault(f, p.sect)
      if (!vault.mats) vault.mats = {}
      vault.mats[real] = (vault.mats[real] || 0) + count
      saveFake(f, gid)
      await redis.set(`xujing:sect-offer-cd:${gid}:${uid}`, 1, { EX: 10 * 60 })
      e.reply(`✅ 已上供 ${itemIcon(real)}${real} ×${count} 给宗门宝库（材料上供无贡献点；#上供 [灵石] 才有贡献）`)
      return true
    } catch (err) {
      logger.error('[宗门系统]材料上供异常:' + (err && err.stack))
      e.reply('材料上供出错了，请稍后再试')
      return true
    }
  }

  /* ---- #一键上供功法: 红色及以下全部入宗门宝库 ---- */
  async offerAllGongfaCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const r = offerAllGongfa(gid, uid)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]一键上供功法异常:' + (err && err.stack))
      e.reply('一键上供功法出错了，请稍后再试')
      return true
    }
  }

  /* ---- #上供 [灵石] ---- */
  async offerCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const cd = await redis.ttl(`xujing:sect-offer-cd:${gid}:${uid}`)
      if (cd !== -2 && cd > 0) { e.reply(`上供冷却中：${Math.ceil(cd / 60)} 分钟后再试`); return true }
      const m = String(e.msg || '').match(/上供\s*(\d*)/)
      const amount = Number((m && m[1]) || 0)
      if (!amount) { e.reply(`用法：#上供 [灵石]（最低 ${CFG.OFFER_MIN}，每100灵石=1贡献）`); return true }
      const r = await offer(gid, uid, amount)
      if (r.ok) await redis.set(`xujing:sect-offer-cd:${gid}:${uid}`, 1, { EX: 10 * 60 })
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]上供异常:' + (err && err.stack))
      e.reply('上供出错了，请稍后再试')
      return true
    }
  }

  /* ---- #我的贡献 ---- */
  async myContribution (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p) { e.reply('你不是宗门成员'); return true }
      if (p.pos === 'zongzhu' || p.pos === 'fuzong' || p.pos === 'taishang') { e.reply(`👑 你是${posCn(p.pos)}，无需贡献点——可 #取用宝库 直接拿宗门金库的灵石/材料/丹药`); return true }
      e.reply(`🎖️ 你在【${sectName(f, p.sect)}】的贡献：${p.contribution || 0}\n（#上供 得贡献，贡献可 #宗门兑换 宝库物品）`)
      return true
    } catch (err) {
      logger.error('[宗门系统]贡献异常:' + (err && err.stack))
      e.reply('查询贡献出错了，请稍后再试')
      return true
    }
  }

  /* ---- #领俸禄: 兼容旧指令，俸禄由玩家主导宗门每小时自动发放 ---- */
  async salaryCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const r = await claimSalary(f, gid, e.user_id)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]俸禄异常:' + (err && err.stack))
      e.reply('查询俸禄出错了，请稍后再试')
      return true
    }
  }

  /* ---- #取用宝库 [灵石|物品名] [数量] (宗主/副宗/太上; 名称与数量均支持模糊输入) ---- */
  async takeVaultCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const text = String(e.msg || '').replace(/^[#＃]?\s*取用宝库/, '').trim()
      const parsed = parseVaultTake(text)
      if (!parsed) {
        e.reply('用法：#取用宝库 [灵石|物品名] [数量]（宗主/副宗/太上可自由取用）\n数量可用 全部 取光；支持 灵石5万 / 5万灵石 / 灵石×5000 / 5000个灵石 等写法')
        return true
      }
      const r = await takeFromVault(f, gid, e.user_id, parsed.name, parsed.all ? 'all' : parsed.count)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]取用宝库异常:' + (err && err.stack))
      e.reply('取用宝库出错了，请稍后再试')
      return true
    }
  }

  /* ---- #宗门兑换 [物品] [数量] ---- */
  async exchangeCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const m = String(e.msg || '').match(/宗门兑换\s*(\S*)\s*(\d*)/)
      const name = (m && m[1]) || ''
      const count = Number((m && m[2]) || 1)
      if (!name) { e.reply('用法：#宗门兑换 [物品] [数量]（灵石/修为丹/破障丹/聚宝丹/材料/宝库装备全名）\n灵石100=20贡献｜普通材料(紫/金)=5｜红材料=800｜彩材料=2000｜修为丹=1｜破障丹=2｜其他丹药=10｜装备=按品质20/40/80/120/180/260/360贡献'); return true }
      const r = await exchange(gid, uid, name, count)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]兑换异常:' + (err && err.stack))
      e.reply('兑换出错了，请稍后再试')
      return true
    }
  }

  /* ---- #宗门宝库 ---- */
  /* ---- #我的宗门: 查看自己宗门身份与宗门概况 ---- */
  async mySect (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p || !p.sect) { e.reply('你还没有加入宗门，可 #创建宗门 或 #加入宗门'); return true }
      const sid = p.sect
      const s = f.sects[sid]
      if (!s) { e.reply('你所属宗门已不存在（可能被灭门/重建），请重新加入'); return true }
      const sm = f.sectMap[sid] || {}
      const owner = s.owner ? (f.players[s.owner] || null) : null
      const v = getVault(f, sid)
      const inj = injuryInfo(p)
      const region = sectRegion(f, sid)
      const areas = Object.keys(f.areas || {}).filter(a => f.areas[a] === sid).join('、') || '无地盘'
      const fakes = sectAlive(f, sid)
      const injTxt = inj.level > 0 ? `\n伤势：${['', '轻伤', '中伤', '重伤'][inj.level] || inj.level}（战力-${inj.pct}%，还需 ${inj.remainMin} 分恢复）` : ''
      const fac = s.facilities || {}
      const lines = [
        `宗门：${sectName(f, sid)}（${regionNameOf(region)}）`,
        `我的身份：${posCn(p.pos)}`,
        `贡献：${(p.pos === 'zongzhu' || p.pos === 'fuzong' || p.pos === 'taishang') ? '无需贡献（可直接 #取用宝库）' : `${p.contribution || 0}`}${injTxt}`,
        '',
        `宗主：${owner ? `🌙${owner.name}（玩家）` : (sm.zongzhu || '（空缺·副宗代掌）')}`,
        `宗门成员：${sectOccupancy(f, sid)}/${sectMemberCapacity(f, sid)} 人`,
        `宝库灵石：${v.stones || 0}`,
        `设施：演武场${fac.yanwu || 0}级/护山阵${fac.hushan || 0}级/灵脉${fac.lingmai || 0}级/药园${fac.yaoyuan || 0}级`,
        `地盘：${areas}`,
        `关系：${relTxt(f, sid)}`,
        '',
        '查看：#宗门宝库 / #宗门设施 / #宗门成员 / #宗门职位 / #宗门关系'
      ]
      await replyLines(e, `🏯 ${sectName(f, sid)} · 我的宗门`, lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]我的宗门异常:' + (err && err.stack))
      e.reply('查询我的宗门出错了，请稍后再试')
      return true
    }
  }

  async sectVault (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const v = getVault(f, p.sect)
      const matsTxt = Object.keys(v.mats || {}).length ? Object.entries(v.mats).map(([m, c]) => `${itemIcon(m)}${m}×${c}`).join('、') : '（无）'
      const pillsTxt = Object.keys(v.pills || {}).length ? Object.entries(v.pills).map(([m, c]) => `${itemIcon(m)}${m}×${c}`).join('、') : '（无）'
      const equipsTxt = Object.keys(v.equips || {}).length ? Object.entries(v.equips).map(([m, c]) => `${itemIcon(m)}${m}×${c}`).join('、') : '（无）'
      const gongfasTxt = Object.keys(v.gongfas || {}).length ? Object.entries(v.gongfas).map(([m, c]) => `${itemIcon(m)}《${m}》×${c}`).join('、') : '（无）'
      /* 战后维护提示: 3 小时内材料维护×2、灵石维护×5(仅玩家宗主宗门) */
      const lastWarAt = Number((f.sects[p.sect] || {}).lastWarAt) || 0
      const warHint = inWarUpkeep(f, p.sect)
        ? `⏳ 战后整备中：材料维护×2、灵石维护×5（剩 ${Math.max(1, Math.ceil((WAR_UPKEEP_MS - (Date.now() - lastWarAt)) / 60000))} 分钟）`
        : ''
      const lines = [
        `🏯 ${sectName(f, p.sect)} 宝库`,
        `灵石：${v.stones || 0}`,
        ...(warHint ? [warHint] : []),
        `材料：${matsTxt}`,
        `丹药：${pillsTxt}`,
        `装备：${equipsTxt}`,
        `功法：${gongfasTxt}`,
        '',
        '来源：上供/小区产出/药园/炼器/税收分成/战利品',
        '支出：设施建造升级/护城阵/攻打/兑换',
        '#上供 [灵石] 得贡献；#宗门兑换 或 #宗门购装备 [装备全名] 使用贡献'
      ]
      await replyLines(e, '💰 宗门宝库', lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]宝库异常:' + (err && err.stack))
      e.reply('查询宝库出错了，请稍后再试')
      return true
    }
  }

  /* ---- #宗门设施 ---- */
  async sectFacilities (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const s = f.sects[p.sect]
      const fac = s.facilities || {}
      const lines = Object.keys(CFG.FACILITIES).map(k => {
        const t = CFG.FACILITIES[k]
        const lv = fac[k] || 0
        const c = (lv < 5) ? requireCost(k, lv + 1) : null
        return `· ${t.cn}：${lv} 级${lv < 5 ? `（升级需 灵石${c.stones} + ${Object.entries(c.mats).map(([m, n]) => `${itemIcon(m)}${m}×${n}`).join(' ')}）` : '（已满级）'}\n  效果：${t.fx.desc}`
      })
      lines.push('', '#升级设施 演武场/护山阵/灵脉/药园（宗主/副宗/太上）')
      await replyLines(e, `🏯 ${sectName(f, p.sect)} 设施`, lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]设施异常:' + (err && err.stack))
      e.reply('查询设施出错了，请稍后再试')
      return true
    }
  }

  /* ---- #升级设施 [名] ---- */
  async upgradeFacilityCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      if (p.pos !== 'zongzhu' && p.pos !== 'fuzong' && p.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以升级设施'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const m = String(e.msg || '').match(/升级设施\s*(\S*)/)
      const name = (m && m[1]) || ''
      const map = { 演武场: 'yanwu', 护山阵: 'hushan', 灵脉: 'lingmai', 药园: 'yaoyuan' }
      const key = map[name]
      if (!key) { e.reply('可升级：演武场 / 护山阵 / 灵脉 / 药园'); return true }
      const r = upgradeFacility(f, p.sect, key)
      if (r.ok) saveFake(f, gid)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]升级异常:' + (err && err.stack))
      e.reply('升级设施出错了，请稍后再试')
      return true
    }
  }

  /* ---- #升级护城阵 [小区] ---- */
  async upgradeAreaDefCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      if (p.pos !== 'zongzhu' && p.pos !== 'fuzong' && p.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以升级护城阵'); return true }
      const m = String(e.msg || '').match(/升级护城阵\s*(\S*)/)
      const area = (m && m[1]) || ''
      if (!regionOfArea(area)) { e.reply('用法：#升级护城阵 [小区名]（#天下小区 看小区）'); return true }
      if (f.areas[area] !== p.sect) { e.reply('只能升级本宗占领小区的护城阵'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const r = upgradeAreaDef(f, area)
      if (r.ok) saveFake(f, gid)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]护城阵异常:' + (err && err.stack))
      e.reply('升级护城阵出错了，请稍后再试')
      return true
    }
  }

  /* ---- #宗门放弃小区 [小区] ---- */
  async abandonAreaCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      if (p.pos !== 'zongzhu' && p.pos !== 'fuzong' && p.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以放弃小区'); return true }
      const m = String(e.msg || '').match(/(宗门放弃小区|放弃小区)\s*(\S*)/)
      const area = (m && m[2]) ? m[2].trim() : ''
      if (!regionOfArea(area)) { e.reply('用法：#宗门放弃小区 [小区名]（#天下小区 看小区）'); return true }
      const r = abandonArea(f, gid, p.sect, area)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]放弃小区异常:' + (err && err.stack))
      e.reply('放弃小区出错了，请稍后再试')
      return true
    }
  }

  /* ---- #护城阵 ---- */
  async areaDefInfo (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const areas = Object.keys(f.areas).filter(a => f.areas[a] === p.sect)
      if (!areas.length) { e.reply('本宗还没有地盘，可 #攻打 夺取'); return true }
      const lines = areas.map(a => `· ${a}：护城阵 ${areaDefLevel(f, a)} 级（守方战力+${CFG.AREA_DEF_BONUS * areaDefLevel(f, a)}%）`)
      lines.push('', '#升级护城阵 [小区] 可升级（宗主/副宗/太上，护山阵60%消耗）')
      await replyLines(e, `🏯 ${sectName(f, p.sect)} 护城阵`, lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]护城阵异常:' + (err && err.stack))
      e.reply('查询护城阵出错了，请稍后再试')
      return true
    }
  }

  /* ---- #天下小区 ---- */
  async areaPanel (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const lines = []
      for (const k of Object.keys(REGIONS)) {
        if (REGIONS[k].special) continue // 特殊大区(简月王朝)不入 #天下小区
        lines.push(`━━━ ${REGIONS[k].name} ━━━`)
        for (const area of REGIONS[k].areas) {
          const owner = f.areas[area]
          const def = areaDefLevel(f, area)
          /* 休战保护期(小区6~24小时按攻打激烈程度): 显示剩余小时 */
          const cdUntil = f.targetCd['area:' + area] || 0
          const cdTxt = cdUntil > Date.now() ? `（⏳休战期还剩 ${Math.ceil((cdUntil - Date.now()) / 3600000)} 小时）` : ''
          /* 占领宗门已灭门: 视为无主(税率归属也不计) */
          const dead = owner && f.sects[owner] && f.sects[owner].wipeAt
          lines.push(`· ${area}：${dead ? '无主（原宗已灭）' : (owner ? `${sectName(f, owner)}${def ? `（护城阵${def}级）` : ''}` : '（无主）')}${cdTxt}`)
        }
      }
      lines.push('', '━━━ 最近产出 ━━━')
      const out = (f.areaOut || []).slice(-100).reverse()
      if (!out.length) lines.push('（暂无产出记录）')
      for (const o of out) {
        const matsTxt = Object.entries(o.mats || {}).map(([m, c]) => `${itemIcon(m)}${m}×${c}`).join('、') || '无'
        lines.push(`[${fmtTime(o.t)}] ${o.area}（${o.owner}）：灵石+${o.stones}｜${matsTxt}`)
      }
      await replyLines(e, '🏘️ 天下小区', lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]小区异常:' + (err && err.stack))
      e.reply('查询小区出错了，请稍后再试')
      return true
    }
  }

  /* ---- #同意入宗 [名字/全部] ---- */
  async acceptJoin (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const m = String(e.msg || '').match(/(同意入宗|接纳散修|同意加入)\s*(\S*)/)
      const name = (m && m[2]) ? m[2].trim() : '全部'
      const r = answerSectJoin(f, gid, e.user_id, true, name)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]入宗异常:' + (err && err.stack))
      e.reply('处理入宗申请出错了，请稍后再试')
      return true
    }
  }

  /* ---- #拒绝入宗 [名字/全部] ---- */
  async refuseJoin (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const m = String(e.msg || '').match(/(拒绝入宗|婉拒散修|拒绝加入)\s*(\S*)/)
      const name = (m && m[2]) ? m[2].trim() : '全部'
      const r = answerSectJoin(f, gid, e.user_id, false, name)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]入宗异常:' + (err && err.stack))
      e.reply('处理入宗申请出错了，请稍后再试')
      return true
    }
  }

  /* ---- #入宗申请 ---- */
  async joinReqs (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p || !['zongzhu', 'fuzong', 'taishang'].includes(p.pos)) { e.reply('只有宗主/副宗主/太上长老可以查看入宗申请'); return true }
      const sid = p.sect
      const reqs = (f.sectJoinReqs && f.sectJoinReqs[sid]) || []
      if (!reqs.length) { e.reply('当前没有待审批的散修入宗申请'); return true }
      e.reply(`🏯【${sectName(f, sid)}】待审批散修入宗申请（${reqs.length}人）：\n${reqs.map((x, i) => `${i + 1}. ${x.name}`).join('\n')}\n\n#同意入宗 全部接纳 ｜ #同意入宗 名字 单独接纳 ｜ #拒绝入宗 婉拒`)
      return true
    } catch (err) {
      logger.error('[宗门系统]入宗异常:' + (err && err.stack))
      e.reply('查询入宗申请出错了，请稍后再试')
      return true
    }
  }

  /* ---- #宗门成员 ---- */
  async sectMembers (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const players = Object.values(f.players || {}).filter(x => x && x.sect === p.sect)
      const fakes = sectAlive(f, p.sect)
      const lines = [
        `关系：${relTxt(f, p.sect)}`,
        '',
        `🌙 玩家成员（${players.length}）：`,
        ...(players.length ? players.map(x => `· ${posCn(x.pos)} ${x.name}（贡献${x.contribution || 0}${x.pos === 'zongzhu' ? ' 👑' : ''}）`) : ['（暂无）']),
        '',
        `🙈 宗门门人（${fakes.length}）：`,
        ...(fakes.length ? fakes.map(x => `· ${posCn(x.pos)} ${x.name}（${levelNameOf(x.level)} ${x.path}·${x.trait}）`).slice(0, 40) : ['（暂无）'])
      ]
      if (fakes.length > 40) lines.push(`…共 ${fakes.length} 人`)
      await replyLines(e, `🏯 ${sectName(f, p.sect)} 成员`, lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]成员异常:' + (err && err.stack))
      e.reply('查询成员出错了，请稍后再试')
      return true
    }
  }

  /* ---- #宗门职位 ---- */
  async sectPositions (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const sm = f.sectMap[p.sect] || {}
      const players = Object.values(f.players || {}).filter(x => x && x.sect === p.sect)
      const pByPos = { zongzhu: [], fuzong: [], taishang: [], zhishi: [], dizi: [] }
      for (const x of players) { if (pByPos[x.pos]) pByPos[x.pos].push(x.name) }
      const fByPos = { zongzhu: [], fuzong: [], taishang: [], zhishi: [], dizi: [] }
      if (sm.zongzhu) fByPos.zongzhu.push(sm.zongzhu)
      for (const k of ['fuzong', 'taishang', 'zhishi', 'dizi']) { for (const n of (sm[k] || [])) fByPos[k].push(n) }
      const lines = [`关系：${relTxt(f, p.sect)}`]
      for (const k of ['zongzhu', 'fuzong', 'taishang', 'zhishi', 'dizi']) {
        const cn = posCn(k)
        const ps = pByPos[k].length ? pByPos[k].map(n => `🌙${n}`).join('、') : ''
        const fs = fByPos[k].length ? fByPos[k].map(n => `🙈${n}`).join('、') : ''
        const both = [ps, fs].filter(Boolean).join('　')
        lines.push(`· ${cn}：${both || '（空缺）'}`)
      }
      lines.push('', '晋升：执事需贡献50/练气后期(6级)/入宗0天；副宗100/金丹(9级)/1天；宗主200/元婴(13级)/2天；太上300/合体(25级)/席位2')
      lines.push('伪玩家宗主宗门：#晋升 [职位] 自动擢升；玩家宗主宗门：#任命 [职位] @xx（宗主免条件/副宗需达标）')
      await replyLines(e, `🏯 ${sectName(f, p.sect)} 职位`, lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]职位异常:' + (err && err.stack))
      e.reply('查询职位出错了，请稍后再试')
      return true
    }
  }

  /* ---- #宗门关系 ---- */
  async sectRelations (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const s = f.sects[p.sect]
      const enemies = (s.enemies || []).map(id => sectName(f, id))
      const allies = (s.allies || []).map(id => sectName(f, id))
      const lines = [
        `结盟宗门：${allies.length ? allies.join('、') : '（无）'}`,
        '盟友可 #盟友助战 [目标] [人数] 一起攻打（如 #盟友助战 天墉城 3），打赢归贡献最高者；#退盟 [宗名] 解除结盟',
        `敌对宗门：${enemies.length ? enemies.join('、') : '（无）'}`,
        '已宣战/被宣战都会成为敌人，可 #议和 [宗名] 停战；#结盟 [宗名] 化敌为友' 
      ]
      await replyLines(e, `🏯 ${sectName(f, p.sect)} 关系`, lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]关系异常:' + (err && err.stack))
      e.reply('查询关系出错了，请稍后再试')
      return true
    }
  }

  /* ---- #结盟 [宗名]: 双方互为盟友(不限制宗门类型), 宗主/副宗/太上可发起 ---- */
  async allyCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const m = String(e.msg || '').match(/结盟\s*(\S*)/)
      const target = (m && m[1]) || ''
      if (!target) { e.reply('用法：#结盟 [宗门名]（如 #结盟 青云宗）'); return true }
      const r = allySect(f, gid, e.user_id, target)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]结盟异常:' + (err && err.stack))
      e.reply('结盟出错了，请稍后再试')
      return true
    }
  }

  /* ---- #退盟 [宗名] ---- */
  async breakAllyCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const m = String(e.msg || '').match(/(?:退盟|解除结盟|解除同盟)\s*(\S*)/)
      const target = (m && m[1]) || ''
      if (!target) { e.reply('用法：#退盟 [宗门名]'); return true }
      const r = breakAlly(f, gid, e.user_id, target)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]退盟异常:' + (err && err.stack))
      e.reply('退盟出错了，请稍后再试')
      return true
    }
  }

  /* ---- #盟友助战 [目标] [人数]: 派兵协助盟友攻打, 打赢归贡献最高者 ---- */
  async allyAssistCmd (e) {
    try {
      if (this.gate(e)) return true
      if (this.warBlock(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const m = String(e.msg || '').match(/(盟友助战|盟友驰援|驰援盟友|驰援帮忙)\s*(\S*?)(?:\s+([0-9０-９]+))?\s*$/)
      const target = (m && m[1] && m[2]) ? m[2].trim() : ''
      const count = Number((m && m[3]) || 0)
      const r = await allyAssist(f, gid, e.user_id, target, count)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]助战异常:' + (err && err.stack))
      e.reply('助战出错了，请稍后再试')
      return true
    }
  }

  /* ---- #任命 [职位] @xx ---- */
  async appoint (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const me = getPlayer(f, uid)
      if (!me) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, me.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const m = String(e.msg || '').match(/任命\s*(\S*)\s*@?(\d*)/)
      const posName = (m && m[1]) || ''
      let target = e.at ? String(e.at) : ''
      if (!target && m && m[2]) target = m[2]
      const posMap = { 执事: 'zhishi', 副宗主: 'fuzong', 副宗: 'fuzong', 太上长老: 'taishang', 太上: 'taishang' }
      const toPos = posMap[posName]
      if (!toPos) { e.reply('用法：#任命 [执事/副宗主/太上长老] @目标'); return true }
      if (!target) { e.reply('请 @目标 或输入 QQ号'); return true }
      const r = await appointTo(f, gid, uid, target, toPos)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]任命异常:' + (err && err.stack))
      e.reply('任命出错了，请稍后再试')
      return true
    }
  }

  /* ---- #晋升 [职位]: 伪玩家宗主宗门自动擢升 ---- */
  async promoteCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const m = String(e.msg || '').match(/晋升\s*(\S*)/)
      const posName = (m && m[1]) || ''
      const posMap = { 执事: 'zhishi', 副宗主: 'fuzong', 副宗: 'fuzong', 太上长老: 'taishang', 太上: 'taishang' }
      const toPos = posMap[posName]
      if (!toPos) { e.reply('用法：#晋升 [执事/副宗主/太上长老]'); return true }
      const r = await autoPromote(f, gid, uid, toPos)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]晋升异常:' + (err && err.stack))
      e.reply('晋升出错了，请稍后再试')
      return true
    }
  }

  /* ---- #传位 @xx ---- */
  async abdicate (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const me = getPlayer(f, uid)
      if (!me) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, me.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      let target = e.at ? String(e.at) : ''
      if (!target) {
        const m = String(e.msg || '').match(/传位\s*@?(\d+)/)
        if (m) target = m[1]
      }
      if (!target) { e.reply('用法：#传位 @目标（仅宗主）'); return true }
      const r = abdicateTo(f, gid, uid, target)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]传位异常:' + (err && err.stack))
      e.reply('传位出错了，请稍后再试')
      return true
    }
  }

  /* ---- #问退位 / #夺权 ---- */
  async askAbdicateCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const cd = await redis.ttl(`xujing:sect-seize-cd:${gid}:${uid}`)
      if (cd !== -2 && cd > 0) { e.reply(`此操作冷却中：${Math.ceil(cd / 3600)} 小时后再试`); return true }
      const r = await askAbdicate(f, gid, uid)
      if (r.ok || /拒绝了|席位|玩家|空缺/.test(r.msg)) {
        // 拒绝也进冷却(24h)
        await redis.set(`xujing:sect-seize-cd:${gid}:${uid}`, 1, { EX: 24 * 3600 })
      }
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]问退位异常:' + (err && err.stack))
      e.reply('问退位出错了，请稍后再试')
      return true
    }
  }

  async seizePowerCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const cd = await redis.ttl(`xujing:sect-seize-cd:${gid}:${uid}`)
      if (cd !== -2 && cd > 0) { e.reply(`此操作冷却中：${Math.ceil(cd / 3600)} 小时后再试`); return true }
      const r = await seizePower(f, gid, uid)
      await redis.set(`xujing:sect-seize-cd:${gid}:${uid}`, 1, { EX: 24 * 3600 })
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]夺权异常:' + (err && err.stack))
      e.reply('夺权出错了，请稍后再试')
      return true
    }
  }

  /* ---- #宣战 [宗名]（#宗门宣战 别名） ---- */
  async declareWarCmd (e) {
    try {
      if (this.gate(e)) return true
      if (this.warBlock(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const me = getPlayer(f, e.user_id)
      if (!me) { e.reply('你不是宗门成员'); return true }
      if (me.pos !== 'zongzhu' && me.pos !== 'fuzong' && me.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以宣战'); return true }
      const m = String(e.msg || '').match(/(宗门宣战|宣战)\s*(\S*)/)
      const name = (m && m[2]) || ''
      if (!name) { e.reply('用法：#宣战 [宗门名]'); return true }
      const sid = sectIdByName(f, name)
      if (!sid) { e.reply('没有找到该宗门'); return true }
      const sReg = sectRegion(f, sid)
      const w = getWorld(gid)
      if (getLoc(w, e.user_id) !== sReg) { e.reply(`你位于【${regionNameOf(getLoc(w, e.user_id))}】，目标宗门在【${regionNameOf(sReg)}】，请先过去`); return true }
      const r = declareWar(f, gid, me.sect, name)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]宣战异常:' + (err && err.stack))
      e.reply('宣战出错了，请稍后再试')
      return true
    }
  }

  /* ---- #议和 [宗名] ---- */
  async makePeaceCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const me = getPlayer(f, e.user_id)
      if (!me) { e.reply('你不是宗门成员'); return true }
      if (me.pos !== 'zongzhu' && me.pos !== 'fuzong' && me.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以议和'); return true }
      const cd = await redis.ttl(`xujing:sect-peace-cd:${gid}:${e.user_id}`)
      if (cd !== -2 && cd > 0) { e.reply(`议和冷却中：${Math.ceil(cd / 3600)} 小时后再试`); return true }
      const m = String(e.msg || '').match(/(议和|罢兵)\s*(\S*)/)
      const name = (m && m[2]) || ''
      if (!name) { e.reply('用法：#议和 [宗门名]'); return true }
      const r = makePeace(f, gid, me.sect, name)
      if (r.ok) await redis.set(`xujing:sect-peace-cd:${gid}:${e.user_id}`, 1, { EX: 24 * 3600 })
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]议和异常:' + (err && err.stack))
      e.reply('议和出错了，请稍后再试')
      return true
    }
  }

  /* ---- #攻打 [对象]（#宗门攻打/攻打宗门 别名） ---- */
  /* ---- 散修组队 ---- */
  async createTeamCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const m = String(e.msg || '').match(/创建队伍\s*(\S*)/)
      const name = (m && m[1]) || ''
      const nick = (e.sender && (e.sender.card || e.sender.nickname)) || '散修'
      const r = await withTeamLock(gid, f => createRogueTeam(f, gid, e.user_id, name, nick))
      e.reply(r.msg)
      return true
    } catch (err) { logger.error('[宗门系统]创建队伍异常:' + (err && err.stack)); e.reply('创建队伍出错了'); return true }
  }
  async inviteTeamCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      let target = e.at ? String(e.at) : ''
      if (!target) { const m = String(e.msg || '').match(/(?:邀请入队|拉人入队|邀请)\s*@?(\d+)/); if (m) target = m[1] }
      if (!target) { e.reply('用法：#邀请入队 @玩家（队长）'); return true }
      const nick = await getNick(gid, target)
      const r = await withTeamLock(gid, f => inviteRogue(f, gid, e.user_id, target, nick))
      e.reply(r.msg)
      return true
    } catch (err) { logger.error('[宗门系统]邀请异常:' + (err && err.stack)); e.reply('邀请出错了'); return true }
  }
  async agreeTeamCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const r = await withTeamLock(gid, f => agreeRogue(f, gid, e.user_id, true))
      e.reply(r.msg)
      return true
    } catch (err) { logger.error('[宗门系统]同意进队异常:' + (err && err.stack)); e.reply('操作出错了'); return true }
  }
  async refuseTeamCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const r = await withTeamLock(gid, f => agreeRogue(f, gid, e.user_id, false))
      e.reply(r.msg)
      return true
    } catch (err) { logger.error('[宗门系统]拒绝进队异常:' + (err && err.stack)); e.reply('操作出错了'); return true }
  }
  async applyTeamCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      let leader = e.at ? String(e.at) : ''
      if (!leader) { const m = String(e.msg || '').match(/(?:申请进队|申请加入)\s*@?(\d+)/); if (m) leader = m[1] }
      if (!leader) { e.reply('用法：#申请进队 @队长'); return true }
      const nick = (e.sender && (e.sender.card || e.sender.nickname)) || String(e.user_id)
      const r = await withTeamLock(gid, f => applyRogue(f, gid, e.user_id, leader, nick))
      e.reply(r.msg)
      return true
    } catch (err) { logger.error('[宗门系统]申请进队异常:' + (err && err.stack)); e.reply('申请出错了'); return true }
  }
  async agreeApplyCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const r = await withTeamLock(gid, f => respondApply(f, gid, e.user_id, true))
      e.reply(r.msg)
      return true
    } catch (err) { logger.error('[宗门系统]同意申请异常:' + (err && err.stack)); e.reply('操作出错了'); return true }
  }
  async refuseApplyCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const r = await withTeamLock(gid, f => respondApply(f, gid, e.user_id, false))
      e.reply(r.msg)
      return true
    } catch (err) { logger.error('[宗门系统]拒绝申请异常:' + (err && err.stack)); e.reply('操作出错了'); return true }
  }
  async kickTeamCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      let target = e.at ? String(e.at) : ''
      if (!target) { const m = String(e.msg || '').match(/(?:踢出队伍|踢人出队)\s*@?(\d+)/); if (m) target = m[1] }
      if (!target) { e.reply('用法：#踢出队伍 @xx（队长）'); return true }
      const r = await withTeamLock(gid, f => kickRogue(f, gid, e.user_id, target))
      e.reply(r.msg)
      return true
    } catch (err) { logger.error('[宗门系统]踢人异常:' + (err && err.stack)); e.reply('操作出错了'); return true }
  }
  async transferTeamCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      let target = e.at ? String(e.at) : ''
      if (!target) { const m = String(e.msg || '').match(/(?:转让队长|移交队长)\s*@?(\d+)/); if (m) target = m[1] }
      if (!target) { e.reply('用法：#转让队长 @xx（队长）'); return true }
      const nick = await getNick(gid, target)
      const r = await withTeamLock(gid, f => transferRogue(f, gid, e.user_id, target, nick))
      e.reply(r.msg)
      return true
    } catch (err) { logger.error('[宗门系统]转让队长异常:' + (err && err.stack)); e.reply('操作出错了'); return true }
  }
  async quitTeamCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const r = await withTeamLock(gid, f => quitRogue(f, gid, e.user_id))
      e.reply(r.msg)
      return true
    } catch (err) { logger.error('[宗门系统]退出队伍异常:' + (err && err.stack)); e.reply('操作出错了'); return true }
  }
  async disbandTeamCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const r = await withTeamLock(gid, f => disbandRogue(f, gid, e.user_id))
      e.reply(r.msg)
      return true
    } catch (err) { logger.error('[宗门系统]解散队伍异常:' + (err && err.stack)); e.reply('操作出错了'); return true }
  }
  async teamInfoCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id); const f = getFake(gid)
      const t = rogueTeamOf(f, e.user_id)
      if (!t) { e.reply('你不在任何玩家小队中~ 可 #创建队伍 开队'); return true }
      const me = String(e.user_id)
      const lines = []
      lines.push(`🎯 玩家小队【${t.name}】`)
      lines.push(`队长：${t.leaderName}${t.leader === me ? '（你）' : ''}`)
      lines.push(`人数：${t.members.length}/${CFG.ROGUE_TEAM_MAX}`)
      for (const u of t.members) {
        const n = u === me ? (t.leader === u ? '队长·你' : '你') : await getNick(gid, u)
        lines.push(`· ${n}`)
      }
      lines.push('', '队长：#邀请入队 / #踢出队伍 / #转让队长 / #解散队伍')
      lines.push('成员：#退出队伍 ｜ 组队攻打宗门：#攻打 宗门名（队长发起）')
      await replyLines(e, '🎯 玩家小队', lines)
      return true
    } catch (err) { logger.error('[宗门系统]队伍状态异常:' + (err && err.stack)); e.reply('查看队伍出错了'); return true }
  }

  async attackCmd (e) {
    try {
      if (this.gate(e)) return true
      if (this.warBlock(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const me = getPlayer(f, uid)
      const team = rogueTeamOf(f, uid)
      const m = String(e.msg || '').match(/(宗门攻打|攻打宗门|攻打)\s*(\S*)/)
      const target = (m && m[2]) ? m[2].trim() : ''
      if (!target) { e.reply('用法：#攻打 小区名 或 宗门名（#天下小区 / #天下宗门 查看）'); return true }
      /* 玩家小队: 有无宗门均可组队攻打别人的宗门；这不是宗门战争 */
      if (team) {
        if (team.leader !== String(uid)) { e.reply('只有玩家小队队长可以发起小队攻打'); return true }
        const w = getWorld(gid)
        const sid = sectIdByName(f, target)
        if (!sid) { e.reply('目标不存在：请输入宗门名（#天下宗门 查看）'); return true }
        const sReg = sectRegion(f, sid)
        if (getLoc(w, uid) !== sReg) { e.reply(`你位于【${regionNameOf(getLoc(w, uid))}】，目标${sectTxtOf(f, sid)}，请先过去`); return true }
        const nick = (e.sender && (e.sender.card || e.sender.nickname)) || '玩家'
        const r = await withTeamLock(gid, current => startRogueAttack(current, gid, uid, target, nick))
        if (!r.ok) { e.reply(r.msg); return true }
        e.reply(r.msg)
        return true
      }
      /* 无玩家小队时，沿用原来的散修单人/宗门身份规则 */
      if (!me) {
        const w = getWorld(gid)
        const myLoc = getLoc(w, uid)
        const sid = sectIdByName(f, target)
        if (!sid) { e.reply('目标不存在：请输入 宗门名（#天下宗门 查看）'); return true }
        const sReg = sectRegion(f, sid)
        if (myLoc !== sReg) { e.reply(`你位于【${regionNameOf(myLoc)}】，目标${sectTxtOf(f, sid)}，请先过去`); return true }
        const nick = (e.sender && (e.sender.card || e.sender.nickname)) || '散修'
        const r = await withTeamLock(gid, current => startRogueAttack(current, gid, uid, target, nick))
        if (!r.ok) { e.reply(r.msg); return true }
        const teamName = (r.atk && r.atk.teamName) || '玩家小队'
        /* 通知被攻方玩家宗主 */
        try {
          const owner = f.sects[sid] && f.sects[sid].owner
          if (owner) {
            const g = Bot.pickGroup(gid)
            if (g && g.sendMsg) {
              g.sendMsg([segment.at(Number(owner)), `\n🏯【宗门警报】玩家小队【${teamName}】正在攻打${sectTxtOf(f, sid)}！\n30分钟内请回复：\n#守 （坚守迎战）\n#不守 （弃守）`])
            }
          }
        } catch (err) { }
        e.reply(r.msg)
        return true
      }
      if (me.pos !== 'zongzhu' && me.pos !== 'fuzong' && me.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以发起攻打'); return true }
      /* 位置校验: 发起人须与目标同大区 */
      const w = getWorld(gid)
      const myLoc = getLoc(w, uid)
      const tReg = regionOfArea(target)
      if (tReg) {
        if (myLoc !== tReg) { e.reply(`你位于【${regionNameOf(myLoc)}】，目标${areaTxtOf(f, target)}，请先过去`); return true }
      } else {
        const sid = sectIdByName(f, target)
        if (!sid) { e.reply('目标不存在：请输入 小区名 或 宗门名'); return true }
        const sReg = sectRegion(f, sid)
        if (myLoc !== sReg) { e.reply(`你位于【${regionNameOf(myLoc)}】，目标${sectTxtOf(f, sid)}，请先过去`); return true }
      }
      const r = await startSectAttack(f, gid, me.sect, target, 'player')
      if (!r.ok) { e.reply(r.msg); return true }
      /* 通知被攻方玩家宗主 */
      try {
        const defSect = r.atk ? (r.atk.targetType === 'sect' ? r.atk.target : f.areas[r.atk.target]) : null
        if (defSect) {
          const owner = f.sects[defSect] && f.sects[defSect].owner
          if (owner) {
            const g = Bot.pickGroup(gid)
            if (g && g.sendMsg) {
              g.sendMsg([segment.at(Number(owner)), `\n🏯【宗门警报】${sectName(f, me.sect)} 正在攻打${warTargetTxt(f, r.atk)}！\n30分钟内请回复：\n#守 （坚守迎战）\n#不守 （弃守）`])
            }
          }
        }
      } catch (err) { }
      e.reply(r.msg + '\n本宗成员可发 #参战 集结人手')
      return true
    } catch (err) {
      logger.error('[宗门系统]攻打异常:' + (err && err.stack))
      e.reply('发起攻打出错了，请稍后再试')
      return true
    }
  }

  /* ---- #撤退（#撤兵/终止攻打/收兵/停止攻打 别名） ---- */
  async abortAttackCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = String(e.user_id)
      const f = getFake(gid)
      const now = Date.now()
      /* 玩家小队队长: 优先终止自己发起的小队攻打；宗门玩家也可兼任小队队长 */
      const team = rogueTeamOf(f, uid)
      if (team && team.leader === uid) {
        const atk = (f.sectAttacks || []).find(a => a.phase !== 'done' && a.by === 'rogue' && String(a.rogue) === uid)
        if (atk) {
          const r = await abortSectAttack(f, gid, atk, now, '队长')
          e.reply(r.msg)
          return true
        }
      }
      /* 宗门成员: 宗主/副宗/太上可终止本宗在途攻打 */
      const me = getPlayer(f, uid)
      if (me) {
        if (me.pos !== 'zongzhu' && me.pos !== 'fuzong' && me.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以终止攻打'); return true }
        const atk = (f.sectAttacks || []).find(a => a.phase !== 'done' && a.atkSect === me.sect)
        if (!atk) { e.reply('本宗当前没有在进行中的攻打'); return true }
        const r = await abortSectAttack(f, gid, atk, now, `${posCn(me.pos)} ${me.name}`)
        e.reply(r.msg)
        return true
      }
      /* 散修: 队长可终止本小队在途攻打 */
      if (team && team.leader === uid) {
        const atk = (f.sectAttacks || []).find(a => a.phase !== 'done' && a.by === 'rogue' && String(a.rogue) === uid)
        if (!atk) { e.reply('本小队当前没有在进行中的攻打'); return true }
        const r = await abortSectAttack(f, gid, atk, now, '队长')
        e.reply(r.msg)
        return true
      }
      e.reply('你没有可终止的攻打（宗门成员需宗主/副宗/太上，散修需队长）')
      return true
    } catch (err) {
      logger.error('[宗门系统]终止攻打异常:' + (err && err.stack))
      e.reply('终止攻打出错了，请稍后再试')
      return true
    }
  }

  /* ---- #守 [目标] / #不守 [目标] / #攻 [目标] ---- */
  async defendCmd (e) {
    /* #守 [目标]: 无目标=被攻宗主决策坚守; 有目标=被攻宗主指定某处坚守决策, 普通成员则加入该处防守 */
    const m = String(e.msg || '').match(/^[#＃]?守\s*(\S*)/)
    const target = (m && m[1]) ? m[1].trim() : ''
    if (target) {
      if (this.pendingDefTarget(e, target)) return this.doDefend(e, true, target)
      return this.doJoinTarget(e, 'def', target)
    }
    return this.doDefend(e, true, '')
  }
  async notDefendCmd (e) {
    const m = String(e.msg || '').match(/^[#＃]?不守\s*(\S*)/)
    const target = (m && m[1]) ? m[1].trim() : ''
    return this.doDefend(e, false, target || '')
  }
  /** 是否 该用户是可决策者 且 目标处有待回应的攻打(用于 #守 [目标] 分派决策/加入) */
  pendingDefTarget (e, target) {
    try {
      if (!e.group_id) return false
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p || !p.sect) return false
      const s = f.sects[p.sect]
      const canDecide = s && ((s.owner === String(e.user_id) && p.pos === 'zongzhu') || p.pos === 'fuzong' || p.pos === 'taishang')
      if (!canDecide) return false
      if (regionOfArea(target)) return (f.sectAttacks || []).some(a => a.phase === 'prep' && !a.defenderDecided && a.targetType === 'area' && a.target === target && f.areas[a.target] === p.sect)
      const sid = sectIdByName(f, target)
      /* 宗门目标: 仅当是本宗自身被攻打(宗主/副宗/太上决策)才算待回应 */
      return sid === p.sect && (f.sectAttacks || []).some(a => a.phase === 'prep' && !a.defenderDecided && a.targetType === 'sect' && a.target === sid)
    } catch (err) { return false }
  }
  async doDefend (e, doDefend, rawTarget = '') {
    try {
      if (this.warBlock(e)) return true
      if (!e.group_id) return false
      if (!isEnabled(e.group_id)) return false
      const gid = String(e.group_id)
      const f = getFake(gid)
      const p = getPlayer(f, e.user_id)
      if (!p) return false
      const s = f.sects[p.sect]
      const canDecide = (s && s.owner === String(e.user_id) && p.pos === 'zongzhu') || p.pos === 'fuzong' || p.pos === 'taishang'
      if (!s || !canDecide) return false
      const r = respondDefend(f, gid, e.user_id, doDefend, rawTarget || null)
      if (!r.ok) {
        /* 指定了目标仍未决 → 明确告知; 未指定目标保持原静默让位 */
        if (rawTarget) { e.reply(r.msg); return true }
        return false
      }
      e.reply(r.msg)
      return true
    } catch (err) { return false }
  }

  /** 玩家选择执行: #守 [目标] 普通成员加入防守 */
  async doJoinTarget (e, side, raw) {
    try {
      if (this.gate(e)) return true
      if (this.warBlock(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const r = joinSectFight(f, gid, uid, side, false, raw)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]参战异常:' + (err && err.stack))
      e.reply('操作出错了，请稍后再试')
      return true
    }
  }

  /* ---- #参战 [目标] / #退战 [目标]: 自动分边加入/退出本宗的攻打或防守 ----
   *   #参与攻打/#宗门防守 为明确分边的旧别名(隐藏); #退出攻打/#退出防守/#退出参战 同 #退战 */
  async joinFightCmd (e) { return this.doJoinFight(e, 'auto', false) }
  async joinAttackCmd (e) { return this.doJoinFight(e, 'atk', false) }
  async joinDefendCmd (e) { return this.doJoinFight(e, 'def', false) }
  async quitFightCmd (e) { return this.doJoinFight(e, 'auto', true) }
  async doJoinFight (e, side, quit) {
    try {
      if (this.gate(e)) return true
      if (this.warBlock(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      /* 可带目标(#参战 天墉城 / #退战 青云宗): 多处战事时指定打/守哪一处 */
      const m = String(e.msg || '').match(/(?:参战|参与攻打|加入攻打|宗门防守|加入防守|退战|退出参战|退出攻打|退出战斗|退出防守|退出守御|攻)\s*(\S*)/)
      const target = (m && m[1]) ? m[1].trim() : ''
      const p = getPlayer(f, uid)
      /* 散修(无宗门档案): 不能加入宗门攻防, 但可 #退战 退出自己所在的小队攻打(否则战争期锁无法解除) */
      if (!p) {
        if (!quit) { e.reply('你不是宗门成员'); return true }
        const rr = quitRogueParticipation(f, gid, uid, target || null)
        e.reply(rr.msg)
        return true
      }
      /* #参战/#退战 自动分边(joinSectFight 内解析); 只按目标大区校验, 不强制回宗门大区 */
      const r = joinSectFight(f, gid, uid, side, quit, target || null)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]参战异常:' + (err && err.stack))
      e.reply('操作出错了，请稍后再试')
      return true
    }
  }

  /* ---- #派兵/#添兵/#减兵/#撤兵 [目标] [人数]: 统一调兵; 减兵不退传送费, 减到0直接终止 ---- */
  async sectForceCmd (e) {
    try {
      if (this.gate(e)) return true
      if (this.warBlock(e)) return true
      const gid = String(e.group_id)
      const m = String(e.msg || '').match(/(派兵|添兵|减兵|撤兵)\s*(\S*?)(?:\s+([0-9０-９]+))?\s*$/)
      const verb = m ? m[1] : '派兵'
      const target = (m && m[2]) ? m[2].trim() : ''
      const count = Number((m && m[3]) || 1)
      const delta = (verb === '减兵' || verb === '撤兵') ? -count : count
      const r = await sectForceAdjust(getFake(gid), gid, e.user_id, target, delta)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]调兵异常:' + (err && err.stack))
      e.reply('调兵出错了，请稍后再试')
      return true
    }
  }

  /* ---- #驰援 [目标] [人数]: 被攻打时宗主中途调兵(无参: 单处直接驰援, 多处列出选择) ---- */
  async sectReinforceCmd (e) {
    try {
      if (this.gate(e)) return true
      if (this.warBlock(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const m = String(e.msg || '').match(/(驰援功法|宗门驰援|驰援)\s*(\S*?)(?:\s+([0-9０-９]+))?\s*$/)
      const target = (m && m[1] && m[2]) ? m[2].trim() : ''
      const count = Number((m && m[3]) || 0)
      const r = sectReinforce(f, gid, uid, target, count)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]驰援异常:' + (err && err.stack))
      e.reply('驰援出错了，请稍后再试')
      return true
    }
  }

  /* ---- #集结仆从 [目标] [人数]: 仆从参与本宗攻打/守城(无参: 单处直接集结, 多处列出选择) ---- */
  async sectServantRallyCmd (e) {
    try {
      if (this.gate(e)) return true
      if (this.warBlock(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const m = String(e.msg || '').match(/(集结仆从|仆从集结)\s*(\S*?)(?:\s+([0-9０-９]+))?\s*$/)
      const target = (m && m[1] && m[2]) ? m[2].trim() : ''
      const count = Number((m && m[3]) || 0)
      const r = await sectServantRally(f, gid, e.user_id, target, count)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]仆从集结异常:' + (err && err.stack))
      e.reply('集结仆从出错了，请稍后再试')
      return true
    }
  }

  /* ---- #处置俘虏 [全杀|搜刮再杀|全放|搜刮再放|关天牢] (无参=处置界面) ---- */
  async handleCaptivesCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const me = getPlayer(f, uid)
      if (!me) { e.reply('你不是宗门成员'); return true }
      if (me.pos !== 'zongzhu' && me.pos !== 'fuzong' && me.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以处置俘虏'); return true }
      const m = String(e.msg || '').match(/处置俘虏\s*(\S*)\s*(收编|全杀|搜刮再杀|全放|搜刮再放|关天牢|送矿山|送往矿山)?/)
      let name = (m && m[1]) || ''
      let act = (m && m[2]) || ''
      /* 兼容 "#处置俘虏 全杀"(第一个词是动作, 不是名字) */
      if (['收编', '全杀', '搜刮再杀', '全放', '搜刮再放', '关天牢', '送矿山', '送往矿山'].includes(name)) { act = name; name = '' }
      const code = name.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
      const quickAct = {
        1: '全杀', 2: '搜刮再杀', 3: '全放', 4: '搜刮再放',
        5: '收编', 6: '关天牢', 7: '送矿山'
      }[code]
      if (quickAct) { act = quickAct; name = '' }
      if (!act) {
        /* 无参: 显示俘虏处置界面(含收编/单独处置; 攻方赢/守方赢都有俘虏可处置) */
        const pending = pendingCaptivesForSect(f, me.sect, true)
        if (!pending) { e.reply('当前没有待处置的俘虏'); return true }
        /* 菜单门: 记录"本宗高层最近打开过处置界面", 裸数字回复只在此窗口内接管,
           避免宗门有待处置俘虏期间(最长24小时)任意裸数字 1~7 都被误判为处置指令(莫名其妙触发) */
        try { await redis.set(`xujing:captive-menu:${gid}:${uid}`, '1', { EX: 300 }) } catch (err) { }
        const myAtk = pending.atk
        const names = [...pending.fakes, ...pending.players.map(u => (f.players[u] || {}).name || u)]
        const liveFakes = pending.fakes.filter(n => f.roster[n] && f.roster[n].alive)
        const staleN = pending.fakes.length - liveFakes.length
        const lines = [
          `🎯 俘虏处置（${sectName(f, me.sect)}）`,
          `被俘：有效伪玩家 ${liveFakes.length} 名 + 玩家 ${pending.players.length} 名${staleN ? `（另有失效记录${staleN}名，将自动清理）` : ''}`,
          `名单：${names.join('、') || '（无）'}`,
          '',
          '请选择处置方式（本菜单打开后5分钟内可直接回复 1~7，或 #处置俘虏1~7 / #处置俘虏 全杀等）：',
          '1️⃣ 全杀（杀光，不搜刮）',
          '2️⃣ 搜刮再杀（搜刮全部后处决）',
          '3️⃣ 全放（直接释放）',
          '4️⃣ 搜刮再放（搜刮全部后释放）',
          '5️⃣ 收编（劝降拜入本宗，宁死不降者保留）',
          '6️⃣ 关天牢（无限期关押，可越狱：关押越久成功率越高，满24小时必成）',
          '7️⃣ 送矿山（押去矿山挖矿，每小时产出灵石/矿物入宗门宝库，玩家不可送）',
          '📌 单独处置：#处置俘虏 [名字] 动作（如 #处置俘虏 张三 收编）'
        ]
        await replyLines(e, '⛓️ 处置俘虏', lines)
        return true
      }
      const r = await handleCaptives(f, gid, me.sect, act, name || null, false, uid)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]俘虏异常:' + (err && err.stack))
      e.reply('处置俘虏出错了，请稍后再试')
      return true
    }
  }

  /* ---- 裸数字回复 处置俘虏: 宗主/副宗/太上在处置界面后直接回复 1~7 ---- */
  async captivePickCmd (e) { return false } // 数字交互统一由 sect_war.warPick 路由

  /* ---- #宗门矿山: 查看本宗矿山矿工与产出 ---- */
  async sectMineCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const me = getPlayer(f, uid)
      if (!me) { e.reply('你不是宗门成员'); return true }
      const arr = (f.sectMines && f.sectMines[me.sect]) || []
      if (!arr.length) { e.reply(`【${sectName(f, me.sect)}】矿山空无一人（战俘可 #处置俘虏 送矿山 押去挖矿）`); return true }
      const now = Date.now()
      const lines = arr.map((m, i) => {
        const p = f.roster[m.name]
        const lv = p ? (p.level || 1) : 1
        const durMin = Math.max(1, Math.round((now - (m.at || now)) / 60000))
        const outS = m.outStones || 0
        const outM = m.outMats || {}
        const outTxt = Object.keys(outM).length ? Object.entries(outM).map(([k, v]) => `${itemIcon(k)}${k}×${v}`).join('、') : '无'
        return `${i + 1}. ${m.name}（境界${lv} · 已挖${durMin}分钟 · 产出灵石${outS} · 材料：${outTxt}${m.colorHit ? ` · 🌈彩×${m.colorHit}` : ''}）`
      })
      const recent = (f.mineEvents || []).filter(x => x.sect === me.sect).slice(-20).reverse()
      const eventLines = recent.map(x => `· ${fmtTime(x.t)} ${x.txt || '矿山动态'}`)
      await replyLines(e, `⛏️ ${sectName(f, me.sect)}·宗门矿山（战俘挖矿）`, [...lines, '', '━━━ 最近矿山动态 ━━━', ...(eventLines.length ? eventLines : ['（暂无动态）'])])
      return true
    } catch (err) {
      logger.error('[宗门系统]矿山异常:' + (err && err.stack))
      return true
    }
  }

  /* ---- #天下矿山: 查看本群所有宗门矿山(含伪玩家宗门) ---- */
  async allMinesCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const mines = f.sectMines || {}
      const entries = Object.entries(mines).filter(([sid, arr]) => arr && arr.length && f.sects && f.sects[sid])
      if (!entries.length) { e.reply('⛏️ 天下暂无矿山（宗门战胜方可将战俘 #处置俘虏 送矿山 挖矿）'); return true }
      const now = Date.now()
      const lines = entries.map(([sid, arr]) => {
        const sname = sectName(f, sid)
        const totalS = arr.reduce((a, m) => a + (m.outStones || 0), 0)
        const totalM = {}
        for (const m of arr) for (const [k, v] of Object.entries(m.outMats || {})) totalM[k] = (totalM[k] || 0) + v
        const colorN = arr.reduce((a, m) => a + (m.colorHit || 0), 0)
        const matTxt = Object.keys(totalM).length ? Object.entries(totalM).map(([k, v]) => `${itemIcon(k)}${k}×${v}`).join('、') : '无'
        return `⛏️【${sname}】矿工 ${arr.length} 人 · 累计产出灵石 ${totalS} · 材料 ${matTxt}${colorN ? ` · 🌈彩×${colorN}` : ''}`
      })
      const recent = (f.mineEvents || []).slice(-40).reverse()
      if (recent.length) lines.push('', '━━━ 最近矿山动态 ━━━', ...recent.map(x => `· ${fmtTime(x.t)} ${x.txt || '矿山动态'}`))
      await replyLines(e, '⛏️ 天下矿山（宗门战俘挖矿）', lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]天下矿山异常:' + (err && err.stack))
      return true
    }
  }

  /* ---- #宗门天牢 ---- */
  async sectJailCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const me = getPlayer(f, uid)
      if (!me) { e.reply('你不是宗门成员'); return true }
      const arr = sectJailList(f, me.sect)
      if (!arr.length) { e.reply('本宗天牢空无一人'); return true }
      const now = Date.now()
      const lines = arr.map((x, i) => {
        const durMin = Math.max(1, Math.round((now - (x.at || now)) / 60000))
        const pct = Math.round(escapeRateOf(x.at, now) * 100)
        return `${i + 1}. ${x.name}（无限期 · 已关${durMin}分钟 · 越狱成功率${pct}%${x.uid ? ' · 可#越狱' : ''}，#释放俘虏 ${x.name}）`
      })
      await replyLines(e, `⛓️ ${sectName(f, me.sect)}·宗门天牢`, lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]天牢异常:' + (err && err.stack))
      return true
    }
  }

  /* ---- #释放俘虏 [名字] ---- */
  async releaseCaptiveCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const me = getPlayer(f, uid)
      if (!me) { e.reply('你不是宗门成员'); return true }
      if (me.pos !== 'zongzhu' && me.pos !== 'fuzong' && me.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以释放俘虏'); return true }
      const m = String(e.msg || '').match(/释放俘虏\s*(\S+)/)
      const name = (m && m[1]) || ''
      if (!name) { e.reply('用法：#释放俘虏 [名字]'); return true }
      const r = await releaseSectJail(f, gid, me.sect, name)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]释放俘虏异常:' + (err && err.stack))
      return true
    }
  }

  /* ---- #越狱 (被关天牢的玩家尝试越狱: 30分钟冷却, 关押越久成功率越高, 满24小时必成) ---- */
  async escapeCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const r = await playerEscape(f, gid, uid)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]越狱异常:' + (err && err.stack))
      return true
    }
  }

  /* ---- #拯救 [@玩家/名字] (花30分钟救出被关天牢的玩家; 期间施救者只能查看信息; 伪玩家不行) ---- */
  async rescueCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const m = String(e.msg || '').match(/拯救\s*(@?\S*)/)
      const target = e.at ? String(e.at) : ((m && m[1]) ? m[1].replace(/^@/, '') : '')
      if (!target) { e.reply('用法：#拯救 @被关玩家（花30分钟把他从天牢救出来，期间你只能查看信息）'); return true }
      /* 支持直接发名字: 名字→在天牢玩家中匹配 uid */
      let tUid = target
      if (!/^\d+$/.test(target)) {
        for (const sid of Object.keys(f.sectJails || {})) {
          const x = (f.sectJails[sid] || []).find(y => y.uid && y.name === target)
          if (x) { tUid = x.uid; break }
        }
      }
      const r = await startRescue(f, gid, uid, tUid)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]拯救异常:' + (err && err.stack))
      return true
    }
  }

  /* ---- #拉人入宗 [伪玩家名]: 玩家宗主/副宗/太上 招揽散修入宗 ---- */
  async recruitFakeCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const me = getPlayer(f, uid)
      if (!me) { e.reply('你不是宗门成员'); return true }
      if (me.pos !== 'zongzhu' && me.pos !== 'fuzong' && me.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以招人入宗'); return true }
      const m = String(e.msg || '').match(/(?:拉人入宗|招收弟子|招人入宗)\s*(\S*)/)
      const name = (m && m[1]) || ''
      const r = recruitFakeToSect(f, gid, me.sect, name)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]招人异常:' + (err && err.stack))
      e.reply('招人入宗出错了，请稍后再试')
      return true
    }
  }

  /* ---- #挖角 [伪玩家名]: 玩家宗主/副宗/太上 挖其他宗门弟子 ---- */
  async poachFakeCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const me = getPlayer(f, uid)
      if (!me) { e.reply('你不是宗门成员'); return true }
      if (me.pos !== 'zongzhu' && me.pos !== 'fuzong' && me.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以挖角'); return true }
      const m = String(e.msg || '').match(/挖角\s*(\S*)/)
      const name = (m && m[1]) || ''
      const r = poachFakeFromSect(f, gid, me.sect, name)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]挖角异常:' + (err && err.stack))
      e.reply('挖角出错了，请稍后再试')
      return true
    }
  }

  /* ---- #维护宗门 [灵石] ---- */
  async maintainCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const me = getPlayer(f, uid)
      if (!me) { e.reply('你不是宗门成员'); return true }
      if (me.pos !== 'zongzhu' && me.pos !== 'fuzong' && me.pos !== 'taishang') { e.reply('只有宗主/副宗主/太上长老可以维护宗门'); return true }
      const sr = sameRegion(e, f, me.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const m = String(e.msg || '').match(/维护宗门\s*(\d*)/)
      const amount = Number((m && m[1]) || 0)
      if (!amount) {
        const s = f.sects[me.sect]
        const v = getVault(f, me.sect)
        e.reply(`🏯 ${sectName(f, me.sect)} 维护概览\n宝库灵石：${v.stones || 0}\n设施：演武场${s.facilities.yanwu}级/护山阵${s.facilities.hushan}级/灵脉${s.facilities.lingmai}级/药园${s.facilities.yaoyuan}级\n用法：#维护宗门 [灵石] 投入宝库灵石增强繁荣度（500灵石=1繁荣，每5分钟结算一次，促进小区产出）`)
        return true
      }
      const v = getVault(f, me.sect)
      if ((v.stones || 0) < amount) { e.reply(`宝库灵石不足（现有 ${v.stones || 0}）`); return true }
      /* 繁荣度结算冷却: 每5分钟可结算维护一次 */
      const s = f.sects[me.sect]
      const mAt = s.maintainAt || 0
      if (mAt > Date.now()) { e.reply(`⏳ 繁荣度结算冷却中，${Math.ceil((mAt - Date.now()) / 60000)} 分钟后可再次维护（每5分钟结算一次）`); return true }
      v.stones -= amount
      const w = getWorld(gid)
      const name = sectName(f, me.sect)
      w.prosperity[name] = (w.prosperity[name] || 0) + Math.floor(amount / 500)
      s.maintainAt = Date.now() + 5 * 60000
      saveWorld(w)
      saveFake(f, gid)
      e.reply(`✅ 已投入 ${amount} 灵石维护宗门，${name} 繁荣度 +${Math.floor(amount / 500)}（每5分钟结算一次，促进小区产出）`)
      return true
    } catch (err) {
      logger.error('[宗门系统]维护异常:' + (err && err.stack))
      e.reply('维护宗门出错了，请稍后再试')
      return true
    }
  }

  /* ---- #组队玩法 散修组队说明(渲染图片, 任何群可看) ---- */
  async rogueGuide (e) {
    try {
      const lines = [
        '🎯 玩家组队玩法',
        '',
        '【什么是玩家小队】',
        '· 有无宗门的玩家都可以组队（最多4人）一起闯江湖，宗门身份不会阻止组队',
        '· 组队后可进入遗蜕秘境，队长收到遭遇时可以带队与玩家/伪玩家交战',
        '',
        '【建队 / 入队】',
        '· #创建队伍 [队名]：开队当队长（免费，队名8字内）',
        '· 队长 #邀请入队 @玩家 → 对方 #同意进队（或 #拒绝进队）',
        '· 或自己 #申请进队 @队长 → 队长 #同意申请（或 #拒绝申请）',
        '',
        '【队伍管理】',
        '· #我的队伍：查看队伍信息',
        '· #转让队长 @xx：把队长移交队友',
        '· #踢出队伍 @xx：队长踢人',
        '· #退出队伍：普通队员退队；队长退出=解散队伍',
        '· #解散队伍：队长解散',
        '',
        '【组队攻打宗门】',
        '· 有无宗门的玩家都可组队，队长使用 #攻打 宗门名，以玩家小队身份攻打别人的宗门；不等于宗门对宗门宣战',
        '· 打赢：宗门总部被攻破即永久灭门；洗劫宝库30%灵石，按实际参战队员分配（含参战后负伤或退场者）。',
        '· 准备期30分钟；开战后退战/撤退要承担当前回合，凌晨1~6点暂停并顺延。',
        '· 全体队员须与目标宗门同大区（#去[大区] 前往）',
        '',
        '【注意】',
        '· 有宗门也可组队，但每个人同一时间只能占用一个战场；小队攻破总部同样触发灭门。',
        '· 玩家小队可组队攻打别人的宗门，不能把本队成员所属宗门作为目标'
      ]
      await replyLines(e, '🎯 玩家组队玩法', lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]组队玩法异常:' + (err && err.stack))
      e.reply('组队玩法说明生成失败，请稍后再试')
      return true
    }
  }

  /* ---- #宗门玩法 全部玩法大全(渲染图片, 任何群可看) ---- */
  async sectGuide (e) {
    try {
      const lines = [
        '🏯 玩家宗门系统 · 玩法大全',
        '',
        '【开启】主人 #宗门系统白名单 添加 群号 后可玩（每群独立江湖世界）',
        '',
        '【加入 / 退出】',
        '· #加入宗门 [名]：拜入宗门当弟子（退出原宗后，其他宗门可立即加入）',
        '· #退出宗门 / #退宗：随时退出；仅原宗门 7 天内不可再加入',
        '· #逐出 @xx：宗主/副宗/太上踢人',
        '· #拉人入宗 [名]：招揽散修入宗（宗主/副宗/太上）',
        '· #挖角 [名]：挖其他宗门弟子（忠诚度/性格/宗门兴衰影响成功率）',
        '',
        '【创建宗门】',
        '· #创建宗门 [名] [大区]：散修花灵石开宗立派',
        '· 费用按创建地税率 40万~100万灵石，自任宗主，初始宝库5万',
        '· 新宗门无地盘，需 #攻打 夺取小区',
        '· #宗门改名 [新名]：宗主/副宗/太上给宗门改名（6字以内，不可与现有宗门同名，繁荣/地盘/税收跟随）',
        '· #迁宗 [大区]：宗主/副宗/太上把宗门总部迁往新大区（宝库扣20万灵石、须到新址奠基、旧区地盘保留、24小时冷却）',
        '',
        '【玩家组队】（有无宗门的玩家都可参加）',
        '· #创建队伍 [队名]：开队当队长（免费）',
        '· 队长 #邀请入队 @玩家 → 对方 #同意进队 ｜ 或对方 #申请进队 @队长 → 队长 #同意申请',
        '· #踢出队伍 @xx / #转让队长 @xx / #退出队伍 / #解散队伍 / #我的队伍',
        '· 满2人后队长 #攻打 宗门名：以玩家小队身份攻打别人的宗门，打赢平分对方宝库30%灵石；不是宗门对宗门战争',
        '',
        '【职位与晋升】',
        '职位链：弟子 → 执事 → 副宗主 → 宗主 → 太上长老',
        '· 伪玩家宗主宗门：达标后 #晋升 [执事/副宗主/太上长老] 自动擢升',
        '· 玩家宗主宗门：宗主可直接 #任命（不用条件）；副宗任命需对方达标',
        '· 宗主任命 太上/副宗主 不用等入宗时间；执事任命与 #晋升 自然晋升仍需入宗时间',
        '· 执事：贡献50 / 练气后期(6级) / 入宗3天',
        '· 副宗主：贡献100 / 金丹(9级) / 入宗7天',
        '· 宗主：贡献200 / 元婴(13级) / 入宗15天（禅让/夺权继位）',
        '· 太上长老：贡献300 / 合体(25级)，2席玩家伪玩家共享',
        '· 成为宗主/副宗/太上后无需贡献点：可 #取用宝库 直接拿宗门金库的灵石/材料/丹药',
        '· #任命 [执事/副宗主/太上长老] @xx（仅宗主）',
        '· #传位 @xx（宗主禅让）；#问退位 / #夺权（对伪玩家宗主）',
        '· 夺权需贡献≥300 且 战力≥宗主×1.2；若现任玩家宗主已不在群里，可直接 #夺权 继任（无任何条件）',
        '',
        '【贡献 / 上供 / 兑换】（弟子/执事）',
        '· #上供 [灵石]：每100灵石=1贡献（10分钟冷却，最低100）',
        '· #一键上供功法：将背包内红色及以下功法全部上供给宗门宝库，供伪玩家直接学习（彩色不受理）',
        '· #我的贡献：看当前贡献',
        '· #宗门兑换 [物品] [数量]：贡献换宝库灵石/丹药/材料/装备',
        '  灵石100=20贡献｜普通材料(紫/金)=5｜红材料=800｜彩材料=2000',
        '  修为丹=1｜破障丹=2｜聚宝丹=40｜装备=按品质20~360贡献',
        '· #宗门购装备 [装备全名] [数量]：普通弟子用贡献购买宝库炼出的装备（按品质20~360贡献）',
        '',
        '【宗主 / 副宗 / 太上 · 取用宝库 / 上供】',
        '· 宗主/副宗/太上无需贡献点：可 #取用宝库 [灵石|物品名] [数量] 随时取用宗门金库的灵石/材料/丹药（名称可只输一半，数量支持 灵石5万/5万灵石/全部 等写法）',
        '· 宗主/副宗/太上也可 #上供 给宗门宝库（灵石/材料皆可，无需贡献点，可自行支配）',
        '',
        '【宗门设施】（灵石+材料建造，建成永久，仅灭门消失）',
        '· 演武场：修炼+8%/级 突破成功率+2%/级 攻打战力+2%/级',
        '· 护山阵：被攻打时守方战力+8%/级',
        '· 灵脉：小区产出灵石+10%/级',
        '· #升级设施 演武场/护山阵/灵脉/药园（宗主/副宗/太上）',
        '',
        '【地盘 / 护城阵 / 产出】',
        '· #攻打 [小区或宗门]：小区占领后休战4~12小时；总部失守永久灭门，不保留原宗门等待换皮。',
        '· #升级护城阵 [小区]：守方战力+6%/级（护山阵60%消耗，建成永久）',
        '· #宗门放弃小区 [小区]：宗主/副宗/太上放弃本宗小区，变回无主之地（各方可立即争夺）',
        '· 小区每半小时按当地繁荣度产出灵石+材料进宝库',
        '· 小区被打结算或撤兵后停产3小时；恢复期结束再计30分钟产出第一笔，之后每30分钟一次（玩家/伪玩家宗门相同）',
        '· #天下小区：看各区占领、护城阵等级与产出记录',
        '',
        '【战争】',
        '· #攻打：先打开数字目标菜单；也可 #攻打 [小区或宗门] [人数]。宗门高层或小队队长下令，发起人须在目标大区。',
        '· 宗门发起费2000+本宗人数×400灵石；跨区每人2000灵石，本地免费；拥有定仙游按现有跨区规则处理，封海照常限制。',
        '· 玩家小队≥2人、全员在目标大区且能行动，免费出征；宗门总部攻破即永久灭门，小区失守只易主。',
        '· 先检查目标、冷却、可调兵力、位置和预算，再扣费及宣战；失败不调动守军、不建立敌对关系。',
        '· 准备期30分钟，拉锯每10分钟一轮、最多8轮；凌晨1~6点暂停，准备/回合计时顺延。',
        '· #守 / #不守：高层选择战场后决定坚守或弃守；普通成员 #守 自行加入守军。',
        '· #防守策略：数字选择稳守/保人；也可 #防守策略 稳守 或 保人。无人回应时稳守自动组织兵力，保人弃守；总部被破仍灭门。',
        '· #参战 / #退战：数字选择战场，也可加固定战役编号或目标名；真人只能自己报名，同一人不可同时参加两场战争。',
        '· #派兵 / #添兵 / #驰援 / #减兵：先选战场，再回复人数；也可 #派兵 [战役号或目标] [人数]。指定人数是调兵上限，实际受兵力/预算/封海限制。',
        '· #撤兵 [战场] [人数] 等同减兵；不带参数的 #撤兵 等同撤退。减兵只撤本宗NPC，调兵费用不退。',
        '· 准备期攻军撤空取消本次出征，守军撤空视为弃守；开战后退战/减兵/撤退均在本轮交战后生效，撤退方按败退结算。',
        '· #撤退 [战场]：本方高层或小队队长下令；撤军仍保留战后3小时维护与被打小区停产规则。',
        '· #集结仆从 [战场] [人数]：集结自己收服的仆从；跨区同样受预算与封海限制。',
        '· #盟友助战 [战场] [人数]：派本宗NPC增援盟友，可继续添兵；盟友真人成员须 #参战 自行报名。',
        '· #战法：数字选择战场和战法，也可 #战法 [战役号] [战法名]；只能准备期更改，两宗合围须有盟友实际入场。',
        '· 战力沿用人数×600+个人实际战力、原设施及NPC防守加成；预估是当前单轮优势，不代表整场获胜率。',
        '· 每回合累计参战贡献：战后论功行赏及联盟地盘/战利品分配按累计贡献，负伤、被俘或撤离者保留已取得的贡献。',
        '· #攻打预估 [目标] [人数]：只读查看调兵预算和战力；#宗门兵力 查看各门人待命/参战/在途情况。',
        '· #天下战争 查看总览；#战争详情 [固定战役号] 查看对应战报；#天下战争 [序号] 保留旧的列表查询。',
        '· #宣战 [宗名] 正式敌对；#议和 [宗名] 提议停战，玩家宗门须 #同意议和 [宗名] 或 #拒绝议和 [宗名]，同意前战争继续。',
        '· 接受议和后结束双方进行中的战事、互放本场俘虏；弱势方5%宝库赔款和议和24小时冷却沿用。',
        '',
        '【俘虏】（胜方宗主/副宗/太上）',
        '· #处置俘虏：查看待处置俘虏与全部选项（菜单打开后5分钟内可直接回复 1~7，或发 #处置俘虏1~7）',
        '· #处置俘虏1~7 / 打开菜单后5分钟内直接回复 1~7：按菜单序号处置（全杀/搜刮再杀/全放/搜刮再放/收编/关天牢/送矿山；有其他数字交互进行中时请用 #处置俘虏 前缀）',
        '· #处置俘虏 收编：逐个劝降拜入本宗（宁死不降者保留，可再处置）',
        '· #处置俘虏 [名字] 动作：单独处置某一人（如 #处置俘虏 张三 收编）',
        '· 攻方打赢、守方守赢抓到的俘虏都归本宗处置；关天牢可越狱（关押越久成功率越高，满24小时必成）',
        '',
        '【矿山】（战俘挖矿）',
        '· #处置俘虏 送矿山：押战俘去矿山挖矿（玩家不可送；每小时产灵石/矿物入宗门宝库，境界越高产越多）',
        '· #宗门矿山：查看本宗矿山矿工与产出',
        '· #天下矿山：查看本群所有宗门矿山（含伪玩家宗门，AI 宗门也会把战俘押去挖矿）',
        '',
        '【重伤】战败重伤：战力-20/40/60%，30分钟/2小时/8小时恢复',
        '',
        '【查看】#我的宗门 / #宗门宝库 / #宗门设施 / #宗门成员 / #宗门职位 / #宗门关系 / #护城阵',
        '',
        '【维护】#维护宗门 [灵石]：宝库灵石提升繁荣度，促进小区产出',
        '',
        '【注意】',
        '· 查看/上供/兑换/参战/任命等需在自己宗门大区（#去[大区] 前往）',
        '· 发起攻打/宣战需与目标同大区',
        '· 玩家坐镇的宗门不会灭门；凌晨1~6点暂停'
      ]
      await replyLines(e, '🏯 宗门玩法大全', lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]玩法大全异常:' + (err && err.stack))
      e.reply('玩法大全生成失败，请稍后再试')
      return true
    }
  }

  /* ---- #宗门系统 帮助 ---- */
  async sectHelp (e) {
    try {
      if (this.gate(e)) return true
      const lines = [
        '🏯 宗门系统指令',
        '加入/退出：#加入宗门 [名] / #退出宗门 / #逐出 @xx',
        '创建：#创建宗门 [名]（可加 中州/东海/西域/北境/南疆）',
        '查看：#我的宗门 / #宗门宝库 / #宗门设施 / #宗门成员 / #宗门职位 / #宗门关系 / #护城阵 / #天下小区',
        '贡献/兑换：#上供 [灵石] / #我的贡献 / #宗门兑换 [物品] [数量]（弟子/执事/副宗）',
        '功法上供：#一键上供功法（红色及以下功法全部入宝库，供宗门伪玩家直接学习；彩色功法不会上供）',
        '取用宝库：#取用宝库 [物品] [数量]（宗主/副宗/太上随时自由取用，无需贡献点；名称/数量可模糊输入，如 灵石5万/全部；玩家主导宗门每名弟子每小时自动发放500灵石俸禄）',
        '购丹：#宗门购丹 [丹药] [数量]（丹阁价×80%，灵石入宝库不交税）',
        '入宗审批：#入宗申请（查看） / #同意入宗 [名] / #拒绝入宗 [名]（宗主）',
        '结盟：#结盟 [宗名]（宗主/副宗/太上） / #退盟 [宗名] / #盟友助战 [目标] [人数]（盟友驰援/驰援帮忙均可，打赢归贡献最高者）',
        '设施：#升级设施 演武场/护山阵/灵脉/药园（宗主/副宗/太上）',
        '护城阵：#升级护城阵 [小区]（宗主/副宗/太上）',
        '地盘：#宗门放弃小区 [小区]（宗主/副宗/太上，小区变回无主）',
        '职位：#任命 [执事/副宗主/太上长老] @xx / #晋升 [执事/副宗/太上]（伪玩家宗主宗门） / #传位 @xx / #问退位 / #夺权',
        '战争：#攻打 / #战法 / #防守策略（支持数字菜单）；#攻打预估 [目标] / #宗门兵力 / #战争详情 [固定战役号]',
        '参战：#参战 / #退战 / #撤退（数字选择战场）；开战后离场在本轮结算后生效。#议和 / #同意议和 / #拒绝议和 [宗名]。',
        '防守：#守 / #不守（高层选战场决策；普通成员#守自行参战）；#防守策略 稳守/保人。总部被破即灭门。',
        '调兵：#驰援 [目标] [人数] / #集结仆从 [目标] [人数] / #盟友助战 [目标] [人数]（宗主/副宗/太上）',
        '俘虏：#处置俘虏 打开固定战役菜单，回复1~7选择处置，0取消；也支持名字与文字动作。',
        '维护：#维护宗门 [灵石]',
        '玩家小队：#创建队伍 / #邀请入队 @xx / #同意进队 / #申请进队 @队长 / #踢出队伍 / #转让队长 / #我的队伍',
        '说明：查看与操作需在宗门所在大区（#去[大区] 前往）；宗门无地盘需攻打夺取；玩家小队攻打宗门须由队长发起（免费）'
      ]
      await replyLines(e, '📜 宗门系统', lines)
      return true
    } catch (err) {
      logger.error('[宗门系统]帮助异常:' + (err && err.stack))
      e.reply('帮助面板生成失败，请稍后再试')
      return true
    }
  }

  /* ---- #宗门购丹 [丹药] [数量]: 灵石买宝库丹药(丹阁价80%, 灵石直接进宝库, 不交税) ---- */
  async buyPillCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const m = String(e.msg || '').match(/宗门购丹\s*(\S*)\s*(\d*)/)
      const name = (m && m[1]) || ''
      const count = Number((m && m[2]) || 1)
      if (!name) { e.reply('用法：#宗门购丹 [修为丹/破障丹/聚宝丹] [数量]（丹阁价×80%，灵石直接进宗门宝库，不交税）'); return true }
      const r = await buyPillFromVault(gid, uid, name, count)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]购丹异常:' + (err && err.stack))
      e.reply('购丹出错了，请稍后再试')
      return true
    }
  }

  async buyVaultEquipCmd (e) {
    try {
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const uid = e.user_id
      const f = getFake(gid)
      const p = getPlayer(f, uid)
      if (!p) { e.reply('你不是宗门成员'); return true }
      const sr = sameRegion(e, f, p.sect)
      if (!sr.ok) { e.reply(sr.msg); return true }
      const m = String(e.msg || '').match(/(?:宗门购装备|宝库购装备|宗门买装备)\s*(\S*)\s*(\d*)/)
      const name = (m && m[1]) || ''
      const count = Number((m && m[2]) || 1)
      if (!name) { e.reply('用法：#宗门购装备 [装备全名] [数量]（使用贡献兑换，装备按品质收费，普通弟子可用）'); return true }
      const r = await exchange(gid, uid, name, count)
      e.reply(r.msg)
      return true
    } catch (err) {
      logger.error('[宗门系统]购装备异常:' + (err && err.stack))
      e.reply('购装备出错了，请稍后再试')
      return true
    }
  }

  /* ---- 管理员(主人): #重洗天下 一键重置本群全部伪玩家/宗门数据并重新演化 ---- */
  async rewashWorld (e) {
    try {
      if (!e.isMaster) { e.reply('只有主人可以重洗天下'); return true }
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = rewashFake(gid)
      /* 同步世界经济: 小区税收归属与宗门名按新档对齐 */
      try {
        const w = getWorld(gid)
        syncWorldSectMap(f, w)
        saveWorld(w)
      } catch (err) { }
      e.reply('✅ 已重洗天下：本群全部伪玩家与宗门数据已重置，世界重新演化！\n⚠️ 玩家宗门/成员身份也已重置，请重新 #创建宗门 或 #加入宗门；\n伪玩家将从低境界开始，靠修炼/突破自然成长')
      return true
    } catch (err) {
      logger.error('[宗门系统]重洗天下异常:' + (err && err.stack))
      e.reply('重洗天下出错了，请稍后再试')
      return true
    }
  }

  /* ---- 管理员(主人): #重置休战期 一键清除本群小区休战期 ---- */
  async resetTruceCmd (e) {
    try {
      if (!e.isMaster) { e.reply('只有主人可以重置休战期'); return true }
      if (this.gate(e)) return true
      const gid = String(e.group_id)
      const f = getFake(gid)
      const r = resetAreaTruce(f, gid)
      e.reply(r.n > 0 ? `✅ 已重置 ${r.n} 个小区的休战期，现在可以立即攻打！` : '当前没有小区处于休战期')
      return true
    } catch (err) {
      logger.error('[宗门系统]重置休战异常:' + (err && err.stack))
      e.reply('重置休战期出错了，请稍后再试')
      return true
    }
  }
}

/** 设施升级消耗(显示用) */
function requireCost (key, newLevel) {
  const t = CFG.FACILITIES[key]
  const stones = t.stone * newLevel * newLevel * (newLevel === 1 ? 2 : 1)
  const mats = {}
  for (const [m, c] of Object.entries(t.mats)) mats[m] = c * newLevel * (newLevel === 1 ? 3 : 1)
  return { stones, mats }
}
