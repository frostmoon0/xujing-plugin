import { plugin } from '../../model/api/api.js'
import { getFake, withFakeLock } from '../../components/fake_data.js'
import { isEnabled } from '../../components/sect/config.js'
import { unlock } from '../../components/interact.js'
import { answerWarMenu, chooseWarMenu, warMenuKey } from '../../components/sect/war_interaction.js'
import { WAR_VERBS, parseWarCommand, runWarCommand } from '../../components/sect/war_commands.js'

const TYPE = 'sect-war'
const menuKey = warMenuKey

export class sect_war extends plugin {
  constructor () {
    super({ name: '宗门战争', dsc: '战争文字与数字统一入口', event: 'message', priority: 245, rule: [
      { reg: '^[#＃]?(攻打预估|宗门兵力)(?:.*)$', fnc: 'warView' },
      { reg: `^[#＃]?(?:${WAR_VERBS.map(v => v === '攻' ? '攻(?!击|打|占)' : v).join('|')})(?:\\s.*|[^\\s]*)$`, fnc: 'warCommand' },
      { reg: '^[#＃]?[0-9０-９]+$', fnc: 'warPick' }
    ] })
  }

  async answer (e, result) { return answerWarMenu(e, result) }

  async warView (e) { return this.warCommand(e) }

  async warCommand (e) {
    if (!e.group_id) { await e.reply('请在群内使用~'); return true }
    if (!isEnabled(e.group_id)) { await e.reply('本群未开启宗门系统~'); return true }
    const command = parseWarCommand(e.msg)
    if (!command) return false
    const gid = String(e.group_id); const uid = String(e.user_id)
    try {
      return await withFakeLock(gid, async () => {
        const result = await runWarCommand(getFake(gid), gid, uid, command, null, e.nickname || e.sender?.card || e.sender?.nickname || uid)
        // 一条新的文字操作会替换本模块菜单，只移除自己的交互。
        if (!result.menu) { await redis.del(menuKey(gid, uid)); await unlock(gid, uid, TYPE) }
        return this.answer(e, result)
      })
    } catch (err) {
      logger.error('[宗门战争] ' + (err.stack || err))
      await e.reply('战争操作未完成，请稍后重试；中断的结算会继续恢复。')
      return true
    }
  }

  async warPick (e) { return chooseWarMenu(e) }
}
