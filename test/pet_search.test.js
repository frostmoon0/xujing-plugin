import fs from 'fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyPetState,
  settlePlayerSearch,
  startSearch,
  searchStatus,
  PET_SEARCH_CMD_REG
} from '../components/pet_data.js'
import { Save_Path } from '../components/plugin.js'

function cleanup (gid) {
  try { fs.rmSync(`${Save_Path}/pet/pet_${gid}.json`, { force: true }) } catch (err) { }
}

test('搜寻宠物命令兼容宠物/灵兽与寻找别名', () => {
  const reg = new RegExp(PET_SEARCH_CMD_REG)
  for (const cmd of ['#搜寻宠物', '搜寻宠物  ', '#搜寻灵兽', '#寻找宠物', '寻找灵兽']) assert.equal(reg.test(cmd), true, cmd)
})

test('到期搜寻在命令前惰性结算，不会被下一次搜寻覆盖', () => {
  const gid = `search-test-${Date.now()}`
  const uid = 'user-1'
  const state = emptyPetState(gid)
  state.search[uid] = { startAt: 1, readyAt: 2, region: 'center' }
  try {
    const encounter = settlePlayerSearch(state, gid, uid, 3)
    assert.ok(encounter)
    assert.equal(state.search[uid], undefined)
    assert.equal(state.encounter[uid], encounter)
    assert.match(searchStatus(state, uid, 3), /回复 1 捕获 \/ 2 放走/)
  } finally {
    cleanup(gid)
  }
})

test('未到期搜寻仍保留进度，不能重复开启', t => {
  t.mock.method(Math, 'random', () => 0.5)
  const gid = `search-test-${Date.now()}-pending`
  const uid = 'user-2'
  const state = emptyPetState(gid)
  try {
    const first = startSearch(state, uid, 'center', 1000)
    assert.equal(first.ok, true)
    const second = startSearch(state, uid, 'center', 1001)
    assert.equal(second.ok, false)
    assert.match(second.msg, /已在/)
    assert.ok(state.search[uid])
  } finally {
    cleanup(gid)
  }
})
