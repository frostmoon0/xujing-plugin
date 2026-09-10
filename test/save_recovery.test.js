import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  quarantineCorrupt,
  recoverCorruptJson,
  restoreFromBackup
} from '../components/save_backup.js'

/* 断电半写/文件系统回放留下的典型损坏内容: 整文件全是 NUL 字节 */
const NULS = '\u0000'.repeat(1024)
const GOOD = JSON.stringify({ sectMap: { 天墉城: '万剑宗' }, prosperity: {} })

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xujing-recovery-'))
}
/** 造一个备份目录: entries = [[备份目录名, 相对路径, 内容], ...] */
function backupDirWith (entries) {
  const dir = tmpDir()
  for (const [stamp, rel, content] of entries) {
    const f = path.join(dir, stamp, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
  }
  return dir
}
/** 造一个损坏的正式存档, 返回其路径 */
function corruptSaveFile (root, rel) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, NULS)
  return file
}

const REL = 'world/world_571758813.json'

test('极端损坏档: 隔离现场并从最近备份原样恢复', () => {
  const root = tmpDir()
  const file = corruptSaveFile(root, REL)
  const backupDir = backupDirWith([['save_20260909_103000', REL, GOOD]])

  const r = recoverCorruptJson(file, REL, null, { backupDir, now: new Date('2026-09-10T02:48:00Z') })

  assert.equal(r.restored, true)
  assert.equal(r.dir, 'save_20260909_103000')
  assert.equal(fs.readFileSync(file, 'utf8'), GOOD, '恢复出来的字节应与备份完全一致')
  assert.ok(r.bak && fs.existsSync(r.bak), '损坏现场必须保留')
  assert.equal(fs.readFileSync(r.bak, 'utf8'), NULS)
  assert.match(path.basename(r.bak), /^world_571758813\.json\.corrupt\.2026-09-10T02-48-00-000Z\.bak$/)
})

test('线上同款故障: 最近的备份也已是坏档, 向前找更旧的好档', () => {
  const root = tmpDir()
  const file = corruptSaveFile(root, REL)
  // 复刻真实备份链: 10-30 完好 → 19-37 起全是坏档
  const backupDir = backupDirWith([
    ['save_20260910_103000', REL, NULS],
    ['save_20260909_193751', REL, NULS],
    ['save_20260909_103000', REL, GOOD]
  ])

  const r = recoverCorruptJson(file, REL, null, { backupDir })

  assert.equal(r.restored, true)
  assert.equal(r.dir, 'save_20260909_103000', '必须跳过更新的坏副本, 取最近可解析的那份')
  assert.equal(fs.readFileSync(file, 'utf8'), GOOD)
})

test('无可用备份: 不恢复, 但损坏现场已隔离、原路径让位给调用方决定重建', () => {
  const root = tmpDir()
  const file = corruptSaveFile(root, REL)
  const backupDir = path.join(tmpDir(), 'not-exist')

  const r = recoverCorruptJson(file, REL, null, { backupDir })

  assert.equal(r.restored, false)
  assert.equal(r.dir, null)
  assert.ok(r.bak && fs.existsSync(r.bak), '没有备份时更要保住现场')
  assert.equal(fs.existsSync(file), false, '坏档不能继续占着正式路径')
})

test('备份副本结构不符时视为不可用(expect 过滤)', () => {
  const root = tmpDir()
  const file = corruptSaveFile(root, REL)
  const backupDir = backupDirWith([
    ['save_20260910_103000', REL, JSON.stringify({ notAWorld: true })],
    ['save_20260909_103000', REL, GOOD]
  ])

  const r = recoverCorruptJson(file, REL, d => !!(d && d.sectMap), { backupDir })

  assert.equal(r.restored, true)
  assert.equal(r.dir, 'save_20260909_103000')
})

test('隔离文件名不含 Windows 非法字符', () => {
  const root = tmpDir()
  const file = corruptSaveFile(root, REL)
  const bak = quarantineCorrupt(file, new Date('2026-09-10T02:48:00.551Z'))

  assert.ok(bak)
  assert.ok(!path.basename(bak).includes(':'), '冒号在 Windows 文件名里非法')
  assert.equal(path.dirname(bak), path.dirname(file), '隔离文件留在同目录, 便于人工排查')
})

test('文件不存在或备份目录不存在时安全返回, 不抛错', () => {
  const root = tmpDir()
  assert.equal(quarantineCorrupt(path.join(root, 'nope.json')), null)
  assert.equal(restoreFromBackup(REL, { backupDir: path.join(root, 'nope') }), null)
})

test('写回失败时不谎报成功, 带回原因供上层决定重建', () => {
  const root = tmpDir()
  /* 正式路径的父级被一个普通文件占住 → 建目录/写文件必然失败 */
  fs.writeFileSync(path.join(root, 'blocker'), 'x')
  const file = path.join(root, 'blocker', 'world_571758813.json')
  const backupDir = backupDirWith([['save_20260909_103000', REL, GOOD]])

  const r = recoverCorruptJson(file, REL, null, { backupDir })

  assert.equal(r.restored, false)
  assert.equal(r.dir, null)
  assert.ok(r.error, '失败要带回原因, 供上层决定重建')
})
