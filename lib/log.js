/**
 * 共享日志工具 —— 插件内部所有"吞掉的错误"都落到文件里。
 *
 * 理由：主动搭讪/住相的错误**绝不能影响主对话**，所以全部 try/catch 静默。
 * 代价是"没跑"和"跑了但判定为不说"从外面看一模一样。日志是区分这两种情况的唯一手段。
 */

import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'

const MAX_BYTES = 512 * 1024

/**
 * 追加一条诊断记录。
 * @param {string} file - 日志文件路径
 * @param {string} event - 事件名
 * @param {object} [data] - 附加字段
 */
export function log(file, event, data = {}) {
  try {
    if (!file) return
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      try { renameSync(file, `${file}.1`) } catch { /* 轮转失败就继续追加 */ }
    }
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...data })
    appendFileSync(file, `${line}\n`, 'utf8')
  } catch {
    /* 日志失败也不该影响主流程 */
  }
}
