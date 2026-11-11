/* ============================================================
 * 统一"脱不开身"状态检查
 * 供裸数字驱动的动作类处理器(如逛街/商店购买 streetChoose)调用,
 * 关闭"先开交互菜单 → 再进入锁定状态 → 用裸数字绕锁"的漏洞:
 *   状态锁(洗劫/伏击/讨伐/万魂/天牢/跨越/持令/宗门被俘/营救/屠城/宗门攻防战)
 *   在统一 Proxy 拦截文字指令, 但纯数字(isChoiceMsg)会放行交由各处理器,
 *   处理器必须再用本函数复查, 否则被锁玩家仍能用数字买东西/做动作。
 * ============================================================ */
import { getRaid, getJailRemain } from './raid_data.js'
import { ambushActiveOf } from './ambush.js'
import { getBoss } from './boss_data.js'
import { Wanhun } from './wanhun_data.js'
import { getWorld, getMoving } from './world_data.js'
import { captiveOf, rescuingOf, isSectWarParticipant } from './sect_system.js'
import { dynastyReadActive } from './dynasty_data.js'
import { getFake } from './fake_data.js'
import { playerInRealm } from './realm_data.js'
import { playerInTaichu } from './taichu_presence.js'

/** 玩家当前是否处于"禁止其他动作"的锁定状态(洗劫/逃亡/天牢/伏击/讨伐/万魂窟/失魂/界壁跨越/登仙令/宗门被俘/营救/屠城读阵/宗门攻防战/遗蜕秘境)
 *  仅用于动作类处理器前置复查; 万魂窟内合法动作(窟内战斗/商人)与遗蜕秘境内的秘境数字决策由各自处理器单独放行,
 *  不受此函数影响 (秘境数字处理器传 opts.skipRealm 豁免秘境本身; opts.skipBattle 跳过所有战斗玩法锁——
 *  洗劫/伏击/讨伐/宗门战/秘境, 供吃丹/换装等"玩家自身操作"数字处理器使用, 天牢/被俘/失魂/跨越/登仙令等惩罚锁仍照拦) */
export async function isPlayerActionLocked (gid, uid, opts = {}) {
  gid = String(gid || '')
  uid = String(uid || '')
  if (!gid || !uid) return false
  const battleFree = !!opts.skipBattle
  // 古墟数字仅自身处理器可豁免，避免其他已打开菜单绕过副本锁。
  if (!battleFree && !opts.skipTaichu && playerInTaichu(gid, uid)) return true
  // skipToken 仅供持令旅行，skipCave 仅供窟内操作；均不豁免天牢/被俘/失魂等惩罚。
  try {
    /* 遗蜕秘境中(公开/专属, 屏障/探索阶段): 不能分心逛街/跨区/换队等外部动作 */
    if (!battleFree && !opts.skipRealm && playerInRealm(gid, uid)) return true
    /* 洗劫/逃亡 */
    const rd = await getRaid(gid, uid)
    if (!battleFree && rd && (rd.phase === 'raid' || rd.phase === 'escape')) return true
    /* 藏宝阁天牢 */
    if ((await getJailRemain(uid)) > 0) return true
    /* 宗门战争被俘/天牢 + 营救中 */
    if (await captiveOf(gid, uid)) return true
    if (await rescuingOf(gid, uid)) return true
    /* 伏击 */
    if (!battleFree && await ambushActiveOf(gid, uid)) return true
    /* 持续讨伐世界Boss(登仙令持令仍锁定) */
    const bs = getBoss(gid)
    if (!battleFree && bs && bs.auto && bs.auto[uid]) return true
    if (!opts.skipToken && bs && bs.token && bs.token.holder && String(bs.token.holder) === uid && bs.token.end > Date.now()) return true
    /* 万魂窟探索(失魂是惩罚, 仍锁) */
    if (Wanhun.isLocked(uid, gid) || (!battleFree && !opts.skipCave && Wanhun.inCave(uid, gid))) return true
    /* 界壁跨越中 */
    const mv = getMoving(getWorld(gid), uid)
    if (mv && mv.end > Date.now()) return true
    /* 简月王朝屠城读阵 */
    if (dynastyReadActive(gid, uid)) return true
    /* 宗门攻防战参与 */
    if (!battleFree && !opts.skipSectWar && isSectWarParticipant(getFake(gid), uid)) return true
  } catch (err) { }
  return false
}

/** 动作类裸数字处理器前置守卫: 玩家处于锁定状态(洗劫/伏击/讨伐/万魂/天牢/战争等)时, 回复并返回 true(拦截该动作);
 *  仅用于"改变玩家状态的动作"处理器, 不要加在自身合法状态(伏击处置/俘虏处置/万魂窟内)处理器上 */
export async function guardActionLocked (e, hint = '⛓️ 你正处在脱不开身的状态（洗劫/伏击/讨伐/万魂/天牢/战争等），暂时无法执行该操作~', opts = {}) {
  if (!e || !e.group_id) return false
  if (await isPlayerActionLocked(e.group_id, e.user_id, opts)) {
    try { await e.reply(hint) } catch (err) { }
    return true
  }
  return false
}
