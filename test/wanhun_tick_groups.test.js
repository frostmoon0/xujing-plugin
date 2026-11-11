import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Save_Path, Plugin_Name, Yunzai_Path } from '../components/plugin.js'
import Wanhun, { activeWanhunGroups, tickWanhunGroups } from '../components/wanhun_data.js'
import { Yanghun, activeYanghunGroups } from '../components/yanghun_data.js'

function fixtures (t, kind) {
  const liveSave = path.join(Yunzai_Path, 'data', Plugin_Name, 'save')
  assert.notEqual(path.resolve(Save_Path), path.resolve(liveSave), '后台回归测试必须使用隔离存档')
  const dir = path.join(Save_Path, kind)
  fs.mkdirSync(dir, { recursive: true })
  const files = []
  const directories = []
  t.after(() => {
    for (const file of files) fs.rmSync(file, { force: true })
    for (const subdir of directories) fs.rmdirSync(subdir)
  })
  return {
    write (name, data = { users: {}, shops: {} }) {
      const file = path.join(dir, name)
      fs.writeFileSync(file, JSON.stringify(data))
      files.push(file)
      return file
    },
    directory (name) {
      const subdir = path.join(dir, name)
      fs.mkdirSync(subdir)
      directories.push(subdir)
    }
  }
}

test('万魂后台发现仅返回数字群独立档，跳过测试、全局、备份和同名目录', t => {
  const f = fixtures(t, 'wanhun')
  for (const name of ['wanhun_123456.json', 'wanhun_987654321.json', 'wanhun_integrity_18020_9.json', 'wanhun_global.json', 'wanhun_123456.json.bak', 'unrelated_123456.json']) f.write(name)
  f.directory('wanhun_333333.json')
  assert.deepEqual(activeWanhunGroups().sort(), ['123456', '987654321'])
})

test('实际万魂后台推进不读取或通知遗留测试群，真实数字群仍串行推进和通知', async t => {
  const f = fixtures(t, 'wanhun')
  const real = '123456'
  f.write(`wanhun_${real}.json`, { users: { 901: {}, 902: {} }, shops: {} })
  const invalidFiles = ['integrity_18020_9', 'integrity_18020_10', 'integrity_18020_20', 'global'].map(gid => f.write(`wanhun_${gid}.json`, { users: { 901: {} }, shops: {} }))
  const before = invalidFiles.map(file => fs.readFileSync(file, 'utf8'))
  const shops = []; const caves = []; const notices = []
  const originalBot = globalThis.Bot; const originalSegment = globalThis.segment
  globalThis.Bot = { pickGroup: gid => {
    assert.equal(gid, real, '测试群不得进入实际群对象查找')
    return { sendMsg: message => notices.push(message) }
  } }
  globalThis.segment = { at: uid => uid }
  t.after(() => {
    if (originalBot === undefined) delete globalThis.Bot
    else globalThis.Bot = originalBot
    if (originalSegment === undefined) delete globalThis.segment
    else globalThis.segment = originalSegment
  })
  t.mock.method(Wanhun, 'tickShops', gid => { shops.push(gid) })
  t.mock.method(Wanhun, 'tickCave', async (uid, gid, notify) => { caves.push([uid, gid]); notify('万魂窟遭遇') })
  await tickWanhunGroups()
  assert.deepEqual(shops, [real])
  assert.deepEqual(caves, [['901', real], ['902', real]])
  assert.equal(notices.length, 2)
  assert.deepEqual(invalidFiles.map(file => fs.readFileSync(file, 'utf8')), before)
  assert.equal(global.__xujingWanhunTickRunning__, false)
})

test('养魂阵后台结算也跳过遗留测试和全局档，按需读取接口仍兼容', async t => {
  const f = fixtures(t, 'yanghun')
  const state = { level: 2, running: false, progressMs: 0, lastRunAt: 0, createdAt: Date.now() }
  f.write('yanghun_123456.json', { users: { 901: state } })
  const invalidFiles = ['integrity_18020_9', 'global'].map(gid => f.write(`yanghun_${gid}.json`, { users: { 902: state, 903: state } }))
  f.write('yanghun_123456.json.bak')
  f.directory('yanghun_333333.json')
  const before = invalidFiles.map(file => fs.readFileSync(file, 'utf8'))
  assert.deepEqual(activeYanghunGroups(), ['123456'])
  assert.deepEqual(await Yanghun.settleAll(), { groups: 1, users: 1 })
  assert.deepEqual(invalidFiles.map(file => fs.readFileSync(file, 'utf8')), before)
  assert.equal(Yanghun.getState('902', 'global').level, 2)
  assert.equal(Yanghun.getState('902', 'integrity_18020_9').level, 2)
})
