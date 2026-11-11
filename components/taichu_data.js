/** 太初专属物品不参与普通随机材料/彩装池；只提高新装备预算，既有战力公式不变。 */
export const TAICHU_EQUIPMENT = Object.freeze({
  '太初·断界': { type: 'weapon', quality: 7, atk: 7200, taichu: true },
  '太初·镇神': { type: 'helmet', quality: 7, def: 4800, hp: 18000, taichu: true },
  '太初·无相': { type: 'chest', quality: 7, def: 6000, hp: 27000, taichu: true },
  '太初·承天': { type: 'pants', quality: 7, def: 5400, hp: 22500, taichu: true },
  '太初·踏虚': { type: 'shoes', quality: 7, def: 4200, hp: 18000, taichu: true },
  '太初·寂轮': { type: 'ring', quality: 7, atk: 3600, def: 3000, hp: 18000, taichu: true }
})

const details = {
  '太初·断界': { route: 'forge', base: '攻势·武器', core: '断界刃胚', diagram: '断界图谱', mats: { '造梦神玉': 120, '云裳仙蕊': 60, '凤羽玉': 300, '天衍阵纹': 60, '乾坤阵晶': 60, '海眼寒铁': 24, '沧溟珠泪': 8, '镇魂晶': 80, '万魂帝晶': 12, '七阶妖丹': 3 } },
  '太初·镇神': { route: 'soul', base: '攻势·头盔', core: '镇神骨', diagram: '镇神图谱', mats: { '造梦神玉': 100, '云裳仙蕊': 40, '天衍阵纹': 100, '乾坤阵晶': 100, '功法残卷': 20, '镇魂晶': 160, '万魂帝晶': 10, '九幽阵髓': 60, '六阶妖丹': 6, '七阶妖丹': 2 } },
  '太初·无相': { route: 'tide', base: '攻势·胸甲', core: '无相丝', diagram: '无相图谱', mats: { '造梦神玉': 120, '云裳仙蕊': 60, '龙宫珊瑚': 120, '沧溟珠泪': 12, '幽冥木': 600, '织云石': 1200, '海眼寒铁': 24, '镇魂晶': 100, '六阶妖丹': 6, '七阶妖丹': 3 } },
  '太初·承天': { route: 'forge', base: '攻势·裤子', core: '承天残纹', diagram: '承天图谱', mats: { '造梦神玉': 100, '云裳仙蕊': 40, '月魄石': 1800, '凤羽玉': 260, '血煞髓': 100, '乾坤阵晶': 100, '海眼寒铁': 18, '镇魂晶': 100, '六阶妖丹': 6, '七阶妖丹': 2 } },
  '太初·踏虚': { route: 'tide', base: '攻势·鞋子', core: '踏虚晶核', diagram: '踏虚图谱', mats: { '造梦神玉': 100, '云裳仙蕊': 40, '星璇石': 1800, '流光玉': 1200, '太虚阵砂': 120, '潮汐月华': 30, '龙宫珊瑚': 80, '镇魂晶': 100, '六阶妖丹': 6, '七阶妖丹': 2 } },
  '太初·寂轮': { route: 'soul', base: '攻势·戒指', core: '寂轮心核', diagram: '寂轮图谱', mats: { '造梦神玉': 120, '云裳仙蕊': 80, '无主幽魂': 600, '万魂帝晶': 18, '镇魂晶': 200, '血煞髓': 100, '九幽阵髓': 80, '沧溟珠泪': 8, '六阶妖丹': 6, '七阶妖丹': 3 } }
}

export const TAICHU_RECIPES = Object.freeze(Object.fromEntries(Object.entries(details).map(([name, d]) => [name, {
  route: d.route, base: d.base, core: d.core, diagram: d.diagram,
  materials: { '太初印': 8, [d.core]: 1, [d.diagram]: 1, ...d.mats },
  stones: 10000000, contribution: 1000
}])))

export const TAICHU_MATERIALS = Object.freeze({
  '太初印': { type: 'special', quality: 7, taichu: true },
  '古墟补给': { type: 'special', quality: 5, taichu: true },
  '太初修补包': { type: 'special', quality: 6, taichu: true },
  ...Object.fromEntries(Object.values(details).flatMap(d => [
    [d.core, { type: 'special', quality: 7, taichu: true }],
    [d.diagram, { type: 'special', quality: 7, taichu: true }],
    [`${d.diagram}碎片`, { type: 'special', quality: 6, taichu: true }],
    [`${d.core}碎片`, { type: 'special', quality: 6, taichu: true }]
  ]))
})

export const TAICHU_FRAGMENT_NEED = 10
export const TAICHU_SUPPLY_RECIPES = Object.freeze({
  '古墟补给': { materials: { '星霜草': 10, '织云石': 10 }, stones: 2000, contribution: 0 },
  '太初修补包': { materials: { '月魄石': 30, '流光玉': 20, '凤羽玉': 2 }, stones: 10000, contribution: 10 }
})
