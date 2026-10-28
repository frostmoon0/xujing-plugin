import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { Save_Path } from '../components/plugin.js'
import {
  getPetState, resolveEncounter, petPower, petMaxPower
} from '../components/pet_data.js'
import { allSpecies, bloodlineOf } from '../components/pet_species.js'
import { pruneFakePets, tidyFakePets, fakePetTick } from '../components/fake_data.js'

const DIR = `${Save_Path}/pet`
const GIDS = ['testpetgrowth01', 'testpetgrowth02']

function mkPet (pid, quality, stage = '蜕变', atk = 100, def = 80, hp = 400) {
  return {
    pid, speciesId: 'test-species', quality, stage, customName: '',
    maxAtk: atk, maxDef: def, maxHp: hp,
    growthStart: 0, obtainedAt: 0, lastAt: 0
  }
}

test.afterEach(() => {
  for (const g of GIDS) {
    try { fs.unlinkSync(`${DIR}/pet_fake_${g}.json`) } catch (err) { }
  }
})

test('伪玩家捕获即满成长: 蛋也直接蜕变, 玩家仍走孵化', () => {
  const now = Date.now()
  const state = getPetState(GIDS[0], 'fake')
  const sp = allSpecies().find(s => bloodlineOf(s.bloodline).quality === 4)
  assert.ok(sp, '应存在四品物种')
  const mkEnc = () => ({
    speciesId: sp.id, quality: 4, mode: 'egg',
    maxAtk: 100, maxDef: 80, maxHp: 400,
    region: 'mixed', expireAt: now + 600000, windowLocked: null
  })
  state.encounter['甲'] = mkEnc()
  state.encounter['乙'] = mkEnc()

  const normal = resolveEncounter(state, '甲', 1, now, 0)
  const instant = resolveEncounter(state, '乙', 1, now, 0, { instantGrow: true })

  assert.equal(normal.ok, true)
  assert.equal(normal.pet.stage, 'egg')
  assert.equal(petPower(normal.pet), 0)

  assert.equal(instant.ok, true)
  assert.equal(instant.pet.stage, '蜕变')
  assert.equal(instant.pet.hatchProgress, 100)
  assert.equal(instant.pet.hatchStart, 0)
  assert.ok(petPower(instant.pet) > 0, '满成长灵兽应有战力')
  assert.equal(petPower(instant.pet), petMaxPower(instant.pet))
})

test('伪玩家放生垃圾灵兽: 白/绿放生, 最多留最强三只', () => {
  const state = {
    bag: {
      甲: [mkPet(1, 1), mkPet(2, 2), mkPet(3, 4, '蜕变', 1000, 800, 4000), mkPet(4, 4, '蜕变', 1200, 900, 4500), mkPet(5, 5, '蜕变', 1500, 1100, 5000)]
    },
    active: { 甲: 1 }
  }
  assert.equal(pruneFakePets(state, '甲'), true)
  assert.equal(state.bag['甲'].length, 3)
  assert.deepEqual(state.bag['甲'].map(p => p.pid).sort((a, b) => a - b), [3, 4, 5])
  assert.equal(state.active['甲'], undefined, '出战槽位指向被放生灵兽时应摘除')
})

test('全是垃圾时至少保留最强的一只', () => {
  const state = { bag: { 乙: [mkPet(1, 1), mkPet(2, 2), mkPet(3, 2, '蜕变', 200, 160, 800)] }, active: {} }
  pruneFakePets(state, '乙')
  assert.equal(state.bag['乙'].length, 1)
  assert.equal(state.bag['乙'][0].pid, 3)
})

test('tidyFakePets 把旧灵兽补到满成长并放生垃圾', () => {
  const now = Date.now()
  const state = {
    bag: { 丙: [mkPet(1, 1, 'baby'), mkPet(2, 3, '少年'), mkPet(3, 4, '成年', 1000, 800, 4000)] },
    active: {}
  }
  assert.equal(tidyFakePets(state, [{ name: '丙' }], now), true)
  assert.ok(state.bag['丙'].every(p => p.stage === '蜕变'))
  assert.ok(state.bag['丙'].length <= 3)
  assert.ok(state.bag['丙'].every(p => p.quality >= 3))
})

test('fakePetTick 捕获后自动催熟并清理垃圾灵兽', () => {
  const now = Date.now()
  const gid = GIDS[1]
  const state = getPetState(gid, 'fake')
  state.bag['甲'] = [
    mkPet(1, 1, 'baby'),
    mkPet(2, 3, '少年'),
    mkPet(3, 4, '成年', 1000, 800, 4000),
    mkPet(4, 4, 'baby', 1200, 900, 4500)
  ]
  state.active['甲'] = 1
  state.search = {}
  state.encounter = {}
  state.redWindow = null
  state.rainbowWindow = null
  state.nextRedAt = now + 1e12
  state.nextRainbowAt = now + 1e12

  const f = {
    roster: {
      甲: { name: '甲', alive: true, loc: 'center', activities: { nextPetAt: now + 1e9 } }
    }
  }
  fakePetTick(f, gid, now)

  const bag = state.bag['甲']
  assert.ok(bag.length <= 3, '最多留三只')
  assert.ok(bag.every(p => p.stage === '蜕变'), '旧灵兽应补到满成长')
  assert.ok(bag.every(p => p.quality >= 3), '白/绿垃圾应被放生')
  assert.ok(bag.some(p => p.pid === 4))
  assert.equal(state.active['甲'], 4, '出战应换成最强的一只')
})
