import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import * as equip from '../components/equip_data.js'
import { createTaichuAttr } from '../components/taichu_equipment.js'
import { robSpoils, inheritFakeAssets } from '../components/fake_data.js'
import { extractWarLoot, depositWarLoot, takeVaultEquipAttrs } from '../components/sect/war_loot.js'

const empty = () => ({ items: {}, equipped: {}, equippedAttr: {}, artifacts: {} })
const name = '太初·断界'
const enchanted = durability => {
  const attr = createTaichuAttr({ atk: 2400 })
  attr.taichu.durability = durability
  attr.taichu.enchants = { sharpness: 5, array: 3, durability: 5 }
  attr.taichu.wearRemainder = 0.5
  return attr
}
const owned = bag => [...equip.getBagEquipEntries(bag).map(x => x.attr), ...Object.entries(bag.equipped || {}).flatMap(([part, n]) => n === name ? [bag.equippedAttr[part]] : [])].sort((a, b) => a.taichu.id.localeCompare(b.taichu.id))

function giftApp (from, recipient) {
  const source = fs.readFileSync(new URL('../apps/user/trade.js', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?from\s*['"][^'"]+['"];?\r?$/gm, '').replace(/^export /gm, '')
  const prototype = vm.runInNewContext(`${source}\n;trade.prototype`, {
    ...equip, Save_Path: 'unused', fs, path: {}, plugin: class {}, structuredClone,
    getBag: () => from, saveBag: () => {}, getFake: () => ({ roster: { 受赠者: recipient } }), saveFake: () => {},
    logPlayerTrade: () => {}, logEvent: () => {}, levelNameOf: String
  })
  return Object.create(prototype)
}

test('玩家赠送伪玩家多件同名太初装备，耐久附魔及身份逐件保留', async () => {
  const from = empty(), recipient = { name: '受赠者', alive: true, bag: empty() }
  const attrs = [enchanted(123), enchanted(456)]
  for (const attr of attrs) equip.addItemToBag(from, name, 1, attr, false)
  const app = giftApp(from, recipient)
  await app.fakeGift({ group_id: 'g', user_id: '1', msg: `#伪玩家送 受赠者 ${name} 2`, reply: () => {} })
  assert.equal(from.items[name], undefined)
  assert.deepEqual(owned(recipient.bag), attrs.sort((a, b) => a.taichu.id.localeCompare(b.taichu.id)))
})

test('赠送数量不足不扣已有实例，也不在伪玩家背包生成新装备', async () => {
  const from = empty(), recipient = { name: '受赠者', alive: true, bag: empty() }
  equip.addItemToBag(from, name, 1, enchanted(0), false)
  const before = structuredClone({ from, recipient })
  await giftApp(from, recipient).fakeGift({ group_id: 'g', user_id: '1', msg: `#伪玩家送 受赠者 ${name} 2`, reply: () => {} })
  assert.deepEqual({ from, recipient }, before)
})

test('NPC搜刮与亲属继承保留背包和穿戴实例，源装备全部摘除', () => {
  for (const inherited of [false, true]) {
    const target = { name: '接收者', alive: true, bag: empty(), money: 0 }
    const victim = { name: '原主人', alive: false, bag: empty(), money: 0, relations: { spouse: target.name } }
    const attrs = [enchanted(0), enchanted(999)]
    equip.addItemToBag(victim.bag, name, 1, attrs[0], false)
    victim.bag.equipped.weapon = name
    victim.bag.equippedAttr.weapon = attrs[1]
    const f = { roster: { [target.name]: target, [victim.name]: victim }, sects: {}, sectMap: {} }
    if (inherited) inheritFakeAssets(f, victim)
    else robSpoils(f, target, victim)
    assert.deepEqual(owned(target.bag), attrs.sort((a, b) => a.taichu.id.localeCompare(b.taichu.id)))
    assert.deepEqual(owned(victim.bag), [])
  }
})

test('无人继承的机缘库与宗门战利品宝库均保留完整附魔元数据', () => {
  const bag = empty(), attr = enchanted(531)
  equip.addItemToBag(bag, name, 1, attr, false)
  const victim = { name: '原主人', alive: false, bag: structuredClone(bag), money: 0 }
  const f = { roster: {}, sects: {}, sectMap: {} }
  inheritFakeAssets(f, victim)
  assert.deepEqual(f.fatePool.items[0].attr, attr)
  assert.deepEqual(owned(victim.bag), [])
  const entries = extractWarLoot(bag, 1, () => 0), vault = {}
  depositWarLoot(vault, entries)
  const extracted = takeVaultEquipAttrs(vault, name, 1)[0]
  assert.deepEqual(extracted.attr, attr)
  const recipient = empty()
  equip.addItemToBag(recipient, name, 1, extracted.attr, false)
  assert.deepEqual(owned(recipient), [attr])
})
