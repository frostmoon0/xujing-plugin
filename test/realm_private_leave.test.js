import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { Save_Path } from '../components/plugin.js'
import { savePrivateRealm, getPrivateRealm, leaveTeam, teamOf } from '../components/realm_data.js'

test('专属秘境撤离写回专属档, 不会仍留在队伍里', async () => {
  const gid = `unit_private_quit_${Date.now()}`
  const privateId = '1'
  const uid = '10001'
  const team = {
    id: `player:solo:${uid}`,
    kind: 'player',
    partyId: `solo:${uid}`,
    partyLeader: uid,
    leader: uid,
    partyMembers: [uid],
    members: [uid],
    contrib: { [uid]: 0 },
    victory: { [uid]: 0 },
    step: 0,
    node: null
  }
  const st = {
    private: true,
    gid,
    privateId,
    phase: 'barrier',
    teams: { [team.id]: team }
  }
  savePrivateRealm(st, gid)
  try {
    const r = await leaveTeam(st, gid, uid)
    assert.equal(r.ok, true)
    const after = getPrivateRealm(gid, privateId)
    assert.ok(after, '专属秘境档仍存在')
    assert.equal(teamOf(after, uid), null, '撤离后不应仍在专属秘境队伍中')
  } finally {
    try { fs.rmSync(path.join(Save_Path, 'realm', `realm_p_${gid}_${privateId}.json`), { force: true }) } catch (err) { }
  }
})
