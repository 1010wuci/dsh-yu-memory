// 初筛白名单：人工判过“该留、只是文字里带了技术词”的文件，按文件名登记，跳过判弃。
// 只认确切文件名；新片想进白名单，得我手工加——不按规则模糊匹配，免得整类被放过。
import { readFileSync, existsSync } from 'node:fs';

// 白名单是可选件：用环境变量 XY_BAIMINGDAN 指一个 json，没设就当没有白名单（不猜本机路径）。
const 档 = process.env.XY_BAIMINGDAN || '';

export function 在白名单(文件名) {
  if (!档 || !existsSync(档)) return false;
  try {
    const j = JSON.parse(readFileSync(档, 'utf8'));
    return (j.文件 || []).includes(文件名);
  } catch {
    return false;
  }
}
