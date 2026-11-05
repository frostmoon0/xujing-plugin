import { getFake, withFakeLock } from '../fake_data.js'
import { isEnabled } from './config.js'
import { forceLock, isCurrent, unlock } from '../interact.js'
import { guardActionLocked } from '../action_lock.js'
import { runWarCommand, commandFromWarChoice } from './war_commands.js'

const TYPE = 'sect-war'
export const warMenuKey = (gid, uid) => `xujing:sect-war-menu:${gid}:${uid}`

export async function answerWarMenu (e, result) {
  const gid = String(e.group_id); const uid = String(e.user_id)
  if (result.menu) {
    await redis.set(warMenuKey(gid, uid), JSON.stringify(result.menu), { EX: 300 })
    await forceLock(gid, uid, TYPE)
  }
  await e.reply(result.msg)
  return true
}

/** 文字指令与裸数字共用业务；这里负责栈顶、状态重查和固定菜单的生命周期。 */
export async function chooseWarMenu (e) {
  if (!e.group_id || !isEnabled(e.group_id)) return false
  const gid = String(e.group_id); const uid = String(e.user_id)
  if (!await isCurrent(gid, uid, TYPE)) return false
  if (await guardActionLocked(e, undefined, { skipSectWar: true })) return true
  try {
    return await withFakeLock(gid, async () => {
      if (!await isCurrent(gid, uid, TYPE)) return false
      const raw = await redis.get(warMenuKey(gid, uid))
      if (!raw) { await unlock(gid, uid, TYPE); await e.reply('战争菜单已过期，请重新打开'); return true }
      const number = Number(String(e.msg).replace(/^[#＃]/, '').replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)))
      if (!number) { await redis.del(warMenuKey(gid, uid)); await unlock(gid, uid, TYPE); await e.reply('已取消本次选择。'); return true }
      const state = JSON.parse(raw)
      const command = commandFromWarChoice(state, number)
      if (!command) { await e.reply('请输入菜单中的有效序号，0 取消。'); return true }
      // 等待群锁时也可能进入其他玩法，因此执行前再检查一次。
      if (await guardActionLocked(e, undefined, { skipSectWar: true })) return true
      const result = await runWarCommand(getFake(gid), gid, uid, command, state, e.nickname || uid)
      if (!result.menu) { await redis.del(warMenuKey(gid, uid)); await unlock(gid, uid, TYPE) }
      return answerWarMenu(e, result)
    })
  } catch (err) {
    logger.error('[宗门战争]数字选择 ' + (err.stack || err))
    await e.reply('本次选择尚未完成，请稍后重试或回复0取消。')
    return true
  }
}
