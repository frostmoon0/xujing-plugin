import { plugin } from '../../model/api/api.js'
import Wanhun, { parseWanhunNamedCmd, wanhunNamedCmdReg } from '../../components/wanhun_data.js'
import { getWorld, getLoc } from '../../components/world_data.js'
import { getBag, rainbowAtk, itemIcon } from '../../components/equip_data.js'
import { forceLock, isCurrent, unlock } from '../../components/interact.js'
import { textToImg } from '../../components/common-lib/reply-img.js'

function notifyAt (gid, uid, text) {
  try {
    const group = Bot.pickGroup(gid)
    if (group && group.sendMsg) group.sendMsg([segment.at(Number(uid)), text])
  } catch (err) { }
}

const pending = new Map()
function keyOf (e) { return `${e.group_id}:${e.user_id}` }
function reply (e, text) { e.reply(text); return true }

export class wanhun extends plugin {
  constructor () {
    super({
      name: '万魂幡',
      dsc: '万魂幡与万魂窟',
      event: 'message',
      priority: 45,
      rule: [
        { reg: '^[#＃]?(万魂幡|万魂幡信息)$', fnc: 'wanhunPanel' },
        { reg: '^[#＃]?(万魂幡命名|万魂幡改名)\\s*\\S*$', fnc: 'renameWanhun' },
        { reg: '^[#＃]?装备万魂幡$', fnc: 'equipWanhun' },
        { reg: wanhunNamedCmdReg('装备'), fnc: 'equipNamedWanhun' },
        { reg: '^[#＃]?卸下万魂幡$', fnc: 'unequipWanhun' },
        { reg: wanhunNamedCmdReg('卸下'), fnc: 'unequipNamedWanhun' },
        { reg: '^[#＃]?祭出万魂幡$', fnc: 'deployWanhun' },
        { reg: wanhunNamedCmdReg('祭出'), fnc: 'deployNamedWanhun' },
        { reg: '^[#＃]?收回万魂幡$', fnc: 'recallWanhun' },
        { reg: wanhunNamedCmdReg('收回'), fnc: 'recallNamedWanhun' },
        { reg: '^[#＃]?(打造|制作)万魂幡(\\d+)?$', fnc: 'craftWanhun' },
        { reg: '^[#＃]?(升级|进阶)万魂幡$', fnc: 'upgradeWanhun' },
        { reg: '^[#＃]?探索万魂窟$', fnc: 'enterCave' },
        { reg: '^[#＃]?退出万魂窟$', fnc: 'leaveCave' },
        { reg: '^[#＃]?万魂窟状态$', fnc: 'caveStatus' },
        { reg: '^[#＃]?万魂窟战$', fnc: 'fightCave' },
        { reg: '^[#＃]?万魂窟撤退$', fnc: 'retreatCave' },
        { reg: '^[#＃]?(服用还魂丹|吃还魂丹)$', fnc: 'takePill' },
        { reg: '^[#＃]?救援(?:\\s*@?(\\d+))?$', fnc: 'rescue' },
        { reg: '^[#＃]?(魔窟商人|魔窟老者)$', fnc: 'merchant' },
        { reg: '^[#＃]?(万魂幡路线|万魂窟攻略)$', fnc: 'route' },
        { reg: '^[#＃]?培育主魂$', fnc: 'trainMainSoul' },
        { reg: '^[#＃]?培育副魂\\s*(\\d+)$', fnc: 'trainDeputySoul' },
        { reg: '^[#＃]?喂养主魂\\s*(\\d+)$', fnc: 'feedMainSoul' },
        { reg: '^[#＃]?喂养副魂\\s*(\\d+)\\s*(\\d+)$', fnc: 'feedDeputySoul' },
        { reg: '^[#＃]?万魂幡状态$', fnc: 'wanhunStatus' },
        { reg: '^[#＃]?(万魂幡玩法|万魂窟玩法|万魂幡说明|万魂幡攻略|万魂窟说明)$', fnc: 'wanhunGuide' },
        { reg: '^[#＃]?[0-9]+$', fnc: 'pick' }
      ]
    })
  }

  async wanhunPanel (e) {
    const p = Wanhun.panel(e.user_id, e.group_id)
    const cave = await Wanhun.caveStatus(e.user_id, e.group_id)
    const name = p.artifact ? Wanhun.nameOf(p.artifact) : '万魂幡'
    const equipCmd = p.artifact ? `#装备${name}` : '#装备万魂幡'
    const deployCmd = p.artifact ? `#祭出${name}` : '#祭出万魂幡'
    return reply(e, `━━━ 禁忌法宝：${name} ━━━\n${p.text}\n\n${cave}\n\n#打造万魂幡 · ${equipCmd} · ${deployCmd}\n改名：#万魂幡命名 <名字>；改名后 #装备/#祭出/#收回/#卸下 均可直接用新名字\n进阶成功率固定100%，需要累计收魂和业力。`)
  }

  async renameWanhun (e) {
    const m = String(e.msg || '').match(/^[#＃]?(?:万魂幡命名|万魂幡改名)\s*(.*)$/)
    const ret = Wanhun.rename(e.user_id, e.group_id, m ? m[1] : '')
    return reply(e, ret.msg)
  }

  async equipWanhun (e) { return reply(e, Wanhun.equip(e.user_id, e.group_id, true).msg) }

  async equipNamedWanhun (e) {
    const m = String(e.msg || '').match(/^[#＃]?装备\s*(\S+)$/)
    if (!m) return false
    const artifact = Wanhun.getArtifact(e.user_id, e.group_id)
    if (!artifact || Wanhun.nameOf(artifact) !== m[1]) return false
    return reply(e, Wanhun.equip(e.user_id, e.group_id, true).msg)
  }
  async unequipWanhun (e) { return reply(e, Wanhun.equip(e.user_id, e.group_id, false).msg) }
  async deployWanhun (e) { return reply(e, Wanhun.deploy(e.user_id, e.group_id).msg) }
  async recallWanhun (e) { return reply(e, Wanhun.recall(e.user_id, e.group_id).msg) }
  /* 改名后可用新名字: 名字匹配才处理, 否则 return false 放行给傀儡等其它指令 */
  async unequipNamedWanhun (e) {
    const name = parseWanhunNamedCmd(e.msg, '卸下')
    if (!name) return false
    const artifact = Wanhun.getArtifact(e.user_id, e.group_id)
    if (!artifact || Wanhun.nameOf(artifact) !== name) return false
    return reply(e, Wanhun.equip(e.user_id, e.group_id, false).msg)
  }
  async deployNamedWanhun (e) {
    const name = parseWanhunNamedCmd(e.msg, '祭出')
    if (!name) return false
    const artifact = Wanhun.getArtifact(e.user_id, e.group_id)
    if (!artifact || Wanhun.nameOf(artifact) !== name) return false
    return reply(e, Wanhun.deploy(e.user_id, e.group_id).msg)
  }
  async recallNamedWanhun (e) {
    const name = parseWanhunNamedCmd(e.msg, '收回')
    if (!name) return false
    const artifact = Wanhun.getArtifact(e.user_id, e.group_id)
    if (!artifact || Wanhun.nameOf(artifact) !== name) return false
    return reply(e, Wanhun.recall(e.user_id, e.group_id).msg)
  }
  async craftWanhun (e) {
    const uid = e.user_id
    const gid = e.group_id
    const m = String(e.msg || '').match(/^[#＃]?(?:打造|制作)万魂幡(\d+)?$/)
    const wantNum = m && m[1] ? parseInt(m[1], 10) : null
    const bag = getBag(uid, gid)
    if (bag.artifacts?.wanhun) return reply(e, '你已经拥有万魂幡，不能重复打造。')
    const rainbows = Array.isArray(bag.rainbows) ? bag.rainbows : []
    if (!rainbows.length) return reply(e, '打造万魂幡需要一把成长性特殊彩武（先用 #铸造特殊彩武 获取）。')
    const list = rainbows.map((w, i) => ({
      id: w.id,
      label: `【${w.name}】攻击+${rainbowAtk(w)}`
    }))
    /* 按序号直接选 */
    if (wantNum) {
      if (wantNum < 1 || wantNum > list.length) {
        return reply(e, `序号超出范围，可用彩武：\n${list.map((it, i) => `${i + 1}. ${it.label}`).join('\n')}`)
      }
      return reply(e, Wanhun.craft(uid, gid, list[wantNum - 1].id).msg)
    }
    /* 不带序号: 弹列表选择(1把也弹) */
    await forceLock(e.group_id, uid, 'wanhun-craft')
    pending.set(keyOf(e), { type: 'craftWeapon', list, at: Date.now() })
    return reply(e, `你有 ${rainbows.length} 把彩武，请发送数字选择要消耗哪一把打造万魂幡：\n${list.map((it, i) => `${i + 1}. ${it.label}`).join('\n')}`)
  }

  async upgradeWanhun (e) {
    const ret = await Wanhun.upgrade(e.user_id, e.group_id)
    return reply(e, ret.msg)
  }

  async enterCave (e) {
    const ret = await Wanhun.enterCave(e.user_id, e.group_id)
    return reply(e, ret.msg)
  }

  async leaveCave (e) {
    const ret = Wanhun.leaveCave(e.user_id, e.group_id)
    return reply(e, ret.msg)
  }

  async caveStatus (e) {
    return reply(e, await Wanhun.caveStatus(e.user_id, e.group_id))
  }

  async beginChoice (e, type) {
    const lock = await forceLock(e.group_id, e.user_id, `wanhun-${type}`)
    pending.set(keyOf(e), { type, at: Date.now() })
    return lock
  }

  async fightCave (e) {
    const ret = await Wanhun.resolveCave(e.user_id, e.group_id, 'fight')
    return reply(e, ret.msg)
  }

  async retreatCave (e) {
    const ret = await Wanhun.resolveCave(e.user_id, e.group_id, 'retreat')
    return reply(e, ret.msg)
  }

  async takePill (e) {
    const ret = Wanhun.usePill(e.user_id, e.group_id)
    return reply(e, ret.msg)
  }

  async rescue (e) {
    let target = e.at
    if (!target) {
      const m = String(e.msg || '').match(/救援\s*@?(\d+)/)
      target = m && m[1]
    }
    if (!target) return reply(e, '请@需要救援的玩家，例如：#救援 @玩家')
    const ret = Wanhun.rescue(target, e.group_id)
    return reply(e, ret.msg)
  }

  async merchant (e) {
    if (getLoc(getWorld(e.group_id), e.user_id) !== 'west') return reply(e, '魔窟商人只在西域出现，请先前往西域。')
    const shop = Wanhun.shop(e.user_id, e.group_id)
    await forceLock(e.group_id, e.user_id, 'wanhun-shop')
    pending.set(keyOf(e), { type: 'shop', at: Date.now() })
    const text = Wanhun.shopText(shop)
    try {
      const img = await textToImg(text)
      if (img) {
        e.reply(img)
        return true
      }
    } catch (err) { }
    return reply(e, text)
  }

  async pick (e) {
    const k = keyOf(e)
    const n = Number(String(e.msg || '').replace(/[^0-9]/g, ''))
    const cave = Wanhun.getCave(e.user_id, e.group_id)
    if (cave.cave?.inCave && cave.cave.pending && !cave.lostInCave) {
      const p = cave.cave.pending
      if (n !== 1 && n !== 2) return reply(e, p.type === 'ghost' ? '遇到幽魂时，请回复1吸收或回复2放走。' : '万魂窟遇到阴魂时，请回复1战斗或回复2撤退。')
      if (p.type === 'ghost') {
        const ret = await Wanhun.resolveCave(e.user_id, e.group_id, n === 1 ? 'absorb' : 'release')
        return reply(e, ret.msg)
      }
      const ret = await Wanhun.resolveCave(e.user_id, e.group_id, n === 1 ? 'fight' : 'retreat')
      return reply(e, ret.msg)
    }
    const st = pending.get(k)
    if (!st || Date.now() - st.at > 5 * 60 * 1000) {
      /* 待选状态过期/丢失: 摘除残留的万魂交互锁, 避免堵住后续交互 */
      if (st && st.type === 'craftWeapon') await unlock(e.group_id, e.user_id, 'wanhun-craft')
      else if (st && st.type === 'shop') await unlock(e.group_id, e.user_id, 'wanhun-shop')
      pending.delete(k)
      return false
    }
    /* 打造万魂幡: 选择消耗哪一把彩武 */
    if (st.type === 'craftWeapon') {
      /* 校验: 仅当 wanhun-craft 在栈顶才处理(被其它交互埋住则让位, 保留待选状态等回到栈顶再恢复) */
      if (!(await isCurrent(e.group_id, e.user_id, 'wanhun-craft'))) {
        return false
      }
      if (n < 1 || n > st.list.length) return reply(e, `请输入 1~${st.list.length} 之间的数字`)
      const weapon = st.list[n - 1]
      pending.delete(k)
      const ret = Wanhun.craft(e.user_id, e.group_id, weapon.id)
      return reply(e, ret.msg)
    }
    /* 校验: 仅当 wanhun-shop 在栈顶才处理(被其它交互埋住则让位, 保留货单待选状态等回到栈顶再恢复) */
    if (!(await isCurrent(e.group_id, e.user_id, 'wanhun-shop'))) {
      return false
    }
    if (n < 1 || n > 12) return reply(e, '请输入1到12之间的兑换编号。')
    const ret = await Wanhun.buyShop(e.user_id, e.group_id, n)
    /* 购买成功或失败后都保留货单待选状态，玩家可连续回复数字兑换；每次操作重新续5分钟。 */
    await forceLock(e.group_id, e.user_id, 'wanhun-shop')
    const current = pending.get(k)
    if (current) {
      current.at = Date.now()
      pending.set(k, current)
    }
    return reply(e, `${ret.msg}${ret.ok ? '\n货单仍保持开启，5分钟内可继续回复其他序号兑换，无需重新打开魔窟商人。' : ''}`)
  }

  async route (e) {
    const gates = []
    const steps = []
    for (let r = 1; r <= 8; r++) {
      gates.push(`${r}→${r + 1}：收魂${Wanhun.UPGRADE[r].souls}、业力${Wanhun.UPGRADE[r].karma}`)
      steps.push(`${r}→${r + 1}：${Wanhun.upgradeCostText(r)}`)
    }
    const text = [
      '━━━ 万魂幡路线 ━━━',
      '1. 前往西域，使用1颗🔹魂石进入万魂窟，魂石每10分钟续一次；没有魂石会掉一个境界。',
      '2. 30秒至2分钟遇到阴魂，必须战斗或撤退；探索越久，敌人越强。',
      '3. 掉落按品质逐步开放：白/绿/蓝材料一直可得（白色材料更容易掉），30分钟后紫/金/红材料进入常规掉落且概率较高；彩色材料仅📜万魂幡残卷与🌈万魂帝晶（残卷30分钟后提高，帝晶50分钟后明显提高）；🌈造梦神玉、🌈云裳仙蕊不由万魂窟掉落。',
      '4. 战败或撤退失败会失魂；窟内只能服用🕯️还魂丹，救援送出后仍会失魂10小时。',
      `5. 打造：${itemIcon('万魂幡残卷')}万魂幡残卷×5、🌈成长性特殊彩武×1、${itemIcon('阴魂砂')}阴魂砂×20、${itemIcon('游魂骨')}游魂骨×20；#打造万魂幡 弹出彩武列表按序号选择消耗哪一把。`,
      `6. 九阶容量：${Wanhun.RANK_CAPACITY.slice(1).join('/')}；每次进阶成功率100%，但需要累计收魂、业力和材料。`,
      '进阶门槛（累计收魂/业力）：',
      ...gates.map(g => `· ${g}`),
      '进阶材料：',
      ...steps.map(s => `· ${s}`),
      '正式指令：#进阶万魂幡（#升级万魂幡仍兼容）。',
      `还魂丹配方：${itemIcon('玄阴玉')}玄阴玉×2、${itemIcon('镇魂晶')}镇魂晶×1、${itemIcon('血煞髓')}血煞髓×1、${itemIcon('云裳仙蕊')}云裳仙蕊×1。`
    ].join('\n')
    try {
      const img = await textToImg(text)
      if (img) {
        e.reply(img)
        return true
      }
    } catch (err) { }
    return reply(e, text)
  }

  async trainMainSoul (e) {
    const ret = Wanhun.trainMainSoul(e.user_id, e.group_id)
    return reply(e, ret.msg)
  }

  async trainDeputySoul (e) {
    const m = String(e.msg || '').match(/^[#＃]?培育副魂\s*(\d+)/)
    const ret = Wanhun.trainDeputySoul(e.user_id, e.group_id, m ? Number(m[1]) : 1)
    return reply(e, ret.msg)
  }

  async feedMainSoul (e) {
    const m = String(e.msg || '').match(/^[#＃]?喂养主魂\s*(\d+)/)
    const ret = await Wanhun.feedMainSoul(e.user_id, e.group_id, m ? Number(m[1]) : 0)
    return reply(e, ret.msg)
  }

  async feedDeputySoul (e) {
    const m = String(e.msg || '').match(/^[#＃]?喂养副魂\s*(\d+)\s*(\d+)/)
    const idx = m ? Number(m[1]) : 1
    const amount = m ? Number(m[2]) : 0
    const ret = await Wanhun.feedDeputySoul(e.user_id, e.group_id, idx, amount)
    return reply(e, ret.msg)
  }

  async wanhunStatus (e) {
    const text = Wanhun.statusText(e.user_id, e.group_id)
    try {
      const img = await textToImg(text)
      if (img) {
        e.reply(img)
        return true
      }
    } catch (err) { }
    return reply(e, text)
  }

  async wanhunGuide (e) {
    const text = Wanhun.guideText()
    /* 与 #万魂幡路线/#万魂幡状态 及其它 #XXX玩法 一致: 玩法说明全文渲染成一张图发送, 避免长文本刷屏/协议端422 */
    try {
      const img = await textToImg(text)
      if (img) {
        e.reply(img)
        return true
      }
    } catch (err) { }
    /* 图片渲染不可用(如 puppeteer 异常)时回退: 完整玩法说明较长, 拆成小段逐条发送避免协议端422。 */
    const pages = []
    let current = ''
    for (const line of text.split('\n')) {
      if (current && current.length + line.length + 1 > 600) {
        pages.push(current)
        current = ''
      }
      current = current ? `${current}\n${line}` : line
    }
    if (current) pages.push(current)
    for (const page of pages) {
      try {
        await e.reply(page)
      } catch (err) {
        /* 单段仍被协议端拒绝时继续拆小，避免回退发送整篇再次触发422。 */
        for (let i = 0; i < page.length; i += 300) {
          try { await e.reply(page.slice(i, i + 300)) } catch (splitErr) { }
        }
      }
    }
    return true
  }
}
