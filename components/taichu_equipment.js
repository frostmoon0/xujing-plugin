import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { TAICHU_EQUIPMENT } from './taichu_data.js'

// 缺失、损坏或非布尔值配置均保持关闭。玩家与伪玩家共用此入口。
export function isTaichuEnabled () {
  try {
    return JSON.parse(fs.readFileSync(new URL('../config/taichu.json', import.meta.url), 'utf8')).enabled === true
  } catch { return false }
}

export const ENCHANTMENTS = Object.freeze({
  sharpness: { name: '锋锐', parts: ['weapon', 'ring'], stat: 'atk', step: 0.1 },
  armor: { name: '坚甲', parts: ['helmet', 'chest', 'pants', 'shoes'], stat: 'def', step: 0.2 },
  vitality: { name: '生机', parts: ['helmet', 'chest', 'pants', 'shoes', 'ring'], stat: 'hp', step: 0.2 },
  array: { name: '破阵', parts: ['weapon'], step: 0.1 },
  seal: { name: '镇禁', parts: ['helmet'], step: 0.05 },
  durability: { name: '耐久', parts: ['weapon', 'helmet', 'chest', 'pants', 'shoes', 'ring'], care: true },
  lightness: { name: '轻灵', parts: ['shoes'], care: true, step: 0.05 },
  treasure: { name: '寻宝', parts: ['helmet', 'ring'], care: true, step: 0.05 }
})

// 元数据嵌入 attr，沿用背包装备属性的分组、交易、穿脱与继承载体。
export function createTaichuAttr (base) {
  return { ...base, taichu: { version: 1, id: randomUUID(), durability: 1000, maxDurability: 1000, wearRemainder: 0, enchants: {} } }
}

/** 旧存档缺字段时补齐；原有合法附魔、身份和耐久保留。 */
export function normalizeTaichuAttr (attr) {
  if (!attr?.taichu || typeof attr.taichu !== 'object' || Array.isArray(attr.taichu)) return createTaichuAttr(attr || {})
  const meta = attr.taichu
  const durability = Number(meta.durability)
  const remainder = Number(meta.wearRemainder)
  return { ...attr, taichu: {
    ...meta, version: 1,
    id: typeof meta.id === 'string' && meta.id ? meta.id : randomUUID(),
    maxDurability: 1000,
    durability: Number.isFinite(durability) ? Math.max(0, Math.min(1000, Math.floor(durability))) : 1000,
    wearRemainder: Number.isFinite(remainder) && remainder >= 0 && remainder < 1 ? remainder : 0,
    enchants: meta.enchants && typeof meta.enchants === 'object' && !Array.isArray(meta.enchants) ? meta.enchants : {}
  } }
}

export function validEnchantLevel (attr, part, key) {
  const level = attr?.taichu?.enchants?.[key]
  if (!ENCHANTMENTS[key]?.parts.includes(part) || !Number.isInteger(level) || level < 1 || level > 5) return 0
  // 无安装入口；读取历史/转移数据时仍严格遵守两个强化槽、一个养护槽。
  const care = !!ENCHANTMENTS[key].care
  const installed = Object.keys(ENCHANTMENTS).filter(id => !!ENCHANTMENTS[id].care === care && ENCHANTMENTS[id].parts.includes(part) && Number.isInteger(attr?.taichu?.enchants?.[id]) && attr.taichu.enchants[id] >= 1 && attr.taichu.enchants[id] <= 5)
  return installed.slice(0, care ? 1 : 2).includes(key) ? level : 0
}

// 仅计算本件原生属性；不接受角色总属性，也不改变传入对象。
export function taichuEquipStats (attr, part, setCount = 0, { enabled = isTaichuEnabled() } = {}) {
  const stats = Object.fromEntries(['atk', 'def', 'hp'].map(key => [key, Math.max(0, Number(attr?.[key]) || 0)]))
  if (!enabled || !attr?.taichu) return stats
  if (!(attr.taichu.durability > 0)) return { atk: 0, def: 0, hp: 0 }
  const setBonus = setCount >= 6 ? 0.3 : setCount >= 4 ? 0.2 : setCount >= 2 ? 0.1 : 0
  for (const key of Object.keys(stats)) {
    const enchant = Object.keys(ENCHANTMENTS).find(id => ENCHANTMENTS[id].stat === key)
    const bonus = enchant ? validEnchantLevel(attr, part, enchant) * ENCHANTMENTS[enchant].step : 0
    stats[key] = Math.round(stats[key] * (1 + bonus + (key === 'atk' ? 0 : setBonus)))
  }
  return stats
}

export function wearTaichuEquipment (attr, part, amount, { enabled = isTaichuEnabled() } = {}) {
  if (!enabled || !attr?.taichu || !Number.isFinite(amount) || amount <= 0) return false
  const meta = attr.taichu
  const loss = amount / (1 + validEnchantLevel(attr, part, 'durability')) + (meta.wearRemainder || 0)
  const whole = Math.floor(loss + 1e-9)
  meta.durability = Math.max(0, meta.durability - whole)
  meta.wearRemainder = meta.durability ? Math.max(0, loss - whole) : 0
  return true
}

export function taichuSetCount (bag, { enabled = isTaichuEnabled() } = {}) {
  if (!enabled) return 0
  return Object.entries(bag?.equipped || {}).filter(([part, name]) => TAICHU_EQUIPMENT[name]?.type === part && bag?.equippedAttr?.[part]?.taichu?.durability > 0).length
}

export function taichuExplorationEffects (bag, { enabled = isTaichuEnabled() } = {}) {
  const effects = { array: 0, seal: 0, lightness: 0, treasure: 0, sealCapacity: 0, dingxu: false, setCount: 0 }
  if (!enabled) return effects
  for (const [part, name] of Object.entries(bag?.equipped || {})) {
    const attr = bag?.equippedAttr?.[part]
    if (TAICHU_EQUIPMENT[name]?.type !== part || !(attr?.taichu?.durability > 0)) continue
    for (const key of ['array', 'seal', 'lightness', 'treasure']) effects[key] = Math.max(effects[key], validEnchantLevel(attr, part, key) * ENCHANTMENTS[key].step)
  }
  const count = taichuSetCount(bag, { enabled })
  effects.setCount = count
  effects.sealCapacity = count >= 4 ? 0.2 : 0
  effects.dingxu = count >= 6
  return effects
}

/** receipt应使用持久化战斗ID/阶段ID，同一结算不能重复扣耐久。 */
export function wearTaichuLoadout (bag, amount, { receipt = '', enabled = isTaichuEnabled() } = {}) {
  if (!enabled || !bag || !Number.isFinite(amount) || amount <= 0) return false
  const receipts = bag.taichu?.wearReceipts || []
  if (receipt && receipts.includes(receipt)) return false
  let changed = false
  for (const [part, name] of Object.entries(bag.equipped || {})) {
    if (TAICHU_EQUIPMENT[name]?.type !== part) continue
    changed = wearTaichuEquipment(bag.equippedAttr?.[part], part, amount, { enabled }) || changed
  }
  if (changed && receipt) {
    bag.taichu ||= {}
    bag.taichu.wearReceipts = [...receipts, receipt].slice(-100)
  }
  return changed
}

export function fmtTaichuAttr (attr, part) {
  const meta = attr?.taichu
  if (!meta) return ''
  const roman = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ']
  const names = Object.entries(ENCHANTMENTS).flatMap(([key, enchant]) => {
    const level = validEnchantLevel(attr, part, key)
    return level ? [`${enchant.name}${roman[level]}`] : []
  })
  return ` 耐久${Math.max(0, meta.durability || 0)}/${meta.maxDurability || 1000}${meta.durability <= 0 ? '（已损坏）' : meta.durability < 200 ? '（待修理）' : ''}${names.length ? ` 附魔：${names.join('、')}` : ''} [${String(meta.id || '').slice(0, 8)}]`
}
