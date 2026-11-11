import path from 'path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import { flushDeferredSaves } from './deferred_save.js'
/* 插件根目录：components 的上一级 */
export const Plugin_Path = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/* 插件文件夹名（随目录改名自动适配） */
export const Plugin_Name = path.basename(Plugin_Path)
/* Yunzai 根目录与插件数据目录：不依赖启动时的 process.cwd() */
export const Yunzai_Path = path.resolve(Plugin_Path, '..', '..')
/* node --test 的每个 worker 使用独立临时存档，不能让假群数据进入正式定时任务。 */
export const isTestRuntime = Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test') || /\.test\.[cm]?js$/.test(process.argv[1] || '')
const testPrefix = `${Plugin_Name}-test-${process.pid}-`
const testDataRoot = isTestRuntime ? fs.mkdtempSync(path.join(os.tmpdir(), testPrefix)) : null
export const Data_Path = testDataRoot || path.join(Yunzai_Path, 'data')
export const Save_Path = path.join(Data_Path, Plugin_Name, 'save')

if (testDataRoot) {
  fs.mkdirSync(Save_Path, { recursive: true })
  process.once('exit', () => {
    // 延迟保存的退出钩子不能在清理后重新造出测试目录。
    flushDeferredSaves()
    const target = path.resolve(testDataRoot)
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(testPrefix)) return
    try { fs.rmSync(target, { recursive: true, force: true }) } catch { }
  })
}
