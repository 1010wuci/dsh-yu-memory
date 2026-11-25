// 重建索引.mjs —— 按碎片正文重建 索引.md。
// 规矩（2026-11-02 改）：**已有片一律沿用旧索引里的标题/关键词/刻痕，只重算簇**。
// 为什么：重建是为了"把新片补进来"，不是为了重写别人的字；旧索引里的标题是当初定的，
// 靠正文重新猜（尤其正文里话题/关键词两段长得像）会把标题猜成关键词，
// 覆盖表按标题做键，标题一变 → 整片认不出裁定 → 变「没主簇」（测试鱼 y0006 57 片踩过）。
// 用法：node 重建索引.mjs --root=<库根> [--写]   默认只报数，--写 才落盘并备份旧索引。
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { 定主簇 } from './簇表.mjs';

const 写 = process.argv.includes('--写');
let root = '';
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--root=')) root = a.slice(7);
  else if (a === '--root' && process.argv[i + 1]) { root = process.argv[i + 1]; i++; }
}
if (!root) { console.error('× 缺 --root=<库根>'); process.exit(1); }

const 碎片目录 = join(root, '碎片');
const 索引路径 = join(root, '索引.md');
if (!existsSync(碎片目录)) { console.error(`× 读不到 ${碎片目录}`); process.exit(1); }

const 字段 = (txt, 名) => {
  const m = txt.match(new RegExp(`^-\\s*\\*{0,2}${名}\\*{0,2}\\s*[：:]\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : '';
};

// 旧索引：编号 → {标题, 关键, 刻痕}
const 旧 = new Map();
if (existsSync(索引路径)) {
  for (const line of readFileSync(索引路径, 'utf8').split(/\r?\n/)) {
    const c = line.split('｜');
    if (c.length < 5) continue;
    const id = (c[0].match(/^-\s*(\d{4})/) || [])[1];
    if (!id) continue;
    旧.set(id, { 标题: c[1].trim(), 关键: c[2].trim(), 刻痕: c[3].trim() });
  }
}

// 库根已经有 _主簇.json 的话，拿它给「规则判不出」的片兜底。
// 分主簇里有一遍「近邻继承」（关键词最像的片，共同词≥2 就跟着走），这里不重复实现，
// 免得两处逻辑各长各的；索引只是目录，簇的权威在 _主簇.json。
const 主簇表 = new Map();
try {
  const j = JSON.parse(readFileSync(join(root, '_主簇.json'), 'utf8'));
  for (const x of j.明细 || []) if (x.主簇) 主簇表.set(String(x.id), x.主簇);
} catch { /* 没这份文件就纯按规则 */ }

const 套 = (s) => String(s).replace(/\s+/g, ' ').trim();

const 条 = [];
const 坏 = [];

for (const 名 of readdirSync(碎片目录).filter((n) => n.endsWith('.md'))) {
  const txt = readFileSync(join(碎片目录, 名), 'utf8');
  // 编号（2026-11-14 改，小砚 V7-C）：优先取片正文里的「- 编号：」，可那是自由文本，谁都能往里写。
  // 正文写 `- 编号：0001" onmouseover=...` 就原样进索引.md，再被网关下发给 index.html 的 data-号 属性——
  // 属性注入那道「只挡不引号」的护栏正好被这条绕过。只认 4 位数字，不合格回退文件名。
  const 正文编号 = 字段(txt, '编号');
  if (正文编号 && !/^\d{4}$/.test(正文编号)) 坏.push(名 + '：正文编号不合规（' + 正文编号.slice(0, 20) + '），已回退文件名');
  const 编号 = /^\d{4}$/.test(正文编号) ? 正文编号 : (名.match(/碎片-(\d{4})/) || [])[1];
  if (!编号) { 坏.push(名 + '：没有编号'); continue; }

  const 话题 = 字段(txt, '话题');
  // 分隔符必须是「、」：分主簇按「、」切关键词，换成「，」会把整串当一个词 → 命中不了 → 没主簇
  const 词 = 字段(txt, '关键词').split(/[、,，]/).map((s) => s.trim()).filter(Boolean);

  const 前 = 旧.get(编号);
  // 已有片：沿用旧行的标题/关键词/刻痕；新片才从正文猜，猜不到再用文件名
  const 标题 = 前?.标题 || 话题 || (txt.match(/^#\s*\d{4}｜(.+)$/m) || [])[1] ||
    (名.match(/^碎片-\d{4}-(.+)\.md$/) || [])[1] || 编号;
  const 关键 = 前?.关键 || 词.join('、');
  const 刻痕 = 前?.刻痕 || 字段(txt, '刻痕') || '（未定）';

  let 簇 = '';
  try {
    // 判簇也用旧索引里的标题与关键词：有些碎片正文里的话题/关键词两段缺字或写串了，
    // 正文不可靠，索引才是当初定下来的那一份（2026-11-02 真库该下 55 片没主簇的坑）。
    const 判题 = 前?.标题 || 话题;
    const 判词 = 前?.关键 ? 前.关键.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : 词;
    const r = 定主簇(root, 编号, 判题, 判词);
    簇 = (r && (r.main || r.簇 || r.名)) || '（没主簇）';
    if (簇 === '（没主簇）' && 主簇表.has(编号)) 簇 = 主簇表.get(编号);
  } catch { 簇 = '（没主簇）'; }

  条.push({ 编号, 标题: 套(标题), 关键: 套(关键), 刻痕: 套(刻痕), 路径: `碎片\\${名}`, 簇 });
}

条.sort((a, b) => a.编号.localeCompare(b.编号));
const 行 = 条.map((r) => `- ${r.编号}｜${r.标题}｜${r.关键}｜${r.刻痕}｜${r.路径}｜${r.簇}`);

const 分布 = new Map();
for (const r of 条) 分布.set(r.簇, (分布.get(通用(r.簇)) || 0) + 1);
function 通用(s) { return s; }
const 排序 = [...分布.entries()].sort((a, b) => b[1] - a[1]);

console.log(`扫到 ${条.length} 片`);
if (坏.length) console.log('坏行：', 坏.join('；'));
console.log('簇分布：' + 排序.map(([k, v]) => `${k}${v}`).join('　'));

if (写) {
  if (existsSync(索引路径)) {
    const 备 = 索引路径 + '.bak-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    copyFileSync(索引路径, 备);
    console.log('旧索引备份到：' + 备);
  }
  writeFileSync(索引路径, 行.join('\n') + '\n', 'utf8');
  console.log('已写 ' + 索引路径 + `（${行.length} 行）`);
} else {
  console.log('（没写盘，加 --写 才落）');
}
