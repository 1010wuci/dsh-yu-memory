#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""算向量（Linux 版）：onnxruntime + tokenizers 跑 bge-base-zh-v1.5。

两种用法：
  1) 整库/增量：python3 算向量.py --库 <记忆库根> [--算 0001,0002]
     输出与 算向量.mjs 同构的 _向量.json（model/dim/builtAt/root/count/vectors）。
  2) 只编码一段文本：python3 算向量.py --文本 "问句"
     JSON 数组打在 stdout —— 召回.mjs 在没装 node 版 transformers 时用这条。

为什么有这份：服务器的 onnxruntime-node 要从 GitHub 下二进制，下不动（302）；
Python 的 onnxruntime 走清华源能装。算法与 算向量.mjs 对齐：CLS + L2 归一 + 4 位小数。
"""
import argparse, glob, json, os, re, sys, time
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

默认模型 = os.environ.get('XY_模型', '')


def 载模型(模型目录):
    tok = Tokenizer.from_file(os.path.join(模型目录, 'tokenizer.json'))
    tok.enable_truncation(max_length=512)
    tok.enable_padding(pad_id=0, pad_token='[PAD]')

    onnx路 = None
    for 候 in ('onnx/model_quantized.onnx', 'onnx/model.onnx'):
        p = os.path.join(模型目录, 候)
        if os.path.exists(p):
            onnx路 = p
            break
    if not onnx路:
        raise SystemExit('模型目录里没有 onnx/model_quantized.onnx')

    so = ort.SessionOptions()
    so.log_severity_level = 3
    sess = ort.InferenceSession(onnx路, so, providers=['CPUExecutionProvider'])
    要token = 'token_type_ids' in [i.name for i in sess.get_inputs()]
    return tok, sess, 要token


def 编码一段(文本, tok, sess, 要token, 位数=4):
    enc = tok.encode(文本[:1200])
    feats = {'input_ids': [enc.ids], 'attention_mask': [enc.attention_mask]}
    if 要token:
        feats['token_type_ids'] = [enc.type_ids]
    out = sess.run(None, feats)[0]          # [1, seq, 768]
    cls = out[0][0]                         # CLS pooling，与 算向量.mjs 对齐
    v = cls / (np.linalg.norm(cls) + 1e-12)
    return [round(float(x), 位数) for x in v]


def 读片(库):
    """与 算向量.mjs 的 loadDocs 一致：读 索引.md 的编号/话题/关键词，正文取碎片文件。"""
    idx = os.path.join(库, '索引.md')
    片 = []
    if not os.path.exists(idx):
        return 片
    with open(idx, encoding='utf-8') as f:
        for line in f:
            m = re.match(r'^-\s*(\d{4})｜([^｜]*)｜([^｜]*)｜', line.strip())
            if not m:
                continue
            编号, 话题, 关键词 = m.group(1), m.group(2).strip(), m.group(3).strip()
            命中 = sorted(glob.glob(os.path.join(库, '碎片', '碎片-%s-*.md' % 编号)))
            正文 = ''
            if 命中:
                with open(命中[0], encoding='utf-8') as g:
                    正文 = g.read()
            片.append({'id': 编号, 'topic': 话题, 'kw': 关键词, 'body': 正文})
    return 片


def 整库(库, 模型目录, 只算):
    库 = 库.rstrip('/')
    出 = os.path.join(库, '_向量.json')
    tok, sess, 要token = 载模型(模型目录)

    片 = 读片(库)
    print('库根：%s　片数：%d' % (库, len(片)))

    旧 = None
    if os.path.exists(出):
        try:
            with open(出, encoding='utf-8') as f:
                旧 = json.load(f)
            if 旧.get('model') != 模型目录:
                print('旧向量是 %s 算的，现在是 %s——这次走全量' % (旧.get('model'), 模型目录))
                旧 = None
        except Exception:
            旧 = None

    要算 = 片
    if 旧:
        有 = 旧.get('vectors', {})
        要算 = [d for d in 片 if d['id'] in 只算 or d['id'] not in 有]
        print('增量：点名 %d 片，实算 %d 片，其余照旧' % (len(只算), len(要算)))

    vectors = dict(旧.get('vectors', {})) if 旧 else {}
    n = 0
    for d in 要算:
        文本 = (d['topic'] + '｜' + d['kw'] + '｜' + d['body'])[:1200]
        vectors[d['id']] = 编码一段(文本, tok, sess, 要token)
        n += 1
        if n % 20 == 0:
            print('  算到 %d/%d' % (n, len(要算)))

    缺 = [d['id'] for d in 片 if d['id'] not in vectors]
    if 缺:
        raise SystemExit('对账失败：有片没向量 %s（不写盘）' % 缺[:8])

    结果 = {
        'model': 模型目录,
        'dim': len(next(iter(vectors.values()))) if vectors else 0,
        'builtAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'root': 库,
        'count': len(vectors),
        'vectors': vectors,
    }
    with open(出, 'w', encoding='utf-8') as f:
        json.dump(结果, f, ensure_ascii=False)
    print('写好 %s：%d 片 × %d 维' % (出, 结果['count'], 结果['dim']))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--库', default='')
    ap.add_argument('--模型', default=默认模型, help='本地 bge 模型目录；也可用环境变量 XY_模型')
    ap.add_argument('--算', default='')
    ap.add_argument('--文本', default=None)
    a = ap.parse_args()

    if not a.模型:
        raise SystemExit('没有模型目录：用 --模型 或环境变量 XY_模型 指一个本地 bge 目录')

    if a.文本 is not None:
        tok, sess, 要token = 载模型(a.模型)
        print(json.dumps(编码一段(a.文本, tok, sess, 要token)))
        return

    if not a.库:
        raise SystemExit('要么给 --库，要么给 --文本')
    整库(a.库, a.模型, [x.strip() for x in a.算.split(',') if x.strip()])


if __name__ == '__main__':
    main()
