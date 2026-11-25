// 分主簇：给每一片找一个「主簇」——一片只归一个，词只做辅助。
// 簇表统一在 簇表.mjs（2026-10-31 抽出来），分主簇／归档／召回三处都读它，不再各写一份。
// 判不出来就明说「没主簇」，不硬塞；判出并列最高分另记「含糊」。
// 只读库与索引；结果先写工具目录，验过再复制进库。
// 用法：node 分主簇.mjs [--root=库根] [--out=路径] [--json]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { SEEDS, 判主簇, 合并表, 读本地表 } from './簇表.mjs';

const args = process.argv.slice(2);
const _rEq = (args.find(a => a.startsWith('--root=')) || '').slice(7);
const _rSp = (() => { const i = args.indexOf('--root'); return i >= 0 ? (args[i + 1] || '') : ''; })();
const root = _rEq || _rSp || process.env.XY_MEMORY_ROOT || '';
if (!root) { console.error('× 缺 --root=<库根>（或设 XY_MEMORY_ROOT）'); process.exit(1); }
// 2026-11-01：多实例下不许共用一个产物文件——除了真库，产物默认落在该库自己的根里。
const outPath = (args.find(a => a.startsWith('--out=')) || '').slice(6)
  || join(root, '_主簇.json');
const wantJson = args.includes('--json');

const 索引 = join(root, '索引.md');
if (!existsSync(索引)) { console.error(`读不到 ${索引}`); process.exit(1); }

const 片 = [];
for (const line of readFileSync(索引, 'utf8').split('\n')) {
  const m = line.match(/^-\s*(\d{4})\s*｜([^｜]*)｜([^｜]*)｜/);
  if (!m) continue;
  片.push({ id: m[1], 话题: m[2].trim(), 关键词: m[3].split('、').map(s => s.trim()).filter(Boolean) });
}

// 2026-11-09：这条鱼自己加的簇和词也要算进去（`记忆/_簇表-本地.json`）。
// 不读它的话，鱼自己长出来的簇永远归不进任何片——开簇等于白开。
const 表 = 合并表(root);
const 本 = 读本地表(root);
const 宽词 = new Set();
for (const [, 词们] of Object.entries(本.加词 || {})) {
  if (Array.isArray(词们)) for (const w of 词们) if (w) 宽词.add(String(w).toLowerCase());
}
for (const c of 本.加簇) {
  if (Array.isArray(c.词)) for (const w of c.词) if (w) 宽词.add(String(w).toLowerCase());
}

// 第二遍用的字面比较：两字以上才算同一个词，单字只做包含
const 有效 = s => s && [...s].length >= 2;

const 结果 = [];
for (const p of 片) {
  const best = 判主簇(p.话题, p.关键词, 表, 宽词);
  // 并列检测：把种子按同规则打一次分，看有没有第二个同分
  let 并列 = false;
  if (best) {
    let 同分 = 0;
    for (const [main, syn] of 表) {
      let score = 0;
      for (const w of syn) {
        const s = String(w).toLowerCase();
        if ([...s].length >= 2 && p.话题.toLowerCase().includes(s)) score += 3;
        if (p.关键词.some(k => { const t = String(k).toLowerCase(); return t === s || t.includes(s); })) score += 1;
      }
      if (score === best.score) 同分++;
    }
    并列 = 同分 > 1;
  }
  结果.push({
    id: p.id,
    话题: p.话题,
    主簇: best ? best.main : '（没主簇）',
    分: best ? best.score : 0,
    并列,
  });
}

// 第二遍：判不出主簇的片，跟着「关键词最像的那一片」走（近邻继承）。
// 纯代码、不用模型；邻居不足两词共同就不动它，绝不硬塞。
const 关键词表 = new Map(片.map(p => [p.id, p.关键词.map(k => k.toLowerCase())]));
const 有主的 = 结果.filter(r => r.主簇 !== '（没主簇）');
for (const r of 结果) {
  if (r.主簇 !== '（没主簇）') continue;
  const 我的 = 关键词表.get(r.id) || [];
  let 最像 = null, 最多 = 0;
  for (const q of 有主的) {
    const 他的 = 关键词表.get(q.id) || [];
    let 同 = 0;
    for (const k of 我的) if (他的.some(x => x === k || (有效(x) && x.includes(k)) || (有效(k) && k.includes(x)))) 同++;
    if (同 > 最多) { 最多 = 同; 最像 = q; }
  }
  if (最像 && 最多 >= 2) {
    r.主簇 = 最像.主簇;
    r.来源 = '跟随';
    r.跟谁 = 最像.id;
    r.共存词 = 最多;
  }
}

// 第三遍：人工裁定覆盖。规则判不出 / 最高分撞车的片，最终归哪个簇由我定，
// 表在库根 `_主簇覆盖.json`（模型只出候选，这里才是结论）。没有这份表就跳过。
let 覆盖 = {};
try { 覆盖 = JSON.parse(readFileSync(join(root, '_主簇覆盖.json'), 'utf8')).覆盖 || {}; } catch {}
let 应用了几条 = 0;
let 按编号命中的旧键 = 0;
for (const r of 结果) {
  // 2026-10-31 起按「标题」做键：编号会复用，片删了又占同一个号，旧裁定就串到新片上（发生过一次）。
  // 旧编号键仍认，但会计数报出来，提示该迁了。
  const o = 覆盖[r.话题] || 覆盖[r.id];
  if (!o || !o.簇) continue;
  if (!覆盖[r.话题]) 按编号命中的旧键++;
  if (r.主簇 !== o.簇) 应用了几条++;
  r.原判 = r.主簇;
  r.主簇 = o.簇;
  r.来源 = o.来源 || '人工裁定';
}
if (按编号命中的旧键) console.log(`[提示] 有 ${按编号命中的旧键} 条裁定还是按编号命中的，建议跑 改覆盖表键.mjs --写 迁成标题键`);

const 分布 = new Map();
for (const r of 结果) {
  if (!分布.has(r.主簇)) 分布.set(r.主簇, []);
  分布.get(r.主簇).push(r.id);
}
const 排序 = [...分布.entries()].sort((a, b) => b[1].length - a[1].length);
const 没主簇 = 结果.filter(r => r.主簇 === '（没主簇）').map(r => r.id);
// 撞车 = 规则层面两个簇同分。裁过的（覆盖表里有）就不算挂着——挂着的是「还没人定」的。
const 撞车全部 = 结果.filter(r => r.并列).map(r => r.id);
const 并列的 = 结果.filter(r => r.并列 && !覆盖[r.话题]).map(r => r.id);

const 载荷 = {
  builtAt: new Date().toISOString(),
  规则: '簇表见 簇表.mjs；话题命中 3 分、关键词命中 1 分，取最高分，一片只取一个；0 分记「没主簇」，并列另记',
  种子簇数: 表.length,
  片数: 结果.length,
  分布: Object.fromEntries(排序),
  短候选: { 没主簇, 并列: 并列的, 撞车全部 },
  明细: 结果,
};

writeFileSync(outPath, JSON.stringify(载荷, null, 1), 'utf8');
// 2026-11-01 抽检抓到的真 bug：真库的产物原来只写工具目录，库根那份没人刷新，
// 一路停在 163 片（库已经 170），而 抽检.mjs 读的是库根那份 → 新片显示「无主簇」。
// 现在真库双写：工具目录（召回/星图用）+ 库根（抽检、平台侧读）。别处失败不挡主产物。
let 库根副本 = '';
if (normalize(outPath) !== normalize(join(root, '_主簇.json'))) {
  try {
    const 库根路径 = join(root, '_主簇.json');
    writeFileSync(库根路径, JSON.stringify(载荷, null, 1), 'utf8');
    库根副本 = 库根路径;
  } catch (e) {
    console.error(`（库根副本写失败，不影响主产物：${e && e.message}）`);
  }
}

if (wantJson) {
  console.log(JSON.stringify({ 片数: 载荷.片数, 种子簇数: 表.length, 分布: 载荷.分布, 没主簇, 并列: 并列的 }, null, 2));
} else {
  console.log(`片 ${载荷.片数}，主簇 ${排序.filter(([k]) => k !== '（没主簇）').length} 个（种子簇 ${表.length}）`);
  for (const [k, ids] of 排序) console.log(`  ${k.padEnd(6, '　')} ${String(ids.length).padStart(3)}  ${ids.slice(0, 12).join(' ')}${ids.length > 12 ? ' …' : ''}`);
  console.log(`\n没主簇：${没主簇.length} 片 ${没主簇.join(' ') || '（无）'}`);
  console.log(`并列（撞车且还没人定）：${并列的.length} 片 ${并列的.join(' ') || '（无）'}`);
  console.log(`撞车但有裁定：${撞车全部.length - 并列的.length} 片（在覆盖表里）`);
  console.log(`→ ${outPath}`);
}
