/*yunzai*/
import plugin from '../../../../lib/plugins/plugin.js'
/*bot*/
import { BotApi } from './botapi.js'
/*alemon*/
import { AlemonApi } from './alemonapi.js'
/*拉黑名单*/
import xujing_data from '../../components/xujing_data.js'
/*藏宝阁天牢/洗劫*/
import { getJailRemain, getRaid } from '../../components/raid_data.js'
/*宗门战争被俘: 等待处置期间禁动作*/
import { captiveOf, rescuingOf, isSectWarParticipant } from '../../components/sect_system.js'
/*宗门/世界数据: 战争参与状态读取*/
import { getFake } from '../../components/fake_data.js'
/*遗蜕秘境: 玩家是否在秘境队伍中(屏障/探索阶段)*/
import { playerInRealm } from '../../components/realm_data.js'
/*修仙世界: 界壁跨越拦截*/  
import { getWorld, getMoving, regionNameOf } from '../../components/world_data.js'
/*世界boss: 登仙令持令拦截*/
import { getBoss } from '../../components/boss_data.js'
/*伏击: 伏击中行动拦截(打boss同款锁)*/
import { ambushActiveOf } from '../../components/ambush.js'
/*三阁动态补货: 活跃统计*/
import { recordActive } from '../../components/shop_data.js'
/*闲置灵石清理: 记录最后使用虚境指令时间(超期未使用自动清空灵石)*/
import { recordLastCmd } from '../../components/idle_cleanup.js'
/* 万魂幡：万魂窟失魂状态拦截 */
import { Wanhun, caveActionBlocked } from '../../components/wanhun_data.js'
/* 简月王朝：屠城读阵中拦截 */
import { dynastyReadActive } from '../../components/dynasty_data.js'

/* 启动日志: 用于确认机器人加载的是最新代码(若控制台没有此行,说明没复制新文件或没重启) */
console.log('[虚境插件] 已加载最新代码: 交互回复直接文字 / 全局指令冷却(数字选择除外) / 拉黑功能 / 万魂窟内行动拦截 / 伏击中行动拦截')

/**
 * 给事件对象 e 的 reply 打上“长消息渲染图片”补丁
 * 已按需求移除自动图片渲染:
 *  - 帮助面板/幻境排行/决斗/背包等大文件信息 → 用 HTML 渲染/合并转发/显式 textToImg 处理, 不受此处影响
 *  - 其余玩法(e.reply 文本) → 直接发送文字, 不再自动转图, 交互响应更快(突破确认/逛街菜单/数字选择等)
 */
function patchReplyImage (e) {
  // 保持 e.reply 原生, 直接发送原消息
  return
}

/**
 * 虚境插件基类:统一指令频率限制与长消息图片渲染
 *
 * 为什么用 Proxy 而不是 setTimeout 后替换实例方法?
 *  - 旧实现 setTimeout(() => this.wrapRule(), 0) 后再 this[fnc] = wrapped,
 *    若框架在包装生效前就已提取/缓存方法引用, 则冷却与图片渲染完全不触发
 *    (表现为"指令冷却没生效 / 有些指令回复不生成图片")
 *  - Proxy 在每次属性访问(框架调用 app[指令方法])时动态返回包装方法, 无时序竞争
 *  - 内部链式调用(this.xxx())发生在原始对象上, 不经过代理, 不会重复拦截/重复打补丁
 */
class YuePlugin extends plugin {
  constructor (cfg = {}) {
    super(cfg)
    // 收集 rule 中的 fnc(方法名) 与 auth(权限), 供代理拦截判断
    const fncSet = new Set()
    const authMap = {}
    for (const r of (this.rule || [])) {
      if (r && r.fnc) {
        fncSet.add(r.fnc)
        authMap[r.fnc] = r.auth
      }
    }
    // 有指令才需要代理包装
    if (fncSet.size) {
      const self = this
      const wrappedCache = new Map()
      // 洗劫相关指令白名单: 洗劫/逃亡期间仅放行这些
      const RAID_METHODS = new Set(['raidStart', 'raidConfirm', 'raidBegin', 'raidStop', 'raidBesiege', 'raidStatus'])
      // 世界boss讨伐相关指令白名单: 持续讨伐中放行(攻击/停止/状态/抢令), 保证能查看进度与退出讨伐
      const BOSS_METHODS = new Set(['grabToken', 'attackBoss', 'stopAutoAtk', 'bossStatus'])
      // 伏击相关指令白名单(仅动作): 伏击中放行(开始/打/放/试探/处置/取消/仆从), 保证能操作与撤退;
      //     信息类(伏击状态/我的仆从/玩法说明)走下方统一白名单接口 VIEW_METHODS
      const AMBUSH_METHODS = new Set(['ambushCmd', 'ambushHitCmd', 'ambushLetCmd', 'ambushTalkCmd', 'ambushDisposeCmd', 'ambushDisposePickCmd', 'ambushCancelCmd', 'servantDismissCmd'])
      // 登仙令持有者可在倒计时内使用世界移动指令追逃；争夺/其他动作仍受拦截。
      const WORLD_TRAVEL_METHODS = new Set(['go', 'goPick', 'goForce', 'goTeleport'])
      // 宗门攻防战参战白名单: 玩家加入攻打/防守(战争未结束)期间, 仅放行宗门/战争相关指令,
      //     其余动作(跨区/修炼/逛街/交易/决斗/秘境/打boss/伏击/洗劫等)统一拦截; 信息类走 VIEW_METHODS
      const SECT_WAR_METHODS = new Set(['warCommand', 'warPick', 'abandonAreaCmd', 'abdicate', 'abortAttackCmd', 'acceptJoin', 'agreeApplyCmd', 'agreeTeamCmd', 'allMinesCmd', 'allyAssistCmd', 'allyCmd', 'applyTeamCmd', 'appoint', 'areaDefInfo', 'areaPanel', 'askAbdicateCmd', 'attackCmd', 'breakAllyCmd', 'buyPillCmd', 'buyVaultEquipCmd', 'captivePickCmd', 'createSect', 'createTeamCmd', 'declareWarCmd', 'defendCmd', 'disbandTeamCmd', 'escapeCmd', 'exchangeCmd', 'handleCaptivesCmd', 'inviteTeamCmd', 'joinAttackCmd', 'joinDefendCmd', 'joinFightCmd', 'joinPlayerSectCmd', 'joinReqs', 'kickTeamCmd', 'leavePlayerSectCmd', 'maintainCmd', 'makePeaceCmd', 'myContribution', 'mySect', 'notDefendCmd', 'offerAllGongfaCmd', 'offerCmd', 'offerMatCmd', 'poachFakeCmd', 'promoteCmd', 'quitFightCmd', 'quitTeamCmd', 'recruitFakeCmd', 'refuseApplyCmd', 'refuseJoin', 'refuseTeamCmd', 'releaseCaptiveCmd', 'relocateSectCmd', 'renameSectCmd', 'rescueCmd', 'resetTruceCmd', 'rewashWorld', 'rogueGuide', 'salaryCmd', 'sectFacilities', 'sectGuide', 'sectHelp', 'sectJailCmd', 'sectMembers', 'sectMineCmd', 'sectPositions', 'sectReinforceCmd', 'sectForceCmd', 'sectRelations', 'sectServantRallyCmd', 'sectVault', 'seizePowerCmd', 'takeVaultCmd', 'teamInfoCmd', 'transferTeamCmd', 'upgradeAreaDefCmd', 'upgradeFacilityCmd'])
      // 玩家自身操作(所有战斗玩法锁都应放行, 战斗中可吃丹/换装/调整战力/管理宠物傀儡法宝):
      //     吃丹 takePill/oneClickPill、换装 changeEquip/takeoff/autoequip、功法 gongfaRun/gongfaClear、
      //     灵兽 petDeploy/petRecall、傀儡 craft/equip/unequip/deploy/recall/upgrade/rename/dismantle/dismantleTechnique、
      //     万魂幡法宝 equipWanhun/unequipWanhun/recallWanhun/deployWanhun/upgradeWanhun;
      //     数字处理器(chooseEquip/petPick/puppet pick)由 action_lock 的 skipBattle 放行
      const SELF_ACTION_METHODS = new Set(['takePill', 'oneClickPill', 'changeEquip', 'takeoff', 'autoequip', 'gongfaRun', 'gongfaClear', 'petDeploy', 'petRecall', 'craft', 'equip', 'unequip', 'deploy', 'recall', 'upgrade', 'rename', 'dismantle', 'dismantleTechnique', 'equipWanhun', 'unequipWanhun', 'recallWanhun', 'deployWanhun', 'upgradeWanhun', 'attackSeal'])
      // 遗蜕秘境相关指令白名单(秘境中放行): 入场/破界/停止破界/撤离/开关/刷新;
      //     信息类(秘境状态/天下秘境/玩法说明)走下方统一白名单接口 VIEW_METHODS; 纯数字选择跳过, 归各数字处理器路由
      //     #使用遗蜕古钥 不在白名单: 已在秘境中的玩家不能再开新专属秘境; 转让队长在秘境中仍可用(队长交接,
      //     秘境内队伍快照由 realm 侧同步), 但退出/踢人/解散/建队等换队操作一律拦截
      //     玩家自身操作由共享 SELF_ACTION_METHODS 放行(与洗劫/打boss/伏击/宗门战锁一致)
      const REALM_METHODS = new Set(['enter', 'atkBarrier', 'stopBarrier', 'quit', 'toggle', 'forceSpawn', 'transferTeamCmd'])
      // 查看/信息类指令白名单(只读,不改变状态): 天牢与洗劫期间均放行
      //  - 个人信息: myinfo(我的信息) / seelevel(我的等级) / seelevel2(我的境界)
      //  - 排行榜: rank(幻境日榜) / rankWeek(周榜) / realmRank(境界榜) / powerRank(战力榜) / wealthRank(财富榜) / testRank
      //  - 功法: gongfaStatus(我的功法库) / gongfaAll(功法图鉴)
      //  - 其他查看: cplist(群cp) / gethouse(看房) / list(境界列表) / auctionList(拍卖列表)
      //  - 信息/帮助: alemonMsg(虚境信息) / message+message2(帮助) / allPlays(玩法大全) / itemList(道具目录) / sponsor(赞助)
      //  - 修仙世界: taxRate(税率) / sectRank(宗门繁荣) — 查看类, 天牢/洗劫/跨越期间可查看
      const VIEW_METHODS = new Set(['warView', 'myinfo', 'seelevel', 'seelevel2', 'rank', 'rankWeek', 'realmRank', 'testRank', 'gongfaStatus', 'gongfaAll', 'cplist', 'gethouse', 'list', 'auctionList', 'alemonMsg', 'message', 'message2', 'allPlays', 'itemList', 'sponsor', 'taxRate', 'allTaxRate', 'sectRank', 'sectOccupy', 'areaDefInfo', 'areaPanel', 'worldNews', 'sectList', 'sectDetail', 'personInfo', 'fakePetRank', 'tradeNews', 'smallNews', 'mySect', 'myContribution', 'sectVault', 'sectFacilities', 'sectMembers', 'sectPositions', 'sectRelations', 'sectHelp', 'sectGuide', 'bossStatus', 'mixbox', 'rainbowInfo', 'sectJailCmd', 'sectMineCmd', 'allMinesCmd', 'jailListCmd', 'teamInfoCmd', 'joinReqs', 'warList', 'powerRank', 'wealthRank', 'rogueGuide', 'playIndex', 'fakeGuide', 'bossGuide', 'practiceGuide', 'tradeGuide', 'jianghuGuide', 'ambushGuide', 'ambushStatusCmd', 'servantStatusCmd', 'servantGuide', 'wanhunPanel', 'caveStatus', 'caveOverview', 'shenyouStatus', 'dingxianyou', 'wanhunStatus', 'wanhunGuide', 'route', 'yanghunStatus', 'yanghunGuide', 'petBag', 'puppetPanel', 'puppetGuide', 'corePanel', 'petDetail', 'petCatalog', 'petRank', 'searchStatus', 'petGuide', 'dynastyPanel', 'realmMap', 'realmAll', 'status', 'realmGuide', 'favorPanel', 'sealStatus', 'guide'])
      /* 商店入口不是纯查看: dangeShow/qigeShow/cangbaogeShow 会开启购买交互(裸数字可买),
       * 放入 VIEW_METHODS 会让洗劫/伏击/讨伐/万魂/天牢/战争等锁定状态都能"开商店→数字购买"绕过锁 → 移出白名单 */
      const WANHUN_RECOVERY = new Set(['wanhunPanel', 'caveStatus', 'takePill', 'rescue', 'wanhunStatus'])
      return new Proxy(this, {
        get (target, prop, receiver) {
          // 只拦截 rule 中声明的指令方法, 其余属性(rule/event/priority/name等)原样返回
          if (typeof prop === 'string' && fncSet.has(prop)) {
            if (wrappedCache.has(prop)) return wrappedCache.get(prop)
            const v = Reflect.get(target, prop, receiver)
            if (typeof v === 'function') {
              const auth = authMap[prop]
              const orig = v.bind(target)
              const wrapped = async (...args) => {
                const e = args[0]
                // 0. 全角数字转半角(中文输入法常把数字打成全角, 统一转半角保证所有数字参数解析正常)
                if (e && typeof e.msg === 'string' && /[０-９]/.test(e.msg)) {
                  e.msg = e.msg.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
                }
                // 1. 长消息渲染为图片(该事件对象所有 e.reply 统一走图片渲染)
                patchReplyImage(e)
                // 1.2 纯数字选择指令(交互下一步: 突破选1/2、逛街选1~4、装备/赠送/出售选择等)
                //     无待选交互时不属任何动作——天牢/洗劫/跨越/持令等动作拦截一律跳过,
                //     交由各数字处理器判断(无待选则返回false放行), 避免发个裸数字被误拦报"洗劫中"
                const isChoiceMsg = /^[#＃]?[0-9]+(\s*[x×*]?\s*[0-9]+)?$/.test(
                  String((e && e.msg) || '').trim()
                )
                // 1.5 夜间关闭: 凌晨1点~6点不接受指令(含主人,防深夜刷屏)
                const _hour = new Date().getHours()
                if (_hour >= 1 && _hour < 6) {
                  try { await e.reply('🌙 夜深了，虚境已关闭，凌晨1点~6点请早点休息~') } catch (err) {}
                  return true
                }
                // 2. 管理指令仅主人可用(群聊管理员也不可用)
                if (auth === 'master' && e && !e.isMaster) {
                  try { await e.reply('凡人，休得僭越！此命令仅主人可用~') } catch (err) {}
                  return true
                }
                // 3. 拉黑用户: 静默屏蔽其指令(主人不受限,避免把自己锁死)
                if (e && !e.isMaster) {
                  try {
                    if (await xujing_data.isBlacklisted(e.user_id)) return true
                  } catch (err) {}
                }
                // 3.5 万魂窟失魂：只允许查看、救援和服用还魂丹，禁止通过其他插件绕过状态。
                if (e && auth !== 'master' && e.group_id && !WANHUN_RECOVERY.has(prop) && !VIEW_METHODS.has(prop) && !isChoiceMsg) {
                  try {
                    if (Wanhun.isLocked(e.user_id, e.group_id)) {
                      const cave = Wanhun.getCave(e.user_id, e.group_id)
                      const left = cave.lostUntil > Date.now() ? Math.ceil((cave.lostUntil - Date.now()) / 60000) : 0
                      await e.reply(cave.lostInCave
                        ? '🕯️ 你已失魂并困在万魂窟，只能使用 #服用还魂丹。'
                        : `🕯️ 你仍处于失魂状态，还剩${left}分钟，期间不能行动；可使用 #服用还魂丹。`)
                      return true
                    }
                  } catch (err) {}
                }
                // 3.5a 万魂窟探索中(未失魂): 只能进行万魂窟/万魂幡相关动作与查看类指令,
                //     去丹阁/去器阁/去藏宝阁、去中州等跨区、逛街、交易、决斗、打造武器/红装/彩装等行动指令一律拒绝
                //     (探索期间脱不开身; 对主人同样生效, 防测试号绕过; 管理指令豁免; 纯数字选择跳过, 不干扰窟内战斗/商人回复)
                if (e && auth !== 'master' && e.group_id && !isChoiceMsg) {
                  try {
                    if (Wanhun.inCave(e.user_id, e.group_id) && caveActionBlocked(prop, { isChoiceMsg, isView: VIEW_METHODS.has(prop) })) {
                      await e.reply('🕯️ 你正在万魂窟深处探索，脱不开身！请先 #退出万魂窟（或处理完当前阴魂）再行动吧~')
                      return true
                    }
                  } catch (err) {}
                }
                // 3.5b 藏宝阁天牢: 禁止动作类指令(0~2小时, 到点自动解除); 查看类指令(我的信息/境界/排行/功法等)放行; 纯数字选择跳过
                //     (对主人同样生效, 防测试号绕过; 管理指令如#解天牢不受拦, 主人可自救)
                if (e && auth !== 'master' && !VIEW_METHODS.has(prop) && !isChoiceMsg) {
                  try {
                    const _jr = await getJailRemain(e.user_id)
                    if (_jr > 0) {
                      const _m = Math.floor(_jr / 60)
                      const _s = _jr % 60
                      await e.reply(`⛓️ 你身陷藏宝阁天牢，还需 ${_m} 分 ${_s} 秒才能行动……`)
                      return true
                    }
                  } catch (err) {}
                }
                // 3.5b 宗门战争被俘/天牢: 等待处置或被关天牢期间禁止动作类指令(查看类/纯数字/管理豁免); 天牢中可 #越狱 尝试逃出
                //     救援中(#拯救)的天牢玩家可 #越狱 自救(#拯救是施救者, 走 3.5c 不冲突)
                //     (对主人同样生效; 天牢玩家标记由 settleSectJails 每分钟刷新, 越狱成功/获释立即解除)
                if (e && e.group_id && auth !== 'master' && prop !== 'escapeCmd' && !VIEW_METHODS.has(prop) && !isChoiceMsg) {
                  try {
                    const _cap = await captiveOf(String(e.group_id), e.user_id)
                    if (_cap) {
                      const _jail = String(_cap).includes('·天牢')
                      await e.reply(_jail
                        ? `⛓️ 你身陷【${String(_cap).replace('·天牢', '')}】天牢，无法行动！可发 #越狱 尝试逃出（关押越久成功率越高，满24小时必成）~`
                        : `⛓️ 你已被【${_cap}】俘虏，无法行动！等待对方处置（#天下大事 / #战争详情 可查看战况）~`)
                      return true
                    }
                  } catch (err) {}
                }
                // 3.5c 营救中(#拯救): 30分钟内只能查看信息, 不能做其他动作(被救者出狱/救援完成自动解除)
                //     (对主人同样生效)
                if (e && e.group_id && auth !== 'master' && !VIEW_METHODS.has(prop) && !isChoiceMsg) {
                  try {
                    const _rs = await rescuingOf(String(e.group_id), e.user_id)
                    if (_rs) {
                      const _rsS = String(_rs).replace('·救援', '')
                      await e.reply(`⛏️ 你正在营救【${_rsS}】天牢中的同伴，约需30分钟（期间只能查看信息）~`)
                      return true
                    }
                  } catch (err) {}
                }
                // 3.5d 简月王朝屠城读阵中: 30分钟内只能查看信息/取消屠城, 不能做其他动作
                //     (对主人同样生效, 避免测试号绕过; 管理指令豁免; 纯数字选择跳过, 不干扰数字路由)
                if (e && e.group_id && !VIEW_METHODS.has(prop) && prop !== 'cancelSlaughter' && prop !== 'interruptSlaughter' && !isChoiceMsg) {
                  try {
                    const _dy = dynastyReadActive(String(e.group_id), e.user_id)
                    if (_dy) {
                      const _left = Math.max(0, Math.ceil((_dy.end - Date.now()) / 60000))
                      await e.reply(`🩸 你正在【${_dy.city}】布置血炼大阵读阵中（剩 ${_left} 分钟），脱不开身！可 #取消屠城 放弃~`)
                      return true
                    }
                  } catch (err) {}
                }
                // 3.6 洗劫藏宝阁期间: 只能使用洗劫相关指令(终止/状态/围剿等)与查看类指令(我的信息/境界/排行等),
                //     其他动作类玩法一律拒绝(突破/修炼/逛街/买卖/决斗等, 防边洗劫边干别的)
                //     (对主人同样生效, 避免测试号绕过; 洗劫指令+查看指令可正常使用; 纯数字选择跳过, 防误拦)
                //     玩家自身操作(SELF_ACTION_METHODS, 洗劫中可吃丹换装等)放行
                if (e && e.group_id && !RAID_METHODS.has(prop) && !VIEW_METHODS.has(prop) && !SELF_ACTION_METHODS.has(prop) && !isChoiceMsg) {
                  try {
                    const _rd = await getRaid(String(e.group_id), e.user_id)
                    if (_rd && (_rd.phase === 'raid' || _rd.phase === 'escape')) {
                      await e.reply('⛏️ 你正在洗劫藏宝阁，脱不开身！先 #终止洗劫 或等逃亡结束吧~')
                      return true
                    }
                  } catch (err) {}
                }
                // 3.7 界壁跨越中(修仙世界): 5分钟内拒绝所有动作指令, 查看类指令(税率/宗门繁荣/我的信息等)放行
                //     到点后由世界定时任务自动结算(成功到达/失败掉境界), 此处仅拦截未到点的; 纯数字选择跳过
                //     (对主人同样生效; 管理指令豁免)
                if (e && auth !== 'master' && !VIEW_METHODS.has(prop) && !isChoiceMsg) {
                  try {
                    const _mv = getMoving(getWorld(e.group_id), e.user_id)
                    if (_mv && _mv.end > Date.now()) {
                      const _left = Math.ceil((_mv.end - Date.now()) / 1000)
                      await e.reply(`🌌 你正在跨越界壁前往【${regionNameOf(_mv.to)}】，还剩 ${_left} 秒，动作指令暂不可用~`)
                      return true
                    }
                  } catch (err) {}
                }
                // 3.8 登仙令持令中(世界boss·每群独立): 倒计时1分钟内仅允许查看与跨区追逃, 时间到自动收入囊中; 纯数字选择跳过
                //     (对主人同样生效; 管理指令豁免)
                if (e && auth !== 'master' && !VIEW_METHODS.has(prop) && !WORLD_TRAVEL_METHODS.has(prop) && e.group_id && !isChoiceMsg) {
                  try {
                    const _bs = getBoss(e.group_id)
                    if (_bs.token && _bs.token.holder && String(_bs.token.holder) === String(e.user_id) && _bs.token.end > Date.now()) {
                      const _left = Math.ceil((_bs.token.end - Date.now()) / 1000)
                      await e.reply(`🏮 你身怀登仙令正在远遁，还剩 ${_left} 秒，期间无法行动！`)
                      return true
                    }
                  } catch (err) {}
                }
                // 3.9 持续讨伐世界boss中(自动攻击): 不能分心做其他动作(去别处/修炼/摆摊/买卖/决斗等),
                //     讨伐相关(#攻击boss/#停止攻击/#boss状态/#抢夺登仙令)与查看类指令放行; 纯数字选择跳过
                //     (对主人同样生效, 避免测试号绕过; 需 #停止攻击 才能退出讨伐)
                //     玩家自身操作(SELF_ACTION_METHODS, 讨伐中可吃丹换装等)放行
                if (e && e.group_id && !BOSS_METHODS.has(prop) && !VIEW_METHODS.has(prop) && !SELF_ACTION_METHODS.has(prop) && !isChoiceMsg) {
                  try {
                    const _bs = getBoss(e.group_id)
                    if (_bs.auto && _bs.auto[String(e.user_id)]) {
                      await e.reply('⚔️ 你正在持续讨伐世界Boss，脱不开身！请先 #停止攻击 退出讨伐，再做其他事~')
                      return true
                    }
                  } catch (err) {}
                }
                // 3.10 伏击中(任意阶段): 不能分心做其他动作(跨区/修炼/逛街/买卖/打boss/洗劫等),
                //      与打boss同款锁——不退出(#取消伏击)不允许行动指令; 伏击动作指令(AMBUSH_METHODS)与
                //      统一白名单接口 VIEW_METHODS 的信息类(#伏击状态/#我的仆从/#我的信息/玩法说明等)放行; 纯数字选择跳过
                //      (对主人同样生效, 避免测试号绕过; 需 #取消伏击 撤退才能解除, 或等伏击自然结束)
                //      玩家自身操作(SELF_ACTION_METHODS, 伏击中可吃丹换装等)放行
                if (e && e.group_id && !AMBUSH_METHODS.has(prop) && !VIEW_METHODS.has(prop) && !SELF_ACTION_METHODS.has(prop) && !isChoiceMsg) {
                  try {
                    const _ph = await ambushActiveOf(e.group_id, e.user_id)
                    if (_ph) {
                      const _phCn = { prep: '埋伏准备中', ready: '蹲守猎物中', waiting: '有情况待抉择', won: '已制服猎物待处置' }[_ph] || '伏击中'
                      await e.reply(`🪤 你正在伏击中（${_phCn}），脱不开身！请先 #取消伏击 撤退，再做其他事~`)
                      return true
                    }
                  } catch (err) {}
                }
                // 3.11 宗门攻防战中(玩家加入攻打/防守, 战争未结束): 不能分心做其他动作(跨区/修炼/逛街/
                //      交易/决斗/秘境/打boss/洗劫/万魂窟等), 战争/宗门相关指令(SECT_WAR_METHODS)与
                //      统一白名单接口 VIEW_METHODS 的信息类放行; 纯数字选择跳过(处置俘虏等数字路由不受影响)
                //      (对主人同样生效; 需 #退战 退出参战才能解除, 或等战争结束)
                //      玩家自身操作(SELF_ACTION_METHODS, 战争中可吃丹换装等)放行
                if (e && e.group_id && !SECT_WAR_METHODS.has(prop) && !VIEW_METHODS.has(prop) && !SELF_ACTION_METHODS.has(prop) && !isChoiceMsg) {
                  try {
                    if (isSectWarParticipant(getFake(String(e.group_id)), e.user_id)) {
                      await e.reply('⚔️ 你正在宗门攻防战中，脱不开身！请先 #退战 退出参战（#天下战争 看战况），再做其他事~')
                      return true
                    }
                  } catch (err) {}
                }
                // 3.12 遗蜕秘境中(进入秘境队伍, 屏障/探索阶段): 不能分心做其他动作(跨区/逛街/交易/决斗/
                //      修炼/换队/洗劫/攻打等), 秘境自身指令(REALM_METHODS)与统一白名单 VIEW_METHODS 信息类放行;
                //      纯数字选择跳过(数字路由归各处理器, 由 action_lock 的秘境锁拦截非秘境数字);
                //      玩家自身操作(SELF_ACTION_METHODS, 混战/遭遇中可吃丹换装等)放行;
                //      需 #撤离 离开秘境才能解除(或秘境结算/关闭)
                //      (对主人同样生效, 避免测试号绕过; 管理指令豁免)
                if (e && e.group_id && !REALM_METHODS.has(prop) && !VIEW_METHODS.has(prop) && !SELF_ACTION_METHODS.has(prop) && !isChoiceMsg) {
                  try {
                    if (playerInRealm(String(e.group_id), e.user_id)) {
                      await e.reply('🌌 你正在遗蜕秘境中探索，脱不开身！请先 #撤离 离开秘境，再做其他事~')
                      return true
                    }
                  } catch (err) {}
                }
                // 4.5 活跃度统计(供三阁动态补货): 有效互动计入该群, 玩的人越多货越多
                try {
                  if (e && e.group_id) await recordActive(e.group_id, e.user_id)
                } catch (err) {}
                // 4.6 记录最后使用虚境指令时间(闲置灵石清理: 超期未使用自动清空灵石)
                try {
                  if (e && e.group_id) await recordLastCmd(e.group_id, e.user_id)
                } catch (err) {}
                // 5. 执行指令方法: 捕获异常并记日志后返回 false 放行,
                //    避免单个处理器(如换装chooseEquip/逛街streetChoose/赠送giftPick)抛错时
                //    被框架的 catch→break 中断整条规则链, 导致后面真正处理该数字的
                //    breakChoose/streetChoose 没有机会执行 → 多人并发时用户数字指令被"丢"
                try {
                  return await orig(...args)
                } catch (err) {
                  try {
                    logger.error(`[虚境] 指令[${prop}]执行异常: ${(err && err.stack) || err}`)
                  } catch (_e) {}
                  return false
                }
              }
              wrappedCache.set(prop, wrapped)
              return wrapped
            }
            return v
          }
          return Reflect.get(target, prop, receiver)
        }
      })
    }
  }
}

export { BotApi, AlemonApi, YuePlugin as plugin }