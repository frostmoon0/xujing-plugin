import { randomUUID } from 'node:crypto'
import { getBag, saveBag } from './equip_data.js'
import { isTaichuEnabled, wearTaichuLoadout } from './taichu_equipment.js'

const eventIds = new WeakMap()
export function taichuBattleReceipt (event, scope) {
  let id = event?.message_id ?? event?.msg_id ?? event?.messageId
  if (id == null && event && typeof event === 'object') {
    id = eventIds.get(event)
    if (!id) { id = randomUUID(); eventIds.set(event, id) }
  }
  return `${scope}:${id ?? randomUUID()}`
}

/** 战斗完成调用；查看面板、胜率和伤害计算不得调用。 */
export function wearPlayerTaichu (gid, uid, receipt, amount = 2, { enabled = isTaichuEnabled(), load = getBag, save = saveBag } = {}) {
  if (!enabled || !uid) return false
  const bag = load(uid, gid)
  if (!wearTaichuLoadout(bag, amount, { receipt, enabled })) return false
  save(uid, bag, gid)
  return true
}

/** NPC由原业务保存世界档；仅扣实际穿戴，不随机生成装备。 */
export function wearNpcTaichu (person, receipt, amount = 2, { enabled = isTaichuEnabled() } = {}) {
  return enabled && person?.bag ? wearTaichuLoadout(person.bag, amount, { receipt, enabled }) : false
}
