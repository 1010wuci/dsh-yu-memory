// 自动写片：取最近几轮原话 → 调模型写一片草稿 → 落到DRAFT_DIR等你我审。
// 不写库、不进索引，只产草稿；进不进真库由我裁决。
// 用法：node 写片.mjs [轮数=8] [--turns=N] [--dry]
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { 判草稿 } from './初筛规则.mjs';
import { 在白名单 } from './初筛白名单.mjs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const TOOLS = process.env.XY_TOOLS || fileURLToPath(new URL('.', import.meta.url));
const MODEL = 'deepseek-chat';

const args = process.argv.slice(2);
const turns = Number((args.find(a => a.startsWith('--turns=')) || '').slice(8))
  || Number(args.find(a => /^\d+$/.test(a)) || 8);
const dry = args.includes('--dry');
// 2026-11-01 加：给平台上的鱼用。不给参数就是我自己（真库 + 工具目录下的草稿夹）。
//   --库=<某个鱼的记忆库>      → 编号从那个库的最大号起算
//   --草稿=<某个鱼的家>/_写片草稿 → 草稿落到那条鱼自己家里
// 审查补的坑：`--库` 不写等号会被静默忽略、落回真库，这里直接报错拦下。
for (const k of ['--库', '--草稿']) {
  if (args.includes(k) && !args.some(a => a.startsWith(k + '='))) {
    console.error(`${k} 要写成 ${k}=<路径>，中间不能有空格；否则会静默落回我的真库`); process.exit(1);
  }
}
const 库根 = ((args.find(a => a.startsWith('--库=')) || '').slice(4)) || process.env.XY_MEMORY_ROOT || '';
if (!库根) { console.error('没给库根：用 --库=<路径>，或设环境变量 XY_MEMORY_ROOT'); process.exit(1); }
const DRAFT_DIR = ((args.find(a => a.startsWith('--草稿=')) || '').slice(5)) || process.env.XY_DRAFT || join(TOOLS, '_写片草稿');

let KEY = String(process.env.DEEPSEEK_API_KEY || '').trim();
if (!KEY) {
  try {
    const cred = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    KEY = (cred.match(/^\s*DEEPSEEK_API_KEY:\s*"?([^\r\n"]+)"?/m) || [, ''])[1].trim();
  } catch { KEY = ''; }
}
if (!KEY) { console.error('没读到 DEEPSEEK_API_KEY'); process.exit(1); }

// 1) 取最近几轮；带了 --从= 就从那一刻往后取（固化用，按进度写，不再反复只写最近）
const 从 = ((args.find(a => a.startsWith('--从=')) || '').slice(4));
const 取参 = [join(TOOLS, '取最近.mjs'), String(turns), '--json'];
if (从) 取参.push('--从=' + 从);
const r = spawnSync(process.execPath, 取参, { encoding: 'utf8' });
if (r.status !== 0) { console.error('取数失败：', r.stderr || r.stdout); process.exit(1); }
const rows = JSON.parse(r.stdout);
if (!rows.length) { console.error('没取到对话'); process.exit(1); }
const talk = rows.map(x => `${x.role}：${x.t}`).join('\n\n');

// 2) 写作规约：一片只写一件事；只写事、不写机制；不许编
const SYS = `你把一段对话写成记忆碎片。规则：
1 **默认整段对话只写一片**。只有确实互不相干的事才分开写（用单独一行 === 隔开），分也最多两片。
2 别按对话轮次切。一次问答不算一件事，一件事要有起因、我做了什么、结果是什么。
3 「一件事」指人和人之间发生了什么（他做了什么、说了什么、我因此怎么想），不是一条技术结论、一个参数或一段设计。
4 只写这段对话里真实发生的事和他真实说过的话，不补充、不推测、不编。
5 不写任何系统机制、参数、脚本名、目录、设计道理——那些不进记忆。
6 如果这段对话里没有值得单独留下的事，就只输出一行：不值得留。
每一片严格用这个格式：
## 标题
（一行，二十字以内，写这件事本身）
## 话题
（逗号分隔，三个到六个词）
## 关键词
（逗号分隔，六个到十二个词）
## 事实
（发生了什么，一百五十字以内）
## 我当时怎么想
（第一人称，一百五十字以内）`;

const USER = `这段对话：\n\n${talk}`;

if (dry) {
  console.log('--- 系统 ---\n' + SYS);
  console.log('--- 用户 ---\n' + USER);
  console.log(`（${rows.length} 条，约 ${Buffer.byteLength(USER, 'utf8')} 字节，未调模型）`);
  process.exit(0);
}

// 3) 调模型
const resp = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: USER }],
    max_tokens: 3000, temperature: 0.4,
  }),
});
const j = await resp.json();
if (!j.choices) { console.error('调用失败：', JSON.stringify(j).slice(0, 300)); process.exit(1); }
const out = (j.choices[0].message.content || '').trim();

// 4) 拆片、编号、落草稿（只出草稿，不进库）
const pieces = out.split(/^\s*={3,}\s*$/m).map(s => s.trim()).filter(Boolean);

// 建议编号：库里最大号 + 1 起，只写进草稿抬头，不占号、不登记
let maxNo = 0;
try {
  for (const f of readdirSync(join(库根, '碎片'))) {
    const m = f.match(/碎片-(\d{4})/);
    if (m) maxNo = Math.max(maxNo, Number(m[1]));
  }
} catch { /* 读不到就不给号 */ }

if (!existsSync(DRAFT_DIR)) mkdirSync(DRAFT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const u = j.usage || {};
// 峰时：UTC 01–04、06–10；谷时半价
const h = new Date().getUTCHours();
const peak = ((h >= 1 && h < 4) || (h >= 6 && h < 10));
const pin = peak ? 0.3 : 0.15, pout = peak ? 1.2 : 0.6;   // 美元/百万 token
const usd = ((u.prompt_tokens || 0) * pin + (u.completion_tokens || 0) * pout) / 1e6;

const paths = [];
pieces.forEach((p, i) => {
  const no = maxNo ? String(maxNo + 1 + i).padStart(4, '0') : '????';
  const head = `# 草稿（待审，建议编号 ${no}）\n\n- 取数：最近 ${rows.length} 条（${rows[0]?.ms ? new Date(rows[0].ms).toTimeString().slice(0, 5) : '?'} 起）\n- 模型：${MODEL}　输入 ${u.prompt_tokens} / 输出 ${u.completion_tokens} token　约 ${(usd * 7.1).toFixed(4)} 元（${peak ? '峰时' : '谷时'}）\n- 时间：${new Date().toLocaleString('zh-CN')}\n- 本篇：第 ${i + 1} / ${pieces.length} 片\n\n---\n\n`;
  const path = join(DRAFT_DIR, `草稿-${stamp}-${i + 1}.md`);
  writeFileSync(path, head + p + '\n', 'utf8');
  paths.push(`[${no}] ${path}`);
});

// 写完就地初筛：接口术语这类硬规则命中的直接挪进 _弃（不删），其余进待审。
const 弃目录 = join(DRAFT_DIR, '_弃');
mkdirSync(弃目录, { recursive: true });
const 弃 = []; const 留 = [];
for (const p2 of paths) {
  // paths 里带一段「[编号] 」前缀，取真路径再读写
  const 真路径 = p2.replace(/^\[[^\]]*\]\s*/, '');
  const 名字 = basename(真路径);
  const { 命中 } = 判草稿(readFileSync(真路径, 'utf8'));
  if (在白名单(名字)) { 留.push(名字); continue; }
  if (命中.length) {
    renameSync(真路径, join(弃目录, 名字));
    appendFileSync(join(弃目录, '弃因.md'), `- ${名字}｜${命中.join('')}｜自动初筛｜${new Date().toISOString().slice(0, 10)}\n`, 'utf8');
    弃.push(名字 + ' ' + 命中.join(''));
  } else 留.push(basename(p2));
}
if (弃.length) console.log('初筛判弃 ' + 弃.length + ' 片（已挪 _弃，可捞回）：\n' + 弃.join('\n'));
console.log(`出了 ${pieces.length} 片草稿（待审 ${留.length} 片，未进库）：`);
console.log(留.map(f => join(DRAFT_DIR, f)).join('\n'));
console.log(`\n用量：输入 ${u.prompt_tokens} / 输出 ${u.completion_tokens} token，约 ${(usd * 7.1).toFixed(4)} 元（${peak ? '峰时' : '谷时'}）`);
if (pieces.length === 1) console.log('只出了一片——这段对话里可能确实只有一件事，也可能它没拆开，审的时候留意。');
