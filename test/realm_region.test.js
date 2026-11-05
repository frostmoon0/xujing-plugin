import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TERRAINS, TERRAIN_REGIONS, terrainAllowedInRegion, terrainPoolForRegion, rollRealm
} from '../components/realm_data.js'

test('海底龙宫与镇海海眼为东海专属', () => {
  assert.equal(TERRAINS.longgong.region, 'east')
  assert.equal(TERRAINS.zhenhai.region, 'east')
  assert.equal(terrainAllowedInRegion('longgong', 'east'), true)
  assert.equal(terrainAllowedInRegion('zhenhai', 'east'), true)
  for (const region of ['center', 'west', 'north', 'south']) {
    assert.equal(terrainAllowedInRegion('longgong', region), false)
    assert.equal(terrainAllowedInRegion('zhenhai', region), false)
  }
})

test('每个大区都有可用地形, 且只包含本区或公用', () => {
  for (const region of ['center', 'east', 'west', 'north', 'south']) {
    const pool = terrainPoolForRegion(region)
    assert.ok(pool.length > 0, `${region} should have terrains`)
    for (const terrain of pool) assert.equal(terrainAllowedInRegion(terrain, region), true)
  }
  assert.ok(terrainPoolForRegion('east').includes('longgong'))
  assert.ok(terrainPoolForRegion('east').includes('zhenhai'))
  assert.ok(!terrainPoolForRegion('center').includes('longgong'))
  assert.ok(!terrainPoolForRegion('center').includes('zhenhai'))
  for (const region of ['center', 'east', 'west', 'north', 'south']) {
    assert.ok(terrainPoolForRegion(region).includes('shifang'), '万法残墟是公用')
    assert.ok(terrainPoolForRegion(region).includes('zhenmo'), '镇魔古狱是公用')
  }
})

test('rollRealm 不会把东海专属刷到别的大区', () => {
  for (const region of ['center', 'west', 'north', 'south']) {
    for (let i = 0; i < 30; i++) {
      const r = rollRealm(() => 0.99, { region })
      assert.equal(r.region, region)
      assert.equal(terrainAllowedInRegion(r.terrain, region), true, `${region} 刷出了 ${r.terrain}`)
    }
  }
  const east = rollRealm(() => 0.1, { region: 'east' })
  assert.equal(east.terrain, 'zhenhai')
})

test('地形归属表覆盖 18 种地形', () => {
  const seen = new Set()
  for (const [region, label] of Object.entries(TERRAIN_REGIONS)) {
    assert.ok(label)
    for (const [key, t] of Object.entries(TERRAINS)) if (t.region === region) seen.add(key)
  }
  assert.equal(seen.size, Object.keys(TERRAINS).length)
})
