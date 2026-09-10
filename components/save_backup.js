/* ============================================================
 * 存档自动备份
 * 每半小时把 save/ 复制到 D:/Yunzai-Bot-backup/xujing-yue-plugin/save_时间戳/
 * 保留最近 MAX_BACKUPS(100) 份, 超出自动删除最旧的备份
 * ============================================================ */
import fs from 'fs'
import path from 'path'
import { Plugin_Name, Save_Path } from './plugin.js'

const SAVE_DIR = Save_Path
export const BACKUP_DIR = process.env.XUJING_BACKUP_DIR
  ? path.resolve(process.env.XUJING_BACKUP_DIR)
  : path.resolve('D:/Yunzai-Bot-backup', Plugin_Name)
export const MAX_BACKUPS = 100

const pad = n => String(n).padStart(2, '0')
/** 备份目录名(时间戳可排序): save_YYYYMMDD_HHmmss */
function stampOf (d) {
  return `save_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/* ---------- 损坏恢复 ---------- */

/** 损坏现场文件名: <原文件>.corrupt.<时间戳>.bak (与 save_cleanup 的 RECOVERY_RE 一致) */
function corruptNameOf (now) {
  return `.corrupt.${now.toISOString().replace(/[:.]/g, '-')}.bak`
}

/** 隔离损坏存档: 原地改名保留现场(不删除); 返回隔离后路径, 文件不存在或改名失败返回 null */
export function quarantineCorrupt (file, now = new Date()) {
  try {
    if (!fs.existsSync(file)) return null
    const bak = file + corruptNameOf(now)
    fs.renameSync(file, bak)
    return bak
  } catch (err) {
    return null
  }
}

/**
 * 从最近的自动备份里取一份能解析的副本(由新到旧)。
 * relPath: 相对 save/ 的路径, 如 'world/world_123.json'
 * expect: 可选结构校验, 返回 false 视为该副本不可用, 继续找更旧的
 * 返回 { dir, raw, data } 或 null(备份目录不存在/无可用副本)
 */
export function restoreFromBackup (relPath, { backupDir = BACKUP_DIR, expect = null } = {}) {
  let dirs
  try {
    if (!fs.existsSync(backupDir)) return null
    dirs = fs.readdirSync(backupDir).filter(n => /^save_\d{8}_\d{6}$/.test(n)).sort().reverse()
  } catch (err) { return null }
  for (const d of dirs) {
    try {
      const raw = fs.readFileSync(path.join(backupDir, d, relPath), 'utf8')
      const data = JSON.parse(raw)
      if (expect && !expect(data)) continue
      return { dir: d, raw, data }
    } catch (err) { /* 该副本缺失/同样损坏 → 继续找更旧的 */ }
  }
  return null
}

/**
 * 损坏存档恢复: 隔离坏档 → 从最近可用备份原样写回。
 * 备份内容不做二次序列化, 保证恢复出来的字节与备份一致。
 * 返回 { restored, bak, dir, error }
 */
export function recoverCorruptJson (file, relPath, expect = null, opts = {}) {
  const bak = quarantineCorrupt(file, opts.now || new Date())
  const hit = restoreFromBackup(relPath, { backupDir: opts.backupDir, expect })
  if (!hit) return { restored: false, bak, dir: null }
  try {
    const dir = path.dirname(file)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, hit.raw, 'utf8')
    return { restored: true, bak, dir: hit.dir }
  } catch (err) {
    return { restored: false, bak, dir: null, error: err && err.message }
  }
}

/** 执行一次备份: 复制 save → D盘备份目录/save_时间戳/, 超过 MAX_BACKUPS 删最旧 */
export function backupSaves () {
  try {
    if (!fs.existsSync(SAVE_DIR)) return { ok: false, msg: '存档目录不存在: ' + SAVE_DIR }
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const dest = path.join(BACKUP_DIR, stampOf(new Date()))
    fs.cpSync(SAVE_DIR, dest, { recursive: true })
    /* 清理旧备份: 按时间戳排序(名字可排序), 超出上限删最旧 */
    const dirs = fs.readdirSync(BACKUP_DIR).filter(n => /^save_\d{8}_\d{6}$/.test(n)).sort()
    while (dirs.length > MAX_BACKUPS) {
      const rm = dirs.shift()
      try { fs.rmSync(path.join(BACKUP_DIR, rm), { recursive: true, force: true }) } catch (err) { }
    }
    return { ok: true, msg: `存档已备份(共 ${dirs.length} 份, 最多 ${MAX_BACKUPS})` }
  } catch (err) {
    return { ok: false, msg: '备份失败: ' + (err && err.message) }
  }
}
