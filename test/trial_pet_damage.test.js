import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { rotateTrialPeriods } from '../components/trial_periods.js'

// 执行真实指令方法；将 Redis、存档、转发和战斗依赖替换为内存实现。
const source = fs.readFileSync(new URL('../apps/user/trial.js', import.meta.url), 'utf8')
const method = source.slice(source.indexOf('    async trial(e) {'), source.indexOf('    /** 今日日榜'))

for (const [gid, petPower] of [['pet-group', 1000], ['other-group', 0]]) {
  test(`试炼每回合与排行均使用当前群出战灵兽：${gid}`, async () => {
    let saved
    const calls = []
    const power = (g, u) => 500 + (g === 'pet-group' && u === 'player' ? 1000 : 0)
    const run = vm.runInNewContext(`({ ${method} }).trial`, {
      getTrialCfg: async () => ({ cd: 2, rounds: 3 }),
      moment: () => ({ format: () => '2026-11-04' }),
      redis: { get: async () => 0, incr: async () => 1, expire: async () => {} },
      getUserLevel: async () => ({ level: 4, levelname: '筑基' }),
      getBag: () => ({}), getBuffs: async () => ({ atk: 1 }),
      calcCombatPower: (level, bag, buff, g, u) => ({ power: power(g, u) }),
      calcDamage: (level, bag, variance, buff, g, u) => {
        calls.push([g, u])
        return { dmg: power(g, u) / 2 }
      },
      readTrial: () => ({ groups: {}, weekGroups: {} }),
      saveTrial: data => { saved = data },
      getNick: () => '测试玩家', getWeekStart: () => '2026-10-31', rotateTrialPeriods,
      fightDesc: () => '', Config: { getforwardMsg: () => {} }, console
    })
    await run({ group_id: gid, user_id: 'player', reply: msg => assert.fail(String(msg)) })
    assert.deepEqual(calls, Array.from({ length: 3 }, () => [gid, 'player']))
    assert.equal(saved.groups[gid].player.power, 500 + petPower)
    assert.equal(saved.groups[gid].player.dmg, 3 * (500 + petPower) / 2)
    assert.equal(saved.weekGroups[gid].player.total, saved.groups[gid].player.dmg)
  })
}
