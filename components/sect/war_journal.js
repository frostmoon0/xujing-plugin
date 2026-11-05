/** 外部玩家账户与战争世界档分开保存，使用收据使重试不重复入账。 */
import xujing_data from '../xujing_data.js'

export async function payWarPlayer (gid, uid, amount, receipt) {
  const filename = `${gid}.json`
  const home = await xujing_data.getQQYUserHome(uid, null, filename, false)
  const user = home[uid] ||= {}
  user.warReceipts ||= {}
  if (!Object.hasOwn(user.warReceipts, receipt)) {
    user.money = (Number(user.money) || 0) + amount
    user.warReceipts[receipt] = { amount, at: Date.now() }
    await xujing_data.getQQYUserHome(uid, home, filename, true)
  }
  return user.warReceipts[receipt]
}

export async function addWarKarma (gid, uid, amount, receipt) {
  const filename = `${gid}.json`
  const home = await xujing_data.getQQYUserHome(uid, null, filename, false)
  const user = home[uid]
  if (!user) return 0
  user.warReceipts ||= {}
  if (!Object.hasOwn(user.warReceipts, receipt)) {
    user.karma = (Number(user.karma) || 0) + amount
    user.warReceipts[receipt] = { karma: amount, at: Date.now() }
    await xujing_data.getQQYUserHome(uid, home, filename, true)
  }
  return user.karma
}

export function queueWarEffect (war, key, type, data) {
  const journal = war.settlement ||= { id: `war:${war.id}`, effects: {} }
  journal.effects ||= {}
  journal.effects[key] ||= { type, data, done: false }
}

export async function flushWarEffects (f, gid, war, handlers, save) {
  for (const [key, effect] of Object.entries(war.settlement?.effects || {})) {
    if (effect.done) continue
    await handlers[effect.type](effect.data, `${war.settlement.id}:${key}`)
    effect.done = true
    save(f, gid)
  }
}
