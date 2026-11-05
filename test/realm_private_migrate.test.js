import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { Save_Path } from '../components/plugin.js'
import { savePrivateRealm, getPrivateRealm, getPrivateRealms, openPrivateRealm, terrainAllowedInRegion } from '../components/realm_data.js'
import { getWorld, setLoc } from '../components/world_data.js'

test('旧专属秘境跨区地形读取时会迁移到本区地形', () => {
  const gid = `unit_private_migrate_${Date.now()}`
  const privateId = 'm1'
  const state = {
    gid,
    private: true,
    privateId,
    phase: 'explore',
    region: 'north',
    terrain: 'jinji', // 南疆地形, 不应出现在北境
    teams: { 'player:solo:1': { id: 'player:solo:1', kind: 'player', members: ['1'], partyMembers: ['1'] } }
  }
  savePrivateRealm(state, gid)
  try {
    const got = getPrivateRealm(gid, privateId)
    assert.ok(got)
    assert.equal(terrainAllowedInRegion(got.terrain, 'north'), true, `${got.terrain} 不是北境地形`)
    assert.notEqual(got.terrain, 'jinji')
  } finally {
    try { fs.rmSync(path.join(Save_Path, 'realm', `realm_p_${gid}_${privateId}.json`), { force: true }) } catch (err) { }
  }
})

test('没有队伍的旧专属秘境不再展示', () => {
  const gid = `unit_private_empty_${Date.now()}`
  const privateId = 'e1'
  const state = { gid, private: true, privateId, phase: 'explore', region: 'center', terrain: 'yifu', teams: {} }
  savePrivateRealm(state, gid)
  try {
    assert.equal(getPrivateRealms(gid).length, 0)
  } finally {
    try { fs.rmSync(path.join(Save_Path, 'realm', `realm_p_${gid}_${privateId}.json`), { force: true }) } catch (err) { }
  }
})

test('新开古钥秘境固定在使用者当前大区', async () => {
  const gid = `unit_private_region_${Date.now()}`
  const uid = '10002'
  const w = getWorld(gid)
  setLoc(w, uid, 'north')
  let privateId = ''
  try {
    const r = await openPrivateRealm(gid, { extra_rewards: [] }, uid, `solo:${uid}`, [uid])
    assert.equal(r.ok, true)
    privateId = r.st.privateId
    assert.equal(r.info.region, 'north')
    assert.equal(terrainAllowedInRegion(r.st.terrain, 'north'), true, `${r.st.terrain} 不是北境地形`)
  } finally {
    try { fs.rmSync(path.join(Save_Path, 'realm', `realm_p_${gid}_${privateId}.json`), { force: true }) } catch (err) { }
    try { fs.rmSync(path.join(Save_Path, 'world', `world_${gid}.json`), { force: true }) } catch (err) { }
  }
})
