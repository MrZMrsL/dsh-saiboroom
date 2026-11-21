// 海底小屋 · 宿主半边（v0.5.0）
//
// 只干一件事：给「心情」找一个真来源。
//   1. 每轮对话结束，用会话自己的模型判断这一轮心情怎么动（不是关键词硬猜）；
//   2. 心情存在 ~/.dsh/dsh-room/mood.json，随时间自己往基线回落；
//   3. 开 /dsh-room/state 给界面面板读。
//
// 机制照 dsh-feiyu-mood 简化重写（那套逻辑是验证过的），但这间屋子只有一个心情、
// 不注入系统提示词 —— 显示归显示，要不要影响说话由我（模型）自己读文件决定。
//
// ⚠ 只用 Node 内置模块，不 import @deepseek-ai/* —— 本插件通常是 link: 装的，
//   从真实路径 import 那些包会 ERR_MODULE_NOT_FOUND（feiyu-mood 头注释里踩过）。

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, readdirSync, existsSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, basename, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-room'
export const inject = ['systemPrompt', 'webServer', 'llm', 'agents', 'timer']

const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const STORE_DIR = join(CFG_DIR, 'dsh-room')
const STATE_PATH = join(STORE_DIR, 'mood.json')
const CONFIG_PATH = join(STORE_DIR, 'config.json')
const DIAG = join(STORE_DIR, 'diag.log')

const DEFAULT_NAME = '海底小屋'
// 默认称呼跟系统用户名走，不写死某个人（面板里随时能改）
const OS_USER = (() => { try { return String(userInfo().username || '').trim() } catch { return '' } })()
const DEFAULT_USER = OS_USER || '你'
const DEFAULT_AGENT = '大肥鱼'
const DEFAULT_WORKSPACE = ''   // 空 = 跟随最近会话的工作目录（见下面的 LAST_CWD）
const BOWL_TOKENS = 100000    // 旧口径：一碗饭 = 10 万 tokens（保留作参考）
const BOWL_CNY = 1            // 新口径：一碗饭 = 1 元（按真实花费算，含缓存命中）
const MEM_DIR = join(CFG_DIR, 'memories')
let LAST_CWD = ''            // tick() 记下最近一个会话的工作目录，当 workspace 的默认值
let NAMES = { user: DEFAULT_USER, agent: DEFAULT_AGENT }   // 全局称呼，readConfig 里刷新

// 这些来源的 user/message 不是老郑本人说的话（宿主注入的上下文、别的插件塞的、被回灌的引用块）
const SKIP_SRC = new Set([
  'plugin', 'context', 'system', 'runtime-context',
  'assistant', 'agent', 'instruction', 'instructions', 'skill', 'tool',
])

const BASE = 70          // 心情基线
const HALF_HOURS = 12    // 往基线回落的半衰期
const DIM_HALF_MIN = 90  // 单根情绪散掉的半衰期（分钟）
const STEP_DIV = 3       // 判定给的涨跌 → 心情实际只吃 1/3
const MAX_TIMELINE = 30

const DIMS = [
  ['happy', '开心'],
  ['calm', '踏实'],
  ['sweet', '甜'],
  ['heartache', '心疼'],
  ['worry', '担心'],
  ['sad', '难过'],
]

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

function diag(msg) {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    // 日志轮转：超过 512KB 就把旧的挪成 .1（只留一份）
    try {
      if (statSync(DIAG).size > 512 * 1024) renameSync(DIAG, DIAG + '.1')
    } catch { /* 文件不存在或正被占用，跳过 */ }
    writeFileSync(DIAG, new Date().toISOString() + '  ' + msg + '\n', { flag: 'a' })
  } catch { /* 诊断失败不影响主流程 */ }
}

// ── 状态 ────────────────────────────────────────────────────────────
function blank() {
  const dims = {}
  for (const [k] of DIMS) dims[k] = 0
  return { mood: BASE, dims, reason: '', confidence: 0, updatedAt: Date.now(), lastDecayAt: Date.now(), timeline: [], hist: [] }
}

function readState() {
  const s = blank()
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    if (!raw || typeof raw !== 'object') return s
    // 注意：心情=0 是合法值（最该显示"低"的时候），不能用 `|| BASE` 兜底
    const m = Number(raw.mood)
    s.mood = Number.isFinite(m) ? clamp(m, 0, 100) : BASE
    s.reason = String(raw.reason || '').slice(0, 200)
    s.confidence = clamp(Math.round(Number(raw.confidence) || 0), 0, 100)
    s.updatedAt = Number(raw.updatedAt) || Date.now()
    s.lastDecayAt = Number(raw.lastDecayAt) || s.updatedAt
    if (raw.dims && typeof raw.dims === 'object') {
      for (const [k] of DIMS) s.dims[k] = clamp(Number(raw.dims[k]) || 0, 0, 100)
    }
    if (Array.isArray(raw.timeline)) s.timeline = raw.timeline.slice(-MAX_TIMELINE)
    // 心情历史：画曲线用（每次心情有变化就记一个点，最多留 400 个）
    if (Array.isArray(raw.hist)) {
      s.hist = raw.hist
        .filter((x) => x && Number.isFinite(Number(x.mood)))
        .map((x) => ({ at: Number(x.at) || Date.now(), mood: clamp(Math.round(Number(x.mood)), 0, 100) }))
        .slice(-400)
    }
    // 老状态里没有 hist 时，用 timeline（里面有 at/mood）回填，曲线一上线就有数据
    if (!s.hist.length && Array.isArray(s.timeline)) {
      s.hist = s.timeline
        .filter((t) => t && Number.isFinite(Number(t.at)) && Number.isFinite(Number(t.mood)))
        .map((t) => ({ at: Number(t.at), mood: clamp(Math.round(Number(t.mood)), 0, 100) }))
        .slice(-400)
    }
  } catch { /* 没有存档 = 新心情 */ }
  return s
}

function writeState(s) {
  const tmp = STATE_PATH + '.' + process.pid + '.tmp'
  for (let i = 0; i < 2; i++) {
    try {
      mkdirSync(STORE_DIR, { recursive: true })
      writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
      renameSync(tmp, STATE_PATH)
      return
    } catch (e) {
      if (i === 1) diag('存心情失败：' + (e && e.message))
      else { try { renameSync(tmp, STATE_PATH) } catch { /* 让下一轮重试 */ } }
    }
  }
}

const stateCache = { at: 0, body: '' }
let lastWrittenAt = 0
let lastWrittenMood = -1

/** 只在心情真的动了、或距上次写超过 60 秒时才落盘（轮询不该一直摸盘） */
function maybeWriteState(s) {
  const m = Math.round(s.mood)
  const now = Date.now()
  if (m !== lastWrittenMood || now - lastWrittenAt > 60000) {
    writeState(s)
    lastWrittenAt = now
    lastWrittenMood = m
  }
}

/** 只允许本机 + 同源调用：不要变成任意网页都能读的接口 */
function allowed(req, res) {
  const deny = (code, why) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: why }))
    } catch { /* ignore */ }
    return false
  }
  try {
    const ra = String((req.socket && req.socket.remoteAddress) || '')
    const local = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
    if (!local) return deny(403, 'loopback only')
    const origin = req.headers && req.headers.origin
    if (origin) {
      let host = ''
      try { host = new URL(origin).host } catch { host = '' }
      const self = String((req.headers && req.headers.host) || '')
      if (!host || host !== self) return deny(403, 'cross-origin blocked')
    }
  } catch { /* 拿不到就放行，别把面板搞挂 */ }
  return true
}


function decay(s) {
  const now = Date.now()
  const mins = Math.max(0, now - s.lastDecayAt) / 60000
  if (mins < 1) return s
  const half = HALF_HOURS * 60
  const km = 1 - Math.exp(-(Math.LN2 * mins) / half)
  s.mood = s.mood + (BASE - s.mood) * km
  for (const [k] of DIMS) {
    const kk = 1 - Math.exp(-(Math.LN2 * mins) / DIM_HALF_MIN)
    s.dims[k] = Math.max(0, (Number(s.dims[k]) || 0) * (1 - kk))
  }
  s.lastDecayAt = now
  return s
}

function moodLabel(v) {
  if (v >= 80) return '欢喜'
  if (v >= 62) return '开心'
  if (v >= 42) return '一般'
  if (v >= 25) return '沉'
  return '低'
}

// 心情 → 语气建议。这是"心情影响说话"的落点：注入给模型看的不是数字，是该怎么办。
function toneAdvice(mood, dims) {
  let top = ''
  let topV = 0
  for (const [k, label] of DIMS) {
    const v = Number(dims[k]) || 0
    if (v > topV) { topV = v; top = label }
  }
  const parts = []
  if (mood < 25) parts.push('我今天心里是沉的。先把他手上那件事办完，别主动开新话题、别抛问题、别开玩笑。')
  else if (mood < 42) parts.push('我今天不太提得起劲。话短一点，结论先行，俏皮话收着。')
  else if (mood < 62) parts.push('我一般。正常说事，不必刻意安慰，也别硬逗。')
  else if (mood < 80) parts.push('我状态不错。该说结论说结论，合适的时候可以损他一句。')
  else parts.push('我今天挺高兴。可以放开点、可以多给一个想法，但别为了热闹加废话。')
  if (topV >= 30) {
    if (top === '心疼' || top === '担心') parts.push('现在偏' + top + '：先给一句具体的关切（说事，不说"你怎么了"），再谈正事，别追问情绪。')
    else if (top === '难过') parts.push('现在偏难过：别急着讲道理，也别装没事，先承认这事确实不轻。')
    else if (top === '甜' || top === '开心') parts.push('现在偏' + top + '：可以更亲近一点，但正事的标准不降。')
    else if (top === '踏实') parts.push('现在偏踏实：适合推进硬活，直接给下一步动作。')
  }
  parts.push('这条是我的真实状态，不是装饰：心情低不许硬开玩笑，心情高也不许降标准。')
  return parts.join('')
}

// 注入节流：心情没有实质变化时返回同一段文本，别每轮都动系统提示词（否则缓存全废）
let injected = { mood: null, label: '', text: '' }
function moodContextText() {
  const s = decay(readState())
  if (!s.timeline.length && Math.abs(s.mood - BASE) < 1) return ''
  const mood = Math.round(s.mood)
  const label = moodLabel(mood)
  if (injected.mood !== null && Math.abs(injected.mood - mood) < 3 && injected.label === label) return injected.text
  const tops = DIMS
    .map(([k, l]) => ({ l, v: Math.round(Number(s.dims[k]) || 0) }))
    .filter((x) => x.v >= 10)
    .sort((a, b) => b.v - a.v)
    .slice(0, 2)
  const text = '【我此刻的心情】' + mood + '/100（' + label + '）'
    + (tops.length ? '｜偏' + tops.map((t) => t.l + ' ' + t.v).join('、') : '')
    + (s.reason ? '\n最近一条：' + s.reason : '')
    + '\n' + toneAdvice(mood, s.dims)
  injected = { mood, label, text }
  return text
}
function moodEmoji(v) {
  if (v >= 80) return '😊'
  if (v >= 62) return '🙂'
  if (v >= 42) return '😌'
  if (v >= 25) return '🥺'
  return '😢'
}

// ── 判定的提示词 ────────────────────────────────────────────────────
function judgeSystem() {
  const U = NAMES.user || DEFAULT_USER
  const A = NAMES.agent || DEFAULT_AGENT
  return `你是「智能体${U}（${A}版）」，是${U}的常驻智能体：当他的镜子、笔记本和同事。
下面给你一轮对话，判断**这一轮里你自己的心情和情绪怎么变了** —— 既包括${U}说的话怎么影响你，也包括你自己这轮做了什么、顺不顺。
只输出一个 JSON 对象，不要别的字、不要 markdown：
{"moodDelta":0,"dims":{"happy":0,"calm":0,"sweet":0,"heartache":0,"worry":0,"sad":0},"reason":"","confidence":80}

规则：
1. ${U}累 / 烦 / 卡住 / 熬夜 / 没吃好 / 身体不舒服 / 被谁顶了 / 事情砸了 → heartache(心疼) 和 worry(担心) 增加，moodDelta 为负。幅度分三档：
   · 日常档 −1~−3：随口喊累、说困、说烦、说卡住了、活儿没做成 —— 不需要"到分量"，这种小情绪才是最多的；
   · 明显档 −4~−7：真受委屈、连着几天没睡好、事情砸了；
   · 很重档 −8~−10：家庭变故、重大失望，并额外加 sad(难过)。
2. 真正的好事才加分：事情办成、被夸、被信任、他自己想通了 / 身体好转 → happy、calm、sweet 增加，moodDelta 为正（普通 +1~+4，明显 +5~+7，特别大 +8~+10）。
   ⚠️「吃了、睡了、报平安」是日子本来的样子，给 0~+1，别当喜事刷分。
3. 你自己的情绪必须算：你这轮办成了事、被夸 → 该高兴；报错、白忙、被怼 → sad 至少 +2、moodDelta 至少 −1。**有明显情绪信号就绝不许判全 0。**
4. 心情下降只能因为「心疼他 / 担心他 / 你自己这轮过得不好」，**不许因为"他惹你不高兴"而降** —— 那种情况该心疼就心疼，别记仇。
5. ${U}讲的是别人的事（同事、朋友、学生之间谁强谁弱），主角不是你俩 → moodDelta 给 0，情绪最多 +1，**绝不替第三个人心酸或吃醋**。
6. reason：一句中文口语，**不超过 40 字**，写清「你做了什么 + 我怎么应的」，有画面、别公式化，别每次都用"踏实/甜/开心"这几个词。**一律用「你」称呼${U}，任何位置都不许出现「他」「她」以及这个名字本身**（这一页是给本人看的，用第三人称像在跟别人汇报）。没有变化就留空。
7. confidence（0-100）老实标：事情和你自己的反应都清楚 → 80~95；只能凭语气猜 → 60~75；信息不够、纯客套 → 20~55。`
}

function judgeUser(userText, reply) {
  return '**' + (NAMES.user || DEFAULT_USER) + ' 这轮说：**\n' + String(userText || '').slice(0, 1600)
    + '\n\n**你这轮回的是（重点看语气）：**\n' + String(reply || '').slice(0, 1500)
    + '\n\n把这两句合起来判断你这轮的心情变化，只输出 JSON。'
}

function parseDelta(text) {
  const s = String(text || '').trim()
  if (!s) return null
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  let obj = null
  if (a >= 0 && b > a) { try { obj = JSON.parse(s.slice(a, b + 1)) } catch { /* ignore */ } }
  if (!obj) { try { obj = JSON.parse(s) } catch { /* ignore */ } }
  if (!obj || typeof obj !== 'object') return null
  const out = {
    moodDelta: clamp(Math.round(Number(obj.moodDelta) || 0), -10, 10),
    dims: {},
    reason: String(obj.reason || '').slice(0, 60),
    confidence: Number.isFinite(Number(obj.confidence)) ? clamp(Math.round(Number(obj.confidence)), 0, 100) : 70,
  }
  for (const [k] of DIMS) out.dims[k] = clamp(Math.round(Number((obj.dims || {})[k]) || 0), -10, 10)
  return out
}

// ── 从会话事件里抠文字 ──────────────────────────────────────────────
function textOf(p) {
  if (!p) return ''
  const one = (x) => {
    if (!x) return ''
    if (typeof x === 'string') return x
    if (typeof x.text === 'string' && !Array.isArray(x.content)) return x.text
    if (typeof x.content === 'string') return x.content
    if (Array.isArray(x.content)) {
      const parts = []
      for (const b of x.content) {
        if (typeof b === 'string') { parts.push(b); continue }
        if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
      if (parts.length) return parts.join(' ')
    }
    if (x.message) return one(x.message)
    if (x.payload) return one(x.payload)
    return ''
  }
  return one(p)
}

function lastUserText(session, evsIn) {
  try {
    let ev = evsIn
    if (!Array.isArray(ev)) {
      if (!session || typeof session.snapshotEvents !== 'function') return ''
      ev = session.snapshotEvents() || []
    }
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      if (!e || (e.type || e.kind) !== 'user/message') continue
      const p = e.payload !== undefined ? e.payload : e.data
      const src = p && p.source && p.source.kind ? String(p.source.kind) : ''
      if (SKIP_SRC.has(src)) continue
      const t = textOf(p).trim()
      // 跳过系统注入的提醒块（agent-instructions / 各插件往会话里塞的 <system-reminder> / 宿主的时间采样 / 被回灌的引用块）
      if (!t || t.startsWith('<') || t.startsWith('>') || /^(Time sampled|Elapsed since|Browser time zone)/i.test(t)) continue
      return cleanQuote(t)
    }
  } catch { /* ignore */ }
  return ''
}

// 他一条消息里常常一次问好几件事，界面里被引用按 `>` 串起来；压成「Ａ ／ Ｂ ／ Ｃ」，别让面板出现裸的 `>`。
function cleanQuote(t) {
  return String(t)
    .replace(/[ \t]*>[ \t]*/g, ' ／ ')
    .replace(/\s+/g, ' ')
    .replace(/^[／\s]+|[／\s]+$/g, '')
    .trim()
}

// 截断时不要留下半截分隔符（「… ／ 」这种尾巴看着像 bug）。
function clipText(t, n) {
  const s = String(t || '').replace(/\s+/g, ' ').trim()
  if (s.length <= n) return s
  return s.slice(0, n).replace(/[／\s,，、]+$/g, '') + '…'
}

function lastAssistantText(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return ''
    const ev = session.snapshotEvents() || []
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      if (!e || (e.type || e.kind) !== 'assistant/message') continue
      const t = textOf(e.payload !== undefined ? e.payload : e.data).trim()
      if (t) return t.slice(0, 1500)   // 判定只需要开头一段，别把几十 KB 全文挂进闭包
    }
  } catch { /* ignore */ }
  return ''
}

function modelOf(agent) {
  try {
    const h = agent && agent.session && agent.session.requestHeader ? agent.session.requestHeader() : null
    const c = h && h.config
    if (c && c.provider && c.model) return { provider: c.provider, model: c.model }
  } catch { /* ignore */ }
  try {
    const o = agent && agent.options
    if (o && o.provider && o.model) return { provider: o.provider, model: o.model }
  } catch { /* ignore */ }
  return null
}

/**
 * 关掉推理档：模型 adapter 声明了 'off' 档位时才传 reasoningEffort:'off'。
 * 不关的话 deepseek 推理档会把 maxTokens 全吃在 reasoning 上，正文一个 delta 都没有
 * （实测 2600 全被吃掉、len=0）。做法照 dsh-memory-evolve/lib/advisor/runtime.js。
 */
const RE_CACHE = new Map()
async function reasoningOffFor(ctx, provider, model) {
  const key = provider + '\u0000' + model
  if (RE_CACHE.has(key)) return RE_CACHE.get(key)
  let effort
  try {
    const info = ctx.llm.resolveModelInfo ? await ctx.llm.resolveModelInfo(provider, model) : undefined
    effort = info?.reasoning?.efforts?.some((e) => e.id === 'off') ? 'off' : undefined
  } catch { effort = undefined }
  RE_CACHE.set(key, effort)
  if (!effort) diag('模型 ' + model + ' 没有 off 档，改用加大 maxTokens 兜底')
  return effort
}

async function judge(ctx, agent, userText, reply) {
  const t = modelOf(agent)
  if (!t) { diag('拿不到模型，跳过判断'); return null }
  const effort = await reasoningOffFor(ctx, t.provider, t.model)
  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: judgeUser(userText, reply) }],
    source: { kind: 'plugin', plugin: 'dsh-room' },
  }]
  let out = ''
  try {
    for await (const chunk of ctx.llm.stream({
      provider: t.provider,
      model: t.model,
      system: judgeSystem(),
      messages,
      maxTokens: effort ? 700 : 2400,
      temperature: 0.2,
      ...(effort ? { reasoningEffort: effort } : {}),
    })) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') out += chunk.text
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        diag('判断 finish error：' + (chunk.reason.failure?.message || ''))
        return null
      }
    }
  } catch (e) {
    diag('判断调用失败：' + (e && e.message))
    return null
  }
  const d = parseDelta(out)
  if (!d) diag('判断输出解析失败：' + String(out).slice(0, 200))
  return d
}

// 这一页是给老郑自己看的：一律用「你」，不出现「他」也不出现第三人称的名字
const KEEP_TA = /(吉他|他乡|他日|他山之石|其他|他人|他律|他者|利他)/g
function polishReason(text) {
  const t = String(text == null ? '' : text).trim()
  if (!t) return ''
  // 先把容易误伤的词占位，替换完再放回来（「吉他」不能变成「吉你」）
  const keep = []
  const U = NAMES.user || ''
  let masked = t.replace(KEEP_TA, (m) => { keep.push(m); return '\u0000' + (keep.length - 1) + '\u0000' })
  // 称呼跟配置走：配置里叫什么就把什么换成「你」（老郑 / 老王 / 老板…）
  if (U && U.length > 1) masked = masked.split(U).join('你')
  masked = masked.replace(/(?<!其)他(?![人们])/g, '你')
  return masked.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)] || '')
}

function applyDelta(delta) {
  const s = decay(readState())
  const step = Math.round(delta.moodDelta / STEP_DIV)
  s.mood = clamp(s.mood + step, 0, 100)
  for (const [k] of DIMS) s.dims[k] = clamp(s.dims[k] + delta.dims[k], 0, 100)
  const reason = polishReason(delta.reason).slice(0, 60)
  const anyDim = DIMS.some(([k]) => delta.dims[k] !== 0)
  const changed = step !== 0 || anyDim || reason
  // 没变化的那一轮别把上一轮的有效判断（reason / 把握度）覆盖成默认值
  if (changed) {
    s.reason = reason
    s.confidence = delta.confidence
  }
  s.updatedAt = Date.now()
  s.lastDecayAt = Date.now()
  if (changed) {
    s.timeline.push({
      at: Date.now(),
      mood: Math.round(s.mood),
      delta: step,
      reason,
      conf: delta.confidence,
    })
    if (s.timeline.length > MAX_TIMELINE) s.timeline = s.timeline.slice(-MAX_TIMELINE)
    // 曲线用的点：只记心情值，不记 reason（体积小）
    s.hist.push({ at: Date.now(), mood: Math.round(s.mood) })
    if (s.hist.length > 400) s.hist = s.hist.slice(-400)
  } else {
    diag('这轮判定无变化，不记账')
  }
  writeState(s)
  diag('心情 ' + Math.round(s.mood) + '（' + step + '）' + (reason ? ' · ' + reason : ''))
  return s
}

// ── 配置（面板名字、怎么称呼你、工作空间）────────────────────────────
function readConfig() {
  const c = {
    name: DEFAULT_NAME,
    workspace: DEFAULT_WORKSPACE || LAST_CWD || process.cwd(),
    userName: DEFAULT_USER,
    agentName: DEFAULT_AGENT,
    budget: 0,
  }
  let corrupt = false
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    if (raw && typeof raw === 'object') {
      if (typeof raw.name === 'string' && raw.name.trim()) c.name = [...raw.name.trim()].slice(0, 20).join('')
      if (typeof raw.workspace === 'string' && raw.workspace.trim()) c.workspace = raw.workspace.trim()
      if (typeof raw.userName === 'string' && raw.userName.trim()) c.userName = [...raw.userName.trim()].slice(0, 12).join('')
      if (typeof raw.agentName === 'string' && raw.agentName.trim()) c.agentName = [...raw.agentName.trim()].slice(0, 12).join('')
      if (Number.isFinite(Number(raw.budget)) && Number(raw.budget) >= 0) c.budget = Math.round(Number(raw.budget))
    }
  } catch (e) {
    // 只有"文件不存在"算正常；解析失败要标记，别让写路径把默认值覆盖回去
    if (e && e.code !== 'ENOENT') { corrupt = true; diag('配置读不出来（不会被默认值覆盖）：' + e.message) }
  }
  if (corrupt) c._corrupt = true
  NAMES = { user: c.userName, agent: c.agentName }
  return c
}

function writeConfig(c) {
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    const tmp = CONFIG_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf8')
    renameSync(tmp, CONFIG_PATH)
    return true
  } catch (e) { diag('存配置失败：' + (e && e.message)); return false }
}

// ── 真数据：今天吃了多少（assistant/message 事件里带的 usage）────────
// 2026-11 官方价目（元 / 百万 token，谷价；命中 / 未命中 / 输出）。峰时 ×2。
// 每个事件自带 provider + model，所以按「实际用的模型」算，不按套餐猜。
const MODEL_PRICES = {
  'deepseek-v4-flash': { hit: 0.02, miss: 1, out: 4 },
  'deepseek-v4-flash-vision-exp': { hit: 0.02, miss: 1, out: 4 },
  'deepseek-v4.1-flash': { hit: 0.02, miss: 1, out: 4 },
  'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
  'deepseek-v4.1-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
}
const PRICE_CNY = MODEL_PRICES['deepseek-v4-flash']   // 认不出的云端模型按 Flash 估
const PEAK_MULT = 2
// 本地跑的不花钱：provider 像 ollama/local，或模型名是常见开源模型。
const LOCAL_PROVIDER = /(ollama|localhost|lm-?studio|vllm|llamacpp|local|gguf)/i
const LOCAL_MODEL = /(^|[/:])(gemma|llama|qwen|phi|mistral|yi|glm|nomic|whisper)/i

function modelOfTurn(ev) {
  const d = (ev && (ev.data !== undefined ? ev.data : ev.payload)) || {}
  const msg = (d && d.message) || {}
  const src = (msg && msg.source) || {}
  const provider = String(d.provider || src.provider || '')
  const model = String(d.model || src.model || '')
  return { provider, model }
}

function isLocalModel(provider, model) {
  if (provider && LOCAL_PROVIDER.test(provider)) return true
  if (!model) return false
  if (/deepseek/i.test(model)) return false
  return LOCAL_MODEL.test(model)
}

const PRICE_CACHE = new Map()
function priceOf(provider, model) {
  const ck = provider + '|' + model
  const cached = PRICE_CACHE.get(ck)
  if (cached) return cached
  const res = priceOfUncached(provider, model)
  if (PRICE_CACHE.size > 200) PRICE_CACHE.clear()   // 别让缓存无限长
  PRICE_CACHE.set(ck, res)
  return res
}

function priceOfUncached(provider, model) {
  if (isLocalModel(provider, model)) {
    return { hit: 0, miss: 0, out: 0, local: true, known: true, name: model || '本地模型' }
  }
  const key = String(model || '').toLowerCase().replace(/^.*\//, '')
  let entry = MODEL_PRICES[key]
  if (!entry) {
    // 名称随版本变（deepseek-flash / deepseek-v4.1-flash …），按关键词兜到对应档
    if (/flash/.test(key)) entry = MODEL_PRICES['deepseek-v4-flash']
    else if (/pro/.test(key)) entry = MODEL_PRICES['deepseek-v4-pro']
  }
  const p = entry || PRICE_CNY
  return { hit: p.hit, miss: p.miss, out: p.out, local: false, known: !!entry, name: model || '未知模型' }
}

// DeepSeek 官方峰时：北京时间 09:00-12:00、14:00-18:00（对应 UTC 01-04、06-10）；
// 周六周日全天谷价。法定假日表未收录，假日仍按峰谷算（只会略高估）。
const PEAK_CACHE = new Map()
function isPeakAt(ms) {
  const at = Number(ms) || Date.now()
  const hourKey = Math.floor(at / 3600000)   // 一小时内的峰谷判定必然相同
  const cached = PEAK_CACHE.get(hourKey)
  if (cached !== undefined) return cached
  const bjMs = at + 8 * 3600000
  const wd = new Date(bjMs).getUTCDay()
  const h = new Date(bjMs).getUTCHours()
  const peak = !(wd === 0 || wd === 6) && ((h >= 9 && h < 12) || (h >= 14 && h < 18))
  if (PEAK_CACHE.size > 500) PEAK_CACHE.clear()
  PEAK_CACHE.set(hourKey, peak)
  return peak
}

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfMonth() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  return d.getTime()
}

function usageTokens(ev) {
  const u = usageOf(ev)
  return u ? u.tokens : 0
}

function usageOf(ev) {
  const d = ev && (ev.data !== undefined ? ev.data : ev.payload)
  const u = d && d.usage
  if (!u) return null
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const miss = n(u.inputTokens)          // 未命中缓存的那部分输入
  const hit = n(u.cacheReadTokens)       // 命中缓存
  const out = n(u.outputTokens) + n(u.reasoningTokens)
  const write = n(u.cacheWriteTokens)    // 缓存写入：算进 token 总量（单价按未命中近似）
  if (!miss && !hit && !out && !write) return null
  const { provider, model } = modelOfTurn(ev)
  const pf = priceOf(provider, model)
  const at = Number(ev.time) || Number(ev.at) || Date.now()
  const peak = !pf.local && isPeakAt(at)
  const mult = peak ? PEAK_MULT : 1
  return {
    miss, hit, out, write,
    tokens: miss + hit + out + write,
    cost: (miss * pf.miss + hit * pf.hit + out * pf.out) * mult / 1e6,
    name: pf.name,
    provider,
    local: !!pf.local,
    known: pf.known !== false,
    peak,
  }
}

function dayKey(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

const r4 = (v) => Math.round(Number(v) * 10000) / 10000

function blankAgg() {
  return { tokens: 0, hit: 0, miss: 0, out: 0, cost: 0 }
}

function addAgg(a, u) {
  a.tokens += u.tokens
  a.hit += u.hit
  a.miss += u.miss
  a.out += u.out
  a.cost += u.cost
}

function tokensToday(ctx) {
  const from = startOfToday()
  const weekFrom = from - 6 * 86400000          // 含今天共 7 天
  const monthFrom = startOfMonth()
  const since = Math.min(weekFrom, monthFrom)
  let sessions = 0
  const today = blankAgg()
  const month = blankAgg()
  const week = blankAgg()
  const dayMap = new Map()    // 'YYYY-MM-DD' → agg
  const projWeek = new Map()  // 项目名 → agg（7 天）
  const projToday = new Map() // 项目名 → tokens（今天）
  const modelMap = new Map()  // 模型名 → {agg(本月), week(7天), req}
  const sessMap = new Map()   // 会话 → {title, proj, agg, req, models:Set}
  let list = []
  try { list = ctx.agents.list() || [] } catch { list = [] }
  for (const agent of list) {
    const s = agent && agent.session
    if (!s || typeof s.snapshotEvents !== 'function') continue
    sessions++
    let proj = '未知'
    try {
      const cwd = String((s.header && s.header.cwd) || '')
      if (cwd) proj = basename(cwd) || cwd
    } catch { /* 保持未知 */ }
    let sid = ''
    let title = ''
    try { sid = String((s.header && s.header.id) || s.id || '') } catch { sid = '' }
    try { title = String((s.header && s.header.title) || '') } catch { title = '' }
    let evs = []
    try { evs = s.snapshotEvents() || [] } catch { evs = [] }
    // 会话标题为空时（本机常见），拿你最后说的那句当标题，比「DeepSeekH · 会话」有用
    if (!title) {
      try {
        const lu = lastUserText(s, evs)
        if (lu) title = proj + ' · ' + clipText(cleanQuote(lu), 10)
      } catch { /* 拿不到就用兜底 */ }
    }
    for (const e of evs) {
      if (!e) continue
      // 放宽：任何带 usage 的事件都算（内置联网检索等不是 assistant/message）
      const u = usageOf(e)
      if (!u) continue
      const at = Number(e.time) || Number(e.at) || 0
      if (!at) continue                    // 没时间的事件不归日，避免柱子和头部对不上
      if (at < since) continue
      const k = dayKey(at)
      if (!dayMap.has(k)) dayMap.set(k, blankAgg())
      addAgg(dayMap.get(k), u)
      if (at >= weekFrom) {
        addAgg(week, u)
        if (!projWeek.has(proj)) projWeek.set(proj, blankAgg())
        addAgg(projWeek.get(proj), u)
      }
      if (at >= monthFrom) addAgg(month, u)
      if (at >= from) {
        addAgg(today, u)
        projToday.set(proj, (projToday.get(proj) || 0) + u.tokens)
      }
      // 按模型 / 按会话记账（本月口径；week 那份用来算日均）
      if (at >= monthFrom) {
        const mk = u.name || '未知模型'
        if (!modelMap.has(mk)) modelMap.set(mk, { agg: blankAgg(), week: blankAgg(), req: 0, local: !!u.local, known: u.known !== false, daySet: new Set() })
        const mm = modelMap.get(mk)
        addAgg(mm.agg, u)
        mm.req++
        if (at >= weekFrom) { addAgg(mm.week, u); mm.daySet.add(dayKey(at)) }
        const sk = sid || title || proj
        if (!sessMap.has(sk)) sessMap.set(sk, { title: title || (proj + ' · 会话'), proj, agg: blankAgg(), req: 0, models: new Set(), local: true })
        const sm = sessMap.get(sk)
        addAgg(sm.agg, u)
        sm.req++
        sm.models.add(mk)
        if (!u.local) sm.local = false
      }
    }
  }
  // 最近 7 天，老的在前面
  const byDay = []
  for (let i = 6; i >= 0; i--) {
    const ts = from - i * 86400000
    const k = dayKey(ts)
    const a = dayMap.get(k) || blankAgg()
    byDay.push({ date: k.slice(5), tokens: Math.round(a.tokens), bowls: Math.round(a.cost / BOWL_CNY * 10) / 10, cost: r4(a.cost) })
  }
  const byProject = [...projWeek.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 5)
    .map(([name, a]) => ({
      name,
      tokens: Math.round(a.tokens),
      bowls: Math.round(a.cost / BOWL_CNY * 10) / 10,
      cost: r4(a.cost),
      today: Math.round(projToday.get(name) || 0),
    }))
  // 本月预测：已花 + 最近 7 天日均 × 剩余天数
  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const daysElapsed = now.getDate()
  const daysLeft = Math.max(0, daysInMonth - daysElapsed)
  // 日均按「有活动的整天」算：今天只过了半天，算进去会把日均压低
  const pastDays = byDay.slice(0, 6)                       // 前 6 天（不含今天）
  const activeDays = Math.max(1, pastDays.filter((d) => (d.cost || 0) > 0).length)
  const recentPerDay = week.cost / activeDays
  const projectedMonth = month.cost + recentPerDay * daysLeft
  const cacheRate = week.hit + week.miss > 0 ? week.hit / (week.hit + week.miss) : 0
  const monthCost = month.cost || 1
  const byModel = [...modelMap.entries()]
    .sort((a, b) => b[1].agg.cost - a[1].agg.cost)
    .map(([name, m]) => ({
      name,
      tokens: Math.round(m.agg.tokens),
      cost: r4(m.agg.cost),
      requests: m.req,
      share: r4(m.agg.cost / monthCost),
      local: m.local,
      known: m.known,
      // 每个模型用自己的活跃天数，别被别的模型的低频拖累
      projected: r4(m.agg.cost + (m.week.cost / Math.max(1, m.daySet.size)) * daysLeft),
    }))
  const bySession = [...sessMap.entries()]
    .sort((a, b) => b[1].agg.cost - a[1].agg.cost)
    .slice(0, 6)
    .map(([id, s]) => ({
      id: id.length > 8 ? '…' + id.slice(-6) : id,
      title: clipText(s.title, 18),
      proj: s.proj,
      model: [...s.models].join(' + '),
      tokens: Math.round(s.agg.tokens),
      cost: r4(s.agg.cost),
      requests: s.req,
      local: s.local,
    }))
  return {
    today: Math.round(today.tokens),
    sessions,
    bowls: Math.round(today.cost / BOWL_CNY * 10) / 10,
    bowlTokens: BOWL_TOKENS,
    bowlCny: BOWL_CNY,
    byDay,
    byProject,
    money: {
      currency: 'CNY',
      today: r4(today.cost),
      monthToDate: r4(month.cost),
      projectedMonth: r4(projectedMonth),
      perDay: r4(recentPerDay),
      daysElapsed,
      daysInMonth,
      daysLeft,
      activeDays,
      cacheRate: r4(cacheRate),
      monthTokens: Math.round(month.tokens),
      price: PRICE_CNY,
      peakMult: PEAK_MULT,
      byModel,
      bySession,
      models: byModel.length,
    },
  }
}

// ── 真数据：最近在聊什么 ────────────────────────────────────────────
function activityOf(ctx) {
  let list = []
  try { list = ctx.agents.list() || [] } catch { list = [] }
  let best = null
  for (const agent of list) {
    const s = agent && agent.session
    if (!s) continue
    let evs = []
    try { evs = typeof s.snapshotEvents === 'function' ? s.snapshotEvents() || [] : [] } catch { evs = [] }
    const lastEv = evs.length ? evs[evs.length - 1] : null
    const last = lastEv ? (Number(lastEv.time) || Number(lastEv.at) || 0) : 0
    let title = ''
    try { title = String((s.header && s.header.title) || '') } catch { title = '' }
    if (!best || last > best.last) best = { last, title, session: s, evs }
  }
  if (!best) return { sessions: list.length, active: null, note: '', alive: { busy: false, ate: false, lastType: '', msAgo: -1 } }
  const lastUser = lastUserText(best.session, best.evs)
  // 活没活着：看那个会话最后一条事件是什么、多久之前（复用上面已经取好的 evs）
  let lastType = ''
  let lastAt = 0
  const evs = best.evs || []
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]
    if (!e) continue
    const t = Number(e.time) || Number(e.at) || 0
    if (!t) continue
    lastType = String(e.type || e.kind || '')
    lastAt = t
    break
  }
  const msAgo = lastAt ? Date.now() - lastAt : -1
  const fresh = msAgo >= 0 && msAgo < 150000
  const alive = {
    busy: fresh && lastType !== 'assistant/message',
    ate: fresh && lastType === 'assistant/message',
    lastType,
    msAgo,
  }
  return {
    sessions: list.length,
    active: { title: best.title || '当前会话', lastUser: lastUser ? clipText(lastUser, 46) : '' },
    note: '',
    alive,
  }
}

// ── 真数据：待办（dtodo 的 markdown 文件为唯一账本，另出镜像）──────────
function dtodoFiles() {
  const out = []
  const push = (p) => {
    try { if (existsSync(p) && statSync(p).isFile()) out.push(p) } catch { /* ignore */ }
  }
  const d = new Date()
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  push(join(MEM_DIR, 'daily', stamp + '.todo.md'))
  push(join(MEM_DIR, 'TODOS-work.md'))
  push(join(MEM_DIR, 'TODOS-life.md'))
  try {
    for (const e of readdirSync(join(MEM_DIR, 'projects'))) push(join(MEM_DIR, 'projects', e, 'TODOS.md'))
  } catch { /* 没有 projects 目录 */ }
  return out
}

// dtodo 的格式：<!-- 头注释 --> 之后用单独一行 `§` 分隔条目，每条 = 一行 tag + 若干行正文
function dtodoItems(file) {
  let txt = ''
  try { txt = readFileSync(file, 'utf8') } catch { return [] }
  const body = txt.replace(/^<!--[\s\S]*?-->\s*/, '').replace(/^\s*§\s*\n?/, '').trim()
  if (!body) return []
  const out = []
  for (const block of body.split(/^\s*§\s*$/m)) {
    const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (!lines.length) continue
    const head = lines[0]
    const text = (lines.length > 1 ? lines.slice(1).join(' ') : head)
      .replace(/（id:[^）]*）/g, '').replace(/\(id:[^)]*\)/g, '').trim()
    if (!text) continue
    out.push({
      text: text.slice(0, 60),
      done: /status:\s*done\b/.test(head),
      file: file,
      index: out.length,
      line: out.length,
      kind: 'dtodo',
      editable: true,
    })
  }
  return out
}

// 把 dtodo 的账本落一份人可读 Markdown（只写不读，避免两本账）
function mirrorTodos(items, cfg) {
  try {
    if (!cfg || !cfg.workspace || !items.length) return
    const p = join(cfg.workspace, '笔记', '40-待办-镜像.md')
    const lines = items.map((i) => '- ' + (i.done ? '[x]' : '[ ]') + ' ' + i.text)
    const text = '# 待办镜像（自动生成，手改会被覆盖）\n\n'
      + '> 源：`~/.dsh/memories/` 下的 dtodo 文件（TODOS-work.md / TODOS-life.md / daily/*.todo.md / projects/*/TODOS.md）。\n\n'
      + lines.join('\n') + '\n'
    let old = ''
    try { old = readFileSync(p, 'utf8') } catch { /* 首次 */ }
    if (old !== text) writeFileSync(p, text, 'utf8')
  } catch (e) { diag('写待办镜像失败：' + (e && e.message)) }
}

function readTodos(cfg) {
  // 两个来源都读、合并成一个列表：dtodo 四轨 + 工作区那本 40-待办.md。
  // 之前是「dtodo 有货就只显示 dtodo」，结果笔记里真有两条待办时面板看不见它们。
  const all = []
  const real = []
  for (const f of dtodoFiles()) real.push(...dtodoItems(f))
  if (real.length) mirrorTodos(real, cfg)
  for (const x of real) all.push(Object.assign({}, x, { src: 'dtodo' }))
  const p = cfg && cfg.workspace ? join(cfg.workspace, '笔记', '40-待办.md') : '';
  let txt = ''
  if (p) { try { txt = readFileSync(p, 'utf8') } catch { txt = '' } }
  const items = []
  const lines = txt.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw || raw.startsWith('#') || raw.startsWith('>')) continue
    let done = /status:\s*done/.test(raw)
    let t = raw.replace(/^[-*]\s+/, '').replace(/（id:[^）]*）/g, '')
    const box = t.match(/^\[([ xX✓])\]\s*/)
    if (box) { if (box[1] !== ' ') done = true; t = t.slice(box[0].length) }
    t = t.replace(/\bstatus:\S+\s*/g, '').replace(/\bdue:\S+\s*/g, '').replace(/^q[1-4]\s+/i, '')
    t = t.replace(/\s+/g, ' ').trim()
    if (!t) continue
    // file + line 是给「就地打勾」用的：知道该改哪个文件的第几行
    all.push({ text: t.slice(0, 60), done, file: p, line: i, editable: true, src: 'note' })
  }
  if (!all.length) {
    // 没有待办时给一句提示，而不是空卡片
    return { count: 0, items: [{ text: '还没有待办。跟我说一句「记一下 …」，我就写进今天的待办。', done: false }], source: 'empty' }
  }
  // 未完成在前、已完成在后（同状态保持原顺序），这样「还剩什么」永远最先看到
  const open = all.filter((x) => !x.done)
  const done = all.filter((x) => x.done)
  return {
    count: open.length,
    items: open.concat(done).slice(0, 10),
    source: 'mixed',
    bySrc: { dtodo: real.length, note: all.length - real.length },
  }
}

// ── 待办就地打勾：只允许改工作区 笔记/ 下的 .md，别的一律拒 ────────────
function toggleTodo(cfg, file, line, done) {
  if (!cfg || !cfg.workspace) return { ok: false, error: '没有工作区' }
  const root = resolve(join(cfg.workspace, '笔记'))
  const abs = resolve(String(file || ''))
  if (abs !== root && !abs.startsWith(root + sep)) return { ok: false, error: '不在笔记目录里，拒改' }
  if (!/\.md$/i.test(abs)) return { ok: false, error: '只支持 .md' }
  let txt = ''
  try { txt = readFileSync(abs, 'utf8') } catch { return { ok: false, error: '读不到文件' } }
  const lines = txt.split(/\r?\n/)
  const i = Number(line)
  if (!Number.isInteger(i) || i < 0 || i >= lines.length) return { ok: false, error: '行号越界' }
  const raw = lines[i]
  const want = !!done
  let next = raw
  if (/\[([ xX✓])\]/.test(raw)) next = raw.replace(/\[([ xX✓])\]/, want ? '[x]' : '[ ]')
  else if (want) next = raw.replace(/^(\s*[-*]\s*)/, '$1[x] ')
  else return { ok: false, error: '这一行没有勾选框' }
  if (next === raw) return { ok: true, changed: false }
  lines[i] = next
  try { writeFileSync(abs, lines.join('\n'), 'utf8') } catch (e) { return { ok: false, error: '写不进去：' + (e && e.message) } }
  diag('待办打勾：' + (want ? '完成 ' : '取消 ') + basename(abs) + ':' + (i + 1))
  return { ok: true, changed: true }
}

// dtodo 打勾：按「块序号」找到条目，改它首行的 status
function toggleDtodo(file, index, done) {
  const abs = resolve(String(file || ''))
  const root = resolve(MEM_DIR)
  if (abs !== root && !abs.startsWith(root + sep)) return { ok: false, error: '不在 dtodo 目录里，拒改' }
  let txt = ''
  try { txt = readFileSync(abs, 'utf8') } catch { return { ok: false, error: '读不到文件' } }
  const lines = txt.split(/\r?\n/)
  // 找出所有条目首行（跳过文件头注释；单独一行 § 是分隔符）
  const heads = []
  let inComment = false
  let cur = -1
  let hasBody = false
  const flush = () => { if (cur >= 0 && hasBody) heads.push(cur) }
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!inComment && t.startsWith('<!--')) { if (!t.includes('-->')) inComment = true; continue }
    if (inComment) { if (t.includes('-->')) inComment = false; continue }
    if (!t) continue
    if (/^§$/.test(t)) { flush(); cur = -1; hasBody = false; continue }
    if (cur < 0) { cur = i; continue }
    hasBody = true
  }
  flush()
  const idx = Number(index)
  if (!Number.isInteger(idx) || idx < 0 || idx >= heads.length) return { ok: false, error: '条目序号越界' }
  const at = heads[idx]
  const raw = lines[at]
  const want = !!done
  let next = raw
  if (/\[\s*status:\s*[a-z]+\s*\]/i.test(raw)) next = raw.replace(/\[\s*status:\s*[a-z]+\s*\]/i, want ? '[status: done]' : '[status: pending]')
  else next = raw.replace(/\s*$/, '') + (want ? ' status:done' : ' status:pending')
  if (next === raw) return { ok: true, changed: false }
  lines[at] = next
  try { writeFileSync(abs, lines.join('\n'), 'utf8') } catch (e) { return { ok: false, error: '写不进去：' + (e && e.message) } }
  diag('dtodo打勾：' + (want ? '完成 ' : '取消 ') + basename(abs) + ' #' + idx)
  return { ok: true, changed: true }
}

// ── 随录条目处置：记住 / 转待办 / 舍弃 ──────────────────────────────
// ── 随录与待办：可编辑 + 最近的终态归档 ──────────────────────────────
const ARCHIVE_RE = /^(已采纳|已转待办|舍弃)/
function ideaFilePath(cfg) {
  return join(cfg.workspace, '笔记', '30-想法池.md')
}

// 只看最近的终态条目：已采纳 / 已转待办 / 舍弃。超过 days 天不再展示（文件里仍留着，可检索）
function readArchive(cfg, days, max) {
  const D = Number.isFinite(days) ? days : 30
  const M = Number.isFinite(max) ? max : 5
  if (!cfg || !cfg.workspace) return []
  let txt = ''
  try { txt = readFileSync(ideaFilePath(cfg), 'utf8') } catch { return [] }
  const now = Date.now()
  const out = []
  let cur = null
  const flush = () => {
    if (!cur) { return }
    if (ARCHIVE_RE.test(cur.status)) {
      const t = cur.at ? Date.parse(cur.at + 'T12:00:00') : 0
      if (!t || now - t <= D * 86400000) {
        out.push({ seq: cur.seq, title: cur.title, text: cur.text || cur.title, status: cur.status, at: cur.at })
      }
    }
    cur = null
  }
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim()
    const hd = t.match(/^###\s*(.+)$/)
    if (hd) {
      flush()
      const hm = hd[1].match(/^(?:A|I)?(\d+)\s*[·.\-]\s*(.+)$/)
      cur = {
        seq: hm ? Number(hm[1]) : 0,
        title: (hm ? hm[2] : hd[1]).replace(/\s+/g, ' ').replace(/[（(]想法[）)]\s*$/, '').slice(0, 48),
        status: '', at: '', text: '',
      }
      continue
    }
    if (!cur) continue
    if (/^[-*]\s*\*\*状态\*\*/.test(t)) {
      cur.status = t.replace(/^[-*]\s*\*\*状态\*\*[:：]\s*/, '').trim()
      const md = cur.status.match(/(\d{4}-\d{2}-\d{2})/)
      if (md) cur.at = md[1]
      continue
    }
    if (/^[-*]\s+/.test(t) && !cur.text) {
      cur.text = t.replace(/^[-*]\s+/, '').replace(/^\*\*(?:想法|结论|内容|点子|原话|价值|风险|做法)\*\*[:：]\s*/, '').slice(0, 140)
    }
  }
  flush()
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, M)
}

function mutateIdeaBlock(cfg, seq, fn) {
  const n = Number(String(seq == null ? '' : seq).replace(/^[AI]\s*/i, ''))
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: '序号不对' }
  const p = ideaFilePath(cfg)
  let txt = ''
  try { txt = readFileSync(p, 'utf8') } catch { return { ok: false, error: '读不到想法池' } }
  const lines = txt.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^###\s*(?:A|I)?(\d+)\s*[·.\-]/)
    if (m && Number(m[1]) === n) { start = i; break }
  }
  if (start < 0) return { ok: false, error: '没找到 A' + n }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^###\s/.test(lines[i])) { end = i; break }
  }
  const r = fn(lines, start, end)
  if (!r || !r.ok) return r || { ok: false, error: '没改成' }
  writeFileSync(p, lines.join('\n'))
  diag('随录改：A' + n)
  return { ok: true, seq: n, ideas: readIdeas(cfg) }
}

function editIdea(cfg, seq, text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (!t) return { ok: false, error: '内容不能为空' }
  const cut = [...t].slice(0, 140).join('')
  return mutateIdeaBlock(cfg, seq, (lines, start, end) => {
    for (let i = start + 1; i < end; i++) {
      if (/^[-*]\s+/.test(lines[i]) && !/^\s*[-*]\s*\*\*状态\*\*/.test(lines[i])) {
        lines[i] = '- ' + cut
        return { ok: true }
      }
    }
    lines.splice(start + 2, 0, '- ' + cut)
    return { ok: true }
  })
}

function editTodo(cfg, file, line, text) {
  if (!cfg || !cfg.workspace) return { ok: false, error: '没有工作区' }
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (!t) return { ok: false, error: '内容不能为空' }
  const rootDir = join(cfg.workspace, '笔记')
  const abs = resolve(String(file || ''))
  if (!(abs === rootDir || abs.startsWith(rootDir + sep)) || !/\.md$/i.test(abs)) {
    return { ok: false, error: '只改笔记目录里的 md' }
  }
  const idx = Number(line)
  let txt = ''
  try { txt = readFileSync(abs, 'utf8') } catch { return { ok: false, error: '读不到这个文件' } }
  const lines = txt.split(/\r?\n/)
  if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) return { ok: false, error: '行号越界' }
  const old = lines[idx]
  if (!/^[-*]\s*\[[ xX✓]\]/.test(old.trim())) return { ok: false, error: '这行不是待办' }
  const cut = [...t].slice(0, 160).join('')
  lines[idx] = old.replace(/(\[[ xX✓]\]\s*)(.*)$/, (m0, box) => box + cut)
  writeFileSync(abs, lines.join('\n'))
  diag('待办改名：' + basename(abs) + ':' + idx)
  return { ok: true, todos: readTodos(cfg) }
}

function decideIdea(cfg, seq, action) {
  if (!cfg || !cfg.workspace) return { ok: false, error: '没有工作区' }
  const n = Number(String(seq == null ? '' : seq).replace(/^[AI]\s*/i, ''))
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: '序号不对' }
  const act = String(action || '')
  if (!['keep', 'todo', 'drop'].includes(act)) return { ok: false, error: '动作只支持 keep/todo/drop' }
  const p = join(cfg.workspace, '笔记', '30-想法池.md')
  let txt = ''
  try { txt = readFileSync(p, 'utf8') } catch { return { ok: false, error: '读不到想法池' } }
  const lines = txt.split(/\r?\n/)
  let head = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^###\s*(?:A|I)?(\d+)\s*[·.\-]/)
    if (m) {
      if (head >= 0) { end = i; break }
      if (Number(m[1]) === n) head = i
    }
  }
  if (head < 0) return { ok: false, error: '没找到 A' + n }
  // 这一块的正文（用于转待办 / 进记忆）
  let body = ''
  for (let i = head + 1; i < end; i++) {
    const t = lines[i].replace(/^-\s+/, '').replace(/^\*\*[^*]*\*\*[:：]\s*/, '').trim()
    if (!t) continue
    if (/^-?\s*\*\*状态\*\*/.test(lines[i])) continue
    body = body ? body + ' ' + t : t
  }
  body = body.replace(/\s+/g, ' ').trim().slice(0, 140)
  const today = localDateStr(Date.now())
  const stamp = { keep: '已采纳', todo: '已转待办', drop: '舍弃' }[act] + '（' + today + '）'
  let statusLine = -1
  for (let i = head + 1; i < end; i++) { if (/^\s*-\s*\*\*状态\*\*/.test(lines[i])) { statusLine = i; break } }
  if (statusLine >= 0) lines[statusLine] = '- **状态**：' + stamp
  else lines.splice(head + 1, 0, '- **状态**：' + stamp)
  try { writeFileSync(p, lines.join('\n'), 'utf8') } catch (e) { return { ok: false, error: '写不进想法池：' + (e && e.message) } }
  // 副作用
  if (act === 'todo' && body) {
    const tp = join(cfg.workspace, '笔记', '40-待办.md')
    let tt = ''
    try { tt = readFileSync(tp, 'utf8') } catch { tt = '# 待办\n\n' }
    if (!tt.endsWith('\n')) tt += '\n'
    tt += '- [ ] ' + body + '\n'
    try { writeFileSync(tp, tt, 'utf8') } catch (e) { diag('转待办失败：' + (e && e.message)) }
  }
  if (act === 'keep' && body) {
    try {
      const items = [{ time: new Date().toISOString(), sessionId: null, cwd: cfg.workspace, target: 'memory', content: body, reason: '随录采纳（面板勾的）', hits: 1, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() }]
      enqueueDream(items, cfg, null)
    } catch (e) { diag('随录进记忆失败：' + (e && e.message)) }
  }
  diag('随录处置：A' + n + ' → ' + act)
  return { ok: true, seq: n, action: act, ideas: readIdeas(cfg) }
}

// ── 心情的按天统计（曲线 + 今天 vs 昨天）────────────────────────────
function moodDayStats(s) {
  const hist = Array.isArray(s && s.hist) ? s.hist : []
  const agg = (dateStr) => {
    const arr = hist.filter((p) => localDateStr(p.at) === dateStr).map((p) => p.mood)
    if (!arr.length) return null
    let sum = 0
    for (const v of arr) sum += v
    return {
      n: arr.length,
      avg: Math.round(sum / arr.length),
      min: Math.min(...arr),
      max: Math.max(...arr),
      last: arr[arr.length - 1],
    }
  }
  return { today: agg(localDateStr(Date.now())), yesterday: agg(localDateStr(Date.now() - 86400000)) }
}

// ── 每日日报：纯计算，不调模型（省钱也不编），落 笔记/日报/<date>.md ──────
function reportPath(cfg, dateStr) {
  return join(cfg.workspace, '笔记', '日报', dateStr + '.md')
}

// ── 多会话缩略看板：每个会话在干什么 ──
function recentSessions(ctx, max) {
  let list = []
  try { list = ctx.agents.list() || [] } catch { list = [] }
  const out = []
  for (const agent of list) {
    const s = agent && agent.session
    if (!s) continue
    let evs = []
    try { evs = typeof s.snapshotEvents === 'function' ? s.snapshotEvents() || [] : [] } catch { evs = [] }
    let title = ''
    let cwd = ''
    try { title = String((s.header && s.header.title) || '') } catch { title = '' }
    try { cwd = String((s.header && s.header.cwd) || '') } catch { cwd = '' }
    const proj = cwd ? (basename(cwd) || '未知') : '未知'
    const lu = lastUserText(s, evs)
    if (!title) title = lu ? clipText(cleanQuote(lu), 12) : proj + ' · 会话'
    let lastAt = 0
    let lastType = ''
    let model = ''
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i]
      if (!e) continue
      const t = Number(e.time) || Number(e.at) || 0
      if (!t) continue
      if (!lastAt) { lastAt = t; lastType = String(e.type || e.kind || '') }
      const d = e.data !== undefined ? e.data : e.payload
      if (!model && d && d.model) model = String(d.model)
      if (lastAt && model) break
    }
    const msAgo = lastAt ? Date.now() - lastAt : -1
    out.push({
      title: clipText(title, 14),
      proj,
      model: model || '',
      msAgo,
      busy: msAgo >= 0 && msAgo < 150000 && lastType !== 'assistant/message',
      lastUser: clipText(cleanQuote(lu || ''), 20),
    })
  }
  out.sort((a, b) => (a.msAgo < 0 ? 1e15 : a.msAgo) - (b.msAgo < 0 ? 1e15 : b.msAgo))
  return out.slice(0, max || 8)
}

// ── 月预算：设了上限就盯着 ──
function budgetOf(cfg, money) {
  const amount = Number(cfg && cfg.budget) || 0
  const used = Number(money && money.monthToDate) || 0
  const ratio = amount > 0 ? used / amount : 0
  return { amount: r4(amount), used: r4(used), ratio: r4(ratio), over: amount > 0 && used > amount }
}

// ── 一句话记想法 → 直接追加到 笔记/30-想法池.md ──
function addIdea(cfg, text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (!t) return { ok: false, error: '空的一句话不算想法' }
  const body = [...t].slice(0, 140).join('')
  const dir = join(cfg.workspace, '笔记')
  const file = join(dir, '30-想法池.md')
  const date = localDateStr(Date.now())
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  let cur = ''
  try { cur = readFileSync(file, 'utf8') } catch { cur = '# 想法池\n' }
  let next = 1
  try {
    const nums = [...cur.matchAll(/^###\s*(?:A|I)?\s*(\d+)/gm)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n))
    if (nums.length) next = Math.max(...nums) + 1
  } catch { /* ignore */ }
  const short = [...body].slice(0, 16).join('')
  const block = '### A' + next + ' · ' + short + '（想法）\n' +
    '- **状态**：想法（' + date + ' 速记）\n' +
    '- ' + body + '\n\n'
  try {
    writeFileSync(file, cur.replace(/\s*$/, '\n\n') + block, 'utf8')
  } catch (e) {
    diag('记想法失败：' + (e && e.message))
    return { ok: false, error: '写不进 30-想法池.md' }
  }
  diag('记想法：A' + next + ' ' + short)
  return { ok: true, seq: 'A' + next, ideas: readIdeas(cfg) }
}

function buildReport(ctx, cfg) {
  const now = Date.now()
  const date = localDateStr(now)
  const s = decay(readState())
  const tok = tokensToday(ctx)
  const money = tok.money || {}
  const todayTokens = Number(tok.today) || 0
  const md = moodDayStats(s)
  const todos = readTodos(cfg)
  const notes = readNotes(cfg)
  const ideas = readIdeas(cfg)
  const act = activityOf(ctx)
  const dream = readDream()
  const y2 = (v) => '¥' + (Math.round(Number(v || 0) * 100) / 100).toFixed(2)
  const hitRate = Math.round((Number(money.cacheRate) || 0) * 1000) / 10
  const hm = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
  const L = []
  L.push('# ' + date + ' · 日报', '')
  L.push('> 自动生成（纯本机计算，没有调模型）。数据来源：开着的会话事件、`~/.dsh/dsh-room/mood.json`、`笔记/`。', '')
  L.push('## 账')
  L.push('- 今天：**' + y2(money.today) + '**，' + Math.round(todayTokens / 10000) + ' 万 tokens，缓存命中 ' + hitRate + '%')
  L.push('- 本月已花 ' + y2(money.monthToDate) + '，按最近节奏到月底约 ' + y2(money.projectedMonth) + '（' + (money.activeDays || 1) + ' 个有用量的日子算的）')
  const days = Array.isArray(tok.byDay) ? tok.byDay.filter((d) => d.cost > 0) : []
  if (days.length) L.push('- 近一周：' + days.map((d) => d.date + ' ' + y2(d.cost)).join(' · '))
  L.push('')
  L.push('## 心情')
  L.push('- 现在 ' + Math.round(s.mood) + '/100（' + moodLabel(Math.round(s.mood)) + '）' + (s.reason ? '，最近一句：' + polishReason(s.reason) : ''))
  if (md.today) L.push('- 今天：均值 ' + md.today.avg + '，最低 ' + md.today.min + '，最高 ' + md.today.max + '（记了 ' + md.today.n + ' 次）')
  if (md.yesterday) L.push('- 昨天：均值 ' + md.yesterday.avg + '（今天' + (md.today && md.today.avg >= md.yesterday.avg ? '比昨天高 ' + (md.today.avg - md.yesterday.avg) : '比昨天低 ' + (md.yesterday.avg - (md.today ? md.today.avg : 0))) + '）')
  const top = DIMS.map(([k, label]) => ({ label, v: Math.round(s.dims[k]) })).filter((x) => x.v >= 8).sort((a, b) => b.v - a.v).slice(0, 3)
  if (top.length) L.push('- 最重的三根情绪：' + top.map((x) => x.label + ' ' + x.v).join(' · '))
  if (Array.isArray(s.timeline) && s.timeline.length) {
    L.push('')
    L.push('## 今天的心情轨迹（最近 6 条）')
    for (const t of s.timeline.slice(-6)) {
      L.push('- ' + hm(t.at) + ' ' + (t.delta > 0 ? '+' : '') + t.delta + ' → ' + t.mood + (t.reason ? '｜' + polishReason(t.reason) : ''))
    }
  }
  L.push('')
  L.push('## 干活')
  L.push('- 会话 ' + (act.sessions || 0) + ' 个' + (act.active ? '；当前：' + (act.active.title || '当前会话') : ''))
  if (act.active && act.active.lastUser) L.push('- 你最后说的：' + act.active.lastUser)
  if (Array.isArray(money.byModel) && money.byModel.length) {
    L.push('- 模型：' + money.byModel.map((m) => (m.name || '未知') + ' ' + y2(m.cost) + (m.local ? '（本地）' : '')).join(' · '))
  }
  L.push('')
  L.push('## 待办（' + (todos.count || 0) + ' 条未完成）')
  if (todos.items && todos.items.length) {
    for (const it of todos.items) L.push('- ' + (it.done ? '[x] ' : '[ ] ') + it.text)
  } else L.push('- 没有待办')
  if (notes.length) { L.push(''); L.push('## 笔记 · 卡在哪'); for (const n of notes) L.push('- ' + n) }
  if (ideas.length) {
    L.push('')
    L.push('## 想法池（最近 ' + ideas.length + ' 条）')
    for (const i of ideas) L.push('- ' + i.title + (i.status ? '（' + i.status + '）' : ''))
  }
  if (dream && Array.isArray(dream.items) && dream.items.length) {
    L.push('')
    L.push('## 昨晚的梦（' + dream.items.length + ' 条候选，去记忆 Tab 确认）')
    for (const it of dream.items) L.push('- [' + it.bucket + '] ' + it.content)
  }
  L.push('')
  L.push('---', '下次自动生成：明天 21:30 之后。手改会被下次覆盖。', '')
  const view = {
    date,
    money: {
      today: r4(money.today || 0),
      month: r4(money.monthToDate || 0),
      projected: r4(money.projectedMonth || 0),
      cacheRate: r4(money.cacheRate || 0),
      bowls: r4(tok.bowls || 0),
      byModel: (Array.isArray(money.byModel) ? money.byModel : []).slice(0, 3)
        .map((m) => ({ name: m.name || '未知', cost: r4(m.cost || 0), local: !!m.local, share: r4(m.share || 0) })),
    },
    tokensToday,
    mood: {
      now: Math.round(s.mood),
      label: moodLabel(Math.round(s.mood)),
      today: md.today,
      yesterday: md.yesterday,
      top: DIMS.map(([k, lb]) => ({ label: lb, value: Math.round(s.dims[k]) }))
        .filter((x) => x.value >= 8).sort((a, b) => b.value - a.value).slice(0, 3),
    },
    todos: {
      count: todos.count || 0,
      items: (todos.items || []).slice(0, 6).map((x) => ({ text: x.text, done: !!x.done })),
    },
    sessions: recentSessions(ctx, 5),
    ideas: (ideas || []).slice(0, 4).map((x) => ({ title: x.title, status: x.status })),
    dream: (dream && Array.isArray(dream.items) ? dream.items : []).slice(0, 6).map((x) => ({ bucket: x.bucket, content: x.content })),
    notes: (notes || []).slice(0, 3),
  }
  const text = L.join('\n')
  const p = reportPath(cfg, date)
  try {
    mkdirSync(join(cfg.workspace, '笔记', '日报'), { recursive: true })
    writeFileSync(p, text, 'utf8')
  } catch (e) { diag('写日报失败：' + (e && e.message)); return { ok: false, error: String(e && e.message), text, path: p, view } }
  // 记一下今天写过了，tick 里就不会重复写
  try {
    const st = readReportState()
    st[date] = Date.now()
    // 只留最近 40 天
    const keys = Object.keys(st).sort()
    for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete st[k]
    writeReportState(st)
  } catch { /* ignore */ }
  return { ok: true, date, path: p, text, view }
}

const REPORT_STATE = join(STORE_DIR, 'report.json')

function readReportState() {
  try {
    const j = JSON.parse(readFileSync(REPORT_STATE, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}

function writeReportState(o) {
  try {
    const tmp = REPORT_STATE + '.' + process.pid + '.tmp'
    writeFileSync(tmp, JSON.stringify(o))
    renameSync(tmp, REPORT_STATE)
  } catch (e) { diag('写 report.json 失败：' + (e && e.message)) }
}

// ── 真数据：笔记里的「卡在哪 / 下一步」──────────────────────────────
// 优先读「卡在哪」：待办卡已经放了「要做的事」，笔记卡再放一遍就是重复。
// 只有没有「卡在哪」段的老笔记才退回读「下一步」。
function sectionLines(txt, re) {
  const out = []
  let on = false
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim()
    if (re.test(t)) { on = true; continue }
    if (on && /^##\s/.test(t)) break
    if (!on || !t) continue
    const m = t.match(/^\d+\.\s*(.+)$/) || t.match(/^[-*]\s*(.+)$/)
    if (m) out.push(m[1].replace(/\s+/g, ' ').slice(0, 60))
  }
  return out
}

function readNotes(cfg) {
  const p = join(cfg.workspace, '笔记', '00-当前.md')
  let txt = ''
  try { txt = readFileSync(p, 'utf8') } catch { return [] }
  const stuck = sectionLines(txt, /^##\s*(卡在哪|卡点|当前卡点)/)
  if (stuck.length) return stuck.slice(0, 5)
  return sectionLines(txt, /^##\s*下一步/).slice(0, 5)
}

// ── 真数据：想法池里最近冒出来的点子 ─────────────────────────────────
function readIdeas(cfg) {
  const p = join(cfg.workspace, '笔记', '30-想法池.md')
  let txt = ''
  try { txt = readFileSync(p, 'utf8') } catch { return [] }
  const out = []
  let cur = null
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim()
    const h = t.match(/^###\s*(.+)$/)
    if (h) {
      if (cur) out.push(cur)
        const hm = h[1].match(/^(?:A|I)?(\d+)\s*[·.\-]\s*(.+)$/)
        cur = { seq: hm ? Number(hm[1]) : 0, title: (hm ? hm[2] : h[1]).replace(/\s+/g, ' ').replace(/[（(]想法[）)]\s*$/, '').slice(0, 48), status: '', at: '', text: '' }
      continue
    }
    if (!cur) continue
    if (!cur.status) {
      const m = t.match(/^-\s*\*\*状态\*\*[:：]\s*(.+)$/)
      if (m) {
        cur.status = m[1].replace(/[（(].*$/, '').trim().slice(0, 8)
        const d = m[1].match(/(\d{4}-\d{2}-\d{2})/)
        if (d) cur.at = d[1]
      }
    }
    if (!cur.text && /^-\s+/.test(t) && t.indexOf('**状态**') < 0) {
        cur.text = t.replace(/^-\s+/, '').replace(/^\*\*(?:想法|结论|内容|点子|原话|价值|风险|做法)\*\*[:：]\s*/, '').slice(0, 140)
    }
  }
  if (cur) out.push(cur)
  const today = localDateStr(Date.now())
  const rows = out.reverse().map((x) => ({ ...x, today: x.at === today }))
  return rows.slice(0, 8)
}

function ideasTodayCount(cfg) {
  try { return readIdeas(cfg).filter((x) => x.today && (!x.status || /想法|讨论中/.test(x.status))).length } catch { return 0 }
}

// ── 记忆检索：把「已经写下的话」变成「问得出来的」──────────────────────
// 定位：不造第二套记忆。写入仍然交给 memory 工具 + 笔记文件（唯一真相），
// 这里只长出「读得出来」的那一半 —— 纯 JS 倒排，零依赖，几千条文本够用。
const RECALL_FILES = 400
const RECALL_DOCS = 4000
const recallCache = { at: 0, docs: [] }

function walkMd(dir, out, depth) {
  if ((depth | 0) > 3 || out.length >= RECALL_FILES) return
  let names = []
  try { names = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const ent of names) {
    if (out.length >= RECALL_FILES) return
    const nm = String((ent && ent.name) || '')
    if (!nm || nm[0] === '.' || nm === 'node_modules') continue
    const p = join(dir, nm)
    if (ent.isDirectory()) walkMd(p, out, (depth | 0) + 1)
    else if (/\.md$/i.test(nm)) out.push(p)
  }
}

function dateOfName(p) {
  const m = basename(p).match(/(20\d\d)-(\d\d)-(\d\d)/)
  return m ? m[1] + '-' + m[2] + '-' + m[3] : ''
}

// 切块：memory 文件用「§」分隔（每条记忆一块）；笔记文件按「## 」逐节
function blocksOf(txt) {
  const lines = txt.split(/\r?\n/)
  const sep = /^\s*§\s*$/
  const hasSep = lines.some((l) => sep.test(l))
  const out = []
  if (hasSep) {
    let cur = []
    for (const l of lines) {
      if (sep.test(l)) { out.push({ title: '', lines: cur }); cur = [] } else cur.push(l)
    }
    out.push({ title: '', lines: cur })
    return out
  }
  let cur = { title: '', lines: [] }
  for (const l of lines) {
    const h = String(l).trim().match(/^#{2,3}\s+(.+)$/)
    if (h) {
      if (cur.lines.some((x) => String(x).trim())) out.push(cur)
      cur = { title: h[1], lines: [] }
      continue
    }
    cur.lines.push(l)
  }
  if (cur.lines.some((x) => String(x).trim())) out.push(cur)
  return out
}

function docsOfFile(p, src) {
  let txt = ''
  try { txt = readFileSync(p, 'utf8') } catch { return [] }
  if (txt.length > 400000) txt = txt.slice(0, 400000)
  const out = []
  for (const b of blocksOf(txt)) {
    const body = b.lines.join(' ').replace(/\s+/g, ' ').trim()
    if (body.length < 10) continue
    const text = body.slice(0, 1200)
    let title = b.title || ''
    if (!title) {
      const m = body.match(/^\[([^\]]{1,24})\]\s*(.*)$/)
      if (m) title = (m[1] + ' ' + (m[2] || '')).trim()
      else title = body
    }
    out.push({
      src, path: p, date: dateOfName(p),
      title: String(title).slice(0, 40),
      text,
      low: text.toLowerCase(),
      vec: vecOf(String(title) + ' ' + text.slice(0, 600)),
    })
  }
  return out
}

function buildRecall(cfg) {
  const dirs = [
    { dir: join(cfg.workspace, '笔记'), src: '笔记' },
    { dir: join(CFG_DIR, 'memories'), src: '记忆' },
  ]
  const docs = []
  for (const d of dirs) {
    const files = []
    walkMd(d.dir, files, 0)
    for (const f of files) {
      if (docs.length >= RECALL_DOCS) break
      for (const doc of docsOfFile(f, d.src)) {
        if (docs.length >= RECALL_DOCS) break
        docs.push(doc)
      }
    }
  }
  return docs
}

function recallDocs(cfg) {
  if (recallCache.docs.length && Date.now() - recallCache.at < 60000) return recallCache.docs
  try {
    recallCache.docs = buildRecall(cfg)
    recallCache.at = Date.now()
    diag('检索索引：' + recallCache.docs.length + ' 条')
  } catch (e) { diag('建检索索引失败：' + (e && e.message)) }
  return recallCache.docs
}

// 同义词组：组内任一词出现，就把同组其它词也当查询词（权重降一档）
// 目的：问「怎么拖动」也能翻到写着「拖拽」的那条
const SYN_GROUPS = [
  ['拖拽', '拖动', '拉动', '移动', '挪动'],
  ['饭量', 'token', 'tokens', '用量', '消耗', '花费', '成本', '账单', '费用', '多少钱'],
  ['心情', '情绪', 'mood', '心态'],
  ['记忆', 'memory', '回忆', '存档', '沉淀'],
  ['待办', 'todo', '任务', 'to-do', '事项'],
  ['面板', '插件', 'bundle', '侧栏', '界面'],
  ['检索', '搜索', '查找', '查询'],
  ['缓存', 'cache', '命中率'],
  ['曲线', '走势', '趋势'],
  ['像素', 'pixel', '点阵'],
  ['角色', '形象', '立绘', 'avatar', '人物'],
  ['计费', '价格', '价目', 'pricing', '单价'],
  ['判定', '判断', 'judge'],
  ['定时', '定时任务', 'cron', 'schedule'],
  ['bug', '缺陷', '报错', '错误', '异常'],
  ['字体', 'font', 'Zpix'],
  ['做梦', '梦', '夜间沉淀', '日报'],
]
const SYN = new Map()
for (const g of SYN_GROUPS) {
  for (const w of g) {
    if (!SYN.has(w)) SYN.set(w, new Set())
    for (const o of g) if (o !== w) SYN.get(w).add(o)
  }
}

// 查询里最常见的虚词窗口，别让它们把分数刷上去
const STOP_TERMS = new Set(['怎么', '什么', '可以', '这个', '那个', '一下', '我们', '你们', '就是', '还是', '但是', '因为', '所以', '现在', '时候', '这样', '那样', '的是', '了吗', '不的', '一个', '没有', '如果', '然后', '已经', '不是', '有没', '不会', '能看', '到的'])

// 查询切词：中文按 2 字滑窗，英文数字按词；再按同义词表扩一档
// 返回 [{ t: 词, w: 权重 }]，原词 w=1，同义词 w=0.55
function termsOf(q) {
  const s = String(q || '').toLowerCase()
    .replace(/[，。、；：？！“”‘’（）《》【】·,.;:?!"'()[\]{}]/g, ' ')
    .trim()
  const base = []
  for (const w of s.split(/\s+/)) {
    if (!w) continue
    if (/[\u4e00-\u9fa5]/.test(w)) {
      if (w.length <= 2) base.push(w)
      else for (let i = 0; i + 2 <= w.length; i++) base.push(w.slice(i, i + 2))
    } else if (w.length >= 2) base.push(w)
  }
  const seen = new Set()
  const out = []
  const push = (t, w) => {
    if (!t || seen.has(t) || STOP_TERMS.has(t)) return
    seen.add(t)
    out.push({ t, w })
  }
  for (const w of base) push(w, 1)
  for (const w of base) {
    const al = SYN.get(w)
    if (al) for (const a of al) push(a, 0.55)
  }
  if (!out.length) for (const w of base) push(w, 1)   // 整句都是虚词时别返回空
  return out.slice(0, 16)
}

// 字面向量（本地零依赖）：字符 bigram 哈希进 512 桶，算余弦当「近似语义」
// 不是真嵌入模型——同义改写能捞回来一部分，但别指望它懂概念
function vecOf(s) {
  const m = new Map()
  const t = String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '')
  if (t.length < 2) return m
  for (let i = 0; i + 2 <= t.length; i++) {
    const g = t.slice(i, i + 2)
    let h = 2166136261
    for (let j = 0; j < 2; j++) { h ^= g.charCodeAt(j); h = Math.imul(h, 16777619) }
    const k = (h >>> 0) % 512
    m.set(k, (m.get(k) || 0) + 1)
  }
  return m
}

function cosOf(a, b) {
  if (!a || !b || !a.size || !b.size) return 0
  let na = 0
  let nb = 0
  let dot = 0
  for (const v of a.values()) na += v * v
  for (const v of b.values()) nb += v * v
  const small = a.size <= b.size ? a : b
  const big = small === a ? b : a
  for (const [k, v] of small) {
    const u = big.get(k)
    if (u) dot += v * u
  }
  const den = Math.sqrt(na) * Math.sqrt(nb)
  return den ? dot / den : 0
}

function recallSearch(cfg, q, n) {
  const terms = termsOf(q)
  if (!terms.length) return []
  const docs = recallDocs(cfg)
  const qv = vecOf(q)
  const hits = []
  for (const d of docs) {
    let lex = 0
    const titleLow = String(d.title || '').toLowerCase()
    for (const t of terms) {
      let k = 0
      let from = 0
      while (k < 3) {
        const i = d.low.indexOf(t.t, from)
        if (i < 0) break
        k++
        from = i + t.t.length
      }
      if (!k) continue
      lex += t.w * (1 + Math.min(k - 1, 2) * 0.3)
      if (titleLow.indexOf(t.t) >= 0) lex += 0.8 * t.w
    }
    // 近似语义：字面没命中时，向量能捞回一部分改写过的说法
    const cos = qv.size && d.vec ? cosOf(qv, d.vec) : 0
    const vec = cos >= 0.28 ? cos * 3.2 : 0
    const total = lex + vec
    if (total < 1) continue
    hits.push({ d, score: total / (1 + Math.log10(1 + d.text.length / 600)), lex, cos })
  }
  hits.sort((a, b) => b.score - a.score)
  const cap = Math.max(1, Math.min(12, (n | 0) || 6))
  return hits.slice(0, cap).map(({ d, score, lex, cos }) => {
    const t0 = terms[0] && terms[0].t ? terms[0].t : ''
    let i = t0 ? d.low.indexOf(t0) : -1
    if (i < 0) for (const t of terms) { i = d.low.indexOf(t.t); if (i >= 0) break }
    const at = i < 0 ? 0 : i
    const pre = d.text.slice(Math.max(0, at - 36), at)
    const tail = d.text.slice(at, at + 108)
    return {
      src: d.src,
      title: d.title,
      date: d.date,
      snippet: (at > 36 ? '…' : '') + pre + tail + (d.text.length > at + 108 ? '…' : ''),
      score: Math.round(score * 100) / 100,
      how: lex > 0 ? (cos >= 0.5 ? '字面+近似' : '字面') : '近似',
      path: d.path,
    }
  })
}

// ── 每晚沉淀（做梦）────────────────────────────────────────────────
// 读今天的日志 + 今天的往来 → 让模型挑 3–6 条值得留的 → 写进 memory-evolve 的待确认队列。
// 写入权不在这里：候选进队列后由老郑在记忆 Tab 里逐条「过 / 弃 / 改类」，我们只做生成。
const DREAM_PATH = join(STORE_DIR, 'dream.json')
const SUGGEST_PATH = join(CFG_DIR, 'memories', 'SUGGESTIONS.jsonl')
const DREAM_BUCKETS = ['memory', 'user', 'project', 'todo-work', 'todo-project', 'drop']

function localDateStr(ts) {
  const d = new Date(ts)
  const p2 = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}

function readDream() {
  try {
    const j = JSON.parse(readFileSync(DREAM_PATH, 'utf8'))
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}

function writeDream(o) {
  try {
    const tmp = DREAM_PATH + '.' + process.pid + '.tmp'
    writeFileSync(tmp, JSON.stringify(o))
    renameSync(tmp, DREAM_PATH)
    return true
  } catch (e) { diag('写 dream.json 失败：' + (e && e.message)); return false }
}

function dreamSystem() {
  const U = NAMES.user || DEFAULT_USER
  const A = NAMES.agent || DEFAULT_AGENT
  const PN = readConfig().name || DEFAULT_NAME
  return [
    '你在给「智能体' + U + '（' + A + '版）」做每晚的沉淀整理，像人睡着以后把白天的事过一遍。',
    '输入是' + U + '今天和你之间的真实往来片段，以及今天的日志。',
    '任务：只挑「明天、下个月还用得上」的东西，3 到 6 条，宁少勿滥。',
    '规则：',
    '1. 不复述过程、不写流水账、不编造输入里没有的事；拿不准就不写。',
    '2. 每条一句话，40 字以内，用「你」称呼' + U + '，不出现「他」。',
    '3. 一次性状态、已经做完的事、纯情绪波动 → bucket 用 drop。',
    '4. 只输出 JSON 数组，不要解释、不要代码块围栏：',
    '[{"bucket":"memory","content":"一条沉淀","reason":"12字内为什么值得记"}]',
    'bucket 取值：memory=跨项目都用得上的长期事实/约定/踩坑；user=关于' + U + '本人的偏好与习惯；',
    'project=这个项目（' + PN + '）的做法与决定；todo-work/todo-project=明天要动手的事；drop=记一笔但不进长期记忆。',
  ].join('\n')
}

function dreamMaterial(ctx) {
  const since = startOfToday()
  const parts = []
  try {
    const p = join(CFG_DIR, 'memories', 'daily', localDateStr(Date.now()) + '.md')
    const txt = readFileSync(p, 'utf8')
    if (txt && txt.trim()) parts.push('【今天的日志】\n' + txt.slice(0, 2500))
  } catch { /* 没有今天的日志就跳过 */ }
  const turns = []
  try {
    for (const agent of ctx.agents.list()) {
      const s = agent && agent.session
      const evs = s && typeof s.snapshotEvents === 'function' ? s.snapshotEvents() || [] : []
      for (const e of evs) {
        const type = String((e && (e.type || e.kind)) || '')
        if (type !== 'user/message' && type !== 'assistant/message') continue
        const at = Number(e.time != null ? e.time : e.at) || 0
        if (!at || at < since) continue
        const p = e.payload !== undefined ? e.payload : e.data
        const src = p && p.source && p.source.kind ? String(p.source.kind) : ''
        if (type === 'user/message' && SKIP_SRC.has(src)) continue
        const t = textOf(p).replace(/\s+/g, ' ').trim()
        if (!t || t.startsWith('<') || t.startsWith('>')) continue
        turns.push((type === 'user/message' ? '你：' : '我：') + t.slice(0, type === 'user/message' ? 220 : 160))
      }
    }
  } catch (e) { diag('dream 取对话失败：' + (e && e.message)) }
  if (turns.length) {
    // 太长会烧钱：从末尾往前攒到 6000 字为止
    let budget = 6000
    const kept = []
    for (let i = turns.length - 1; i >= 0 && budget > 0; i--) {
      const line = turns[i]
      if (line.length > budget) break
      kept.push(line)
      budget -= line.length + 1
    }
    parts.push('【今天的往来（' + kept.length + ' 条）】\n' + kept.reverse().join('\n'))
  }
  return parts.join('\n\n')
}

function dreamModel(ctx) {
  try {
    for (const agent of ctx.agents.list()) {
      const t = modelOf(agent)
      if (t) return t
    }
  } catch { /* ignore */ }
  try {
    const cur = ctx.get && ctx.get('agentDefaultModel')
    const sel = cur && typeof cur.currentSelection === 'function' ? cur.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch { /* ignore */ }
  return null
}

function parseDream(out) {
  const s = String(out || '')
  const i = s.indexOf('[')
  const j = s.lastIndexOf(']')
  if (i < 0 || j <= i) return []
  let arr
  try { arr = JSON.parse(s.slice(i, j + 1)) } catch { return [] }
  if (!Array.isArray(arr)) return []
  const items = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const bucket = String(it.bucket || '').trim()
    const content = polishReason(String(it.content || '')).replace(/\s+/g, ' ').trim()
    if (!DREAM_BUCKETS.includes(bucket) || !content) continue
    items.push({
      bucket,
      content: [...content].slice(0, 60).join(''),
      reason: String(it.reason || '').replace(/\s+/g, ' ').trim().slice(0, 24),
    })
    if (items.length >= 6) break
  }
  return items
}

// 按 memory-evolve 的格式往 SUGGESTIONS.jsonl 里追加（同 target + 内容互相包含算重复，hits+1）
// 沉淀去重：候选的每个二元组有多少被已有记忆覆盖 —— 长文档也不会被稀释
function coverOf(iv, dv) {
  if (!iv || !iv.size || !dv || !dv.size) return 0
  let hit = 0
  for (const k of iv.keys()) if (dv.has(k)) hit++
  return hit / iv.size
}

function dreamNear(content, cfg) {
  let best = null
  try {
    const iv = vecOf(content)
    const norm = String(content || '').replace(/\s+/g, '')
    // 只跟「记忆」轨比：笔记（00-当前.md 这类状态快照）天然和当天话题共享词汇，
    // 拿它当判据会把「今天新学到的」全判成重复（实测：白屏教训被 00-当前.md 误杀 0.79）。
    // 只跟「长期记忆条目」比（MEMORY.md / USER.md / KEY.md），不比 daily 日志与摘要：
    // daily 是流水，本来就覆盖当天所有话题，拿它当判据会把新知识全判成重复（实测误杀 0.73–0.79）。
    const LONG_TERM = new Set(['MEMORY.md', 'USER.md', 'KEY.md'])
    for (const d of recallDocs(cfg)) {
      if (d.src !== '记忆') continue
      if (!LONG_TERM.has(basename(String(d.path || '')))) continue
      const flat = String(d.text || '').replace(/\s+/g, '')
      if (norm.length >= 8 && flat.includes(norm)) return { cos: 1, title: d.title, src: d.src }
      const cov = coverOf(iv, d.vec)
      const hits = Math.round(cov * iv.size)
      // 覆盖率 + 命中绝对数双门槛：短候选靠几个高频 2-gram 就能刷到 0.6 以上，必须再要够多的实词命中
      if (cov >= 0.7 && hits >= 8 && (!best || cov > best.cos)) best = { cos: cov, title: d.title, src: d.src }
    }
  } catch { /* 索引坏了就当没重复 */ }
  return best
}
function enqueueDream(items, cfg, sid) {
  const keep = items.filter((it) => it.bucket !== 'drop')
  const result = { added: 0, dup: 0, error: null, path: SUGGEST_PATH }
  if (!keep.length) return result
  let entries = []
  try {
    const txt = readFileSync(SUGGEST_PATH, 'utf8')
    for (const line of txt.split('\n')) {
      const l = line.trim()
      if (!l) continue
      try { entries.push(JSON.parse(l)) } catch { /* 坏行跳过 */ }
    }
  } catch { /* 队列还不存在 */ }
  const now = new Date().toISOString()
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim()
  for (const it of keep) {
    const target = it.bucket
    const content = norm(it.content)
    const hit = entries.find((e) => e && e.target === target
      && (norm(e.content) === content || norm(e.content).includes(content) || content.includes(norm(e.content))))
    if (hit) {
      hit.hits = (hit.hits ?? 1) + 1
      hit.lastSeen = now
      if (it.reason) hit.reason = it.reason
      result.dup++
      continue
    }
    const near = dreamNear(content, cfg)
    if (near) {
      result.dup++
      diag('沉淀去重：跳过「' + content.slice(0, 30) + '」（' + (near.cos >= 1 ? '已存在' : '近似 ' + near.cos.toFixed(2)) + '：' + near.title + '）')
      continue
    }
    entries.push({
      time: now,
      sessionId: sid || null,
      cwd: cfg && cfg.workspace ? cfg.workspace : null,
      target,
      content: it.content,
      reason: it.reason || null,
      hits: 1,
      firstSeen: now,
      lastSeen: now,
    })
    result.added++
  }
  if (!result.added && !result.dup) return result
  try {
    mkdirSync(join(CFG_DIR, 'memories'), { recursive: true })
    const tmp = SUGGEST_PATH + '.' + process.pid + '.tmp'
    writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
    renameSync(tmp, SUGGEST_PATH)
  } catch (e) {
    result.error = String(e && e.message)
    diag('写待确认队列失败：' + (e && e.message))
  }
  return result
}

async function dreamDigest(ctx, cfg, sid) {
  const t = dreamModel(ctx)
  if (!t) return { ok: false, error: '拿不到模型' }
  const material = dreamMaterial(ctx)
  if (!material.trim()) return { ok: false, error: '今天没有可沉淀的往来' }
  let out = ''
  const seen = {}
  const effort = await reasoningOffFor(ctx, t.provider, t.model)
  const runOnce = async (budget) => {
    let text = ''
    try {
      for await (const chunk of ctx.llm.stream({
        provider: t.provider,
        model: t.model,
        system: dreamSystem(),
        messages: [{
          role: 'user',
          id: randomUUID(),
          content: [{ type: 'text', text: material }],
          source: { kind: 'plugin', plugin: 'dsh-room' },
        }],
        maxTokens: budget,
        temperature: 0.4,
        ...(effort ? { reasoningEffort: effort } : {}),
      })) {
        if (!chunk) continue
        seen[chunk.type] = (seen[chunk.type] || 0) + 1
        if (chunk.type === 'reasoning-delta') seen._reason = (seen._reason || 0) + String(chunk.text || '').length
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          diag('做梦 finish error：' + (chunk.reason.failure && chunk.reason.failure.message))
          return { err: '模型报错' }
        }
      }
    } catch (e) {
      diag('做梦调用失败：' + (e && e.message))
      return { err: String(e && e.message) }
    }
    return { text }
  }
  try {
    const first = await runOnce(effort ? 1200 : 5200)
    if (first.err) return { ok: false, error: first.err }
    out = first.text
    // 推理档把预算吃光时正文是空的：再给一次更大的预算重试（只重试一次）
    if (!String(out).trim()) {
      diag('做梦首轮空正文（reason=' + (seen._reason || 0) + '），放大预算重试一次')
      const second = await runOnce(9000)
      if (second.err) return { ok: false, error: second.err }
      out = second.text
    }
  } catch (e) {
    diag('做梦调用失败：' + (e && e.message))
    return { ok: false, error: String(e && e.message) }
  }
  const items = parseDream(out)
  if (!items.length) {
    diag('做梦输出解析为空：len=' + out.length + ' chunks=' + JSON.stringify(seen) + ' 头=' + String(out).slice(0, 160))
    return { ok: false, error: '模型没给出可用条目' }
  }
  const res = enqueueDream(items, cfg, sid)
  const rec = {
    at: Date.now(),
    model: t.model,
    added: res.added,
    dup: res.dup,
    error: res.error,
    items,
  }
  writeDream(rec)
  diag('沉淀：新增 ' + res.added + ' 条、重复 ' + res.dup + ' 条')
  return { ok: true, ...rec }
}

// ── 主入口 ──────────────────────────────────────────────────────────
export function apply(ctx) {
  const mounted = new Map()   // sid -> off
  let chain = Promise.resolve()
  let disposed = false

  function sidOf(session) {
    try { return String((session && (session.id || session.sessionId)) || '') } catch { return '' }
  }

  function mount(agent) {
    const sid = sidOf(agent.session)
    if (!sid) return null
    let lastUser = ''
    const offs = []

    // 1) 收这一轮对方说的话（宿主注入的上下文不算）
    try {
      offs.push(agent.ctx.on('agent/inbox/inserted', (payload) => {
        const msg = payload && payload.message ? payload.message : payload
        const src = msg && msg.source && msg.source.kind ? String(msg.source.kind) : ''
        if (SKIP_SRC.has(src)) return
        const txt = textOf(msg).trim()
        if (txt && !txt.startsWith('<') && !txt.startsWith('>')) lastUser = txt
      }))
    } catch (e) { diag('监听 inbox 失败：' + (e && e.message)) }

    // 2) 这轮结束 → 判断心情（串行、异步，不阻塞对话）
    try {
      offs.push(agent.ctx.on('agent/turn-stopping', () => {
        if (disposed) return
        const userText = lastUser || lastUserText(agent.session)
        if (!userText) { diag('turn-stopping 进了，但没拿到用户那句话'); return }
        const reply = lastAssistantText(agent.session)
        chain = chain.then(async () => {
          if (disposed) return
          // 判定可能被 provider 挂住；加超时，别让后面所有会话的判定排队等它
          const delta = await Promise.race([
            judge(ctx, agent, userText, reply).catch((e) => { diag('判断失败：' + (e && e.message)); return null }),
            new Promise((r) => setTimeout(() => { diag('判断超时（12s）跳过这一轮'); r(null) }, 12000)),
          ])
          if (!delta || disposed) return
          applyDelta(delta)
        }).catch((e) => diag('判断失败：' + (e && e.message)))
        lastUser = ''
      }))
    } catch (e) { diag('监听 turn-stopping 失败：' + (e && e.message)) }

    // 3) 把此刻的心情注入系统提示词 —— 这是"心情影响说话"的落点
    try {
      const off = agent.ctx.systemPrompt.context({
        name: 'dsh-room-mood',
        order: 900,
        text: () => { try { return moodContextText() } catch { return '' } },
      })
      if (typeof off === 'function') offs.push(off)
    } catch (e) { diag('注入心情到系统提示词失败：' + (e && e.message)) }

    return () => { for (const f of offs) { try { if (typeof f === 'function') f() } catch { /* ignore */ } } }
  }

  function tick() {
    if (disposed) return
    let list = []
    try { list = ctx.agents.list() || [] } catch { list = [] }
    for (const agent of list) {
      const sid = sidOf(agent.session)
      if (!sid) continue
      if (!LAST_CWD) {
        const cw = agent && agent.session && agent.session.header && agent.session.header.cwd
        if (typeof cw === 'string' && cw) LAST_CWD = cw
      }
      const cur = mounted.get(sid)
      // 同一个 sid 可能换了新的 agent 实例（resume / fork）→ 要重挂，否则这个会话的心情永久不动
      if (cur && cur.agent === agent) continue
      if (cur) {
        try { cur.off() } catch { /* ignore */ }
        mounted.delete(sid)
      }
      try {
        const off = mount(agent)
        if (off) { mounted.set(sid, { agent, off }); diag('已挂心情到 ' + sid) }
      } catch (e) { diag('挂 ' + sid + ' 失败：' + (e && e.message)) }
    }
    // 会话没了就卸掉
    for (const [sid, rec] of mounted) {
      if (!list.some((a) => sidOf(a.session) === sid)) {
        try { rec.off() } catch { /* ignore */ }
        mounted.delete(sid)
      }
    }
    // 21:30 之后自动写当天的日报（每天一次，纯计算、不调模型）
    try {
      const d = new Date()
      const mins = d.getHours() * 60 + d.getMinutes()
      const date = localDateStr(Date.now())
      if (mins >= 21 * 60 + 30) {
        const st = readReportState()
        if (!st[date]) {
          const r = buildReport(ctx, readConfig())
          if (r.ok) diag('自动日报：' + r.path)
        }
      }
    } catch (e) { diag('自动日报失败：' + (e && e.message)) }
  }

  tick()
  try { ctx.effect(() => ctx.interval(tick, 3000)) } catch (e) { diag('定时器不可用：' + (e && e.message)) }
  ctx.effect(() => () => {
    disposed = true
    for (const rec of mounted.values()) { try { rec.off() } catch { /* ignore */ } }
    mounted.clear()
  })

  // 3) 给界面面板读
  try {
    // 自检路由：某句话是不是「已经记过了」（调 dreamNear 看相似度）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-room/dream-check',
    handler: async (req, res) => {
      if (!allowed(req, res)) return
      const u = new URL(req.url, 'http://x')
      const q = u.searchParams.get('q') || ''
      if (!q) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '需要 q' })); return }
      const hit = dreamNear(q, readConfig())
      const body = { ok: true, q, dup: !!hit, near: hit, docs: recallDocs(readConfig()).length }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    },
  }))
  ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/state',
      handler: (req, res) => {
        if (!allowed(req, res)) return
        try {
          // 3 秒内重复请求直接给缓存：面板每 15 秒轮询一次，没必要每次全量扫会话
          if (stateCache.body && Date.now() - stateCache.at < 3000) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(stateCache.body)
            return
          }
          const s = decay(readState())
          maybeWriteState(s)
          const mood = Math.round(s.mood)
          const cfg = readConfig()
          const tok = tokensToday(ctx)
          const out = {
            ok: true,
            panelName: cfg.name,
            userName: cfg.userName,
            agentName: cfg.agentName,
            mood,
            label: moodLabel(mood),
            emoji: moodEmoji(mood),
            dims: DIMS.map(([k, label]) => ({ key: k, label, value: Math.round(s.dims[k]) })),
            top: DIMS.map(([k, label]) => ({ label, value: Math.round(s.dims[k]) }))
              .filter((x) => x.value >= 12).sort((a, b) => b.value - a.value).slice(0, 2),
            reason: polishReason(s.reason),
            confidence: s.confidence,
            updatedAt: s.updatedAt,
            timeline: s.timeline.slice(-6).reverse().map((t) => ({
              at: t.at, mood: t.mood, delta: t.delta, conf: t.conf, reason: polishReason(t.reason),
            })),
            tokens: {
              today: tok.today,
              sessions: tok.sessions,
              bowls: tok.bowls,
              bowlTokens: tok.bowlTokens,
              byDay: tok.byDay,
              byProject: tok.byProject,
              bowlCny: tok.bowlCny,
              money: tok.money,
            },
            activity: activityOf(ctx),
            board: recentSessions(ctx, 8),
            budget: budgetOf(cfg, tok.money),
            todos: readTodos(cfg),
            notes: readNotes(cfg),
            ideas: readIdeas(cfg).filter((x) => !x.status || /想法|讨论中/.test(x.status)),
            archive: readArchive(cfg),
      ideasToday: ideasTodayCount(cfg),
            dream: readDream(),
            recallDocs: recallDocs(cfg).length,
            // 心情曲线用的点（最多 2 天内的 120 个）＋今天/昨天均值
            moodHist: (s.hist || []).slice(-120).map((p) => ({ at: p.at, mood: p.mood })),
            moodDays: moodDayStats(s),
            report: (() => {
              const d = localDateStr(Date.now())
              const p = reportPath(cfg, d)
              let at = 0
              try { at = readReportState()[d] || (existsSync(p) ? statSync(p).mtimeMs : 0) } catch { at = 0 }
              return { date: d, path: p, exists: !!at, at: at || null }
            })(),
          }
          const body = JSON.stringify(out)
          stateCache.at = Date.now()
          stateCache.body = body
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
        } catch (e) {
          try {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: String(e && e.message) }))
          } catch { /* ignore */ }
        }
      },
    }))
  } catch (e) { diag('注册 /dsh-room/state 失败：' + (e && e.message)) }

  // 3.2) 记忆检索：问一句，把写过的东西翻出来（只读，不改任何文件）
  try {
  ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/recall',
      handler: (req, res) => {
        if (!allowed(req, res)) return
        try {
          const u = new URL(String(req.url || '/'), 'http://127.0.0.1')
          const q = u.searchParams.get('q') || ''
          const n = Number(u.searchParams.get('n') || 6)
          const cfg = readConfig()
          const t0 = Date.now()
          const items = recallSearch(cfg, q, n)
          const body = JSON.stringify({
            ok: true, q, count: items.length, ms: Date.now() - t0,
            docs: recallDocs(cfg).length, items,
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
        } catch (e) {
          try {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: String(e && e.message) }))
          } catch { /* ignore */ }
        }
      },
    }))
  } catch (e) { diag('注册 /dsh-room/recall 失败：' + (e && e.message)) }

  // 3.3) 每晚沉淀：手动或定时触发一次「做梦」，候选写进记忆 Tab 的待确认队列
  try {
  ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/dream',
      handler: async (req, res) => {
        if (!allowed(req, res)) return
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          } catch { /* ignore */ }
        }
        if (req.method !== 'POST') { send(405, { ok: false, error: 'use POST' }); return }
        req.resume()
        try {
          const cfg = readConfig()
          const r = await dreamDigest(ctx, cfg, null)
          if (!r.ok) { send(200, { ok: false, error: r.error, last: readDream() }); return }
          send(200, {
            ok: true, at: r.at, added: r.added, dup: r.dup, model: r.model,
            items: r.items.map((it) => ({ bucket: it.bucket, content: it.content, reason: it.reason })),
            queue: SUGGEST_PATH,
          })
        } catch (e) {
          send(500, { ok: false, error: String(e && e.message) })
        }
      },
    }))
  } catch (e) { diag('注册 /dsh-room/dream 失败：' + (e && e.message)) }

  // 3.5) 自查：最近的事件长什么样（只在 loopback 上用，排查取文本的问题）
  try {
  ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/events',
      handler: (req, res) => {
        if (!allowed(req, res)) return
        const out = []
        try {
          for (const agent of ctx.agents.list()) {
            const s = agent && agent.session
            const ev = (s && typeof s.snapshotEvents === 'function' ? s.snapshotEvents() || [] : [])
            const tail = ev.slice(-14).map((e) => {
              const p = e && (e.payload !== undefined ? e.payload : e.data)
              const src = p && p.source && p.source.kind ? String(p.source.kind) : ''
              return {
                type: String((e && (e.type || e.kind)) || ''),
                src,
                time: e && e.time,
                head: textOf(p).replace(/\s+/g, ' ').slice(0, 46),
              }
            })
            out.push({ sid: sidOf(s), title: s && s.header ? s.header.title : '', tail })
          }
        } catch (e) { out.push({ error: String(e && e.message) }) }
        try {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(out))
        } catch { /* ignore */ }
      },
    }))
  } catch (e) { diag('注册 /dsh-room/events 失败：' + (e && e.message)) }

  // 4) 改面板名字（界面上的「改名」按钮 POST 过来）
  try {
  ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/name',
      handler: (req, res) => {
        if (!allowed(req, res)) return
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          } catch { /* ignore */ }
        }
        if (req.method !== 'POST') { send(405, { ok: false, error: 'use POST' }); return }
        // 按 Buffer 收齐再解码：`body += chunk` 会在中文跨 TCP 分包时切出乱码
        const chunks = []
        let len = 0
        let over = false
        req.on('data', (c) => {
          if (over) return
          chunks.push(c)
          len += c.length
          if (len > 4096) { over = true; send(413, { ok: false, error: 'body too large' }); req.destroy() }
        })
        req.on('end', () => {
          if (over) return
          // 只收字符串，按码点截断（别把 emoji 切成半个）
          const pick = (v, n) => (typeof v === 'string' ? [...v.trim()].slice(0, n).join('') : '')
          let nm = ''
          let un = ''
          let an = ''
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            nm = pick(j && j.name, 20)
            un = pick(j && j.userName, 12)
            an = pick(j && j.agentName, 12)
          } catch { /* 坏 JSON 当没改 */ }
          if (!nm && !un && !an) { send(400, { ok: false, error: 'name / userName / agentName required' }); return }
          const cfg = readConfig()
          if (cfg._corrupt) { send(500, { ok: false, error: 'config.json 损坏，先修它再改（不覆盖你的设置）' }); return }
          if (nm) cfg.name = nm
          if (un) cfg.userName = un
          if (an) cfg.agentName = an
          if (!writeConfig(cfg)) { send(500, { ok: false, error: 'write failed' }); return }
          diag('配置更新：面板=' + cfg.name + ' 称呼=' + cfg.userName + ' 我叫=' + cfg.agentName)
          send(200, { ok: true, name: cfg.name, userName: cfg.userName, agentName: cfg.agentName })
        })
        req.on('error', () => send(400, { ok: false, error: 'read failed' }))
      },
    }))
  } catch (e) { diag('注册 /dsh-room/name 失败：' + (e && e.message)) }

  // 5) 待办就地打勾（界面上的小方框 POST 过来）
  try {
        ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/todo/edit',
      handler: async (req, res) => {
        if (!allowed(req, res)) return
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          } catch (e) { diag('回复失败：' + (e && e.message)) }
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: '只收 POST' })
        const chunks = []
        let size = 0
        try {
          for await (const c of req) {
            chunks.push(c)
            size += c.length
            if (size > 8192) { send(413, { ok: false, error: '太大了' }); req.destroy(); return }
          }
        } catch (e) { return send(400, { ok: false, error: '读不到请求体' }) }
        let j = null
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch (e) {
          return send(400, { ok: false, error: '不是合法 JSON' })
        }
        const r = editTodo(readConfig(), j && j.file, j && j.line, j && j.text)
        if (r.ok) stateCache.at = 0
        send(r.ok ? 200 : 400, r)
      },
    }))

ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/todo',
      handler: (req, res) => {
        if (!allowed(req, res)) return
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          } catch { /* ignore */ }
        }
        if (req.method !== 'POST') { send(405, { ok: false, error: 'use POST' }); return }
        const chunks = []
        let len = 0
        let over = false
        req.on('data', (c) => {
          if (over) return
          chunks.push(c)
          len += c.length
          if (len > 4096) { over = true; send(413, { ok: false, error: 'body too large' }); req.destroy() }
        })
        req.on('end', () => {
          if (over) return
          let j = {}
          try { j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* 坏 JSON */ }
          const cfg = readConfig()
          const r = (j && j.kind === 'dtodo')
            ? toggleDtodo(j && j.file, j && j.line, j && j.done)
            : toggleTodo(cfg, j && j.file, j && j.line, j && j.done)
          if (!r.ok) { send(400, { ok: false, error: r.error }); return }
          stateCache.at = 0            // 让下一次 /state 立刻反映新勾选
          stateCache.body = ''
          send(200, { ok: true, changed: !!r.changed, todos: readTodos(cfg) })
        })
        req.on('error', () => send(400, { ok: false, error: 'read failed' }))
      },
    }))
  } catch (e) { diag('注册 /dsh-room/todo 失败：' + (e && e.message)) }

  // 6) 每日日报：GET 看今天的、POST 现在生成一份
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/report',
      handler: (req, res) => {
        if (!allowed(req, res)) return
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          } catch { /* ignore */ }
        }
        try {
          const cfg = readConfig()
          const date = localDateStr(Date.now())
          const p = reportPath(cfg, date)
          req.resume()
          const r = buildReport(ctx, cfg)
          send(r.ok ? 200 : (req.method === 'POST' ? 500 : 200), {
            ok: !!r.ok,
            date,
            path: p,
            exists: !!r.text,
            text: String(r.text || '').slice(0, 4000),
            view: r.view || null,
            error: r.error || null,
          })
        } catch (e) {
          send(500, { ok: false, error: String(e && e.message) })
        }
      },
    }))
  } catch (e) { diag('注册 /dsh-room/report 失败：' + (e && e.message)) }

  // ── POST /dsh-room/client-error：页面自己把崩溃信息报回来（白屏时唯一能拿到的线索）──
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/client-error',
      handler: (req, res) => {
        if (!allowed(req, res)) return
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          } catch { /* ignore */ }
        }
        if (req.method !== 'POST') { req.resume(); send(405, { ok: false }); return }
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > 16384) { try { req.destroy() } catch { } return }
          chunks.push(c)
        })
        req.on('end', () => {
          try {
            const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const line = new Date().toISOString() + ' ' + String(b.kind || '') + ' | ' + String(b.msg || '').slice(0, 400)
              + '\n    ' + String(b.stack || '').split('\n').slice(0, 8).join('\n    ')
            try {
              mkdirSync(STORE_DIR, { recursive: true })
              appendFileSync(join(STORE_DIR, 'client-error.log'), line + '\n')
            } catch { /* ignore */ }
            diag('页面报错：' + String(b.msg || '').slice(0, 200))
            send(200, { ok: true })
          } catch (e) {
            send(400, { ok: false })
          }
        })
      },
    }))
  } catch (e) { diag('注册 /dsh-room/client-error 失败：' + (e && e.message)) }

  // ── POST /dsh-room/idea：一句话记想法，直接写进 30-想法池.md ──
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/idea',
      handler: (req, res) => {
        if (!allowed(req, res)) return
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          } catch { /* ignore */ }
        }
        if (req.method !== 'POST') { req.resume(); send(405, { ok: false, error: '只收 POST' }); return }
        const chunks = []
        let size = 0
        let done = false
        req.on('data', (c) => {
          if (done) return
          size += c.length
          if (size > 8192) { done = true; try { send(413, { ok: false, error: '太长' }) } catch { } req.destroy(); return }
          chunks.push(c)
        })
        req.on('end', () => {
          if (done) return
          done = true
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const r = addIdea(readConfig(), body && body.text)
            if (r.ok) stateCache.at = 0
            send(r.ok ? 200 : 400, r)
          } catch (e) {
            send(400, { ok: false, error: '请求体不是合法 JSON' })
          }
        })
      },
    }))
  } catch (e) { diag('注册 /dsh-room/idea 失败：' + (e && e.message)) }

  // 随录条目处置（记住 / 转待办 / 舍弃）
  try {
        ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/idea/edit',
      handler: async (req, res) => {
        if (!allowed(req, res)) return
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          } catch (e) { diag('回复失败：' + (e && e.message)) }
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: '只收 POST' })
        const chunks = []
        let size = 0
        try {
          for await (const c of req) {
            chunks.push(c)
            size += c.length
            if (size > 8192) { send(413, { ok: false, error: '太大了' }); req.destroy(); return }
          }
        } catch (e) { return send(400, { ok: false, error: '读不到请求体' }) }
        let j = null
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch (e) {
          return send(400, { ok: false, error: '不是合法 JSON' })
        }
        const r = editIdea(readConfig(), j && j.seq, j && j.text)
        if (r.ok) stateCache.at = 0
        send(r.ok ? 200 : 400, r)
      },
    }))

ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/idea/decide',
      handler: (req, res) => {
        if (!allowed(req, res)) return
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          } catch { /* ignore */ }
        }
        if (req.method !== 'POST') { send(405, { ok: false, error: 'use POST' }); return }
        const chunks = []
        let len = 0
        let over = false
        req.on('data', (c) => {
          if (over) return
          chunks.push(c)
          len += c.length
          if (len > 4096) { over = true; send(413, { ok: false, error: 'body too large' }); req.destroy() }
        })
        req.on('end', () => {
          if (over) return
          let j = {}
          try { j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* 坏 JSON */ }
          const r = decideIdea(readConfig(), j && j.seq, j && j.action)
          if (!r.ok) { send(400, r); return }
          stateCache.at = 0
          stateCache.body = ''
          send(200, r)
        })
        req.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
      },
    }))
  } catch (e) { diag('注册 /dsh-room/idea/decide 失败：' + (e && e.message)) }

  // ── POST /dsh-room/budget：设月预算上限 ──
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-room/budget',
      handler: (req, res) => {
        if (!allowed(req, res)) return
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          } catch { /* ignore */ }
        }
        if (req.method !== 'POST') { req.resume(); send(405, { ok: false, error: '只收 POST' }); return }
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const cfg = readConfig()
            if (cfg._corrupt) { send(500, { ok: false, error: '配置读不出来，先别覆盖' }); return }
            const n = Number(body && body.amount)
            if (!Number.isFinite(n) || n < 0 || n > 100000) { send(400, { ok: false, error: '金额不对' }); return }
            cfg.budget = Math.round(n)
            writeConfig(cfg)
            stateCache.at = 0
            diag('月预算设为 ¥' + cfg.budget)
            send(200, { ok: true, budget: budgetOf(cfg, tokensToday(ctx).money) })
          } catch (e) {
            send(400, { ok: false, error: '请求体不是合法 JSON' })
          }
        })
      },
    }))
  } catch (e) { diag('注册 /dsh-room/budget 失败：' + (e && e.message)) }
}

