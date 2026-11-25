// 算星图：给每一片算「位置」和「亮度」两个数，落盘，不改库、不进检索。
// 用法：node 算星图.mjs
// 输入：<库根>/_主簇.json（分主簇.mjs 生成）、<库根>/碎片/*.md、<库根>/_检索记录.jsonl（可选）
// 输出：<库根>/_星图.json（机器用）、<库根>/星图.md（人看，按亮度排序前 30）
//
// 规则（2026-10-31 定，改规则要在这里记一笔）：
//   时间分 t ：正文里第一个 yyyy-mm-dd；取不到就用文件 mtime。最新=1，最老=0。
//   重要性 imp：由人定（_重要度.json，1–5 星）。公式（0.2 访问 + 0.45 想法 + 0.35 长度）只在没打星时兜底。
//   位置 r ：1 − (0.25·t + 0.75·imp)。0 是中心，1 是最外圈。
//   角度  a ：按它最重的那一簇分配扇区，同簇的片挤在一起；簇内按编号散开。
//   亮度  b ：0.25·t + 0.75·imp（暂时和 1−r 同源；分开存，以后好分叉）。
//   常亮  lit：挂在种子簇上的片先算常亮候选（第一圈），不代表最终定案。
//   教训  ：关键词带「教训」或「错题」的片不吃时间分、不进衰减，固定在事件层内沿 0.60，标 lesson。
//           理由：星图管「想不想得起来」，教训管「动手前必过」——会淡的东西当不了闸门。
//   访问分：一次召回算 1，之后每 30 天折半（HALF_LIFE_DAYS）。
//   上限  ：事件的 r 最多到所挂簇身后 0.05（CLUSTER_MARGIN），不许比簇更靠外。
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 库根目录：--root=<路径> 或 --root <路径> > 环境变量 XY_ROOT > 默认真库。
// 2026-11-01：以前只认空格写法，写成 --root=xxx 会被静默忽略、算到真库上并覆盖真库产物。
(function () {
  const 参 = process.argv.slice(2);
  let 根 = '';
  const 等式 = 参.find((a) => a.startsWith('--root='));
  if (等式) { 根 = 等式.slice(7); process.argv = process.argv.filter((a) => a !== 等式); }
  else {
    const i = process.argv.indexOf('--root');
    if (i > 1 && process.argv[i + 1]) { 根 = process.argv[i + 1]; process.argv.splice(i, 2); }
  }
  if (根) process.env.XY_ROOT = 根;
})();
const LIB = process.env.XY_ROOT || process.env.XY_MEMORY_ROOT || '';
if (!LIB) { console.error('× 缺库根：--root=<路径>，或设 XY_MEMORY_ROOT'); process.exit(1); }
console.log(`库根：${LIB}`);

const DIR = join(LIB, '碎片');
const LOG = join(LIB, '_检索记录.jsonl');
const OUT_JSON = join(LIB, '_星图.json');
const OUT_MD = join(LIB, '星图.md');

// 2026-10-31 改：簇按「主簇」算（一片只归一个，`分主簇.mjs` 生成），不再用关键词簇。
// 关键词簇（_词簇.json）只用来收词，570 个簇里 524 个只挂一片，拿它算位置等于把噪声当地形。
// 回退：换回备份 算星图.mjs.bak-20261031-改主簇前。
const 主簇分布 = JSON.parse(readFileSync(join(LIB, '_主簇.json'), 'utf8')).分布;

// 重要性由人定（2026-10-31 验位置后定）：_重要度.json 里 1–5 星，公式只当缺省。
// 为什么不再用公式：扫了 12 组权重，跟盲评的相关系数全在 ±0.12 内，说明「重要」不是表面特征能算的。
let 重要度 = {};
try { 重要度 = JSON.parse(readFileSync(join(LIB, '_重要度.json'), 'utf8')).分 || {}; } catch {}
const clusters = Object.entries(主簇分布).map(([main, docs]) => ({
  main,
  docs,
  // 常亮只给「片数 ≥5 的大簇」和教训簇；小簇和「没主簇」都放外圈，别把边缘也点亮
  seeded: main === '教训' || (main !== '（没主簇）' && docs.length >= 5),
}));
const seeded = new Map(clusters.filter(c => c.seeded).map(c => [c.main, c]));

// 访问分带半衰期：一次召回算 1 分，之后每 30 天折一半（2026-10-31 定）。
// 不加这个，同一片被查得越多越往中心漂——那是「被查得多」，不是「重要」。
const HALF_LIFE_DAYS = 30;
const visits = new Map();
if (existsSync(LOG)) {
  const nowMs = Date.now();
  for (const line of readFileSync(LOG, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const ageDays = rec.t ? (nowMs - new Date(rec.t).getTime()) / 86400000 : 0;
      const w = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
      for (const id of rec.ids || []) visits.set(id, (visits.get(id) || 0) + w);
    } catch { /* 坏行跳过，不猜 */ }
  }
}

// 片 → 挂的簇
const docClusters = new Map(); // docCode -> [cluster]
for (const c of clusters) {
  for (const d of c.docs) {
    if (!docClusters.has(d)) docClusters.set(d, []);
    docClusters.get(d).push(c);
  }
}

// 簇分：这一片挂的簇，按各自连片数取对数再平均，最后全体归一化
const raw = [];
const files = readdirSync(DIR).filter(f => f.endsWith('.md'));
for (const f of files) {
  const full = join(DIR, f);
  const txt = readFileSync(full, 'utf8');
  const st = statSync(full);
  // 编号取文件名（2026-11-14 修，R1 的缺口自检逮到的）：原来拿正文里第一个 4 位数字，
  // 0158、0172 两片的正文开头写着日期 2026-11-01，于是两片都被算成「2026」——
  // 星图里合成了一个节点、簇为空、教训标记也丢了，召回那边按编号找亮度时这两片永远「缺星图」。
  // 文件名里的 碎片-四位数字- 才是真编号，正文只当兜底。
  const code = (f.match(/^碎片-(\d{4})/) || [])[1] || (txt.match(/\b(\d{4})\b/) || [])[1] || f.slice(0, 4);

  // 时间：正文日期优先，没有用 mtime
  const dm = txt.match(/(20\d{2})-(\d{2})-(\d{2})/);
  const dateSrc = dm ? '正文' : 'mtime';
  const date = dm ? new Date(`${dm[1]}-${dm[2]}-${dm[3]}`) : st.mtime;

  const cs = docClusters.get(code) || [];
  const clusterScore = cs.length
    ? cs.map(c => Math.log(1 + c.docs.length)).reduce((s, v) => s + v, 0) / cs.length
    : 0;

  // 教训片：关键词里带「教训」或「错题」——不吃时间分、不衰减（2026-10-31 定）
  // 2026-11-14 补：0158、0172 两片没用「- 关键词：」那行，写的是「## 话题」一节，
  // 于是关键词取空、教训标记判成 false，白丢两条不衰减的规矩。这里加一层兜底。
  const kwLine = (txt.match(/^- 关键词：(.*)$/m) || [])[1]
    || (txt.match(/^##\s*话题\s*\n+([^\n]*)$/m) || [])[1]
    || '';
  const isLesson = kwLine.includes('教训') || kwLine.includes('错题');

  // 想法分 / 长度分：给「单片重要性」当证据用（2026-10-31 验位置后新增）
  const 想法段 = (txt.match(/##\s*我当时怎么想\s*\n([\s\S]*?)(?=\n##\s|$)/) || [])[1] || '';
  const 想法字 = 想法段.replace(/\s/g, '').length;
  const 正文字 = txt.replace(/\s/g, '').length;

  raw.push({ code, file: f, date, dateSrc, clusters: cs.map(c => c.main), seededHit: cs.some(c => c.seeded), clusterScore, visitCnt: visits.get(code) || 0, isLesson, 想法字, 正文字 });
}

// 归一化
const days = raw.map(r => r.date.getTime());
const tMin = Math.min(...days), tMax = Math.max(...days);
const span = tMax - tMin || 1;
const cMax = Math.max(...raw.map(r => r.clusterScore), 0.0001);
const vMax = Math.max(...raw.map(r => r.visitCnt), 1);

// 主簇扇区分配：按簇的连片数从重到轻
const mainOrder = clusters.map(c => c.main);
// 角度不能按数组下标分扇区——大簇都排在前面，事件就全挤在同一侧（2026-10-31 修）。
// 改成黄金比散开：簇名定角度，稳定、均匀，加新片也不重排别人的位置。
const GOLDEN = 0.6180339887498949;
const clusterAngle = new Map();
clusters.forEach((c, i) => clusterAngle.set(c.main, ((i * GOLDEN) % 1) * Math.PI * 2));
const ANG = name => clusterAngle.get(name) ?? 0;

const rawNodes = raw.map(r => {
  const t = r.isLesson ? 0 : (r.date.getTime() - tMin) / span;
  const visit = r.visitCnt / vMax; // 访问分（已带半衰期），归一化
  const cs = r.clusterScore / cMax;
  // 2026-10-31 验位置后改：不再用「簇里有几片」当重要性——它把大簇压进内圈、把「关系」「隐私」这种小簇推到外圈，
  // 与小玉自己认的重要程度对不上（20 片盲测 ρ=-0.277）。改成四样证据：
  //   访问分 0.20（被真用到）/ 想法分 0.45（有没有「我当时怎么想」，写得多不多）/ 长度分 0.35 / 教训直接置顶。
  const 想法分 = Math.min(1, r.想法字 / 120);
  const 长度分 = Math.min(1, r.正文字 / 700);
  const 星 = 重要度[r.code];
  const imp = 星 ? 星 / 5 : (r.isLesson ? 1 : 0.20 * visit + 0.45 * 想法分 + 0.35 * 长度分);

  // 主簇＝它挂的簇里连片最多的那个
  const primary = r.clusters.slice().sort((a, b) => {
    const ca = clusters.find(c => c.main === a), cb = clusters.find(c => c.main === b);
    return (cb ? cb.docs.length : 0) - (ca ? ca.docs.length : 0);
  })[0] || '无簇';
  const baseAng = ANG(primary);
  const docsOf = (clusters.find(c => c.main === primary) || { docs: [] }).docs.length;
  const spread = Math.min(1.1, 0.35 + 0.06 * docsOf);            // 弧度：一个簇占多宽的弧
  const jitter = (((parseInt(r.code, 10) * 37) % 100) / 100 - 0.5) * spread;
  const angle = baseAng + jitter;

  return {
    code: r.code,
    file: r.file,
    date: r.date.toISOString().slice(0, 10),
    dateSrc: r.dateSrc,
    clusters: r.clusters,
    primary,
    litVia: !!seeded.get(primary), // 挂在常亮簇下——只是标记，不代表这片本身常亮
    lesson: r.isLesson, // 教训片：不衰减、固定在事件层内沿
    t: +t.toFixed(4),
    visit: +visit.toFixed(4),
    visitScore: +r.visitCnt.toFixed(3),
    imp: +imp.toFixed(4),
    angle: +angle.toFixed(4),
    rRaw: 1 - (0.25 * t + 0.75 * imp),
  };
});

// 分层：以「我」为圆心，种子簇 → 普通簇 → 事件 三层同心，边界不越（2026-10-31 定）。
// 每层里按重要性从内到外排：重要的贴内沿，次要的贴外沿。
// 簇的半径由簇自己的重要性算，不由它下面的片平均——否则层会塌成一圈。
const LAYERS = {
  seed: [0.10, 0.30],   // 种子簇：常亮那一圈
  clus: [0.30, 0.60],   // 普通簇
  evt:  [0.60, 1.00],   // 事件（片）：最外一圈，不许越进簇层
};
const inLayer = (band, imp) => band[0] + (band[1] - band[0]) * (1 - Math.min(1, Math.max(0, imp)));

// 簇的重要性：连片数 + 它下面的片被召回的分
const clusterVisit = new Map();
for (const n of rawNodes) {
  for (const c of n.clusters) clusterVisit.set(c, (clusterVisit.get(c) || 0) + n.visitScore);
}
const cDocsMax = Math.max(...clusters.map(c => Math.log(1 + c.docs.length)), 0.0001);
const cVisitMax = Math.max(...[...clusterVisit.values()], 1);
const clusterNodes = clusters.map(c => {
  // 教训簇常亮：不按连片数和访问分算，直接顶在最内沿（2026-10-31 定）
  const isLessonCluster = c.main === '教训';
  const cimp = isLessonCluster ? 1
             : 0.6 * (Math.log(1 + c.docs.length) / cDocsMax)
             + 0.4 * ((clusterVisit.get(c.main) || 0) / cVisitMax);
  const r = inLayer(c.seeded ? LAYERS.seed : LAYERS.clus, cimp);
  const idx = Math.max(0, mainOrder.indexOf(c.main));
  return {
    main: c.main,
    seeded: c.seeded,
    lesson: isLessonCluster,
    docs: c.docs.length,
    cimp: +cimp.toFixed(4),
    r: +r.toFixed(4),
    angle: +ANG(c.main).toFixed(4),
  };
});

// 事件层要真的用满 0.60–1.00：光把 imp 扔进 inLayer 没用，imp 实际只占 0.3–0.8，
// 13 片挤在 0.68–0.86 那一小段里，梯度全浪费（2026-10-31 验位置发现）。
// 改成：非教训片先做全库 min-max 归一，再摊到整条带；教训片固定内沿 0.60，不参与归一。
const 非教训 = rawNodes.filter(n => !n.isLesson).map(n => n.imp);
const impMin = Math.min(...非教训), impMax = Math.max(...非教训);
const impSpan = (impMax - impMin) || 1;
const 归一imp = n => n.isLesson ? 1 : (n.imp - impMin) / impSpan;

const nodes = rawNodes.map(n => {
  // 事件层：0.60–0.98 按星位排，同星之内再用时间拉开一点（0.02），免得五颗星的片叠成一条线。
  const pos = 0.60 + 0.38 * (1 - 归一imp(n)) + 0.02 * (1 - n.t);
  const owner = clusterNodes.find(c => c.main === n.primary);
  return {
    code: n.code,
    file: n.file,
    date: n.date,
    dateSrc: n.dateSrc,
    clusters: n.clusters,
    primary: n.primary,
    litVia: n.litVia,
    lesson: n.lesson,
    t: n.t,
    visit: n.visit,
    visitScore: n.visitScore,
    imp: n.imp,
    r: +pos.toFixed(4),
    angle: n.angle,
    b: +(1 - pos).toFixed(4),
    // 越界检查：事件如果掉进簇层就是层错了，亮出来，不藏
    layerOK: owner ? pos >= owner.r : pos >= LAYERS.evt[0],
  };
});
const badLayer = nodes.filter(n => !n.layerOK).length;

nodes.sort((a, b) => a.r - b.r);

const builtAt = new Date().toISOString();

// 线（`_线.jsonl`，人工裁定的显式关联）：只带两端都在图上的。
// 星图只负责把它画出来，位置与亮度仍按「时间+人定星」算，线不参与。
let edges = [];
try {
  const known = new Set(nodes.map(n => n.code));
  for (const l of readFileSync(join(LIB, '_线.jsonl'), 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue;
    const o = JSON.parse(l);
    if (known.has(o.a) && known.has(o.b)) edges.push({ a: o.a, b: o.b, 类: o.类, 因: o.因 });
  }
} catch { /* 没有线文件就只画点 */ }

writeFileSync(OUT_JSON, JSON.stringify({ builtAt, rule: '25%时间+75%重要性(人定1-5星;未打星时按0.2访问+0.45想法+0.35长度兜底);三层同心:种子簇0.10-0.30/簇0.30-0.60/事件0.60-1.00;教训片不吃时间分固定0.60,教训簇常亮0.10;线只画不参与位置', halfLifeDays: HALF_LIFE_DAYS, layers: LAYERS, clusters: clusterNodes, nodes, edges }, null, 1), 'utf8');

const lines = [];
lines.push('# 星图（自动生成，勿手改）');
lines.push('');
lines.push('由 `算星图.mjs` 生成。只落盘，不进检索，不影响库。');
lines.push('位置 r：0 是圆心（我），往外依次是 种子簇 0.10–0.30、簇 0.30–0.60、事件 0.60–1.00。');
lines.push('访问分：一次召回算 1 分，之后每 30 天折一半——被查得多不等于重要。');
lines.push('层是硬的：事件掉进簇层算错，标「越界」。');
lines.push('常亮只定在簇上（种子簇），片不单独常亮——「挂常亮簇」只是它挨着哪一圈。');
lines.push('教训片不吃时间分、不衰减，固定贴在事件层内沿 0.60——星图管想不想得起来，教训管动手前过不过。');
lines.push('');
const fromText = nodes.filter(n => n.dateSrc === '正文').length;
const hitN = nodes.filter(n => n.visitScore > 0).length;
lines.push(`生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}　共 ${nodes.length} 片／${clusterNodes.length} 簇　日期取自正文 ${fromText} 片／取自 mtime ${nodes.length - fromText} 片`);
lines.push(`被召回过至少一次：${hitN} 片；越界：${badLayer} 片。（检索流水共 ${existsSync(LOG) ? readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).length : 0} 条，访问分偏薄，参考价值有限。）`);
lines.push(`教训片：${nodes.filter(n => n.lesson).length} 片（标 lesson，不衰减，固定在 r=0.60）。`);
lines.push('');
lines.push('## 簇（内两圈）');
lines.push('');
lines.push('| 主簇 | 种子 | 连片 | r |');
lines.push('|---|---|---|---|');
for (const c of clusterNodes.slice().sort((a, b) => a.r - b.r).slice(0, 12)) {
  lines.push(`| ${c.main} | ${c.seeded ? '是' : ''} | ${c.docs} | ${c.r} |`);
}
lines.push('');
lines.push('## 事件（最外圈，按 r 排前 30）');
lines.push('');
lines.push('| 片 | 日期 | 主簇 | r | 亮度 | 召回分 | 挂常亮簇 | 越界 |');
lines.push('|---|---|---|---|---|---|---|---|');
for (const n of nodes.slice(0, 30)) {
  lines.push(`| ${n.code} | ${n.date} | ${n.primary} | ${n.r} | ${n.b} | ${n.visitScore} | ${n.litVia ? '是' : ''} | ${n.layerOK ? '' : '越界'} |`);
}
writeFileSync(OUT_MD, lines.join('\n') + '\n', 'utf8');

const top = nodes.slice(0, 8).map(n => `${n.code}(${n.r})`).join(' ');
const bottom = nodes.slice(-8).map(n => `${n.code}(${n.r})`).join(' ');
console.log(`片数：${nodes.length}　日期源：正文 ${fromText} / mtime ${nodes.length - fromText}`);
console.log('最靠中心：' + top);
console.log('最靠边缘：' + bottom);
console.log('被召回过：' + hitN + ' 片　越界（事件掉进簇层）：' + badLayer + ' 片　教训片：' + nodes.filter(n => n.lesson).length + ' 片');
console.log('产物：' + OUT_JSON);
console.log('产物：' + OUT_MD);
