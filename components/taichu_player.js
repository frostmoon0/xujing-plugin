import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Save_Path } from './plugin.js'
import { writeJsonAtomic } from './json_store.js'
import { getBag, saveBag } from './equip_data.js'
import { getFake, saveFake } from './fake_data.js'
import xujing_data from './xujing_data.js'
import { saveTaichuStore, validateTaichuStore } from './taichu_store.js'
import { withImmediateSaveContext } from './deferred_save.js'

const journalPath = gid => {
  if (gid === undefined || gid === null || !/^[a-zA-Z0-9_-]{1,120}$/.test(String(gid))) throw new Error('太初事务群号无效')
  return path.join(Save_Path, 'taichu_tx', `${createHash('sha256').update(String(gid)).digest('hex')}.json`)
}
const recordId = record => record.transactionId || createHash('sha256').update(JSON.stringify(record)).digest('hex')

function validateTransaction (transaction, gid) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction) || typeof transaction.uid !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(transaction.uid)) throw new Error('太初事务缺少有效角色')
  for (const key of ['money', 'contribution']) if (transaction[key] !== undefined && (!Number.isFinite(transaction[key]) || transaction[key] < 0)) throw new Error(`太初事务${key === 'money' ? '灵石' : '贡献'}无效`)
  if (transaction.bag !== undefined && (!transaction.bag || typeof transaction.bag !== 'object' || Array.isArray(transaction.bag) || !transaction.bag.items || typeof transaction.bag.items !== 'object' || Array.isArray(transaction.bag.items))) throw new Error('太初事务背包无效')
  if (transaction.contribution !== undefined && !getFake(gid).players?.[transaction.uid]) throw new Error('太初事务贡献角色不存在')
  if (transaction.store !== undefined) {
    const normalized = validateTaichuStore(transaction.store)
    if (Object.values(normalized.runs).some(run => String(run.gid) !== String(gid))) throw new Error('太初事务副本群号不匹配')
    transaction.store = normalized
  }
}

function readJournal (file) {
  const records = []
  let exists = false
  for (const candidate of [file, `${file}.bak`]) {
    if (!fs.existsSync(candidate)) continue
    exists = true
    try {
      const record = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      if (!record || record.version !== 1 || typeof record !== 'object' || Array.isArray(record)) continue
      if (!record.uid && Object.keys(record).some(key => !['version', 'completed'].includes(key))) continue
      records.push(record)
    } catch {}
  }
  if (exists && !records.length) throw new Error('太初事务日志及备份损坏，已停止交易以保护数据')
  const completed = new Set(records.map(record => record.completed).filter(Boolean))
  const pending = records.filter(record => record.uid && !completed.has(recordId(record)))
  if (new Set(pending.map(recordId)).size > 1) throw new Error('太初事务日志存在冲突，已停止交易以保护数据')
  const completion = records.find(record => record.completed)
  return { pending: pending[0] || null, completion: completion && (records.length < 2 || records.some(record => record.completed !== completion.completed)) ? completion : null }
}

/** 必须在同群 withGameLock 内调用。写前日志保障扣费、背包与副本进度共同恢复。 */
export async function commitTaichuPlayerTransaction (gid, transaction) {
  const file = journalPath(gid)
  await recoverTaichuPlayerTransactions(gid)
  const pending = { ...structuredClone(transaction), version: 1, transactionId: randomUUID(), acceptedAt: Date.now() }
  if (pending.uid !== undefined && pending.uid !== null) pending.uid = String(pending.uid)
  validateTransaction(pending, gid)
  // 两份redo都先落盘；即使主日志写入失败，备份仍能恢复已接受的交易。
  writeJsonAtomic(`${file}.bak`, pending)
  writeJsonAtomic(file, pending)
  await recoverTaichuPlayerTransactions(gid)
}

/** 即使总开关关闭，也必须恢复已接受的事务；没有日志时零存档写入。 */
export async function recoverTaichuPlayerTransactions (gid) {
  const file = journalPath(gid)
  const journal = readJournal(file)
  const pending = journal.pending
  if (!pending) {
    // 完成标记优先于同一事务的旧redo，并修复另一副本，避免日后主档损坏时重放旧账户快照。
    if (journal.completion) {
      writeJsonAtomic(file, journal.completion)
      writeJsonAtomic(`${file}.bak`, journal.completion)
    }
    return false
  }
  validateTransaction(pending, gid)
  const uid = String(pending.uid)
  if (pending.money !== undefined) {
    const home = await xujing_data.getQQYUserHome(uid, null, `${gid}.json`, false)
    home[uid].money = pending.money
    if (await xujing_data.getQQYUserHome(uid, home, `${gid}.json`, true) === false) throw new Error('太初事务灵石保存失败')
  }
  if (pending.bag) saveBag(uid, pending.bag, gid)
  if (pending.contribution !== undefined) {
    const f = getFake(gid)
    const p = f.players?.[uid]
    p.contribution = pending.contribution
    if (withImmediateSaveContext(() => saveFake(f, gid)) === false) throw new Error('太初事务贡献保存失败')
  }
  if (pending.store && saveTaichuStore(gid, pending.store, { enabled: true }) === false) throw new Error('太初事务副本保存失败')
  const completed = { version: 1, completed: recordId(pending) }
  writeJsonAtomic(file, completed)
  writeJsonAtomic(`${file}.bak`, completed)
  return true
}

export async function taichuPlayerSnapshot (gid, uid) {
  await recoverTaichuPlayerTransactions(gid)
  const battle = await xujing_data.getQQYUserBattle(uid, null, false, `${gid}.json`)
  const home = await xujing_data.getQQYUserHome(uid, null, `${gid}.json`, false)
  return { bag: structuredClone(getBag(uid, gid)), level: Number(battle[uid]?.level) || 0, money: Number(home[uid]?.money) || 0 }
}
