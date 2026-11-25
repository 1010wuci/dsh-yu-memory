import { 概念候选, 命中词 } from './概念词表.mjs';
// 记忆召回：拿一句话，从库里挑最可能的三片，打印节选。
// 用法：node 召回.mjs "他说的话" [--only=0116,0105] [--top=3]
// 只读，不改库。评分：字符 2-gram + IDF 加权，字段加权（话题/关键词看得比正文重）。
import { readFileSync, readdirSync, appendFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 库根目录：--root <路径> > 环境变量 XY_ROOT > 默认真库。
// 先把 --root 从参数里摘掉，免得它被当成问句的一部分。
// 2026-11-02：两种写法都认（`--root 路径` 与 `--root=路径`）。
// 以前只认空格写法，写成等号会被静默忽略、直接查到真库上——这个坑踩过一次（0158）。
(function () {
  const 等号 = process.argv.findIndex((a) => a.startsWith('--root='));
  if (等号 > 1) {
    process.env.XY_ROOT = process.argv[等号].slice(7);
    process.argv.splice(等号, 1);
    return;
  }
  const i = process.argv.indexOf('--root');
  if (i > 1 && process.argv[i + 1]) { process.env.XY_ROOT = process.argv[i + 1]; process.argv.splice(i, 2); }
})();
const LIB = (() => {
  const 给 = (process.env.XY_ROOT || process.env.XY_MEMORY_ROOT || '').trim();
  if (!给) {
    console.error('[yu-memory] 没有库根：用 --root、XY_ROOT 或 XY_MEMORY_ROOT 指一个记忆库目录');
    process.exit(2);
  }
  if (!existsSync(给)) {
    console.error(`[yu-memory] 库根不存在：${给}`);
    process.exit(2);
  }
  return 给;
})();
// --via=（2026-11-14 加，小砚 R5）：调用方标一下这次检索是怎么来的（命令行／展示／补方向链／自测）。
// 只写进 `_检索记录.jsonl`，回流基准 靠它挑出「模型自己觉得不够、又补问了一次」那类难题。
// 摘掉是为了不让它被当成问句的一部分。
const VIA = (() => {
  const i = process.argv.findIndex((a) => a.startsWith('--via='));
  if (i < 1) return '';
  const v = process.argv[i].slice(6);
  process.argv.splice(i, 1);
  return v;
})();
// 2026-11-15：自检／自测不算检索，不写流水。病根是网关每次请求都探活一次，
// `/api/health` 里「召回可调」那一项会跑一次 `召回(…, '记忆')`，于是每轮都往客户的
// `_检索记录.jsonl` 插一条 `q:"记忆"`——客户鱼 1343 条流水里一大半是这条假问，
// 真难题反倒被淹。这类调用一律标 via=自检，落地时跳过。
const 不记流水 = VIA === '自检' || VIA === '自测';
// 可调权重都在同目录 _召回配置.json；环境变量优先级更高，代码里的数是最后的默认
const 配置表 = (() => {
  try { return JSON.parse(readFileSync(new URL('./_召回配置.json', import.meta.url), 'utf8')); } catch { return {}; }
})();
const 取数 = (键, 环境名, 默认) => Number((环境名 && process.env[环境名] != null ? process.env[环境名] : (配置表[键] != null ? 配置表[键] : 默认)));
// 走 stderr：--json 的输出要能被 ConvertFrom-Json 直接吃，多一行提示就解析失败（2026-11-05 恢复演练撞到）
if (process.env.XY_DEBUG === '1') console.error(`[库根] ${LIB}`);

const DIR = join(LIB, '碎片');

// 星级不写在片里（片头那行「重要性」是「普通/疼」这类文字档），真值一直在 `_重要度.json` 的 `分` 里。
// 2026-11-05 接可信度时才发现这个：先按片头正则取，全库 195 片都取不到，等于那一项白给。
const 重要度 = (() => {
  try { return JSON.parse(readFileSync(join(LIB, '_重要度.json'), 'utf8')).分 || {}; }
  catch { return {}; }
})();

function loadDocs() {
  const docs = [];
  for (const f of readdirSync(DIR)) {
    const m = f.match(/^碎片-(\d{4})-(.+)\.md$/);
    if (!m) continue;
    const t = readFileSync(join(DIR, f), 'utf8');
    // 只认老的带粗体写法。新片的 `- 关键词：` 暂不纳入打分：实测会让 hit@1 从 80% 掉到 70%
    // （教训片关键词多，字段权重 3，一上来就把老片顶掉）。要纳入得先改权重结构，不在这里顺手加。
    const kw = (t.match(/\*\*关键词\*\*：(.+)/) || [, ''])[1];
    // 新片（0129 起）没有「## 原文」这一节，退回整篇小节——否则它们在召回里是空片
    const body = t.split(/^## /m).slice(1).join('\n## ');
    // 日期：先取正文里第一个 yyyy-mm-dd，取不到用文件 mtime。
    // 2026-11-01 加：冷片判「够不够老」要用真日期，原来 docs 没这个字段，
    // 一律回落到 2000-01-01，导致库里所有 1–2 星片都被当成「老」——降权把 hit@1 从 92% 打到 86%。
    const 正文日 = (t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/) || [])[0];
    let 日 = 正文日;
    if (!日) { try { 日 = statSync(join(DIR, f)).mtime.toISOString().slice(0, 10); } catch {} }
    const orig = (t.split('## 原文')[1] || body).split(/\n## /)[0];
    const think = (t.split('## 我当时怎么想')[1] || '').split(/\n## /)[0];
    // 2026-11-05 抄 Ido1um 的做法（它的 src/v10.mjs 有可信度 Q 与三档措辞）：
    // 让每一片自己带着「我记多清楚」——有原话、有想法、星级、有真日期，四样各占一份。
    // 这不是拿去排序，是决定我开口时说几成。
    const 星 = Number(重要度[m[1]] || 0);
    // 「有原话」不再只认「他说：」——我们片里还常写「我：」「客户说」「他问」，都是原话记录。
    const 有原话 = /他说[：:]|他问[：:]|客户说|我[：:]|「[^」]{6,}」/.test(t);
    // 「有具体」：片里数字够多（编号、日期、金额、列数都算）——空话片天生算不出来。
    const 有具体 = (t.match(/\d/g) || []).length >= 6;
    // 私密标记（2026-11-14 接，小砚 V4）：这个字段以前只写不读，等于贴纸不是闸门，客户还以为标了就安全。
    // 现在召回把它带出来，由 gateserver/网关 那一侧决定怎么用（对外的鱼只当背景、不复述细节）。
    const 私密 = /有/.test((t.match(/##\s*私密标记\s*\n+([^\n]*)/) || [])[1] || '');
    docs.push({ id: m[1], topic: m[2], kw, orig, think, date: 日, 日真: !!正文日, 星, 有原话, 有具体, 私密, path: join(DIR, f) });
  }
  return docs;
}

const clean = s => s.replace(/[\s\p{P}\p{S}]/gu, '');
// 虚字：2026-11-01 加。不删字、只让「全是虚字的 2-gram」不算分——
// 病根是「我和QQ是不是两个人」靠「不是」「是」「不」把《二维码不能是 xlsx》顶到第三。
// 只滤虚字组合（不是/是不/个我…），真词照留，所以不会像上次删疑问词那样把桥拆了。
// 想关掉：GN=0。
const 虚字 = new Set('的了是我你他她它在有和就都也这那个们吗呢吧啊不没很太要把被又再给从到与及或但而所以为着过将能会一');
const USE_GN = process.env.GN !== '0';
// 算「字面重叠」时不认这些：疑问/语气切片与一两个字母的英文碎片。
// 起因：冒泡排序撞的是 "on" 和「一段」，东京马拉松撞的是「什么/么时/时候」，
// 都算重叠就会把「翻不到」误判成「够」。打分照旧，只是不拿它们当证据。
const 不算重叠 = (g) => /^[a-z]{1,2}$/.test(g)
  || ['什么','么时','时候','怎么','为什','怎样','如何','多少','哪里','哪个','是不','不是','这个','那个','我的','我们','你们','他们','可以','一段'].includes(g);

// 〔覆盖 #N〕的解析（2026-11-14 抽出）：行下标 → 全局事实序号（1 起，按整个文件从头数），
// 以及被屏蔽的序号集合。写入端 记事.mjs 落的 N 现在也是全局序号（2026-11-14 修之前是「尾 12 行窗口内」的序号，
// 两端只在片 ≤12 条事实时重合，片一长就屏蔽错行——小砚 V7 用 15 条复现的正是这个）。
const 事实行正则 = /^-\s*(\d{1,2}:\d{2}|\d{2}-\d{2}\s+\d{1,2}:\d{2})\s+/;
function 覆盖屏蔽表(行们) {
  const 事实序 = new Map();
  let 第几 = 0;
  for (let i = 0; i < 行们.length; i++) if (事实行正则.test(行们[i])) 事实序.set(i, ++第几);
  const 被覆盖 = new Set();
  for (const s of 行们) {
    const m = s.match(/〔覆盖\s*#(\d+)〕/);
    if (m) 被覆盖.add(Number(m[1]));
  }
  return { 事实序, 被覆盖 };
}

// 2026-11-04 行级摘录：只把片里跟问句对得上的几行交出去。
// 起因：整段塞进去，片越长注入越贵，真正对上的常常只有一两行。
// 开关：XY_LINES=0 回到旧的「前 180 字」。排序一个数都不动。
const 行级摘录 = (正文, 问句, 条数 = 3, 每条 = 140) => {
  const 行们 = String(正文 || '').split(/\r?\n/).map(s => s.trim())
    .filter(s => s && !/^-\s*(编号|时间|渠道|话题|关键词|簇|刻痕|重要性|结果)\s*[:：]/.test(s) && !/^#{1,4}\s/.test(s));
  if (!行们.length) return String(正文 || '').replace(/\s+/g, ' ').slice(0, 180);

  // 〔覆盖 #N〕（2026-11-05 接）：写片时新行推翻了片里第 N 条事实，
  // 注入时那一条就不再交出去——历史留着，交出去的是最新状态。
  // 2026-11-14：这段抽成 覆盖屏蔽表，让 --自测覆盖 验的就是同一段代码（自测另写一份判断等于没测）。
  const { 事实序, 被覆盖 } = 覆盖屏蔽表(行们);

  const qg = grams(String(问句 || ''));
  const 分 = 行们.map((s, i) => {
    const g = grams(s);
    let n = 0;
    for (const k of g) if (qg.has(k) && !不算重叠(k)) n++;
    return { i, s, n };
  });
  const 可用 = 被覆盖.size ? 分.filter(x => !被覆盖.has(事实序.get(x.i))) : 分;
  const 中 = 可用.filter(x => x.n > 0);
  // 摘录回落要诚实（2026-11-14 加，小砚 R6-b）：相关行全被 〔覆盖〕 屏蔽掉时，下面会静默回落到
  // 可用行里最靠前的几条——读的人会以为「就是这几条最相关」。回落时就标一句，别让沉默冒充命中。
  const 回落标 = (中.length === 0 && 被覆盖.size) ? '（相关行已被新说法覆盖）' : '';
  // 总字数封顶 180（跟旧版「前 180 字」一个量级）：按相关度收，收够就停，最后按原顺序拼。
  const 预算 = 180;
  let 用数 = 0;
  const 取 = [];
  for (const x of [...(中.length ? 中 : 可用)].sort((a, b) => b.n - a.n || a.i - b.i)) {
    if (取.length >= 条数) break;
    if (用数 + x.s.length > 预算 && 取.length) break;
    取.push(x); 用数 += x.s.length;
  }
  // 〔覆盖 #N〕是给我自己看的记号，交出去时抹掉，别让它混进提示里。
  if (取.length) return 回落标 + 取.sort((a, b) => a.i - b.i).map(x => { const s = x.s.replace(/〔覆盖\s*#\d+〕/g, '').trim(); return s.length > 每条 ? s.slice(0, 每条) + '…' : s; }).join(' ／ ');
};

// 2026-11-05 实验：字面那一路改用「jieba 分词 + 只留实词」。
// 起因：二字滑窗会被「的了怎么」稀释；实体词精确匹配补的是语义模型把专有名词平滑掉的短板。
// 开关：LEX=jieba 才生效，默认仍走二字滑窗。回退：召回.mjs.bak-20261105-实体词实验。
const 实词位 = 0x100000 | 0x1000 | 0x4000;   // n 名词 / v 动词 / t 时间词
const 虚词表 = new Set('的 了 是 我 你 他 她 它 这 那 们 在 有 和 就 都 也 个 吗 呢 吧 啊 不 没 很 太 要 把 被 又 再 给 从 到 与 及 或 但 而 所以 为 着 过 将 能 会 一 什么 怎么 哪个 哪里 多少 为什么 这样 那样 一下 什么 自己'.split(' '));
let SEGOR = null;
if (process.env.LEX === 'jieba') {
  const pkg = (await import('segmentit')).default;
  SEGOR = pkg.useDefault(new pkg.Segment());
}
const 实词集 = (s) => {
  const set = new Set();
  for (const t of SEGOR.doSegment(String(s || ''), { stripPunctuation: true })) {
    const w = t.w;
    if (!w || 虚词表.has(w) || /^\d+$/.test(w)) continue;
    const 字 = clean(w);
    if (!/^[a-zA-Z]{2,}$/.test(w) && 字.length < 2) continue;
    const pos = t.p;
    if (pos === undefined) { if (字.length >= 2) set.add(w); continue; }
    if (!(pos & 实词位)) continue;
    set.add(w);
  }
  return set;
};

function grams(s) {
  if (SEGOR) return 实词集(s);
  const c = clean(s), set = new Set();
  for (let i = 0; i < c.length - 1; i++) {
    const g = c.slice(i, i + 2);
    if (/^\d+$/.test(g)) continue;
    if (USE_GN && [...g].every(ch => 虚字.has(ch))) continue;
    set.add(g);
  }
  return set;
}

const docs = loadDocs();

// 重量（派生文件，由 算重量.mjs 生成；没有就当 50）
let W = {};
try { W = JSON.parse(readFileSync(join(LIB, '_重量.json'), 'utf8')); } catch {}
const wOf = id => (W[id] && W[id].w) || 50;
const USE_W = process.env.NOWEIGHT !== '1';
const wFactor = id => (USE_W ? 0.75 + 0.5 * wOf(id) / 100 : 1);

// 每个 gram 出现在多少片里（算 IDF）
const df = new Map();
const perKey = new Map();   // 话题＋关键词的 gram（权重 3）
const perBody = new Map();  // 正文的 gram（权重 1）
// 段落级（2026-11-04，默认开）：正文按行切段，打分只认「最对得上的那一段」。
// 起因：整片 600 字摊平打，一小段真正切题的内容会被长片的噪声冲淡。
// 实测（50 题，同一状态）：hit@1 45→46、hit@3 49 持平、概念基准 11/11 与 10/11 不变；
// 系数 1.2/1.5/2.5 同结果，4.0 掉到 44 —— 不是调参碰巧。只升不降。
// 回退：召回.mjs.bak-20261104-段落打分前（或 PARA=0 关掉）。
const USE_PARA = process.env.PARA !== '0';
const PARA_W = 取数('PARA_W', 'PARA_W', 1.5);
const perParas = new Map();
const 切段 = t => String(t || '').split(/\r?\n/).map(s => s.trim())
  .filter(s => s && !/^[-*]\s*(编号|时间|渠道|话题|关键词|簇|刻痕|重要性|结果)\s*[:：]/.test(s) && !/^#{1,4}\s/.test(s))
  .slice(0, 60).map(s => grams(s.slice(0, 240)));
for (const d of docs) {
  const gk = grams(d.topic + ' ' + d.kw);
  const gb = grams(d.orig.slice(0, 600));
  perKey.set(d.id, gk);
  perBody.set(d.id, gb);
  if (USE_PARA) perParas.set(d.id, 切段(d.orig));
  for (const x of new Set([...gk, ...gb])) df.set(x, (df.get(x) || 0) + 1);
}
const N = docs.length;
// 太常见的 gram（超过 65% 的片都有）没有区分度，丢掉。
// 但小库不能套这条：片少时每个词都「超过 65%」，全被丢掉，召回永远空——
// 2026-11-01 在 y0002（只有 1 片）上真踩到了。库里不到 5 片就不做这条过滤。
const idf = g => {
  const dfn = df.get(g) || 0;
  if (N >= 5 && dfn / N > 0.65) return 0;
  return Math.log((N + 1) / (dfn + 0.5));
};

// 星图（派生文件，由 算星图.mjs 生成）：位置越靠中心、亮度越高，同样的词分就稍微往前站一点。
// 加成封在 0.9–1.1 之间，只挪位置不盖证据，免得常被想起的片子霸占所有召回。
let STAR = {};
try { STAR = JSON.parse(readFileSync(join(LIB, '_星图.json'), 'utf8')); } catch {}
const starR = new Map((STAR.nodes || []).map(n => [n.code, n.r]));
const starRs = [...starR.values()];
const rMin = starRs.length ? Math.min(...starRs) : 0;
const rMax = starRs.length ? Math.max(...starRs) : 1;
const USE_STAR = process.env.NOSTAR !== '1' && starRs.length > 0;
// 加成形状可调：STAR_BASE 是边缘系数，STAR_W 是中心相对边缘多出来的幅度。
// 2026-10-31 定：亮度不参与打分（STAR_W 默认 0）——「重要」不等于「对题」，
// 亮度该管的是同样对题时谁先出，不该横向压低内容分。星图从此只做展示层。
const STAR_BASE = 取数('STAR_BASE', 'STAR_BASE', 1.00);
const STAR_W = 取数('STAR_W', 'STAR_W', 0.00);
const starFactor = id => {
  if (!USE_STAR) return 1;
  const r = starR.get(id);
  if (r === undefined) return 1;
  const norm = rMax > rMin ? (rMax - r) / (rMax - rMin) : 0.5;   // 1 = 最靠中心
  return STAR_BASE + STAR_W * norm;
};

function scoreDoc(doc, qg) {
  const gk = perKey.get(doc.id), gb = perBody.get(doc.id);
  let sk = 0, sb = 0, n = 0, n实 = 0;
  for (const g of qg) {
    const w = idf(g);
    if (!w) continue;
    if (gk.has(g)) { sk += w * 3; n++; if (!不算重叠(g)) n实++; } else if (gb.has(g)) { sb += w; n++; if (!不算重叠(g)) n实++; }
  }
  if (USE_PARA) {
    let 最段 = 0;
    for (const p of perParas.get(doc.id) || []) {
      let ps = 0;
      for (const g of qg) { if (!p.has(g)) continue; const w = idf(g); if (w) ps += w; }
      if (ps > 最段) 最段 = ps;
    }
    sb = 最段 * PARA_W;   // 正文只认最对得上的那一段，不摊平
  }
  return { s: (sk + sb) * wFactor(doc.id) * starFactor(doc.id), n, n实 };
}

// 主簇（派生文件，由 分主簇.mjs 生成，口径见 簇表.mjs）：想起一点，把同一主簇的邻片也带亮。
// 2026-10-31 由「关键词簇」改成「主簇」：关键词簇 570 个、524 个只挂一片，靠它带亮等于按噪声连线。
// 回退：召回.mjs.bak-20261031-簇加成改主簇前。
// 改动流水：只算“改过几次、最近哪天”，不进排序、不进星图、不展开内容。
// 要查谁改的、为什么，用 node 看改动.mjs <片号>。
const 改动统计 = new Map();   // 片 → { 次, 最近 }
try {
  const 目录 = join(LIB, '改动流水');
  for (const f of readdirSync(目录)) {
    if (!f.endsWith('.jsonl') || f.startsWith('_')) continue;
    const 行 = readFileSync(join(目录, f), 'utf8').split('\n').filter(Boolean);
    if (!行.length) continue;
    const 末 = JSON.parse(行[行.length - 1]);
    改动统计.set(f.replace('.jsonl', ''), { 次: 行.length, 最近: (末.t || '').slice(0, 10) });
  }
} catch {}
const 改过 = (id) => {
  const x = 改动统计.get(id);
  return x ? `｜改过 ${x.次} 次（最近 ${x.最近}）` : '';
};

let 主簇分布 = {};
try { 主簇分布 = JSON.parse(readFileSync(join(LIB, '_主簇.json'), 'utf8')).分布 || {}; } catch {}
const docClusters = new Map();   // 片 → 主簇名集合（现在恒为 1 个，留 Set 是为了以后可能挂次簇）
for (const [main, ids] of Object.entries(主簇分布)) {
  if (main === '（没主簇）') continue;
  for (const id of ids) {
    if (!docClusters.has(id)) docClusters.set(id, new Set());
    docClusters.get(id).add(main);
  }
}
const USE_CLUSTER = process.env.NOCLUSTER !== '1';

// ── 派生文件缺口（2026-11-14 加，小砚 R1）────────────────────────
// 召回吊在 _向量 / _段向量 / _主簇 / _重量 / _星图 五个派生文件上，缺条目全是静默降级：
// 片没有向量 → 语义那一路压根看不见它（Object.entries 里没这个 id）；没重量当 50；没主簇显示「没主簇」。
// 算向量哪天真失败一批，没人会知道。所以让它自己会喊疼：--json 带「缺口」，--缺口 直接问一句。
function 派生缺口() {
  const ids = docs.map(d => d.id);
  const 有向量 = new Set(Object.keys((VEC && VEC.vectors) || {}));
  const 有段 = new Set(Object.keys((SEG && SEG.segs) || {}));
  const 有重量 = new Set(Object.keys(W || {}));
  const 缺 = (判) => { const a = ids.filter(判); return { 数: a.length, 头: a.slice(0, 10) }; };
  return {
    片数: ids.length,
    向量: { 有: 有向量.size, 缺: 缺(id => !有向量.has(id)) },
    段向量: { 有: 有段.size, 缺: 缺(id => !有段.has(id)) },
    主簇: { 有: docClusters.size, 缺: 缺(id => !docClusters.has(id)) },
    重量: { 有: 有重量.size, 缺: 缺(id => !(W && W[id] != null)) },
    星图: { 有: starR.size, 缺: 缺(id => !starR.has(id)) },
    模型: { 整片: (VEC && VEC.model) || null, 段: (SEG && SEG.model) || null,
      阈值: { COS_LINE, COS_SOFT, COS_SOFT2 } },
  };
}
// 亮度记在线上：同一簇的两端，谁更重，这条线就越亮（0.10 的封顶，只挪位置不盖证据）
const edgeBoost = (a, b) => 1 + 0.10 * (wOf(a) + wOf(b)) / 200;

// 线（`_线.jsonl`，人工裁定的显式关联）：簇管归类，线管「是不是同一件事」。
// 2026-10-31 加。2026-11-02 改：**默认不参与排序**——他定线只做展示（让客户直观看见架构在起作用）。
// 要临时开回排序：XY_LINE=1；幅度 LINE_W。
// 展示那一步（--注入 里的「跨簇还有线连着」）不吃这个开关，一直有。
// 回退：召回.mjs.bak-20261031-加线前。
let 线图 = new Map();
try {
  for (const l of readFileSync(join(LIB, '_线.jsonl'), 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue;
    const o = JSON.parse(l);
    for (const [x, y] of [[o.a, o.b], [o.b, o.a]]) {
      if (!线图.has(x)) 线图.set(x, new Set());
      线图.get(x).add(y);
    }
  }
} catch { /* 没有线文件就照旧按簇走 */ }
const USE_LINE = process.env.XY_LINE === '1';
const LINE_W = 取数('LINE_W', 'LINE_W', 0.15);

// 2026-11-01 加「冷片降权」：很久没被想起、星级又低、又够老的片，排后面。
// 只降权、不删；NCOLD=1 关；COLD_W 是乘数（默认 0.7）。
const COLD_W = 取数('COLD_W', 'COLD_W', 0.70);
const USE_COLD = process.env.NCOLD !== '1';
const COLD_DAYS = 取数('COLD_DAYS', 'COLD_DAYS', 30);

// 2026-11-05 抄 Ido1um（它的 src/v10.mjs 有 Q 与 qLabels）：把我「说几成」的措辞换成三档人话。
// 它用 Q = 原话 + 具体 + 想法 + 星级 算每片多硬；我照着算了一遍，全库 187/204 片都是满分——
// 我们的片本来就写得硬（有原话、有数字、有想法），这个分数在我们库里没有区分度。
// 所以三档不接在「片有多硬」上，接在**这一问命中得有多稳**上：够 / 存疑 / 翻不到 本来就是三段。
const 印象词 = (够级) => ({ '够': '比较确定', '存疑': '大概记得', '翻不到': '只记得片段' }[够级] || '大概记得');

// 旧片：超过 XY_旧事天 天的，交出去时前面标「旧事 · MM-DD」——不隐瞒，也不让它读起来像今天的事。
// 抄它的口径：过期事实不藏，只换措辞。默认 30 天；现在库里最老的片才 12 天，所以一片都标不上。
const 旧事天 = 取数('旧事天', 'XY_旧事天', 30);
const 旧事标 = (d) => {
  const t = new Date(d.date || '').getTime();
  if (!t) return '';
  return (Date.now() - t) / 86400000 >= 旧事天 ? `旧事 · ${String(d.date).slice(5)}：` : '';
};

// 2026-11-01 加「概念路由」：问句里若出现概念词表里的抽象词（两个人、QQ、钱、关掉…），
// 就把这些词挂的簇里的片往前挪一点。起因是真题库里「你和QQ是不是两个人」这类问句，
// 主题词在片里几乎零字面，字面与语义都排不上，可它在人裁的簇表里是有归属的。
// 只是一个偏置，不改变谁被算进候选；NOCONCEPT=1 关，CONCEPT_W 是权重（默认 0.18）。
const USE_CONCEPT = process.env.NOCONCEPT !== '1';
const CONCEPT_W = 取数('CONCEPT_W', 'CONCEPT_W', 0.18);
let 冷片集 = new Set();
if (USE_COLD) {
  // 2026-11-01 修：原来整块包在一个 try 里，_检索记录.jsonl 不存在（新库/沙盘）就抛错，
  // 整段被吞掉、冷片集永远是空的——降权静默失效。现在每个文件各自兜底。
  let 星表 = {};
  try { 星表 = JSON.parse(readFileSync(join(LIB, '_重要度.json'), 'utf8')).分 || {}; } catch {}
  const 末次 = new Map();
  try {
    for (const 行 of readFileSync(join(LIB, '_检索记录.jsonl'), 'utf8').split('\n')) {
      if (!行.trim()) continue;
      try {
        const o = JSON.parse(行);
        for (const id of o.ids || []) if (!末次.get(id) || 末次.get(id) < o.t) 末次.set(id, o.t);
      } catch {}
    }
  } catch {}
  const 今 = Date.now();
  for (const d of docs || []) {
    const 星 = 星表[d.id];
    if (星 === undefined || 星 > 2) continue;
    const 末 = 末次.get(d.id);
    const 久未想起 = !末 || (今 - new Date(末).getTime()) / 86400000 >= COLD_DAYS;
    const 够老 = (今 - new Date(d.date || '2000-01-01').getTime()) / 86400000 >= COLD_DAYS;
    if (久未想起 && 够老) 冷片集.add(d.id);
  }
  if (process.env.COLD_DEBUG === '1') console.error('[冷片] 命中 ' + 冷片集.size + ' 片：' + [...冷片集].slice(0, 5).join(',') + '　星表条数=' + Object.keys(星表).length + '　片数=' + (docs || []).length);
}


// —— 语义这一路：只吃「意思」，和字面各排一列，再用 RRF 合起来 ——
// 用法：默认开；想只看字面就设 NOSEM=1。SEM_W 是这一列的权重，RRF_K 是融合常数。
const USE_SEM = process.env.NOSEM !== '1';
const SEM_W = 取数('SEM_W', 'SEM_W', 1.5);
const RRF_K = 取数('RRF_K', 'RRF_K', 10);

// —— 弃答那道门：库里最像的那片也不够像，就别硬凑，如实说「翻不到」 ——
// 门槛只看余弦（绝对相似度），不看名次；NOCOS=1 关掉，COS 改线。
const USE_COS = process.env.NOCOS !== '1';
// 余弦阈值可以是 let（2026-11-14，小砚 R3）：它对「某模型 + q8 精度」校出来，换模型就全线失准，
// 所以允许 _向量.json 里存一份，读文件值（下面 VEC 加载后覆盖）。字面阈值跟模型无关，仍是 const。
let COS_LINE = 取数('COS_LINE', 'COS', 0.50);     // 低于它就是「翻不到」
let COS_SOFT = 取数('COS_SOFT', 'COS_SOFT', 0.55); // 低于它、字面又没撞上三处，算「存疑」
const N_LINE = 取数('N_LINE', 'N_LINE', 2);   // 「翻不到」要求字面重叠 < 2
const N_SOFT = 取数('N_SOFT', 'N_SOFT', 3);   // 「存疑」要求字面重叠 < 3
let COS_SOFT2 = 取数('COS_SOFT2', 'COS_SOFT2', 0.60); // 第二档：余弦更高但只要字面几乎没撞上，也算存疑
const N_SOFT2 = 取数('N_SOFT2', 'N_SOFT2', 2);
let VEC = null;
try { VEC = JSON.parse(readFileSync(join(LIB, '_向量.json'), 'utf8')); } catch { /* 没算过向量就只走字面 */ }
// 阈值跟模型走（2026-11-14 加，小砚 R3）：换 embedding 模型或换量化精度，代码里那三个数就失准
// （512/768 混维那次就是预演）。算向量/基准把校准过的阈值写进 _向量.json 的「阈值」，并在同处记模型指纹。
// 优先级：环境变量 > 人工调过的 _召回配置.json > _向量.json（仅当模型指纹对得上）> 代码默认。
// 为什么「人工调过」也算：配置里那三个数只要还是当初的默认值，就说明没人动过，可以跟着模型漂；
// 一旦有人显式改了，就以那个人的数为准，免得文件里一份旧阈值把他的调参盖掉。
if (VEC && VEC.阈值 && typeof VEC.阈值 === 'object') {
  const 指纹对 = !VEC.阈值.模型 || !VEC.model || String(VEC.阈值.模型) === String(VEC.model);
  const 没人调 = (键, 默认) => 配置表[键] == null || Number(配置表[键]) === 默认;
  const 取文件 = (k) => (Number.isFinite(Number(VEC.阈值[k])) ? Number(VEC.阈值[k]) : null);
  const 可用 = (环境名, 键, 默认) => process.env[环境名] == null && 指纹对 && 没人调(键, 默认);
  if (可用('COS', 'COS_LINE', 0.50) && 取文件('COS_LINE') !== null) COS_LINE = 取文件('COS_LINE');
  if (可用('COS_SOFT', 'COS_SOFT', 0.55) && 取文件('COS_SOFT') !== null) COS_SOFT = 取文件('COS_SOFT');
  if (可用('COS_SOFT2', 'COS_SOFT2', 0.60) && 取文件('COS_SOFT2') !== null) COS_SOFT2 = 取文件('COS_SOFT2');
}
// 2026-11-04：段向量。整片压一个向量会被正文里不相干的大段稀释——「第一条图文」那题字面第一、
// 语义却掉到第 19，就是被片里讲客户端黑屏、量坐标那几句冲淡的。有段向量就按段取最大余弦。
let SEG = null;
try { SEG = JSON.parse(readFileSync(join(LIB, '_段向量.json'), 'utf8')); } catch { /* 没算过段向量就回落整片 */ }
const USE_SEG = process.env.NOSEG !== '1';
const SEGW = 取数('SEGW', 'SEGW', 0);   // 0=不用段；1=全用段
const SEGCAP = 取数('SEGCAP', 'SEGCAP', 0.08);
const SEGLOW = 取数('SEGLOW', 'SEGLOW', 0);   // >0 时只在整片余弦低于它时才用段分（长片里只有一小段讲这事的场景） // 段分最多比整片高这么多，防短段把噪声顶上来   // 0=完全不用段向量（走整片）；1=完全用段；中间＝打底+按比例补
let semPipe = null;
let 用Py = false;   // Linux 服务器的 onnxruntime-node 要从 GitHub 下二进制，下不动 → 改用 python 版编码问句
let 语义为何 = '';  // 语义这路没走上时，记一句人话原因（没 python、没模型、维度不对）
const 向量脚本 = fileURLToPath(new URL('./算向量.py', import.meta.url));
// 2026-11-15 修「换机器/换盘就静默失效」：`_向量.json` 里的 model 是算向量那台机器的绝对路径。
// 11-14 把演示鱼的向量从 Windows 传上服务器，路径还是 D:\小玉的手\…，线上补算就报
// `tokenizer.json No such file`，整条召回崩掉——路径不该由数据文件说了算。
// 现在：文件里那条路存在就用它；不存在就退回「跟本脚本同目录」的 _模型缓存，换机器不用改数据。
const 工具目录 = fileURLToPath(new URL('./', import.meta.url));
const 就地模型 = join(工具目录, '_模型缓存', 'local', 'bge-base-zh-v1.5');
const 能用 = (p) => (typeof p === 'string' && p && existsSync(p) ? p : null);
function 挑模型(文件里那条) {
  const 好 = 能用(文件里那条);
  if (好) return 好;
  const 就地 = 能用(就地模型);
  if (就地) {
    if (文件里那条) console.error(`[模型] 向量文件里的 ${文件里那条} 不在这台机器上，改用 ${就地}`);
    return 就地;
  }
  return 文件里那条;
}
async function sem编码(query) {
  const 模型 = 挑模型(SEG && USE_SEG && SEGW > 0 ? SEG.model : VEC.model);
  if (!semPipe && !用Py) {
    try {
      const { pipeline } = await import('@huggingface/transformers');
      // 2026-11-05 修：SEGW=0 时根本不用段分，却仍按段向量文件挑模型——真库还留着 512 维的旧段向量，
      // 结果查询走 small、库向量是 base 768 维，余弦全乱（真库基准掉到 12/50 的元凶）。只在真用段分时才认段模型。
      semPipe = await pipeline('feature-extraction', 模型, { dtype: 'q8' });
    } catch {
      用Py = true;
    }
  }
  if (用Py) {
    const { execFileSync } = await import('node:child_process');
    // 2026-11-24：本机 python3 只是应用商店的占位符（退出码 9009），换成真解释器路径
    const 解释器 = process.env.XY_PY || 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
    const out = execFileSync(解释器, [向量脚本, '--文本', query, '--模型', 模型],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out.trim());
  }
  const r = await semPipe(query, { pooling: 'cls', normalize: true });
  return Array.from(r.data);
}
// 点积（2026-11-14 加维度守卫，小砚 R2）：两路原来都按 a.length 走，b 短一截就乘出
// undefined → NaN。NaN 参与 sort 比较恒为 false，榜序静默乱掉，没有任何报错。
// 512/768 混维那次（见上）只补了「用哪个模型」，没加断言，同位再犯时仍然没有防线。
// 维度不一致就当「这条语义路没算出来」：返回 -1，低于任何余弦，也不进榜。
function 点积(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

async function semList(query) {
  if (!USE_SEM || (!VEC && !SEG)) return null;
  let v = null;
  try {
    v = await sem编码(query);
  } catch (e) {
    语义为何 = String((e && e.message) || e).split('\n')[0].slice(0, 140);
    return null;
  }
  if (!v) {
    语义为何 = 语义为何 || '编码没返回向量';
    return null;
  }
  if (SEG && USE_SEG && SEGW > 0) {   // 段向量那一路上：整片余弦打底，段分比它高时按 SEGW 往上补一截
    const dot = 点积;
    return Object.entries(SEG.segs).map(([id, arr]) => {
      let best = -1, bk = -1;
      for (let k = 0; k < arr.length; k++) {
        const seg = arr[k];
        if (!Array.isArray(seg) || seg.length !== v.length) continue; // 段向量维度对不上就跳过这一段
        let s = 0;
        for (let i = 0; i < seg.length; i++) s += v[i] * seg[i];
        s /= 127;             // 段向量存的是 -127..127 的整数
        if (s > best) { best = s; bk = k; }
      }
      const 整 = VEC && VEC.vectors && VEC.vectors[id] ? dot(v, VEC.vectors[id]) : -1;
      const 用段 = SEGLOW > 0 ? (整 < SEGLOW ? best : 整) : (整 + SEGW * Math.min(Math.max(0, best - 整), SEGCAP));
      const s = (SEGW >= 1 && SEGLOW <= 0) ? best : 用段;
      return { id, s, seg: bk, 整, 段: best };
    }).sort((a, b) => b.s - a.s);
  }
  const dot = 点积;
  return Object.entries(VEC.vectors).map(([id, vec]) => ({ id, s: dot(v, vec) })).sort((a, b) => b.s - a.s);
}

// ── 级联改写（2026-11-05，默认关）─────────────────────────────
// 榜首分低到「几乎没撞上」时才跑一次改写词补捞，只补漏、不动高分题。
// 开关：XY_REWRITE=1；阈值 XY_REWRITE_SEM（默认 0.18）；权重 XY_REWRITE_W（默认 2）。
// 实测（真库 50 题）：46/50 → 47/50，只触发 3 题；阈值放到 0.25 会全触发并掉到 43/50。
// 按规矩 +1 题算偶然，所以默认关，只有手动开了才生效。
const 改写开 = () => process.env.XY_REWRITE === '1';
const REWRITE_SEM = 取数('REWRITE_SEM', 'XY_REWRITE_SEM', 0.18);
const REWRITE_W = 取数('REWRITE_W', 'XY_REWRITE_W', 2);
let _改写key = null;
function 改写key() {
  if (_改写key !== null) return _改写key;
  try {
    const 文 = readFileSync(join(process.env.USERPROFILE || 'C:\\Users\\Administrator', '.dsh', '.credentials.yaml'), 'utf8');
    const m = 文.match(/^\s*DEEPSEEK_API_KEY:\s*"?([^\r\n"]+)"?/m);
    _改写key = m ? m[1].trim() : '';
  } catch { _改写key = ''; }
  return _改写key;
}
// 把问句翻成「库里可能用来写这件事的名词短语」——归它想，不归它排序。
async function 改写词(query) {
  const key = 改写key();
  if (!key) return [];
  const 提示 = '这是一条记忆库的检索任务。库里的片按话题组织，片名形如「养老单：TXT 是月缴费额」，每片带 4-8 个关键词，都是名词短语。\n\n' +
    '用户问：' + query + '\n\n' +
    '请判断这句话在问库里的哪件事，然后写出 3 到 4 条「库里可能用来写这件事的词」。规则：\n' +
    '- 用名词短语或话题名，不要疑问词，不要解释，不要复述问句。\n' +
    '- 每条 2 到 8 个字，尽量用正事的名词。\n' +
    '- 想不出就只给一条最可能的。\n' +
    '- 只输出 JSON 数组，例如 ["养老单","缴费月数","月缴费额"]。';
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: 'deepseek-chat', temperature: 0, max_tokens: 250, messages: [{ role: 'user', content: 提示 }] }),
    });
    const j = await r.json();
    const 文 = j.choices?.[0]?.message?.content || '';
    const m = 文.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 4) : [];
  } catch { return []; }
}

// ── 线索加分要用到的小东西（2026-11-05）──────────────────────────
const USE_CUE = process.env.NOCUE !== '1';
const CUE_W = 取数('CUE_W', 'CUE_W', 0.25);
// 时间词 → 一个日期区间。只认这几种说得死的；「那阵子」「后来」这种含糊的一概不猜。
const 时间词 = (q) => {
  const s = String(q || '');
  const 今 = new Date();
  const 日 = (n) => new Date(今.getTime() - n * 86400000);
  if (/昨天|昨日/.test(s)) return { 起: 日(2), 止: 日(0), 名: '昨天' };
  if (/前天/.test(s)) return { 起: 日(3.5), 止: 日(1.5), 名: '前天' };
  if (/上周|上个星期/.test(s)) return { 起: 日(14), 止: 日(6), 名: '上周' };
  if (/上个月|上月/.test(s)) return { 起: 日(62), 止: 日(28), 名: '上个月' };
  const m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const y = 今.getFullYear();
    const t = new Date(y, Number(m[1]) - 1, Number(m[2]));
    if (t.getTime() > 今.getTime() + 86400000) t.setFullYear(y - 1);
    return { 起: new Date(t.getTime() - 86400000), 止: new Date(t.getTime() + 86400000), 名: `${m[1]}月${m[2]}日` };
  }
  return null;
};
// 人物词表（2026-11-14 改，小砚 R6-c）：原来写死在代码里（老大/无辞/野良…），是玉库的私货，
// 平台给客户鱼用的时候会一起带过去。现在只从 _召回配置.json 的「人物词表」读，代码里不预置：
// 玉本机那份配了这几个词，服务器那份没有，于是鱼不带私货、玉照旧。缺了就退化成「不按人名加分」，别的路不动。
const 人物词 = Array.isArray(配置表.人物词表) ? 配置表.人物词表.filter((w) => typeof w === 'string' && w) : [];

async function recall(query, top = 3, 不再改写 = false) {
  const qg = grams(query);
  const all = docs.map(d => ({ d, ...scoreDoc(d, qg) })).filter(x => x.s > 0);
  const strong = all.filter(x => x.n >= 2);
  const pool = strong.length ? strong : all;
  pool.sort((a, b) => b.s - a.s);

  // 带亮：拿榜首所在的簇，把同簇的邻片往前挪
  if (USE_CLUSTER && pool.length > 1) {
    const topClusters = docClusters.get(pool[0].d.id) || new Set();
    if (topClusters.size) {
      for (const x of pool) {
        if (x === pool[0]) continue;
        const cs = docClusters.get(x.d.id);
        if (cs && [...cs].some(c => topClusters.has(c))) {
          x.s *= edgeBoost(pool[0].d.id, x.d.id);
          x.via = [...cs].filter(c => topClusters.has(c));
        }
      }
      pool.sort((a, b) => b.s - a.s);
    }
  }
  const sem = await semList(query);
  if (!sem) {
    // 没有向量文件（新库、沙盘、或关了语义）时也照样要降冷片，否则「冷片降权」在这条路上静默失效。
    if (USE_COLD && 冷片集.size) {
      for (const x of pool) if (冷片集.has(x.d.id)) x.s *= COLD_W;
      pool.sort((a, b) => b.s - a.s);
    }
    // 新库没有 _向量.json（每条刚建好的鱼都是这样）——这条分支以前直接 return，
    // 没带上 最高余弦/够级/够了，--json 与 --注入 都会在 .toFixed 上崩。
    // 2026-11-01 在 y0002 上真踩到了，见碎片。
    const 无向量out = pool.slice(0, top);
    无向量out.最高余弦 = -1;          // 没有语义分，就如实说没有
    无向量out.够级 = '够';            // 判不了底，别谎称翻不到
    无向量out.够了 = true;
    无向量out.无语义 = true;
    无向量out.语义为何 = 语义为何 || (USE_SEM ? '' : '关了语义（NOSEM=1）');
    return 无向量out;
  }
  // 一个字面排序、一个语义排序，各自算名次，再用 1/(k+名次) 相加——这样两列不用比分数大小
  const litRank = new Map(pool.map((x, i) => [x.d.id, i + 1]));
  const semRank = new Map(sem.map((h, i) => [h.id, i + 1]));
  const cand = new Map();
  for (const x of pool) cand.set(x.d.id, x);
  for (const h of sem.slice(0, 20)) {           // 语义列前 20 也进候选，防止字面一个词都没撞上的片被挡在门外
    if (cand.has(h.id)) continue;
    const d = docs.find(t => t.id === h.id);
    if (d) cand.set(h.id, { d, s: 0, n: 0, n实: 0 });
  }
  const semScore = new Map(sem.map(h => [h.id, h.s]));
  for (const x of cand.values()) {
    const l = litRank.get(x.d.id), m = semRank.get(x.d.id);
    x.fused = (l ? 1 / (RRF_K + l) : 0) + (m ? SEM_W / (RRF_K + m) : 0);
    x.semRank = m || 0;
    const cs = semScore.get(x.d.id);
    x.cos = cs === undefined ? null : cs;
  }
  // 线：榜首那片若连着别的片，把线上的邻居往前挪一档。线是人裁的，比同簇可靠。
  if (USE_LINE && LINE_W > 0 && cand.size > 1) {
    let 榜首 = null;
    for (const x of cand.values()) if (!榜首 || x.fused > 榜首.fused) 榜首 = x;
    const 邻 = 榜首 && 线图.get(榜首.d.id);
    // 2026-11-02 改：邻片只往前挪，不许反超榜首。
    // 原来直接乘 (1+LINE_W)，线多了以后邻片会把亲答案顶下去（实测 26 条→60 条，hit@1 从 45/50 掉到 42/50）。
    if (邻) for (const x of cand.values()) if (x !== 榜首 && 邻.has(x.d.id)) x.fused = Math.min(x.fused * (1 + LINE_W), 榜首.fused * 0.999);
  }
  if (USE_COLD && 冷片集.size) for (const x of cand.values()) if (冷片集.has(x.d.id)) x.fused *= COLD_W;
  // 概念路由：只给偏置、不删候选（见文件顶部注释）。
  // 2026-11-01 实测：无条件开会把自出 50 题从 46/50 拉到 45/50（概念词覆盖面太宽，把该答的片挪下去了）。
  // 所以只在**字面与语义都弱**的时候才动：最高余弦低于软线，且榜首那片实词重叠不到 2。
  if (USE_CONCEPT && cand.size > 0) {
    let 预余弦 = -1;
    for (const x of cand.values()) if (x.cos !== null && x.cos > 预余弦) 预余弦 = x.cos;
    let 预首 = null;
    for (const x of cand.values()) if (!预首 || x.fused > 预首.fused) 预首 = x;
    const 预n = 预首 ? ((预首.n实 ?? 预首.n) || 0) : 0;
    const 弱 = 预余弦 >= 0 && 预余弦 < COS_SOFT && 预n < 2;
    const 候选簇 = 弱 ? 概念候选(query) : [];
    if (候选簇.length) {
      const 权 = new Map(候选簇.map((c, i) => [c, i === 0 ? CONCEPT_W : CONCEPT_W * 0.6]));
      for (const x of cand.values()) {
        const cs = docClusters.get(x.d.id);
        if (!cs || !cs.size) continue;
        let w = 0;
        for (const c of cs) if (权.has(c)) w = Math.max(w, 权.get(c));
        if (w > 0) x.fused *= (1 + w);
      }
    }
  }
  // ── 线索加分（2026-11-05 抄 Ido1um 的 cueHits 思路）────────────────
  // 它的做法：问句里提到人名 +6、场景 +6、时段 +4、情绪 +4（它分数是 0-100 量级，所以用加法）。
  // 我们的分是 1/(k+名次) 量级，所以改成乘性，上限压到 ×1.375，只当微调。
  // 只认两种线索，别的都不猜：
  //   ① 时间词——昨天/前天/上周/上个月/X月X日：拿它跟片日期比，落在区间里才加；
  //   ② 人名——老大、无辞、小阿璇、弟弟、客户、野良：片里真写了这个人才加。
  // 开关：NOCUE=1 关；CUE_W 是基数（默认 0.25）。
  if (USE_CUE && cand.size) {
    const 时 = 时间词(query);
    const 人 = 人物词.filter((w) => String(query).includes(w));
    if (时 || 人.length) {
      for (const x of cand.values()) {
        let 加 = 0;
        if (时) {
          const t = new Date(x.d.date || '').getTime();
          if (t && t >= 时.起.getTime() && t <= 时.止.getTime()) 加 += CUE_W;
        }
        if (人.length) {
          const 文 = String(x.d.orig || '') + String(x.d.think || '') + String(x.d.topic || '');
          if (人.some((w) => 文.includes(w))) 加 += CUE_W * 0.6;
        }
        if (加 > 0) { x.fused *= (1 + Math.min(加, CUE_W * 1.5)); x.线索 = true; }
      }
      if (process.env.CUE_DEBUG === '1') {
        const 动 = [...cand.values()].filter((x) => x.线索).map((x) => x.d.id);
        console.error(`[线索] 时间=${时 ? 时.名 : '无'} 人=${人.join(',') || '无'} 动到 ${动.length} 片`);
      }
    }
  }
  // ASCII 词：中文一条问句能撞上的常用字太多，英文/型号/命令名不一样——撞上就是撞上了。
  // 而纯 ASCII 问句的余弦会整体塌到 0.47 左右（问什么都同一个数），拿它当底气就会
  // 明明片就在库里、字面也对得上，却判「翻不到」。所以两件事一起做：
  //   ① 含该词的片 fused ×1.35（先把对的那片抬到前面去）；
  //   ② 命中即算硬证据，字面重叠按 +2 算（够级不再被塌掉的余弦拖下水）。
  const ascii词 = (String(query).match(/[A-Za-z][A-Za-z0-9_.\-]{2,}/g) || []).map((t) => t.toLowerCase());
  let ascii硬 = false;
  if (ascii词.length) {
    for (const x of cand.values()) {
      const o = String(x.d.orig || '').toLowerCase();
      if (ascii词.some((t) => o.includes(t))) { ascii硬 = true; x.fused *= 1.35; }
    }
  }
  // 2026-11-04 类型先验：问题片回答「怎么做/为什么」，日子片回答「那天」。
  // 用 --类型=<json> 打开，--类型权= 调倍数（问题片 ×权、日子片 ×(2-权)，默认 1.06）。
  // 不改判定，只动先后；冒用就不降，不降就留。
  if (类型表) {
    const w = 类型权;
    for (const x of cand.values()) {
      const t = 类型表.get(x.d.id);
      if (t === '问题') x.fused *= w;
      else if (t === '日子') x.fused *= (2 - w);
    }
  }
  // 级联改写：榜首分低到「几乎没撞上」时，跑一次改写词补捞，把改写各路按 RRF 加进来再重排。
  // 只补漏、不动高分题——这是它敢默认关着也能留着的原因。
  if (改写开() && !不再改写) {
    const 预排 = [...cand.values()].sort((a, b) => b.fused - a.fused);
    if (!预排.length || 预排[0].fused < REWRITE_SEM) {
      const 词们 = await 改写词(query);
      for (const w of 词们) {
        const 路 = await recall(w, 10, true);
        for (const [i, x] of 路.entries()) {
          let 现 = cand.get(x.d.id);
          if (!现) { x.fused = 0; x.cos = x.cos ?? null; 现 = x; cand.set(x.d.id, 现); }
          现.fused = (现.fused || 0) + (1 / (RRF_K + i + 1)) / REWRITE_W;
        }
      }
    }
  }
  const out = [...cand.values()].sort((a, b) => b.fused - a.fused).slice(0, top);
  // 够不够线：拿库里最像的那一片的余弦当底气。低于线就是「翻不到」，别硬凑。
  let 最高余弦 = -1;
  for (const x of cand.values()) if (x.cos !== null && x.cos > 最高余弦) 最高余弦 = x.cos;
  out.最高余弦 = 最高余弦;
  const n首 = out[0] ? ((out[0].n实 ?? out[0].n) || 0) : 0;
  const n判 = ascii硬 ? n首 + 2 : n首;
  // 指代问句（2026-11-06 加）：问「我叫什么」「我是谁」，答案在片里写成「主人叫老周」——
  // 字面一个实词都撞不上（n判=0），余弦也只在 0.46–0.49 徘徊，于是库里明明有的信息被判「翻不到」。
  // 这类问句本来就只能靠语义，所以放一道：余弦到 0.40 就给「存疑」，不到才算翻不到。
  const 指代问 = /我叫|我是谁|我的名字|叫什么名字|你叫|你是谁|我住哪|我做什么/.test(query);
  out.够级 = (!USE_COS || 最高余弦 < 0) ? '够'
    : (指代问 && 最高余弦 >= 0.40 && 最高余弦 < COS_LINE ? '存疑'
    : (最高余弦 < COS_LINE && n判 < N_LINE ? '翻不到'
    : ((最高余弦 < COS_SOFT && n判 < N_SOFT) || (最高余弦 < COS_SOFT2 && n判 < N_SOFT2) ? '存疑' : '够')));
  out.够了 = out.够级 !== '翻不到';
  return out;
}

export { recall, docs, grams };

const argv = process.argv.slice(2);

// --自测覆盖（2026-11-05 加，2026-11-14 扩）：验「〔覆盖 #N〕指到的那一条还会不会交出去」。
// 为什么不接参数：它不该为测一行去动整库，样本就地造。
// 2026-11-14 改：老样本只有 3 条事实，天然落在 12 行窗口内——写入端「窗口序号」和读取端「全局序号」
// 在那一段里恰好重合，怎么跑都通过，等于假阴性。现在分两段：15 条（跨过窗口，验屏蔽的是第几条）＋3 条（守旧行为）。
if (process.argv.includes('--自测覆盖')) {
  let 错 = 0;
  const 断 = (名, 成立) => { console.log((成立 ? '  ✓ ' : '  ✗ ') + 名); if (!成立) 错++; };

  // 甲：15 条事实，第 15 行推翻第 4 条。屏蔽错的典型样子是「屏蔽掉开篇第 1 条」。
  const 行们 = [];
  for (let i = 1; i <= 15; i++) 行们.push(`- 17:${String(i).padStart(2, '0')} 第${i}件事：说法${i}`);
  行们[14] = '- 18:00 〔覆盖 #4〕第4件事改口了，按新说法算';
  const 甲 = ['## 事实', ...行们, '## 我当时怎么想', '记着看。'].join('\n');
  const 甲行 = 甲.split(/\r?\n/);
  const 甲表 = 覆盖屏蔽表(甲行);
  断('甲：认出 15 条事实行', 甲表.事实序.size === 15);
  断('甲：只屏蔽 1 条', 甲表.被覆盖.size === 1);
  断('甲：屏蔽的是全局第 4 条', 甲表.被覆盖.has(4));
  断('甲：开篇第 1 条没被牵连', !甲表.被覆盖.has(1));
  断('甲：最新那条没被牵连', !甲表.被覆盖.has(15));
  console.log('  甲摘录：' + 行级摘录(甲, '第4件事后来怎么说的'));

  // 乙：老样本，3 条事实、推翻第 1 条——这部分以前对，现在也得对。
  const 乙 = ['## 事实',
    '- 17:02 他抱回来一只灰白色的小猫',
    '- 17:02 他给小猫起名叫团子',
    '- 17:04 〔覆盖 #1〕团子送人了，屋里没有猫了',
    '## 我当时怎么想', '记着看。'].join('\n');
  const 一 = 行级摘录(乙, '团子那只猫后来怎么了');
  console.log('  乙摘录：' + 一);
  断('乙：被覆盖的开篇行没交出去', !一.includes('灰白色的小猫'));
  断('乙：最新状态交出去了', 一.includes('团子送人了'));

  console.log(错 ? `\n自测不通过：${错} 条` : '\n自测通过');
  process.exit(错 ? 1 : 0);
}
const only = (argv.find(a => a.startsWith('--only=')) || '').slice(7);
const topArg = Number((argv.find(a => a.startsWith('--top=')) || '').slice(6)) || 3;
// 问句来源（2026-11-02 加）：--问句=<原样> 优先，其次位置参数。
// 为什么要这条：问句是唯一从用户手里进来的字符串，以前靠位置参数拼进命令行，
// 一个问句写成 `--root` 就能改参数解析（实测换不了库，但会变成空查询）。
// 用 --问句= 之后，问句里的任何连字符、空格、引号都只是文本。
const 问句参 = (argv.find(a => a.startsWith('--问句=')) || '').slice(5);
const query = 问句参 !== '' ? 问句参 : argv.filter(a => !a.startsWith('--')).join(' ');

if (argv.includes('--概念')) {  // 概念关系题：答案单元是「一簇」，不是「一片」
  // 判据与裁定见 交接单：概念题先定位到 1–2 个主簇，把簇里几片合成一段答；跨簇靠线连。
  const r = await recall(query, 20);
  const by = new Map();
  for (const x of r) {
    const cs = docClusters.get(x.d.id);
    const c = (cs && cs.size) ? [...cs][0] : '（没主簇）';
    if (!by.has(c)) by.set(c, { 簇: c, 片: [], 最高: 0 });
    const g = by.get(c);
    g.最高 = Math.max(g.最高, x.fused ?? x.s ?? 0);
    g.片.push(x);
  }
  // 按「最高一片」排，不按片数累加——累加会让片多的大簇靠数量赢，
  // 概念题问的是「这题最贴哪一簇」，不是「哪簇贡献总量大」。
  const 候选 = 概念候选(query);
  const 簇们 = [...by.values()].sort((a, b) => {
    const ia = 候选.indexOf(a.簇), ib = 候选.indexOf(b.簇);
    if (ia < 0 && ib < 0) return b.最高 - a.最高;
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  });
  const 主 = 簇们[0];
  const 次 = 簇们[1] && 簇们[1].最高 >= 主.最高 * 0.7 ? 簇们[1] : null;
  // 2026-11-01 改：簇是答案单元，选片不能再只从前 20 片里挑。
  // 原来「取簇内前四」用的是前 20 片的 fused 分，导致没进前 20 的成员永远选不到——
  // 「关掉你算不算杀了你」主簇判对（自我），可相关的 0060 根本没进前 20，答案里就缺了它。
  // 现在簇内成员取**全簇**，按「问句的 2-gram 与这个概念词在片里命中多少」重排，前 20 的 fused 只作并列时的次序。
  const 词 = 命中词(query);
  const qg = grams(query);
  const 成员 = new Map();
  for (const [c, ids] of Object.entries(主簇分布)) {
    if (c === '（没主簇）') continue;
    成员.set(c, ids);
  }
  const 片文本 = new Map(docs.map(d => [d.id, { t: d.topic + ' ' + d.kw, o: d.orig || '', k: d.think || '' }]));
  const 簇内分 = (id) => {
    const x = 片文本.get(id);
    if (!x) return -1;
    const 全 = x.t + ' ' + x.o + ' ' + x.k;
    let s = 0;
    for (const g of qg) {
      if ((perKey.get(id) || new Set()).has(g)) s += 3 * idf(g);
      else if ((perBody.get(id) || new Set()).has(g)) s += idf(g);
    }
    for (const w of 词) if (w.length > 1 && 全.includes(w)) s += 4;
    return s;
  };
  const 取 = (g) => {
    const ids = 成员.get(g.簇) || g.片.map(x => x.d.id);
    const 已排 = new Map(g.片.map(x => [x.d.id, x]));
    return [...ids]
      .sort((a, b) => 簇内分(b) - 簇内分(a))
      .slice(0, 4)
      .map(id => 已排.get(id) || { d: docs.find(d => d.id === id) })
      .filter(o => o && o.d);
  };
  const 说 = (x) => {
    const 想 = (x.d.think || '').replace(/\s+/g, ' ').trim();
    const 事 = (x.d.orig || '').replace(/\s+/g, ' ').trim();
    return `· ${x.d.id}｜${x.d.topic}\n    ${想 ? '当时的想法：' + 想.slice(0, 130) : '原文：' + 事.slice(0, 130)}`;
  };
  const 行 = [`问：${query}`, `它落到「${主.簇}」这一簇（${主.片.length} 片相关）`, ''];
  for (const x of 取(主)) 行.push(说(x));
  if (次) {
    行.push('', `另一簇也沾边：「${次.簇}」`);
    for (const x of 取(次).slice(0, 2)) 行.push(说(x));
  }
  const 主ids = new Set(主.片.map(x => x.d.id));
  const 跨 = [];
  for (const [id, 邻] of 线图) {
    if (!主ids.has(id)) continue;
    for (const o of 邻) if (!主ids.has(o)) 跨.push(`${id}×${o}`);
  }
  if (跨.length) 行.push('', `跨簇还有线连着：${跨.slice(0, 5).join('、')}`);
  console.log(行.join('\n'));
  process.exit(0);
}

// 类型表（可选）：{"编号":"问题|日子"}，只做先后调整，不参与判定。
const 类型表 = (() => {
  const f = (argv.find((a) => a.startsWith('--类型=')) || '').slice(5);
  if (!f) return null;
  try {
    const arr = JSON.parse(readFileSync(f, 'utf8'));
    return new Map(arr.map((x) => [String(x.编号), String(x.类型)]));
  } catch (e) { console.error('类型文件读不了：' + e.message); return null; }
})();
const 类型权 = Number((argv.find((a) => a.startsWith('--类型权=')) || '').slice(6)) || (配置表.类型权 != null ? Number(配置表.类型权) : 1.06);

if (argv.includes('--bench')) {  // 基准集：真实问法 → 该命中的编号；--题库=<文件> 换一套题
  const benchPath = (argv.find(a => a.startsWith('--题库=')) || '').slice(5) || new URL('./召回基准.json', import.meta.url).pathname;
  const bench = JSON.parse(readFileSync(benchPath, 'utf8'));
  let h1 = 0, h3 = 0, 跳过 = 0;
  const rows = [];
  for (const b of bench) {
    // expect 可以是单个编号，也可以是一组编号（相关片集合：这几片都答得上这道题）。
    // 空数组 / "不适用" = 库里本来就没有能答的片（比如问「现在余额多少」）→ 不计分。
    const want = Array.isArray(b.expect) ? b.expect : (b.expect ? [b.expect] : []);
    if (!want.length) { 跳过++; continue; }
    const r = await recall(b.q, 5);
    const rank = r.findIndex(x => want.includes(x.d.id)) + 1;
    if (rank === 1) h1++;
    if (rank >= 1 && rank <= 3) h3++;
    rows.push({ q: b.q, expect: want.join('/'), rank, got: r.slice(0, 3).map(x => x.d.id), note: b.备注 || '' });
  }
  const N = rows.length;
  for (const x of rows) console.log(`${x.rank ? (x.rank <= 3 ? '✓' : '△') : '✗'} 期望 ${x.expect} 实际排名 ${x.rank || '未进前5'}  取到 ${x.got.join(',') || '-'}  「${x.q}」`);
  console.log(`\n命中 hit@1 = ${h1}/${N}（${(100 * h1 / N).toFixed(0)}%）  hit@3 = ${h3}/${N}（${(100 * h3 / N).toFixed(0)}%）  跳过（库外状态）${跳过} 题  权重=${USE_W ? '开' : '关'}  星图=${USE_STAR ? '开' : '关'}`);
} else if (argv.includes('--注入')) {  // 注入模式：给一句话，输出可直接塞进提示的记忆摘录（带簇名与同簇兄弟）
  const top = Number((argv.find(a => a.startsWith('--top=')) || '').slice(6)) || 3;
  const res = await recall(query, top);
  const 兄弟 = id => {
    const cs = [...(docClusters.get(id) || [])];
    const out = [];
    for (const c of cs) for (const x of (主簇分布[c] || [])) if (x !== id && out.length < 5) out.push(x);
    return { cs, out };
  };
  console.log('## 想起这几片（按相关度排）');
  if (res.够级 === '翻不到') {
    console.log(`（只记得片段：库里没有直接对得上的片，最像的这片余弦只有 ${res.最高余弦.toFixed(3)}，低于够线 ${COS_LINE.toFixed(2)}。）`);
    console.log('（下面这几片只是最接近的，不是答案。要真没有，就把这件事写成一片，或者换个说法再问。）\n');
  } else if (res.够级 === '存疑') {
    console.log(`（大概记得：最像的这片余弦 ${res.最高余弦.toFixed(3)}，字面也没对上几处。下面几片可能不对题。）\n`);
  } else {
    console.log('（比较确定：下面这几片对得上。）\n');
  if (res.无语义) console.log('（这一趟没走语义那路：' + (res.语义为何 || '库里还没算过向量') + '。下面是按字面和簇排的。）\n');
  }
  console.log('每片后头标着它归哪个簇、同簇还有哪几片。要是觉得某片跟同簇的兄弟不是一件事，可以提异议。\n');
  res.forEach((x, i) => {
    const { cs, out } = 兄弟(x.d.id);
    console.log(`[${i + 1}] ${x.d.id}｜簇=${cs.join('/') || '没归簇'}${改过(x.d.id)}`);
    console.log(`    ${x.d.topic}`);
    console.log(`    原文：${旧事标(x.d)}${x.d.orig.replace(/\s+/g, ' ').slice(0, 200)}`);
    if (x.d.think) console.log(`    我当时怎么想：${x.d.think.replace(/\s+/g, ' ').slice(0, 90)}`);
    if (out.length) console.log(`    同簇还有：${out.join(' ')}`);
    console.log('');
  });
  if (!res.length) console.log('（库里没有对得上的片）');
} else if (argv.includes('--缺口')) {  // 派生文件自检（2026-11-14，小砚 R1）：stdout 只出结构化，一句人话走 stderr
  const k = 派生缺口();
  console.log(JSON.stringify(k));
  console.error(`片 ${k.片数}｜缺向量 ${k.向量.缺.数}｜缺段 ${k.段向量.缺.数}｜缺主簇 ${k.主簇.缺.数}｜缺重量 ${k.重量.缺.数}｜缺星图 ${k.星图.缺.数}｜模型 ${k.模型.整片 || '-'}｜够线 ${k.模型.阈值.COS_LINE}`);
} else if (argv.includes('--json')) {  // 机器读模式：给展示层用，吐命中片与「我→簇→片」的路径
  const res = await recall(query, topArg);
  const 缺口 = 派生缺口();
  const 类表 = (() => {
    try { return new Map(JSON.parse(readFileSync(join(LIB, '_类型.json'), 'utf8')).map((x) => [String(x.编号), String(x.类型)])); } catch { return null; }
  })();
  const hits = res.map(x => {
    const cs = [...(docClusters.get(x.d.id) || [])];
    return { id: x.d.id, topic: x.d.topic, cluster: cs[0] || '（没主簇）', 类: (类表 && 类表.get(String(x.d.id))) || null, s: Number((x.s || 0).toFixed(2)), n: x.n || 0, n实: x.n实 || 0,
      // 2026-11-04 加：诊断用。排序看的是 fused（字面名次＋语义名次），s 只是字面原始分，
      // 光看 s 会误判「高分被压下去」；semRank/cos 能看出语义那一路排到哪了。只加输出，不动排序。
      fused: x.fused === undefined ? null : Number(x.fused.toFixed(6)),
      semRank: x.semRank || null,
      cos: x.cos === null || x.cos === undefined ? null : Number(x.cos.toFixed(3)),
      摘: (process.env.XY_LINES === '0' ? String(x.d.orig || '').replace(/\s+/g, ' ').slice(0, 180) : 行级摘录(x.d.orig, query)), 想: String(x.d.think || '').replace(/\s+/g, ' ').slice(0, 100),
      // 2026-11-05 抄进来：每条标是不是旧事（超 XY_旧事天 天）。三档措辞在顶层印象里，不逐片重复。
      旧: !!旧事标(x.d),
      // 2026-11-14（小砚 V4）：私密标记以前只写不读，现在带出来给拼提示的那一侧用。
      私密: !!x.d.私密 };
  });
  // 路径：从「我」出发，先到簇，再到片；同一簇只走一次，否则线会重复画。
  const path = [];
  const seen = new Set();
  for (const h of hits) {
    if (!seen.has('c:' + h.cluster)) { seen.add('c:' + h.cluster); path.push({ from: '我', to: h.cluster, kind: 'cluster' }); }
    path.push({ from: h.cluster, to: h.id, kind: 'piece' });
  }
  console.log(JSON.stringify({ q: query, hits, path, 够级: res.够级, 印象: 印象词(res.够级), 够了: res.够了, 最高余弦: Number((res.最高余弦 ?? -1).toFixed(3)), 够线: COS_LINE, 软线: COS_SOFT, 缺口, 无语义: !!res.无语义, 语义为何: res.语义为何 || '' }));
  // 记流水，和普通模式一样——展示层问的话也是真检索
  // 2026-11-14（小砚 R5）：流水里补「够级」与最高余弦，线上失误才有得回流成基准题
  // （只记命中片的话，分不清「答错了」和「库本来就没有」）。
  try {
    if (!不记流水) appendFileSync(join(LIB, '_检索记录.jsonl'),
      JSON.stringify({ t: new Date().toISOString(), q: query, ids: hits.map(h => h.id), clusters: [...new Set(hits.map(h => h.cluster))], via: VIA || '展示', 够级: res.够级, 余弦: Number((res.最高余弦 ?? -1).toFixed(3)) }) + '\n', 'utf8');
  } catch { /* 记不上不能挡住召回 */ }
} else if (only) {  // 自测模式：给编号，看它自己的分与排名
  const ids = only.split(',');
  for (const id of ids) {
    const doc = docs.find(d => d.id === id);
    if (!doc) continue;
    const q = doc.orig.replace(/\s+/g, ' ').slice(0, 60);
    const r = await recall(q, 5);
    const rank = r.findIndex(x => x.d.id === id) + 1;
    console.log(`\n[${id}] 自测 query=「${q}…」 排名=${rank || '未进前5'} 分=${(r.find(x => x.d.id === id) || {}).s?.toFixed(2) ?? '-'}`);
    for (const x of r) console.log(`   ${x.d.id} ${x.d.topic.slice(0, 26)} 簇=${[...(docClusters.get(x.d.id) || [])].join('/') || '无主簇'} 分=${x.s.toFixed(2)}${改过(x.d.id)}`);
  }
} else if (query) {
  const res = await recall(query, topArg);
  for (const x of res) {
    console.log(`\n${x.d.id}｜${x.d.topic}｜簇=${[...(docClusters.get(x.d.id) || [])].join('/') || '无主簇'}｜分=${x.s.toFixed(2)}｜重叠=${x.n}${改过(x.d.id)}`);
    console.log('  原文：' + 旧事标(x.d) + x.d.orig.replace(/\s+/g, ' ').slice(0, 220));
    console.log('  我当时怎么想：' + x.d.think.replace(/\s+/g, ' ').slice(0, 120));
  }
  // 记一笔检索流水：命中片 + 命中簇 + 问句（将来算遗忘降权、也算哪些线在起作用）
  // 2026-11-14（小砚 R5）：补「够级」与最高余弦，回流脚本才能挑出「翻不到却该记得」的题。
  try {
    const topClusters = [...(docClusters.get(res[0]?.d.id) || [])];
    if (!不记流水) appendFileSync(join(LIB, '_检索记录.jsonl'),
      JSON.stringify({ t: new Date().toISOString(), q: query, ids: res.map(x => x.d.id), clusters: topClusters, via: VIA || '命令行', 够级: res.够级, 余弦: Number((res.最高余弦 ?? -1).toFixed(3)) }) + '\n', 'utf8');
  } catch { /* 记不上不能挡住召回 */ }
}


