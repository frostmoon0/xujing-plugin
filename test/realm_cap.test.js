import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import {
  REALM_MAX_LEVEL, XIANDI_MAX_CHONG, MAX_LEVEL_NAME,
  clampLevel, isAtRealmCap, normalizeBattleLevels
} from '../components/realm_cap.js'
import { realmPower } from '../components/fight.js'
import { levelNameOf } from '../components/world_data.js'
import { Save_Path } from '../components/plugin.js'
import xujing_data from '../components/xujing_data.js'

test('境界上限常量: 仙帝第499重(level 567)', () => {
  assert.equal(XIANDI_MAX_CHONG, 499)
  assert.equal(REALM_MAX_LEVEL, 567)
  assert.equal(MAX_LEVEL_NAME, '仙帝第499重')
  assert.equal(clampLevel(4966), 567)
  assert.equal(clampLevel(-5), 0)
  assert.equal(clampLevel('418'), 418)
  assert.equal(isAtRealmCap(567), true)
  assert.equal(isAtRealmCap(566), false)
})

test('战力在境界上限处封顶', () => {
  const atCap = realmPower(REALM_MAX_LEVEL)
  assert.equal(atCap, 84900)
  assert.equal(realmPower(4966), atCap)
  assert.equal(realmPower(REALM_MAX_LEVEL + 1000), atCap)
})

test('境界名在上限处封顶', () => {
  assert.equal(levelNameOf(REALM_MAX_LEVEL), '仙帝第499重')
  assert.equal(levelNameOf(9999), '仙帝第499重')
})

test('旧档读入时收敛到上限并改写境界名', () => {
  const battle = {
    a: { level: 4966, levelname: '仙帝第4898重' },
    b: { level: 418, levelname: '仙帝第350重' },
    c: { level: 0, levelname: '无灵力' }
  }
  normalizeBattleLevels(battle)
  assert.equal(battle.a.level, REALM_MAX_LEVEL)
  assert.equal(battle.a.levelname, MAX_LEVEL_NAME)
  assert.equal(battle.b.level, 418)
  assert.equal(battle.b.levelname, '仙帝第350重')
  assert.equal(battle.c.level, 0)
})

test('battle 存档读取时收敛超上限档并立即落盘', async () => {
  const gid = 'testcap0001'
  const dir = `${Save_Path}/battle`
  const file = `${dir}/${gid}.json`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    123: { level: 4966, levelname: '仙帝第4898重', experience: 10000000 }
  }))
  try {
    const battle = await xujing_data.getQQYUserBattle('123', null, false, `${gid}.json`)
    assert.equal(battle['123'].level, REALM_MAX_LEVEL)
    assert.equal(battle['123'].levelname, MAX_LEVEL_NAME)
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(onDisk['123'].level, REALM_MAX_LEVEL)
    assert.equal(onDisk['123'].levelname, MAX_LEVEL_NAME)
  } finally {
    try { fs.unlinkSync(file) } catch (err) { }
  }
})
