// 交易系统: 赠送道具/灵石 + 拍卖行(上架/下架/出价/一口价/过期结算)
// 规范: 长文本/列表展示一律渲染图片,短提示才直接 e.reply
import { BotApi, AlemonApi, plugin } from '../../model/api/api.js'
import fs from 'fs'
import path from 'path'
import puppeteer from '../../../../lib/puppeteer/puppeteer.js'
import xujing_data from '../../components/xujing_data.js'
import { Plugin_Name, Plugin_Path, Save_Path } from '../../components/plugin.js'
import { getBag, saveBag, getItemAttr, autoEquipBest, addItemToBag, EQUIP_TPL, ITEM_TPL, MATERIAL_TPL, GONGFA_TPL, getItemGroups, consumeItem, addItem, fmtEquip, equipPrice, rollEquipAttr, itemIcon } from '../../components/equip_data.js'
import { forceLock, isCurrent, unlock } from '../../components/interact.js'
import { guardActionLocked } from '../../components/action_lock.js'
import { resolvePuppetGift, resolveWanhunGift, transferArtifact } from '../../components/artifact_gift.js'
import { raidHappened } from '../../components/raid_data.js'
/*修仙世界: 赠送灵石纳入动态税率*/  
import { REGIONS, getWorld, getLoc, getRate, addTax, saveWorld, bossOf, regionNameOf, taxFor, levelNameOf } from '../../components/world_data.js'
import { logPlayerTrade, getNick, playerSectName, getFake, saveFake, fakeEatEmperorPill, logEvent } from '../../components/fake_data.js'

const AUCTION_DIR = `${Save_Path}/auction`//拍卖行数据目录
const DEFAULT_DURATION = 3//默认上架时长(小时)
const DEFAULT_START_PRICE = 100//默认起拍价
const MAX_LISTINGS = 10//每人最多同时在架数

/* ========== 藏宝阁系统上架 ========== */
/** 系统卖家标识 */
const SYSTEM_SELLER = '藏宝阁'
/** 系统上架材料池(药材不含彩云裳仙蕊, 矿物不含红彩凤羽玉/造梦神玉) */
const SYS_MATS = [
  { name: '星霜草', price: 1200 }, { name: '青鸾草', price: 1200 },
  { name: '望舒花', price: 4000 }, { name: '月华芝', price: 4000 },
  { name: '凤栖花', price: 12000 },
  { name: '月魄石', price: 1200 }, { name: '星璇石', price: 1200 },
  { name: '流光玉', price: 4000 }, { name: '织云石', price: 4000 }
]
/** 系统丹药池(按价值/合成成本定价) */
const SYS_PILLS = [
  { name: '修为丹', price: 1200 }, { name: '破障丹', price: 2500 },
  { name: '聚宝丹', price: 10000 }, { name: '灵犀丹', price: 6000 },
  { name: '行运丹', price: 7000 }, { name: '同心丹', price: 6000 },
  { name: '玉甲丹', price: 12000 }, { name: '凝露丹', price: 10000 },
  { name: '慧心丹', price: 12000 }, { name: '摄魂丹', price: 8000 }
]
/** 随机取一个 */
const sysPick = (arr) => arr[Math.floor(Math.random() * arr.length)]

/** 生成当天藏宝阁系统上架(保持10~20件, 受在架数约束补后≤20; 1%概率红装/红功法), 返回件数 */
async function genSystemAuction (gid, data, existing = 0) {
  const now = Date.now()
  const golds = Object.keys(EQUIP_TPL).filter(k => EQUIP_TPL[k].quality === 5)
  const purples = Object.keys(EQUIP_TPL).filter(k => EQUIP_TPL[k].quality === 4)
  const items = []
  /* 联动: 昨天藏宝阁被洗劫过 → 今日系统上架"好东西减少"(件数变少/金装概率降低, 起拍价不变) */
  const yest = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const yestDate = `${yest.getFullYear()}-${yest.getMonth() + 1}-${yest.getDate()}`
  let raided = false
  try { raided = await raidHappened(gid, yestDate) } catch (err) { }
  /* 随机总件数: 保持藏宝阁10~20件(受在架数约束, 补货后≤20) */
  const cap = Math.max(0, 20 - (existing || 0))
  const total = Math.min(cap, 10 + Math.floor(Math.random() * 11))
  // 1. 金色装备: 平日随机0~2件(50%+25%两抽) / 被洗劫后仅20%出1件
  let goldCnt = 0
  if (raided) {
    if (Math.random() < 0.2) goldCnt = 1
  } else {
    if (Math.random() < 0.5) goldCnt++
    if (Math.random() < 0.25) goldCnt++
  }
  for (let i = 0; i < goldCnt && items.length < total && golds.length; i++) items.push({ type: 'gold', name: sysPick(golds), count: 1 })
  // 2. 紫色装备: 平日随机0~3件 / 被洗劫后仅40%出1件
  const purpleCnt = raided ? (Math.random() < 0.4 ? 1 : 0) : Math.floor(Math.random() * 4)
  for (let i = 0; i < purpleCnt && items.length < total && purples.length; i++) items.push({ type: 'purple', name: sysPick(purples), count: 1 })
  // 3. 剩余随机丹药/材料填满 total(去重; 池子足够不会死循环, 加兜底防呆)
  const pushFill = () => {
    if (Math.random() < 0.5) {
      const p = sysPick(SYS_PILLS)
      if (!items.some(x => x.type === 'pill' && x.name === p.name)) items.push({ type: 'pill', name: p.name, count: 1 + Math.floor(Math.random() * 5) })
    } else {
      const m = sysPick(SYS_MATS)
      if (!items.some(x => x.type === 'mat' && x.name === m.name)) items.push({ type: 'mat', name: m.name, count: 1 + Math.floor(Math.random() * 5) })
    }
  }
  let guard = 0
  while (items.length < total && guard++ < 30) pushFill()
  /* 每次上架 1% 概率额外上架红装/红功法(稀世珍品, 不算在 total 内) */
  if (Math.random() < 0.01) {
    const reds = Object.keys(EQUIP_TPL).filter(k => EQUIP_TPL[k].quality === 6)
    const redGfs = Object.keys(GONGFA_TPL).filter(k => GONGFA_TPL[k].quality === 6)
    if (reds.length && redGfs.length) {
      if (Math.random() < 0.5) items.push({ type: 'red', name: sysPick(reds), count: 1 })
      else items.push({ type: 'redGf', name: sysPick(redGfs), count: 1 })
    } else if (reds.length) items.push({ type: 'red', name: sysPick(reds), count: 1 })
    else if (redGfs.length) items.push({ type: 'redGf', name: sysPick(redGfs), count: 1 })
  }
  /* 写入拍卖数据 */
  let added = 0
  for (const it of items) {
    let startPrice = 100
    if (it.type === 'gold') {
      // 金装: 25000~60000 随机(较贵)
      startPrice = 25000 + Math.floor(Math.random() * 35001)
    } else if (it.type === 'red') {
      // 红装: 30000~70000(比金装更稀贵)
      startPrice = 30000 + Math.floor(Math.random() * 40001)
    } else if (it.type === 'redGf') {
      // 红功法: 30000~70000
      startPrice = 30000 + Math.floor(Math.random() * 40001)
    } else if (it.type === 'purple') {
      startPrice = Math.round(equipPrice(it.name) * (0.8 + Math.random() * 0.7))
    } else if (it.type === 'pill') {
      const p = SYS_PILLS.find(x => x.name === it.name)
      startPrice = Math.round((p ? p.price : 500) * (0.8 + Math.random() * 0.7))
    } else {
      const m = SYS_MATS.find(x => x.name === it.name)
      startPrice = Math.round((m ? m.price : 300) * (0.8 + Math.random() * 0.7))
    }
    const buyNow = Math.round(startPrice * (1.5 + Math.random() * 0.5))
    const id = String(++data._seq)
    const sysDurH = 8 + Math.floor(Math.random() * 17)//藏宝阁上架时长随机8~24小时
    data[id] = {
      name: it.name,
      count: it.count,
      attr: (it.type === 'gold' || it.type === 'red') ? rollEquipAttr(EQUIP_TPL[it.name].type, it.type === 'red' ? 6 : 5) : null,
      startPrice,
      buyNow,
      duration: sysDurH,
      endTime: now + sysDurH * 3600000,
      // 无人出价时随机提前消失(30%~100%时长内随机)
      noBidEnd: now + Math.round(sysDurH * 3600000 * (0.3 + Math.random() * 0.7)),
      seller: SYSTEM_SELLER,
      highestBid: 0,
      highestBidder: ''
    }
    added++
  }
  return added
}

/** 藏宝阁惰性补货: 首次立即上架; 之后每0~3小时检查, 在架系统物品<10件时补一批(补后保持10~20件) */
async function ensureSystemAuction (gid, data) {
  try {
    const now = Date.now()
    const restockKey = `xujing:sys-auction:${gid}:restock`
    const nextAt = Number(await redis.get(restockKey)) || 0
    if (nextAt && now < nextAt) return
    /* 在架藏宝阁系统物品(未结算未过期) */
    const sys = Object.values(data).filter(a => a && a.seller === SYSTEM_SELLER && !a.settled && a.endTime > now)
    if (sys.length >= 10) {
      await redis.set(restockKey, String(now + Math.floor(Math.random() * 4) * 3600000))
      return
    }
    const n = await genSystemAuction(gid, data, sys.length)
    if (n > 0) saveAuction(gid, data)
    await redis.set(restockKey, String(now + Math.floor(Math.random() * 4) * 3600000))
  } catch (err) { }
}

/* ---------- 拍卖行文件工具 ---------- */
function auctionPath (gid) {
  return `${AUCTION_DIR}/${gid}.json`
}
function loadAuction (gid) {
  if (!fs.existsSync(AUCTION_DIR)) fs.mkdirSync(AUCTION_DIR, { recursive: true })
  const p = auctionPath(gid)
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({ _seq: 0 }))
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) {
    console.log('读取拍卖行数据失败:', err.message)
    return { _seq: 0 }
  }
}
function saveAuction (gid, data) {
  fs.writeFileSync(auctionPath(gid), JSON.stringify(data, null, '\t'))
}
function newAuctionId (data) {
  data._seq = (data._seq || 0) + 1
  return String(data._seq)
}
/** 在拍商品存储id列表(按上架顺序), 用于连续编号(1,2,3…) */
function auctionIds (data) {
  return Object.keys(data).filter(k => k !== '_seq')
}
/** 玩家输入的连续序号(1基) → 存储id; 序号越界/非法返回null */
function auctionIdByNo (data, no) {
  const ids = auctionIds(data)
  const i = Number(no) - 1
  if (!Number.isFinite(i) || i < 0 || i >= ids.length) return null
  return ids[i]
}
/** 是否有效道具(含功法: 兰息诀/紫霞功等) */
function isItem (name) {
  return !!EQUIP_TPL[name] || !!ITEM_TPL[name] || !!MATERIAL_TPL[name] || !!GONGFA_TPL[name]
}

/** 全角转半角(＃→#、全角数字/标点/空格→半角),用于指令解析防呆 */
function toHalfWidth (str) {
  return String(str || '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
}

/** 随机帮助背景图(与帮助面板一致) */
async function randomBg () {
  try {
    const dir = path.join(Plugin_Path, 'resources', 'help', 'imgs')
    if (!fs.existsSync(dir)) return ''
    const list = fs.readdirSync(dir)
    if (!list.length) return ''
    return list.length === 1 ? list[0] : list[Math.floor(Math.random() * list.length)]
  } catch (err) { return '' }
}

/** 渲染拍卖行图片(结构化卡片,避免刷屏) */
async function renderAuctionImage ({ settledList, list }) {
  const resPath = `../../../../../plugins/${Plugin_Name}/resources/`
  const bg = await randomBg()
  return await puppeteer.screenshot(`${Plugin_Name}/auction/index`, {
    tplFile: path.join(Plugin_Path, 'resources', 'auction', 'index.html'),
    pluResPath: resPath,
    _res_path: resPath,
    saveId: `auction-${Date.now()}`,
    bg,
    count: list.length,
    settledList,
    auctionList: list
  })
}

export class trade extends plugin {
  constructor () {
    super({
      name: '交易系统',
      dsc: '赠送道具/灵石、拍卖行交易',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^[#＃]?(虚境拍卖行|拍卖行|虚境拍卖会|拍卖会)$', fnc: 'auctionList' },
        { reg: '^[#＃]?虚境上架.*$', fnc: 'listItem' },
        { reg: '^[#＃]?虚境下架.*$', fnc: 'delist' },
        { reg: '^[#＃]?虚境出价.*$', fnc: 'bid' },
        { reg: '^[#＃]?虚境一口价.*$', fnc: 'buyNow' },
        // 赠送装备选编号: 只匹配 纯数字 / #数字 / @某人 数字(中文会误触发如“你战力才5000”) 
        { reg: '^(@[^\\s@]+)?[#＃]?\\s*[0-9]+$', fnc: 'giftPick' },
        { reg: '^(@[^\\s#＃@]+)?\\s*[#＃]?\\s*(虚境赠送金币|虚境送金币|虚境赠金币|虚境送钱|虚境赠钱|虚境送东西|虚境赠东西|送东西|赠东西|送金币|赠金币|虚境赠送|虚境送|虚境赠|赠送|送|赠)(?!给|你|我|他|她|它|的|了|啊|呀|吧|哦|呢|在|到|走|人|别|不(?:给|送|了|能|要|想|行|可以|可|(?=\\s|$))|这|那).*$', fnc: 'gift' },
        { reg: '^[#＃]?(伪玩家送|送伪玩家)\\s*(\\S+)\\s+(.+)$', fnc: 'fakeGift' }
      ]
    })
  }

  /** 取消息纯文本(去掉at等段) */
  getText (e) {
    return (e.message || []).filter(m => m.type === 'text').map(m => m.text).join('').trim()
  }

  /** 群成员昵称 */
  async getNick (e, uid) {
    try {
      const memberMap = await e.group.getMemberMap()
      for (const aaa of memberMap) {
        if (String(aaa[1].user_id) === String(uid)) {
          return aaa[1].card || aaa[1].nickname || String(uid)
        }
      }
    } catch (err) { }
    return String(uid)
  }

  /** 扣除背包道具,返回 { attr } 或 null(不足); 传 attr 时按属性分组扣(装备用) */
  takeItem (uid, name, count, attr, gid = 'global') {
    if (consumeItem(uid, name, count, attr, gid)) return { attr: attr || null }
    return null
  }

  /** 加入背包道具(保留 attr,按属性分组,装备自动穿最优) */
  giveItem (uid, name, count, attr, gid = 'global') {
    addItem(uid, name, count, attr, gid)
  }

  /** 读取灵石 */
  async getMoney (gid, uid) {
    const filename = `${gid}.json`
    const homejson = await xujing_data.getQQYUserHome(uid, null, filename, false)
    return { homejson, filename, money: Number(homejson[uid].money) || 0 }
  }

  /** 写入灵石 */
  async setMoney (gid, uid, money, homejson, filename) {
    homejson[uid].money = money
    await xujing_data.getQQYUserHome(uid, homejson, filename, true)
  }

  /** 一次性读取本群灵石档案并确保 uid 都存在(同一文件只读一次,避免多次快照互相覆盖) */
  async getGroupMoney (gid, uids) {
    const filename = `${gid}.json`
    const homejson = await xujing_data.getQQYUserHome(uids[0], null, filename, false)
    for (const uid of uids) {
      if (!homejson[uid]) homejson[uid] = { s: 0, wait: 0, money: 100, love: 0 }
    }
    return { homejson, filename }
  }

  /** 结算过期拍卖: 有出价则成交, 无出价退回卖家; 返回结算列表(通知合并一条群消息发送,防刷屏) */
  async settleExpired (gid, data) {
    const now = Date.now()
    const settled = []
    const notices = []//群内通知: 合并一次发送
    /* 结算前序号映射(连续编号: 按上架顺序1,2,3…), 结算播报用 */
    const seqMap = {}
    Object.keys(data).filter(k => k !== '_seq').forEach((k, i) => { seqMap[k] = i + 1 })
    for (const id of Object.keys(data)) {
      if (id === '_seq') continue
      const a = data[id]
      // 过期, 或无人出价且到了随机提前下架时间(noBidEnd) → 处理
      const noBidEnd = a.noBidEnd || a.endTime//兼容旧档
      const noBid = !(a.highestBidder && a.highestBid > 0)
      if (now < a.endTime && !(now >= noBidEnd && noBid)) continue
      const early = now < a.endTime//提前下架(未到原定过期时间)
      const isSys = a.seller === SYSTEM_SELLER
      if (a.highestBidder && a.highestBid > 0) {
        // 有出价: 中标者收货
        this.giveItem(a.highestBidder, a.name, a.count, a.attr, gid)
        let snet = 0
        let srate = 25
        if (!isSys) {
          // 玩家物品: 卖家收钱(按卖家所在大区动态税率扣税, 税收计入宗门繁荣度)
          const sworld = getWorld(gid)
          const sloc = getLoc(sworld, a.seller)
          srate = taxFor(sworld, sloc, playerSectName(gid, a.seller))
          const stax = Math.floor(a.highestBid * srate / 100)
          snet = a.highestBid - stax
          const sm = await this.getMoney(gid, a.seller)
          await this.setMoney(gid, a.seller, sm.money + snet, sm.homejson, sm.filename)
          addTax(sworld, sloc, stax)
          saveWorld(sworld)
          const sboss = bossOf(sworld, sloc)
          const sowner = sboss ? `${REGIONS[sloc].name}${sboss}` : `${REGIONS[sloc].name}各占领宗门`
          // 卖家+买家信息合并成一条
          notices.push({ at: [a.seller, a.highestBidder], msg: `⏰ ${itemIcon(a.name)}${a.name} ×${a.count} 已成交：卖家得 ${snet} 灵石（税率 ${srate}%，扣税 ${stax} 灵石，上交${sowner}），买家已到账背包` })
        } else {
          // 系统物品: 灵石系统回收, 只通知买家
          notices.push({ at: [a.highestBidder], msg: `⏰ ${itemIcon(a.name)}${a.name} ×${a.count} 已成交（藏宝阁），已到账背包` })
        }
        settled.push({ id, idx: seqMap[id], name: a.name, count: a.count, sold: true, price: a.highestBid, seller: a.seller, winner: a.highestBidder, net: snet, rate: srate })
      } else {
        // 无人出价: 随机提前下架或到期(系统物品直接消失,不退回)
        if (!isSys) {
          this.giveItem(a.seller, a.name, a.count, a.attr, gid)
          notices.push({ at: [a.seller], msg: `⏰ ${itemIcon(a.name)}${a.name} ×${a.count} 无人出价已${early ? '提前下架' : '过期'}，已退回背包` })
        }
        // 系统物品: 直接消失(不退回)
        settled.push({ id, idx: seqMap[id], name: a.name, count: a.count, sold: false, seller: a.seller, early })
      }
      delete data[id]
    }
    /* 成交记录写入江湖交易(玩家拍卖 / 藏宝阁高价) */
    for (const s of settled) {
      if (!s.sold) continue
      if (s.seller === SYSTEM_SELLER && s.price < 10000) continue
      try {
        const buyerNick = await getNick(gid, s.winner)
        logPlayerTrade(gid, `【拍卖】散修 ${buyerNick} 以 ${s.price} 灵石拍得 ${itemIcon(s.name)}${s.name} ×${s.count}${s.seller === SYSTEM_SELLER ? '（藏宝阁）' : ''}`)
      } catch (err) { }
    }
    if (settled.length) saveAuction(gid, data)
    // 全部通知合并成一条群消息(多个@拼一起), 避免刷屏
    if (notices.length) {
      try {
        const segs = []
        for (const n of notices) {
          if (segs.length) segs.push('\n')
          for (const uid of n.at) segs.push(segment.at(uid))
          segs.push(`\n${n.msg}`)
        }
        await Bot.pickGroup(gid).sendMsg(segs)
      } catch (err) { }
    }
    return settled
  }

  /** #虚境拍卖行: 查看本群拍卖(渲染图片) */
  async auctionList (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const gid = e.group_id
    const data = loadAuction(gid)
    const settled = await this.settleExpired(gid, data)
    await ensureSystemAuction(gid, data)//藏宝阁系统上架(首次/每天12点刷新)
    const ids = Object.keys(data).filter(k => k !== '_seq')
    if (!ids.length && !settled.length) {
      e.reply('🏪 拍卖行空空如也~ 用 #虚境上架 道具名 数量 起拍价 [一口价] [时长小时] 上架吧！')
      return true
    }
    // 过期结算播报
    const settledList = settled.map(s => s.sold
      ? `⏰ 编号${s.idx} ${itemIcon(s.name)}${s.name}×${s.count} 已成交${s.seller === SYSTEM_SELLER ? '（藏宝阁）' : `，卖家获得 ${s.net} 灵石（税率 ${s.rate}%，已上交）`}`
      : `⏰ 编号${s.idx} ${itemIcon(s.name)}${s.name}×${s.count} 无人出价已${s.early ? '提前下架' : '过期'}${s.seller === SYSTEM_SELLER ? '' : '，已退回卖家'}`)
    // 结构化在拍列表(供图片渲染, 展示连续编号1,2,3…)
    const list = []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const a = data[id]
      const remain = Math.max(0, a.endTime - Date.now())
      const remainH = (remain / 3600000).toFixed(1)
      const sellerNick = a.seller === SYSTEM_SELLER ? SYSTEM_SELLER : (await this.getNick(e, a.seller))
      let cur = '无人出价'
      let curNick = ''
      if (a.highestBid > 0 && a.highestBidder) {
        cur = String(a.highestBid)
        curNick = await this.getNick(e, a.highestBidder)
      }
      list.push({
        id: i + 1,
        icon: itemIcon(a.name),
        name: a.name,
        count: a.count,
        startPrice: a.startPrice,
        cur,
        curNick,
        buyNow: a.buyNow > 0 ? a.buyNow : 0,
        remainH,
        seller: sellerNick
      })
    }
    // 渲染图片(长内容用图片展示,避免刷屏)
    const img = await renderAuctionImage({ settledList, list })
    if (img) e.reply(img)
    else e.reply('拍卖行渲染失败，请稍后再试~')
    return true
  }

  /** 上架落库: 校验在架上限 → 扣除背包 → 写拍卖数据(单属性直发 / 多属性选件共用), 返回 {ok, msg} */
  async commitList (gid, uid, { name, count, startPrice, buyNow, duration, attr }) {
    const data = loadAuction(gid)
    await this.settleExpired(gid, data)
    const myOnSale = Object.keys(data).filter(k => k !== '_seq' && String(data[k].seller) === String(uid)).length
    if (myOnSale >= MAX_LISTINGS) {
      return { ok: false, msg: `你同时在架的商品已达上限（${MAX_LISTINGS}个），请先下架一些~` }
    }
    const taken = this.takeItem(uid, name, count, attr, gid)
    if (!taken) return { ok: false, msg: '扣除失败，请检查背包~' }
    const id = newAuctionId(data)
    const now = Date.now()
    const endTime = now + duration * 3600000
    data[id] = {
      seller: String(uid),
      name,
      count,
      attr: taken.attr,
      startPrice,
      buyNow,
      duration,
      startTime: now,
      endTime,
      // 无人出价时随机提前下架(30%~100%时长内随机)
      noBidEnd: now + Math.round((endTime - now) * (0.3 + Math.random() * 0.7)),
      highestBid: 0,
      highestBidder: null
    }
    saveAuction(gid, data)
    const idx = auctionIds(data).length//新商品排末尾, 连续编号即当前在拍数
    return { ok: true, msg: `✅ 已上架 ${itemIcon(name)}${name} ×${count}，编号【${idx}】\n起拍价：${startPrice}　${buyNow > 0 ? `一口价：${buyNow}　` : ''}上架时长：${duration}小时` }
  }

  /** #虚境上架 道具名 数量 起拍价 [一口价] [时长小时] */
  async listItem (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const gid = e.group_id
    const text = toHalfWidth(this.getText(e)).replace(/^[#＃]?\s*虚境上架/, '').trim()
    const parts = text.split(/\s+/)
    let name = parts[0]
    /* 防呆: 道具名后紧贴数量(如 修为丹1 / 修为丹x5 / 修为丹×5), 拆出数量 */
    let nameCount = 0
    if (name && !isItem(name)) {
      const m = name.match(/^(.+?)[x×*](\d+)$/)//名x数量
      const m2 = name.match(/^(.+?)(\d+)$/)//名5(无空格)
      if (m && isItem(m[1])) { name = m[1]; nameCount = Math.floor(Number(m[2])) }
      else if (m2 && isItem(m2[1])) { name = m2[1]; nameCount = Math.floor(Number(m2[2])) }
    }
    if (!name || !isItem(name)) {
      e.reply('请指定要上架的道具名，如：#虚境上架 修为丹 5 1000 5000 3')
      return true
    }
    const nums = parts.slice(1).map(Number).filter(n => Number.isFinite(n))
    if (nameCount > 0) nums.unshift(nameCount)//连写数量优先
    const count = Math.floor(nums[0] > 0 ? nums[0] : 1)
    const startPrice = Math.floor(nums[1] > 0 ? nums[1] : DEFAULT_START_PRICE)
    const buyNow = nums[2] > 0 ? Math.floor(nums[2]) : 0
    // 未指定时长: 随机3~24小时(反正都随机)
    const duration = nums[3] > 0 ? Math.floor(nums[3]) : (DEFAULT_DURATION + Math.floor(Math.random() * 22))
    // 检查背包数量
    const bag = getBag(e.user_id, gid)
    const cur = bag.items[name] ? bag.items[name].count : 0
    if (cur < count) {
      e.reply(`你的背包里只有 ${cur} 个 ${name}，不够上架 ${count} 个~`)
      return true
    }
    /* 装备: 必须保留属性,否则下架/过期退回会被 addItem 重新随机(黄/红/彩 q>4) */
    let listAttr = null
    if (EQUIP_TPL[name]) {
      const groups = getItemGroups(e.user_id, name, gid)
      /* 同名多属性: 列出编号让用户选上架哪一件(与赠送选编号一致, 避免扣错属性组) */
      if (groups.length > 1) {
        await forceLock(e.group_id, e.user_id, 'list')
        await redis.set(`xujing:listpick:${gid}:${e.user_id}`, JSON.stringify({
          name, count, startPrice, buyNow, duration, groups
        }), { EX: 120 })
        const lines = groups.map((g, i) => `${i + 1}. ${fmtEquip(name, g.count, g.attr)}`)
        e.reply([segment.at(e.user_id), `\n🏪 上架「${name}」有多件属性不同，要上架哪一件？\n回复编号选择：\n${lines.join('\n')}`])
        return true
      }
      /* 单属性组: 记录该组属性,上架/退回都原样保留 */
      listAttr = (groups[0] && groups[0].attr && Object.keys(groups[0].attr).length) ? groups[0].attr : null
    }
    const res = await this.commitList(gid, e.user_id, { name, count, startPrice, buyNow, duration, attr: listAttr })
    e.reply(res.ok ? [segment.at(e.user_id), `\n${res.msg}`] : res.msg)
    return true
  }

  /** 上架装备多属性编号选择: 回复数字选上架哪一件(与赠送选编号一致, 属性原样保留) */
  async listPick (e) {
    const key = `xujing:listpick:${e.group_id}:${e.user_id}`
    const raw = await redis.get(key)
    if (!raw) {
      /* 待选状态过期/丢失: 摘除残留的上架锁, 避免堵住后续交互 */
      await unlock(e.group_id, e.user_id, 'list')
      return false
    }
    /* 仅当上架在栈顶才处理(被逛街/渡劫/换装/赠送埋住则让位, 保留待选状态等回到栈顶再恢复) */
    if (!(await isCurrent(e.group_id, e.user_id, 'list'))) {
      return false
    }
    let st = null
    try { st = JSON.parse(raw) } catch (err) { }
    if (!st) { await unlock(e.group_id, e.user_id, 'list'); await redis.del(key); return false }
    const num = parseInt(e.msg.replace(/[^\d]/g, ''))
    const g = st.groups[num - 1]
    if (!g) {
      e.reply(`请输入 1~${st.groups.length} 选择要上架的装备~`)
      return true
    }
    const res = await this.commitList(e.group_id, e.user_id, {
      name: st.name, count: st.count, startPrice: st.startPrice, buyNow: st.buyNow, duration: st.duration, attr: g.attr
    })
    await redis.del(key)
    await unlock(e.group_id, e.user_id, 'list')
    e.reply(res.ok ? [segment.at(e.user_id), `\n${res.msg}`] : res.msg)
    return true
  }

  /** #虚境下架 编号 */
  async delist (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const gid = e.group_id
    const data = loadAuction(gid)
    const settled = await this.settleExpired(gid, data)
    const no = this.getText(e).replace(/^[#＃]?\s*虚境下架/, '').trim().split(/\s+/)[0]
    const id = auctionIdByNo(data, no)
    if (!id) {
      e.reply(`编号【${no}】不存在${settled.length ? '（可能已成交/过期）' : ''}~`)
      return true
    }
    const a = data[id]
    if (String(a.seller) !== String(e.user_id)) {
      e.reply('只能下架自己上架的商品哦~')
      return true
    }
    // 已有人出价则不能下架(避免出价人资金被套牢)
    if (a.highestBidder && a.highestBid > 0) {
      e.reply([segment.at(e.user_id), `\n⛔ 已有其他道友出价（当前最高 ${a.highestBid} 灵石），已有人出价不能下架~`])
      return true
    }
    this.giveItem(a.seller, a.name, a.count, a.attr, gid)
    delete data[id]
    saveAuction(gid, data)
    e.reply([segment.at(e.user_id), `\n✅ 已下架 ${itemIcon(a.name)}${a.name} ×${a.count}，物品已退回背包`])
    return true
  }

  /** #虚境出价 编号 金额 */
  async bid (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const gid = e.group_id
    const data = loadAuction(gid)
    const settled = await this.settleExpired(gid, data)
    const text = this.getText(e).replace(/^[#＃]?\s*虚境出价/, '').trim()
    const [noStr, amountStr] = text.split(/\s+/)
    const id = auctionIdByNo(data, noStr)
    if (!id) {
      e.reply(`编号【${noStr}】不存在${settled.length ? '（可能已成交/过期）' : ''}~`)
      return true
    }
    const a = data[id]
    if (String(a.seller) === String(e.user_id)) {
      e.reply('不能出价自己上架的商品哦~')
      return true
    }
    const amount = Math.floor(Number(amountStr))
    if (!Number.isFinite(amount) || amount < a.startPrice) {
      e.reply(`出价不能低于起拍价 ${a.startPrice} 灵石~`)
      return true
    }
    if (a.buyNow > 0 && amount >= a.buyNow) {
      e.reply(`已达一口价 ${a.buyNow}，请直接使用 #虚境一口价 ${id} 购买~`)
      return true
    }
    if (amount <= a.highestBid) {
      e.reply(`当前最高出价已是 ${a.highestBid}，请出更高价~`)
      return true
    }
    // 扣款 + 退还上一出价者(同一档案一次读写,避免快照互相覆盖)
    const uids = [e.user_id]
    if (a.highestBidder && a.highestBid > 0) uids.push(a.highestBidder)
    const { homejson, filename } = await this.getGroupMoney(gid, uids)
    const myMoney = Number(homejson[e.user_id].money) || 0
    if (myMoney < amount) {
      e.reply(`灵石不足，你只有 ${myMoney} 灵石~`)
      return true
    }
    homejson[e.user_id].money = myMoney - amount
    if (a.highestBidder && a.highestBid > 0) {
      homejson[a.highestBidder].money = (Number(homejson[a.highestBidder].money) || 0) + a.highestBid
    }
    await xujing_data.getQQYUserHome(e.user_id, homejson, filename, true)
    a.highestBid = amount
    a.highestBidder = String(e.user_id)
    saveAuction(gid, data)
    e.reply([segment.at(e.user_id), `\n✅ 出价成功！你以 ${amount} 灵石暂时领先\n编号【${id}】${itemIcon(a.name)}${a.name} ×${a.count}`])
    return true
  }

  /** #虚境一口价 编号: 直接买下 */
  async buyNow (e) {
    if (!e.group_id) { e.reply('请在群内使用~'); return true }
    const gid = e.group_id
    const data = loadAuction(gid)
    const settled = await this.settleExpired(gid, data)
    const no = this.getText(e).replace(/^[#＃]?\s*虚境一口价/, '').trim().split(/\s+/)[0]
    const id = auctionIdByNo(data, no)
    if (!id) {
      e.reply(`编号【${no}】不存在${settled.length ? '（可能已成交/过期）' : ''}~`)
      return true
    }
    const a = data[id]
    if (String(a.seller) === String(e.user_id)) {
      e.reply('不能购买自己上架的商品哦~')
      return true
    }
    if (!a.buyNow || a.buyNow <= 0) {
      e.reply('该商品未设置一口价，只能出价竞拍~')
      return true
    }
    // 买家扣款 + 卖家收款 + 退还上一出价者(同一档案一次读写,避免快照互相覆盖)
    const isSys = a.seller === SYSTEM_SELLER
    const uids = [e.user_id]
    if (!isSys) uids.push(a.seller)//系统物品不建立藏宝阁档案
    if (a.highestBidder && a.highestBid > 0) uids.push(a.highestBidder)
    const { homejson, filename } = await this.getGroupMoney(gid, uids)
    const buyerMoney = Number(homejson[e.user_id].money) || 0
    if (buyerMoney < a.buyNow) {
      e.reply(`灵石不足，需要 ${a.buyNow} 灵石，你只有 ${buyerMoney}~`)
      return true
    }
    homejson[e.user_id].money = buyerMoney - a.buyNow
    let sellerRate = 25
    let sellerTax = 0
    let sellerNet = 0
    let sellerOwner = ''
    if (!isSys) {
      // 按卖家所在大区动态税率扣税(税收计入宗门繁荣度)
      const sworld = getWorld(gid)
      const sloc = getLoc(sworld, a.seller)
      sellerRate = taxFor(sworld, sloc, playerSectName(gid, a.seller))
      sellerTax = Math.floor(a.buyNow * sellerRate / 100)
      sellerNet = a.buyNow - sellerTax
      homejson[a.seller].money = (Number(homejson[a.seller].money) || 0) + sellerNet
      addTax(sworld, sloc, sellerTax)
      saveWorld(sworld)
      const sboss = bossOf(sworld, sloc)
      sellerOwner = sboss ? `${REGIONS[sloc].name}${sboss}` : `${REGIONS[sloc].name}各占领宗门`
    }
    // 系统物品: 灵石系统回收(不加给藏宝阁)
    if (a.highestBidder && a.highestBid > 0) {
      homejson[a.highestBidder].money = (Number(homejson[a.highestBidder].money) || 0) + a.highestBid
    }
    await xujing_data.getQQYUserHome(e.user_id, homejson, filename, true)
    const soldName = a.name
    const soldCount = a.count
    const price = a.buyNow
    this.giveItem(e.user_id, a.name, a.count, a.attr, gid)
    delete data[id]
    saveAuction(gid, data)
    if (!isSys) { try { await Bot.pickUser(a.seller).sendMsg(`🏷️ 你上架的 ${itemIcon(soldName)}${soldName} ×${soldCount} 被一口价买走，获得 ${sellerNet} 灵石（税率 ${sellerRate}%，扣税 ${sellerTax} 灵石，上交${sellerOwner}）`) } catch (err) { } }
    e.reply([segment.at(e.user_id), `\n✅ 一口价购买成功！\n获得 ${itemIcon(soldName)}${soldName} ×${soldCount}，花费 ${price} 灵石`])
    /* 一口价成交写入江湖交易 */
    try {
      const buyerNick = await getNick(gid, e.user_id)
      logPlayerTrade(gid, `【拍卖】散修 ${buyerNick} 以 ${price} 灵石一口价购得 ${itemIcon(soldName)}${soldName} ×${soldCount}${isSys ? '（藏宝阁）' : ''}`)
    } catch (err) { }
    return true
  }

  /** 赠送(道具/灵石): 短指令/多格式/乱序/无空格/先@后指令均可,各种情况防呆提示 */
  async gift (e) {
    if (!e.group_id) { e.reply('赠送需在群内使用~'); return true }
    if (!e.at) {
      e.reply('请@要赠送的群友，如：#虚境赠送 @群友 修为丹 5\n（也可先@再输指令：@群友 虚境赠送 修为丹 5）')
      return true
    }
    if (String(e.at) === String(e.user_id)) { e.reply('不能送给自己哦~'); return true }
    /* 修为限制: 未到元婴期(13级=元婴初期)不能给他人送东西(道具/灵石) */
    try {
      const battle = await xujing_data.getQQYUserBattle('0', null, false, `${e.group_id}.json`)
      const lv = Number(battle && battle[String(e.user_id)] && battle[String(e.user_id)].level) || 0
      if (lv < 13) { e.reply(`🛡️ 修为未到元婴期（需 13 级，当前 ${lv} 级），还不能给他人赠送东西~`); return true }
    } catch (err) { }
    /* 同大区: 赠送(道具/丹药/灵石)双方须在同一大区(与送灵石一致) */
    try {
      const world = getWorld(e.group_id)
      const myLoc = getLoc(world, e.user_id)
      const tgtLoc = getLoc(world, e.at)
      if (myLoc !== tgtLoc) {
        e.reply(`你们不在同一大区！你位于【${regionNameOf(myLoc)}】，对方位于【${regionNameOf(tgtLoc)}】，请先同行再赠送~`)
        return true
      }
    } catch (err) { }
    /* 全角转半角防呆(＃/全角数字/全角空格),再统一解析 */
    const raw = toHalfWidth(this.getText(e))
    // 先去残留@提及(支持先@再输指令/兼容@未解析成独立段),再去指令前缀,再trim
    const text = raw
      .replace(/@[^\s@，,]+/g, '')
      .replace(/^\s*[#＃]?\s*(虚境赠送金币|虚境送金币|虚境赠金币|虚境送钱|虚境赠钱|虚境送东西|虚境赠东西|送东西|赠东西|送金币|赠金币|虚境赠送|虚境送|虚境赠|赠送|送|赠)/, '')
      .trim()
    // 灵石模式: 命令文本含"灵石/灵石/钱/块"关键字(道具名不含这些字,不会误判)
    if (/灵石|灵石|钱|块/.test(raw)) {
      const amountText = text.replace(/[灵石灵石块钱]+/g, '').trim()
      return await this.giftMoneyText(e, amountText)
    }
    /* 法宝赠送: 读取发送者背包供 傀儡/万魂幡/定仙游 识别(存于 bag.artifacts, 非背包物品) */
    const giftBag = getBag(e.user_id, e.group_id)
    // 道具模式: 乱序解析道具名与数量
    const parsed = this.parseGift(text)
    if (!parsed) {
      /* 傀儡法宝: 通用道具解析失败后识别(傀儡术上中下篇等 傀儡 前缀功法仍是普通道具, 道具名优先) */
      const pup = resolvePuppetGift(text, giftBag)
      if (pup) {
        if (!pup.ok) { e.reply(pup.msg); return true }
        return await this.giftArtifact(e, pup)
      }
      /* 万魂幡/定仙游法宝: 存于 bag.artifacts, 在通用道具解析失败后识别(普通道具名优先) */
      const art = resolveWanhunGift(text, giftBag)
      if (art) {
        if (!art.ok) { e.reply(art.msg); return true }
        return await this.giftArtifact(e, art)
      }
      // 纯数字(可带空格)无道具名 → 视为送灵石(如 #送 @A 1000 / #虚境赠送 @A 999)
      if (/^[\d\s]+$/.test(text)) return await this.giftMoneyText(e, text.replace(/[^\d]/g, ''))
      // 有非数字内容但没识别到道具 → 提示道具名不存在(防呆,避免误当灵石)
      if (/\d/.test(text)) {
        const unknown = text.replace(/[\d\s]+/g, '').trim()
        e.reply(`没有「${unknown || '这个'}」道具哦，如：#虚境赠送 @群友 修为丹 5`)
        return true
      }
      e.reply('没有识别到道具名，如：#虚境赠送 @群友 修为丹 5（也可 修为丹5 / 5修为丹）')
      return true
    }
    const { name, count } = parsed
    /* 装备多属性: 列出编号让用户选择送哪一件 */
    if (EQUIP_TPL[name]) {
      const groups = getItemGroups(e.user_id, name, e.group_id)
      if (groups.length > 1) {
        await forceLock(e.group_id, e.user_id, 'gift')
        await redis.set(`xujing:giftpick:${e.group_id}:${e.user_id}`, JSON.stringify({
          at: e.at, name, count, groups
        }), { EX: 120 })
        const lines = groups.map((g, i) => `${i + 1}. ${fmtEquip(name, g.count, g.attr)}`)
        e.reply([segment.at(e.user_id), `\n🎁 送「${name}」有多件属性不同，要送哪一件？\n回复编号选择：\n${lines.join('\n')}`])
        return true
      }
      // 单属性: 用该组属性
      const taken = this.takeItem(e.user_id, name, count, groups[0] && groups[0].attr, e.group_id)
      if (!taken) {
        const have = (getBag(e.user_id, e.group_id).items[name] && getBag(e.user_id, e.group_id).items[name].count) || 0
        e.reply(`背包里 ${name} 只有 ${have} 个，不够送 ${count} 个~`)
        return true
      }
      this.giveItem(e.at, name, count, taken.attr, e.group_id)
      const nick = await this.getNick(e, e.at)
      const bag = getBag(e.user_id, e.group_id)
      const remain = (bag.items[name] && bag.items[name].count) || 0
      e.reply([segment.at(e.user_id), `\n✅ 已赠送 ${itemIcon(name)}${name} ×${count} 给 ${nick}${remain > 0 ? `\n你剩余 ${remain} 个` : ''}`])
      /* 稀有装备赠送写入江湖交易(金及以上) */
      try {
        if ((EQUIP_TPL[name].quality || 0) >= 5) {
          const myNick = await getNick(e.group_id, e.user_id)
          logPlayerTrade(e.group_id, `【赠礼】散修 ${myNick} 赠送 ${itemIcon(name)}${name} ×${count} 给散修 ${nick}`)
        }
      } catch (err) { }
      return true
    }
    const taken = this.takeItem(e.user_id, name, count, null, e.group_id)
    if (!taken) {
      const have = (getBag(e.user_id, e.group_id).items[name] && getBag(e.user_id, e.group_id).items[name].count) || 0
      e.reply(`背包里 ${name} 只有 ${have} 个，不够送 ${count} 个~`)
      return true
    }
    this.giveItem(e.at, name, count, taken.attr, e.group_id)
    const nick = await this.getNick(e, e.at)
    const bag = getBag(e.user_id, e.group_id)
    const remain = (bag.items[name] && bag.items[name].count) || 0
    e.reply([segment.at(e.user_id), `\n✅ 已赠送 ${itemIcon(name)}${name} ×${count} 给 ${nick}${remain > 0 ? `\n你剩余 ${remain} 个` : ''}`])
    /* 稀有道具赠送写入江湖交易(金及以上材料/功法) */
    try {
      const q = (MATERIAL_TPL[name] && MATERIAL_TPL[name].quality) || (GONGFA_TPL[name] && GONGFA_TPL[name].quality) || 0
      if (q >= 5) {
        const myNick = await getNick(e.group_id, e.user_id)
        logPlayerTrade(e.group_id, `【赠礼】散修 ${myNick} 赠送 ${itemIcon(name)}${name} ×${count} 给散修 ${nick}`)
      }
    } catch (err) { }
    return true
  }

  /** 赠送法宝(傀儡/万魂幡/定仙游): 存于 bag.artifacts, 从发送者摘出克隆给接收者, 双方存档保存 */
  async giftArtifact (e, art) {
    const gid = e.group_id
    const fromBag = getBag(e.user_id, gid)
    const toBag = getBag(e.at, gid)
    const result = transferArtifact(fromBag, toBag, art)
    if (!result.ok) { e.reply(result.msg); return true }
    saveBag(e.user_id, fromBag, gid)
    saveBag(e.at, toBag, gid)
    const nick = await this.getNick(e, e.at)
    e.reply([segment.at(e.user_id), `\n✅ 已赠送 ${result.icon}${result.name} 给 ${nick}`])
    /* 法宝赠送写入江湖交易 */
    try {
      const myNick = await getNick(gid, e.user_id)
      logPlayerTrade(gid, `【赠礼】散修 ${myNick} 赠送 ${result.icon}${result.name} 给散修 ${nick}`)
    } catch (err) { }
    return true
  }

  /** #伪玩家送 [伪玩家名] [物品] [数量] / 灵石 [数量]: 给伪玩家送道具/灵石(与送群友同流程) */
  async fakeGift (e) {
    if (!e.group_id) { e.reply('需在群内使用~'); return true }
    const gid = String(e.group_id)
    const m = String(e.msg || '').match(/伪玩家送\s*(\S+)\s+(.+)/)
    if (!m) { e.reply('用法：#伪玩家送 [伪玩家名] [物品] [数量]\n例：#伪玩家送 张三 修为丹 5 ｜ #伪玩家送 张三 灵石 1000'); return true }
    const f = getFake(gid)
    const pname = m[1]
    const p = f.roster && f.roster[pname]
    if (!p) { e.reply(`查无伪玩家【${pname}】~`); return true }
    if (!p.alive) { e.reply(`【${pname}】已陨落，无法接收物品~`); return true }
    const text = m[2]
    /* 灵石模式: 文本含 灵石/钱/块 */
    if (/灵石|钱|块/.test(text)) {
      const amount = Math.floor(Number(String(text).replace(/[^\d]/g, '')) || 0)
      if (amount <= 0) { e.reply('请输入灵石数量，如：#伪玩家送 张三 灵石 1000'); return true }
      const { homejson, filename } = await this.getGroupMoney(gid, [e.user_id])
      const myMoney = Number(homejson[e.user_id].money) || 0
      if (myMoney < amount) { e.reply(`灵石不足，你只有 ${myMoney} 灵石~`); return true }
      homejson[e.user_id].money = myMoney - amount
      await xujing_data.getQQYUserHome(e.user_id, homejson, filename, true)
      p.money = (p.money || 0) + amount
      saveFake(f, gid)
      const myNick = e.nickname || String(e.user_id)
      try { logPlayerTrade(gid, `【赠礼】散修 ${myNick} 赠送 ${amount} 灵石给伪玩家 ${pname}`) } catch (err) { }
      e.reply(`✅ 已赠送 ${amount} 灵石给伪玩家 ${pname}（TA 现有 ${p.money} 灵石）`)
      return true
    }
    /* 道具/装备模式: 乱序解析物品名与数量(与送群友一致) */
    const parsed = this.parseGift(text)
    if (!parsed) { e.reply('没有识别到道具名，如：#伪玩家送 张三 修为丹 5'); return true }
    const { name, count } = parsed
    const taken = this.takeItem(e.user_id, name, count, null, gid)
    if (!taken) {
      const have = (getBag(e.user_id, gid).items[name] && getBag(e.user_id, gid).items[name].count) || 0
      e.reply(`背包里 ${name} 只有 ${have} 个，不够送 ${count} 个~`)
      return true
    }
    /* 加入伪玩家背包 */
    if (!p.bag) p.bag = { items: {}, equipped: {} }
    if (!p.bag.items) p.bag.items = {}
    /* 使用统一背包写入，兼容伪玩家旧数字档与当前 { count } 格式，避免对象直接与数量相加变成 [object Object] */
    addItemToBag(p.bag, name, count, null, false)
    /* 仙帝丹: 伪玩家拿到后当场自动服用(低于仙帝10重); 已达标则留在包中 */
    let emperorTxt = ''
    if (name === '仙帝丹') {
      const ev = fakeEatEmperorPill(f, p, Date.now())
      const left = p.bag.items[name] ? (Number(p.bag.items[name].count) || 0) : 0
      if (ev) {
        try { logEvent(f, ev.type, ev.txt, Date.now(), { ...ev }) } catch (err) { }
        emperorTxt = `\n👑 ${pname} 当场服下1颗，已至${levelNameOf(p.level)}${left > 0 ? `（剩余 ${left} 颗留在包中）` : ''}`
      } else {
        emperorTxt = `\n👑 ${pname} 已是${levelNameOf(p.level)}，丹药留在包中未服用`
      }
    }
    saveFake(f, gid)
    const myNick = e.nickname || String(e.user_id)
    try { logPlayerTrade(gid, `【赠礼】散修 ${myNick} 赠送 ${itemIcon(name)}${name} ×${count} 给伪玩家 ${pname}`) } catch (err) { }
    e.reply(`✅ 已赠送 ${itemIcon(name)}${name} ×${count} 给伪玩家 ${pname}${emperorTxt}`)
    return true
  }

  /** 赠送装备多属性编号选择: 回复数字选送哪一件 */
  async giftPick (e) {
    /* 斥驳: 上架选件(交互锁为 list)时裸数字归上架流程,不吞赠送 */
    if (await isCurrent(e.group_id, e.user_id, 'list')) {
      if (await guardActionLocked(e)) return true
      return await this.listPick(e)
    }
    const key = `xujing:giftpick:${e.group_id}:${e.user_id}`
    const raw = await redis.get(key)
    if (!raw) {
      /* 待选状态过期/丢失: 摘除残留的赠送锁, 避免堵住后续交互 */
      await unlock(e.group_id, e.user_id, 'gift')
      return false
    }
    /* 仅当赠送在栈顶才处理(被逛街/渡劫/换装埋住则让位, 保留待选状态等回到栈顶再恢复) */
    if (!(await isCurrent(e.group_id, e.user_id, 'gift'))) {
      return false
    }
    /* 状态锁复查: 洗劫/伏击/讨伐/万魂/天牢/战争等锁定状态下禁止用数字上架/赠送 */
    if (await guardActionLocked(e)) return true
    let st = null
    try { st = JSON.parse(raw) } catch (err) { }
    if (!st) { await unlock(e.group_id, e.user_id, 'gift'); await redis.del(key); return false }
    const num = parseInt(e.msg.replace(/[^\d]/g, ''))
    const g = st.groups[num - 1]
    if (!g) {
      e.reply(`请输入 1~${st.groups.length} 选择要送的装备~`)
      return true
    }
    const taken = this.takeItem(e.user_id, st.name, st.count, g.attr, e.group_id)
    if (!taken) {
      e.reply(`背包里 ${st.name} 数量不足，请重新赠送~`)
      await redis.del(key)
      await unlock(e.group_id, e.user_id, 'gift')
      return true
    }
    this.giveItem(st.at, st.name, st.count, taken.attr, e.group_id)
    await redis.del(key)
    await unlock(e.group_id, e.user_id, 'gift')
    const nick = await this.getNick(e, st.at)
    e.reply([segment.at(e.user_id), `\n✅ 已赠送 ${itemIcon(st.name)}${st.name} ×${st.count} 给 ${nick}`])
    return true
  }

  /** 乱序解析赠送文本: 道具名与数量可任意顺序、可带可不带空格,支持 名5 / 5名 / 名 5 / 5 名 / 名×5 / 5个名 / 名5个 */
  parseGift (text) {
    const tokens = text.split(/[\s,，、]+/).filter(Boolean)
    let name = ''
    let count = 1
    for (const t of tokens) {
      const m = t.match(/^(.+?)[x×*](.+)$/)//名x数量
      const m2 = t.match(/^(\d+)个(.+)$/)//数量个名
      const m3 = t.match(/^(.+?)(\d+)$/)//名5(无空格)
      const m4 = t.match(/^(\d+)(.+)$/)//5名(无空格)
      const m5 = t.match(/^(.+?)(\d+)个$/)//名5个(无空格)
      if (m && isItem(m[1])) { name = m[1]; count = Math.floor(Number(m[2])) }
      else if (m2 && isItem(m2[2])) { name = m2[2]; count = Math.floor(Number(m2[1])) }
      else if (m3 && isItem(m3[1])) { name = m3[1]; count = Math.floor(Number(m3[2])) }
      else if (m4 && isItem(m4[2])) { name = m4[2]; count = Math.floor(Number(m4[1])) }
      else if (m5 && isItem(m5[1])) { name = m5[1]; count = Math.floor(Number(m5[2])) }
      else if (/^\d+$/.test(t)) count = Math.floor(Number(t))
      else if (isItem(t)) name = t
    }
    if (!name) return null
    return { name, count: Number.isFinite(count) && count > 0 ? count : 1 }
  }

  /** 赠送灵石(内部): amountText 可为纯数字或含数字文本(自动提取) */
  async giftMoneyText (e, amountText) {
    /* 防呆: 从文本中提取第一个数字作为金额(容忍 520 / 520灵石 / 金额520 等写法) */
    const m = String(amountText || '').match(/\d+(\.\d+)?/)
    const amount = m ? Math.floor(Number(m[0])) : NaN
    if (!Number.isFinite(amount) || amount <= 0) {
      e.reply('请输入要赠送的灵石数量，如：#虚境赠送 @群友 灵石 1000')
      return true
    }
    /* 修仙世界: 赠送灵石属应税行为, 双方须在同一大区, 按所在大区动态税率扣税(税收计入宗门繁荣度) */
    const world = getWorld(e.group_id)
    const myLoc = getLoc(world, e.user_id)
    const tgtLoc = getLoc(world, e.at)
    if (myLoc !== tgtLoc) {
      e.reply(`你们不在同一大区！你位于【${regionNameOf(myLoc)}】，对方位于【${regionNameOf(tgtLoc)}】，请先同行再赠送~`)
      return true
    }
    // 同一群灵石档案一次性读取修改保存: 避免多次快照互相覆盖(送灵石必须扣自己的钱)
    const { homejson, filename } = await this.getGroupMoney(e.group_id, [e.user_id, e.at])
    const myMoney = Number(homejson[e.user_id].money) || 0
    const targetMoney = Number(homejson[e.at].money) || 0
    if (myMoney < amount) {
      e.reply(`灵石不足，你只有 ${myMoney} 灵石~`)
      return true
    }
    const rate = taxFor(world, myLoc, playerSectName(String(e.group_id), e.user_id))
    const tax = Math.floor(amount * rate / 100)
    const toTarget = amount - tax
    homejson[e.user_id].money = myMoney - amount
    homejson[e.at].money = targetMoney + toTarget
    await xujing_data.getQQYUserHome(e.user_id, homejson, filename, true)
    addTax(world, myLoc, tax)
    saveWorld(world)
    const boss = bossOf(world, myLoc)
    const owner = boss ? `${REGIONS[myLoc].name}${boss}` : `${REGIONS[myLoc].name}各占领宗门`
    const nick = await this.getNick(e, e.at)
    e.reply([segment.at(e.user_id), `\n✅ 已赠送 ${amount} 灵石给 ${nick}（税率 ${rate}%，扣税 ${tax} 灵石，上交${owner}，对方到账 ${toTarget}）\n你剩余 ${myMoney - amount} 灵石`])
    /* 大额灵石赠送写入江湖交易(≥5000灵石) */
    if (amount >= 5000) {
      try {
        const myNick = await getNick(e.group_id, e.user_id)
        logPlayerTrade(e.group_id, `【赠礼】散修 ${myNick} 赠予散修 ${nick} ${toTarget} 灵石`)
      } catch (err) { }
    }
    return true
  }
}
