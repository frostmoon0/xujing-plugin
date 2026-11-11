import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import YAML from 'yaml'
import { Data_Path, Save_Path, Yunzai_Path, Plugin_Name, isTestRuntime } from '../components/plugin.js'

const pluginUrl = new URL('../components/plugin.js', import.meta.url).href
const moduleUrl = name => new URL(`../components/${name}.js`, import.meta.url).href
const productionData = path.join(Yunzai_Path, 'data')
const snapshot = `console.log(JSON.stringify({ Data_Path, Save_Path, isTestRuntime }))`
const importPaths = `const { Data_Path, Save_Path, isTestRuntime } = await import(${JSON.stringify(pluginUrl)});`
function child (code, { normal = false, file = null, environment = {} } = {}) {
  const env = { ...process.env, ...environment }
  if (normal) delete env.NODE_TEST_CONTEXT
  else env.NODE_TEST_CONTEXT = 'child-v8'
  const args = file ? [file] : ['--input-type=module', '--eval', code]
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 20000 })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

test('node --test 当前进程的所有集中存档路径都在独立临时目录', () => {
  assert.equal(isTestRuntime, true)
  assert.equal(path.dirname(Data_Path), path.resolve(os.tmpdir()))
  assert.match(path.basename(Data_Path), new RegExp(`^${Plugin_Name}-test-${process.pid}-`))
  assert.equal(Save_Path, path.join(Data_Path, Plugin_Name, 'save'))
  assert.notEqual(Data_Path, productionData)
})

test('继承测试环境的子进程独立分配目录，退出不会删除父进程目录', () => {
  const a = child(`${importPaths}${snapshot}`)
  const b = child(`${importPaths}${snapshot}`)
  assert.equal(a.isTestRuntime, true)
  assert.notEqual(a.Data_Path, Data_Path)
  assert.notEqual(a.Data_Path, b.Data_Path)
  assert.equal(fs.existsSync(a.Data_Path), false)
  assert.equal(fs.existsSync(b.Data_Path), false)
  assert.equal(fs.existsSync(Data_Path), true)
})

test('直接执行 test 文件也隔离存档，普通启动仍保留原生产路径', () => {
  const file = path.join(Data_Path, 'direct.test.mjs')
  fs.writeFileSync(file, `${importPaths}${snapshot}`)
  const direct = child('', { normal: true, file })
  assert.equal(direct.isTestRuntime, true)
  assert.notEqual(direct.Data_Path, productionData)
  assert.equal(fs.existsSync(direct.Data_Path), false)
  const normal = child(`${importPaths}${snapshot}`, { normal: true })
  assert.equal(normal.isTestRuntime, false)
  assert.equal(normal.Data_Path, productionData)
  assert.equal(normal.Save_Path, path.join(productionData, Plugin_Name, 'save'))
})

test('真实背包、人物和延迟伪玩家写入都进入临时目录，退出完整清理', () => {
  const code = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    ${importPaths}
    assert.equal(isTestRuntime, true);
    assert.notEqual(Data_Path, ${JSON.stringify(productionData)});
    const { saveFake } = await import(${JSON.stringify(moduleUrl('fake_data'))});
    const { saveBag } = await import(${JSON.stringify(moduleUrl('equip_data'))});
    const { default: xujing } = await import(${JSON.stringify(moduleUrl('xujing_data'))});
    const { withDeferredSaveContext, pendingDeferredSaves } = await import(${JSON.stringify(moduleUrl('deferred_save'))});
    const gid = 'integrity_storage_fixture';
    saveBag('901', { items: {}, equipped: {} }, gid);
    await xujing.getQQYUserHome('901', null, gid + '.json', false);
    withDeferredSaveContext(() => saveFake({ gid, roster: {}, sects: {}, players: {} }, gid));
    assert.ok(pendingDeferredSaves() > 0);
    assert.ok(fs.existsSync(path.join(Save_Path, 'bag', gid, '901.json')));
    assert.ok(fs.existsSync(path.join(Save_Path, 'qylp/UserHome', gid + '.json')));
    process.on('exit', () => assert.equal(fs.existsSync(Data_Path), false));
    ${snapshot}
  `
  const result = child(code)
  assert.equal(fs.existsSync(result.Data_Path), false)
})

test('测试导入人物模块不会把旧版正式存档迁移进临时目录', () => {
  const code = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    ${importPaths}
    assert.equal(isTestRuntime, true);
    const { Plugin_Path } = await import(${JSON.stringify(pluginUrl)});
    const oldRoot = path.join(Plugin_Path, 'data');
    const exists = fs.existsSync;
    const rename = fs.renameSync;
    const moves = [];
    fs.existsSync = file => path.resolve(String(file)).startsWith(oldRoot + path.sep) || exists(file);
    fs.renameSync = (from, to) => { moves.push([from, to]); throw Error('迁移不应执行'); };
    try { await import(${JSON.stringify(moduleUrl('xujing_data'))}); }
    finally { fs.existsSync = exists; fs.renameSync = rename; }
    assert.equal(moves.length, 0);
    ${snapshot}
  `
  const result = child(code)
  assert.equal(fs.existsSync(result.Data_Path), false)
})

test('测试备份忽略正式备份环境变量，只在本进程临时目录读写', () => {
  const forbidden = path.join(productionData, 'backup-must-not-touch')
  const code = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    ${importPaths}
    assert.equal(isTestRuntime, true);
    const forbidden = path.resolve(process.env.XUJING_BACKUP_DIR);
    const exists = fs.existsSync;
    fs.existsSync = file => {
      const target = path.resolve(String(file));
      assert.ok(target !== forbidden && !target.startsWith(forbidden + path.sep), '不能访问真实备份目录');
      return exists(file);
    };
    try {
      const { BACKUP_DIR, backupSaves } = await import(${JSON.stringify(moduleUrl('save_backup'))});
      const relative = path.relative(Data_Path, BACKUP_DIR);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      fs.writeFileSync(path.join(Save_Path, 'isolation-marker.json'), '{}');
      assert.equal(backupSaves().ok, true);
      assert.ok(fs.readdirSync(BACKUP_DIR).some(name => name.startsWith('save_')));
    } finally { fs.existsSync = exists; }
    ${snapshot}
  `
  const result = child(code, { environment: { XUJING_BACKUP_DIR: forbidden } })
  assert.equal(fs.existsSync(result.Data_Path), false)
})

test('测试配置缺失时只读默认配置，已有配置仍沿用当前配置，均不复制真实文件', async () => {
  const source = fs.readFileSync(new URL('../components/command.js', import.meta.url), 'utf8')
    .replace(/^import .*\r?$/gm, '')
    .replace('export default', 'const commandApi =')
  for (const configured of [false, true]) {
    const reads = []; const copies = []
    const command = vm.runInNewContext(`${source}\n;commandApi`, {
      Plugin_Name, Plugin_Path: '/plugin-fixture', isTestRuntime: true, YAML,
      logger: { error: message => assert.fail(message) },
      fs: {
        existsSync: file => file.endsWith('/xujing.config.yaml') ? configured : true,
        copyFileSync: (...args) => copies.push(args),
        readFileSync: file => { reads.push(file); return 'sect:\n  enabled: true\n' }
      }
    })
    assert.equal(await command.getConfig('sect', 'enabled'), true)
    assert.deepEqual(copies, [])
    assert.deepEqual(reads, [`/plugin-fixture/config/xujing.config${configured ? '' : '.def'}.yaml`])
  }
})
