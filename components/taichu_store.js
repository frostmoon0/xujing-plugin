import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Save_Path } from './plugin.js'
import { writeJsonAtomic } from './json_store.js'
import { isTaichuEnabled } from './taichu_equipment.js'

export function emptyTaichuStore () { return { version: 1, runs: {}, ledger: {} } }

function storeFile (gid, directory = path.join(Save_Path, 'taichu')) {
  if (gid === undefined || gid === null || !String(gid)) throw new Error('古墟存档缺少群号')
  return path.join(directory, `${createHash('sha256').update(String(gid)).digest('hex')}.json`)
}

function normalizeStore (raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.version && raw.version !== 1)) throw new Error('太初古墟存档版本或结构异常')
  if (!raw.runs || typeof raw.runs !== 'object' || Array.isArray(raw.runs)) throw new Error('太初古墟队伍存档异常')
  raw.version = 1
  raw.ledger ||= {}
  if (typeof raw.ledger !== 'object' || Array.isArray(raw.ledger)) throw new Error('太初古墟奖励账本异常')
  for (const entry of Object.values(raw.ledger)) {
    if (!entry || typeof entry !== 'object' || typeof entry.week !== 'string' || !Number.isInteger(entry.coreCount) || entry.coreCount < 0 || entry.coreCount > 2 || !entry.receipts || typeof entry.receipts !== 'object' || Array.isArray(entry.receipts)) throw new Error('太初古墟奖励额度异常')
    entry.pending ||= {}
    if (typeof entry.pending !== 'object' || Array.isArray(entry.pending)) throw new Error('太初古墟奖励预留异常')
  }
  for (const run of Object.values(raw.runs)) {
    if (!run || !run.id || !run.members || !['active', 'cleared', 'failed', 'left'].includes(run.phase)) throw new Error('太初古墟队伍结构异常')
    if (typeof run.members !== 'object' || Array.isArray(run.members) || Object.keys(run.members).length < 1 || Object.keys(run.members).length > 3 || !run.members[run.leader]) throw new Error('太初古墟成员结构异常')
    if (!Number.isFinite(run.expiresAt) || !Number.isFinite(run.startedAt)) throw new Error('太初古墟时间字段异常')
    if (run.phase === 'active' && (!Number.isInteger(run.step) || run.step < 0 || run.step > 17 || !run.node?.kind)) throw new Error('太初古墟阶段结构异常')
    run.votes ||= {}; run.settlements ||= {}; run.claimed ||= {}; run.log ||= []
    for (const member of Object.values(run.members)) {
      if (!member || typeof member !== 'object' || !member.id || !Number.isFinite(member.energy) || !Number.isFinite(member.supplies)) throw new Error('太初古墟成员资源异常')
      member.loot ||= {}; member.sealed ||= {}
    }
  }
  return raw
}

export function validateTaichuStore (state) { return normalizeStore(structuredClone(state)) }

export function readTaichuStore (gid, options = {}) {
  const file = storeFile(gid, options.directory)
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) return emptyTaichuStore()
  for (const candidate of [file, `${file}.bak`]) {
    try { return normalizeStore(JSON.parse(fs.readFileSync(candidate, 'utf8'))) } catch {}
  }
  throw new Error('太初古墟存档及备份均损坏，已停止写入以保护数据')
}

export function saveTaichuStore (gid, state, options = {}) {
  if (!(options.enabled ?? isTaichuEnabled())) return false
  normalizeStore(state)
  // 随正常检查点回收已全员领取的旧队伍，未领取战利品始终保留。
  cleanupTaichuStore(state, options.now ?? Date.now(), options)
  const file = storeFile(gid, options.directory)
  let previous
  if (fs.existsSync(file)) {
    try { previous = normalizeStore(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch {
      if (!fs.existsSync(`${file}.bak`)) throw new Error('原古墟存档损坏且没有备份，拒绝覆盖')
      normalizeStore(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')))
    }
  }
  if (previous) writeJsonAtomic(`${file}.bak`, previous)
  writeJsonAtomic(file, state)
  if (!fs.existsSync(`${file}.bak`)) writeJsonAtomic(`${file}.bak`, state)
  return true
}

export function cleanupTaichuStore (state, now = Date.now(), options = {}) {
  if (!(options.enabled ?? isTaichuEnabled())) return false
  let changed = false
  for (const [key, run] of Object.entries(state.runs || {})) {
    if (run.phase === 'active' && now >= run.expiresAt) { run.phase = 'failed'; run.updatedAt = now; run.votes = {}; changed = true }
    // 未领取的封存物品不能随过期清理；只回收所有成员已领取的旧队伍。
    if (run.phase !== 'active' && now - run.updatedAt > 14 * 86400000 && Object.keys(run.members).every(id => run.claimed?.[id])) { delete state.runs[key]; changed = true }
  }
  return changed
}
