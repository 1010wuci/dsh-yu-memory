// 取最近几轮原话：从 DSH 自己的会话文件里捞「他说的」和「我说的」，给写片用。
// 会话文件是 zstd 多帧拼接（一帧一条记录），Node 的单次解压只认第一帧，所以按魔数切帧逐段解。
// 只读，不动库、不写会话。
// 用法：node 取最近.mjs [轮数=6] [--session=会话目录或文件] [--out=路径] [--json]
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAGIC = [0x28, 0xB5, 0x2F, 0xFD];
const SESS_ROOT = join(homedir(), '.dsh', 'sessions');

const args = process.argv.slice(2);
const n = Number((args.find(a => /^\d+$/.test(a))) || 6);
const wantJson = args.includes('--json');
const given = (args.find(a => a.startsWith('--session=')) || '').slice(10);
const outPath = (args.find(a => a.startsWith('--out=')) || '').slice(6);
// 2026-11-09 加：--从=毫秒时间戳 → 只取这一刻之后的轮次。
// 为什么要它：以前只会取「最近 n 轮」，写片永远在同一个窗口里打转；
// 更早的那些（超出 n 轮的）一辈子没进过窗口，等压缩把它们压掉就真没了。
// 现在固化能按「上次写到哪」往下取，压缩前先把这段挑进库，压掉的只是过程。
const fromRaw = (args.find(a => a.startsWith('--从=')) || '').slice(4);
const fromMs = fromRaw ? Number(fromRaw) : 0;

function findSessionFile(target) {
  if (target) {
    const t = target.endsWith('.zstd') ? target : join(target, 'session.v3.jsonl.zstd');
    return t;
  }
  let best = null;
  for (const ws of readdirSync(SESS_ROOT)) {
    const dir = join(SESS_ROOT, ws);
    let subs = [];
    try { subs = readdirSync(dir); } catch { continue; }
    for (const s of subs) {
      const p = join(dir, s, 'session.v3.jsonl.zstd');
      try {
        const st = statSync(p);
        if (!best || st.mtimeMs > best.m) best = { p, m: st.mtimeMs, size: st.size };
      } catch { /* 不是会话目录 */ }
    }
  }
  return best && best.p;
}

function readFrames(file) {
  const b = readFileSync(file);
  const offs = [];
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === MAGIC[0] && b[i + 1] === MAGIC[1] && b[i + 2] === MAGIC[2] && b[i + 3] === MAGIC[3]) offs.push(i);
  }
  const chunks = [];
  let i = 0;
  while (i < offs.length) {
    let j = i + 1, ok = false;
    while (j <= offs.length) {
      const end = j < offs.length ? offs[j] : b.length;
      try { chunks.push(zstdDecompressSync(b.subarray(offs[i], end))); ok = true; i = j; break; }
      catch { j++; }   // 魔数出现在压缩数据内部，往后并一帧再试
    }
    if (!ok) i++;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(p => p && p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text).join('\n').trim();
}

// 他发来的那条里，前面常被塞了注入（运行时上下文、画像、召回记忆）。
// 只留最后一个注入结束标签之后的部分——那才是他自己打的字。
const INJECT_END = [/<\/memory-tools-guide>/g, /<\/scene-navigation>/g, /<\/user-persona>/g, /<\/relevant-memories>/g];
function cleanUserText(raw) {
  let cut = -1;
  for (const re of INJECT_END) {
    for (const m of raw.matchAll(re)) cut = Math.max(cut, m.index + m[0].length);
  }
  const s = (cut >= 0 ? raw.slice(cut) : raw).replace(/^\s*(他|我|user|assistant)?[：:]\s*/i, '').trim();
  if (!s) return '';
  if (s.startsWith('Current runtime context.')) return '';   // 纯注入，不含他的话
  return s;
}

const file = findSessionFile(given);
if (!file) { console.error('没找到会话文件'); process.exit(1); }

const rows = [];
for (const line of readFrames(file).split('\n')) {
  if (!line.trim()) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.type === 'user/message' && o.data) {
    const t = cleanUserText(textOf(o.data.content));
    if (t) rows.push({ role: '他', t, ms: o.time });
  } else if (o.type === 'assistant/message' && o.data && o.data.message) {
    const t = textOf(o.data.message.content);
    if (t) rows.push({ role: '我', t, ms: o.time });
  }
}

// 有 --从= 就按时间往下取，而且**从头取**（先写最早那段，进度才能一段段往前推、不漏）；
// 没有 --从= 才是老规矩：取最近 n 轮。
const 池 = fromMs > 0 ? rows.filter(r => Number(r.ms || 0) > fromMs) : rows;
const tail = fromMs > 0 ? 池.slice(0, Math.max(n * 2, 2)) : 池.slice(-n * 2);
if (!tail.length) { console.error('会话里没捞到对话'); process.exit(1); }

const fmt = ms => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? '--:--' : d.toTimeString().slice(0, 5); };
const body = tail.map(r => `${fmt(r.ms)} ${r.role}：${r.t}`).join('\n\n') + '\n';

if (wantJson) console.log(JSON.stringify(tail, null, 2));
else console.log(body);

if (outPath) {
  writeFileSync(outPath, body, 'utf8');
  console.log(`→ 写入 ${outPath}（${tail.length} 条，${Buffer.byteLength(body, 'utf8')} 字节）`);
}
