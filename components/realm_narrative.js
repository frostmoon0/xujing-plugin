const cleanName = value => typeof value === 'string' ? value.trim() : ''

/** 队名只取真实成员与宗门，不为混编队编造宗门归属。 */
export function realmNpcTeamIdentity (persons = [], { leader = '', sectNameOf = sid => sid } = {}) {
  const members = (Array.isArray(persons) ? persons : []).filter(p => p && cleanName(p.name))
  const preferred = cleanName(leader)
  const leaderName = members.find(p => p.name === preferred)?.name || members[0]?.name || preferred || '无名修士'
  const sid = members[0]?.sect
  const sameSect = members.length > 0 && Boolean(sid) && members.every(p => p.sect === sid)
  const sectName = sameSect ? cleanName(sectNameOf(sid)) : ''
  return {
    name: members.length <= 1 ? leaderName : (sectName ? `${sectName}·${leaderName}` : `${leaderName}一行`),
    sectName
  }
}

function stableHash (value) {
  let hash = 2166136261
  for (const char of value) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0
  return hash
}

/** 只改写已知结算语句；奖励、伤势与其他未知事实均由原消息保留。 */
export function formatRealmNpcAction (team, node, choice, messages) {
  if (!Array.isArray(messages)) return []
  const lines = messages.filter(x => typeof x === 'string').flatMap(x => x.split(/\r?\n/)).map(x => x.trim()).filter(Boolean)
  if (!lines.length) return []

  const name = cleanName(team?.name) || cleanName(team?.leader) || '无名修士'
  const type = node?.type || ''
  const idx = Number(choice)
  const target = cleanName(node?.data?.targetName) || cleanName(String(node?.text || '').match(/【([^】]+)】/)?.[1]) || '另一队修士'
  const beast = cleanName(node?.data?.enemyName) || '拦路妖兽'
  const eventTrial = Boolean(cleanName(node?.data?.eventText)) || String(node?.title || '').includes('异变')
  const opponent = type === 'beast' ? beast : (type === 'trial' ? (eventTrial ? '拦路之敌' : '试炼对手') : target)
  const seed = stableHash(`${team?.id || name}|${team?.step || 0}|${type}|${idx}`)
  const pick = variants => variants[seed % variants.length]
  const defeated = (type === 'fake' || type === 'player') && lines.includes('我方落败。')
  const winner = defeated ? `【${target}】` : ''
  const facts = []
  const aftermath = []
  let combat = ''

  for (const line of lines) {
    // 技术行严格按结构解析，不替换姓名中恰好出现的“我方”“对方”。
    const powers = line.match(/^⚔️\s*我方\s+(\S+)\s*·\s*(.*?)\s+(\S+)\s*·\s*胜率([\d.]+)%$/)
    if (powers) {
      if (idx === 1) combat = `战力${powers[1]}，${opponent}战力${powers[3]}，胜率${powers[4]}%`
      continue
    }
    if (line === '我方获胜。') { facts.push(`与【${target}】交锋获胜。`); continue }
    if (line === '我方落败。') { facts.push(`与【${target}】交锋落败。`); continue }

    // 损失排在事件结果之后，保留实际队命与遣返事实。
    if (/^(?:⛔\s*)?队命-/.test(line) || line === '队命耗尽，已遣返。') {
      aftermath.push(line.replace(/^⛔\s*/, ''))
      continue
    }

    let text = line
    if (type === 'treasure') {
      if (line.startsWith('获得')) text = line.replace(/^获得/, pick(['寻到遗藏，取出', '收起遗藏中的']))
      else if (line === '已放弃宝物。') text = pick(['没有收取遗藏，继续赶路。', '放下这处遗藏，转往别处。'])
    } else if (type === 'canwu' || type === 'dushi') {
      if (line.startsWith('参悟成功，获得')) text = line.replace(/^参悟成功，获得/, '参悟残碑有所领会，获得')
      else if (line === '参悟失败，遭到道则反噬。') text = '参悟残碑失败，遭到道则反噬。'
      else if (line.startsWith('拓印完成，获得')) text = line.replace(/^拓印完成，获得/, '拓下碑文，获得')
      else if (line === '已绕过残碑。') text = pick(['没有触动残碑，继续前行。', '绕过道则残碑，继续探路。'])
    } else if (type === 'fake' || type === 'player') {
      if (line === '支付300灵石，已通过。') text = `交出300灵石，向【${target}】借道而过。`
      else if (line === '灵石不足，已绕行。') text = `灵石不足，避开【${target}】另寻通路。`
      else if (line === '对方已离场。') text = `赶到相遇之处时，【${target}】已经离开。`
      else if (line === '已避开对方。') text = pick([`避开【${target}】的路线，继续探路。`, `与【${target}】错开，绕往别处。`])
      else if (line === '双方未交战。') text = `与【${target}】相互观望，未曾交战。`
    } else if (type === 'trial') {
      if (line.startsWith('迎战获胜，获得')) text = line.replace(/^迎战获胜，获得/, eventTrial ? '迎战拦路异变获胜，获得' : '在试炼中交锋获胜，获得')
      else if (line === '迎战落败。') text = eventTrial ? '迎战拦路异变落败。' : '在试炼中交锋落败。'
      else if (line === '已绕行。') text = eventTrial ? '绕开异变波及的地段，继续前行。' : '绕过这处试炼，继续前行。'
    } else if (type === 'chuangguan') {
      if (line.startsWith('闯关成功，获得')) text = line.replace(/^闯关成功，获得/, '闯过试炼关，获得')
      else if (line === '闯关失败。') text = '闯关失败，未能通过试炼。'
      else if (line === '已绕过考验，无奖励。') text = '绕过试炼关，未取奖励。'
      else if (line === '已退出考验。') text = '退回试炼关外，另寻去路。'
    } else if (type === 'jueze') {
      if (line.startsWith('救助完成，道心+2，获得')) text = line.replace(/^救助完成，道心\+2，获得/, '出手救助幻境中的伤者，道心+2，获得')
      else if (idx === 3 && line.startsWith('获得')) text = line.replace(/^获得/, '取走伤者身旁的宝物，获得')
      else if (line === '未干涉幻境，已离开。') text = '没有回应幻境中的求援，径直离开。'
    } else if (type === 'duojie') {
      if (line.startsWith('夺宝成功，获得')) text = line.replace(/^夺宝成功，获得/, '穿过雷池夺得灵宝，获得')
      else if (line === '夺宝失败，遭到雷击。') text = '入雷池夺宝失败，遭到雷击。'
      else if (line.startsWith('收取灵物，获得')) text = line.replace(/^收取灵物，获得/, '沿雷池外围收取灵物，获得')
      else if (line === '已避开雷池。') text = pick(['避开雷池，转往别处。', '绕过雷池，继续探路。'])
    } else if (type === 'jiemi') {
      if (line === '破禁失败，乱源+1。') text = '强行破禁失败，乱源+1。'
      else if (line === '已绕过禁制。') text = '没有触动禁制，从旁绕过。'
      else if (line.startsWith('禁制解除，获得')) text = line.replace(/^禁制解除，获得/, idx === 2 ? '循阵纹解开禁制，获得' : '破开古老禁制，获得')
    } else if (type === 'beast') {
      if (line.startsWith('猎杀成功，获得')) text = line.replace(/^猎杀成功，获得/, `猎杀${beast}，获得`)
      else if (line === '猎杀失败，遭到妖兽攻击。') text = `猎杀${beast}失败，反遭攻击。`
      else if (line === '支付300灵石，已通过。') text = `用300灵石安抚${beast}，穿过拦路地段。`
      else if (line === '灵石不足，已绕行。') text = `灵石不足，绕开${beast}盘踞的地段。`
      else if (line === '已绕行。') text = pick([`避开${beast}，另寻通路。`, `绕过${beast}盘踞的地段，继续前行。`])
    } else if (type === 'maze') {
      if (line.startsWith('辨明阵纹，获得')) text = line.replace(/^辨明阵纹，获得/, '循阵纹辨明迷阵出路，获得')
      else if (line.startsWith('穿过迷阵，获得')) text = line.replace(/^穿过迷阵，获得/, `沿${idx === 2 ? '右' : '左'}路穿过迷阵，获得`)
      else if (line === '误入死路，乱源+0.5。') text = `沿${idx === 2 ? '右' : '左'}路误入死路，乱源+0.5。`
    } else if (type === 'spring') {
      if (line.startsWith('淬体完成，本场战力+10%，获得')) text = line.replace(/^淬体完成，本场战力\+10%，获得/, '借灵泉淬体，本场战力+10%，获得')
      else if (line === '已离开灵泉。') text = '未在灵泉停留，继续前行。'
    } else if (type === 'scroll') {
      if (line.startsWith('采得')) text = line.replace(/^采得/, '从石缝中采得')
      else if (line === '未采集，已离开。') text = '没有采集石缝中的灵材，转身离开。'
    } else if (type === 'elder') {
      if (line.startsWith('老者赠予')) text = line.replace(/^老者赠予/, '向老者求赠，获赠')
      else if (line.startsWith('老者指明去路，赠予')) text = line.replace(/^老者指明去路，赠予/, '向老者问明前路，临别获赠')
      else if (line.startsWith('试探得手，获得')) text = line.replace(/^试探得手，获得/, '出手试探老者得手，获得')
      else if (line === '试探失败，被老者击退。') text = '出手试探失败，被老者击退。'
    } else if (type === 'contest') {
      if (idx === 1 && line.startsWith('获得')) text = line.replace(/^获得/, '抢在众修之前夺得灵物，获得')
      else if (line.startsWith('趁隙收取，获得')) text = line.replace(/^趁隙收取，获得/, '在众修争抢间趁隙收取，获得')
      else if (line === '已放弃夺宝。') text = '退出夺宝争抢，转往别处。'
    }

    // 搜刮消息可能来自遭遇中的胜方；落败旁白须明确实际受益者。
    if (/^(?:🧳\s*)?夺得奖励池份额：/.test(line)) text = `${winner}${line.replace(/^🧳\s*/, '')}`
    else if (/^🎒\s*从【/.test(line)) text = `${winner}${line.replace(/^🎒\s*/, '')}`
    else if (line === '🤝 已放过对方，未取战利品。') text = `${winner}收手放行，未取战利品。`
    else if (line === '搜刮完成，对方仍在场。') text = `${winner}搜刮后收手，败者仍在秘境中。`
    else if (line === '对方队伍已无人可行动。') text = `【${defeated ? target : name}】已无人可继续行动。`
    facts.push(text)
  }

  if (combat) {
    if (facts.length) facts[0] = `${facts[0].replace(/。$/, '')}（${combat}）。`
    else facts.push(`${combat}。`)
  }
  const narration = [...facts, ...aftermath].map(text => /[。！？!?]$/.test(text) ? text : `${text}。`).join('')
  return narration ? [`【${name}】${narration}`] : []
}
