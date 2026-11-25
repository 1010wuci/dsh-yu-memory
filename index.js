// dsh-yu-memory：把玉的记忆库做成插件的第一块——召回。
//
// 跟原来那个 dsh-xiaoyu-recall 的区别只有三个，都是为了能给别人装：
//   1. 召回脚本跟着包走（lib/召回.mjs），不再指向 D:\小玉的工具；
//   2. 库根只认配置或环境变量 XY_MEMORY_ROOT，两个都没有就报错，不替人猜路径；
//   3. 语义向量那路要 python，可配 Python 可执行文件，没有就靠字面 + 簇，不炸。
//
// 注册的工具名仍然是 recall_memory，参数不变。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

export const name = 'dsh-yu-memory'

// 没有 tools 服务就注册不了工具；inject 少一行，宿主就不给服务。
export const inject = ['tools']

const 包内脚本 = fileURLToPath(new URL('./lib/召回.mjs', import.meta.url))

const 默认 = {
  库根: '',
  脚本: 包内脚本,
  超时毫秒: 30000,
  Python: '',
}

function 整理(数据) {
  const 级 = 数据.够级 || '未知'
  const 头 = `问：${数据.q}\n够不够：${级}（最高余弦 ${数据.最高余弦}，够线 ${数据.够线}，软线 ${数据.软线}）`
  const 片 = (数据.hits || []).map((h, i) => {
    const 行 = [
      `${i + 1}. ${h.id}｜${h.topic}｜簇=${h.cluster}｜分=${h.s}｜重叠=${h.n}`,
      h.摘 ? `   摘：${h.摘}` : '',
      h.想 ? `   想：${h.想}` : '',
    ].filter(Boolean)
    return 行.join('\n')
  })
  if (!片.length) return 头 + '\n\n（库里没有对得上的片）'
  return 头 + '\n\n' + 片.join('\n\n')
}

export function apply(ctx, config) {
  const cfg = { ...默认, ...(config || {}) }
  const 库根 = String(cfg.库根 || process.env.XY_MEMORY_ROOT || '').trim()
  const python = String(cfg.Python || process.env.XY_PY || '').trim()

  if (!库根) {
    process.stderr.write('[yu-memory] 没有库根：在 profile 的插件配置里填「库根」，或设环境变量 XY_MEMORY_ROOT\n')
  } else if (!existsSync(库根)) {
    process.stderr.write(`[yu-memory] 库根不存在：${库根}\n`)
  }
  if (!cfg.脚本 || !existsSync(cfg.脚本)) {
    process.stderr.write(`[yu-memory] 召回脚本找不到：${cfg.脚本}\n`)
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'recall_memory',
      description:
        '从记忆库（上百片）里召回最相关的几片。' +
        '问句写成平时说话的样子（越像自己嘴里说出来的越准），不要写成关键词串。' +
        '返回每片的编号、话题、所属簇、分数、正文摘录与当时想法；开头一行给「够不够」' +
        '（够／存疑／翻不到）——翻不到就说明库里真没有，别硬往下编。',
      parameters: {
        type: 'object',
        properties: {
          问句: { type: 'string', description: '要回想的那件事，用自然语气写一句' },
          片数: { type: 'number', description: '要几片，默认 3，最多 8' },
        },
        required: ['问句'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const 问 = String((args && args.问句) || '').trim()
        if (!问) throw new Error('recall_memory: 问句不能为空')
        if (!库根) return 'recall_memory 没配库根：在插件配置里填「库根」，或设环境变量 XY_MEMORY_ROOT。'
        const 片数 = Math.min(8, Math.max(1, Number(args && args.片数) || 3))
        const env = { ...process.env }
        if (python) env.XY_PY = python
        const r = spawnSync(process.execPath, [cfg.脚本, '--json', 问, '--top=' + 片数, '--root', 库根], {
          encoding: 'utf8',
          timeout: cfg.超时毫秒,
          maxBuffer: 32 * 1024 * 1024,
          env,
        })
        const 出 = String(r.stdout || '').trim()
        const 错 = String(r.stderr || '').trim()
        if (!出) return `召回没跑出结果（exit ${r.status}）\n${错 || '（没有更多信息）'}`
        const 行 = 出.split(/\r?\n/).filter((l) => l.startsWith('{')).pop()
        if (!行) return `召回的输出不是 JSON：\n${出.slice(0, 400)}`
        try {
          return 整理(JSON.parse(行))
        } catch (e) {
          return `召回的 JSON 解析不了：${e && e.message}\n${行.slice(0, 400)}`
        }
      },
    }),
    'yu-memory: recall_memory',
  )
}
