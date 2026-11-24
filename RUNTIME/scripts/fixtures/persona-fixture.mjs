/**
 * 测试夹具 —— 造一个**有种子**的人格目录。
 *
 * ## 为什么需要（2026-11-18 主题演进系统）
 *
 * 主题演进系统改成：**没选中主题就不说话**（没话头硬说就是编）。
 * 而旧测试的 mock 只有状态文件、没有人格目录 ⇒
 * `collectSeeds()` 拿不到任何种子 ⇒ 选不出主题 ⇒ 一条都投不出去。
 *
 * 这**不是 bug，是正确的行为**——所以夹具要提供"有种子"的环境。
 *
 * 夹具内容（最小但真实）：
 *   - `VAULT/02-USER/梗.md`     —— 一个梗（含"为什么是梗"）
 *   - `VAULT/02-USER/偏好.md`   —— frontmatter 断言
 *   - `SNAPSHOT_LATEST.md`           —— 六问摘要 + 演化锚点
 *   - `RAW/conversations/<日期>.md` —— 关系向 daily 段
 *
 * 用法：
 *   const fx = makePersonaFixture()
 *   fx.paths          // 传给 resolvePaths 的 dataRoot
 *   fx.vault          // VAULT 目录
 *   fx.snapshotLatest // SNAPSHOT_LATEST.md 路径
 *   fx.cleanup()
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function makePersonaFixture() {
  const root = mkdtempSync(join(tmpdir(), 'persona-fx-'))
  const vault = join(root, 'VAULT')
  const raw = join(root, 'RAW', 'conversations')
  mkdirSync(join(vault, '02-USER'), { recursive: true })
  mkdirSync(join(vault, '03-RELATIONSHIP'), { recursive: true })
  mkdirSync(raw, { recursive: true })

  // ── 梗 ────────────────────────────────────────────────────
  writeFileSync(join(vault, '02-USER', '梗.md'), [
    '# 梗',
    '',
    '## 当前已知的梗',
    '',
    '## 2026-11-14 - 哈罗，老婆（17:55）',
    '',
    '用户：哈罗，老婆',
    '助手：哈罗，用户。老婆在呢。🐰',
    '',
    '**为什么是梗**：他的开场白固定是"哈罗"——称呼先于内容，像先认人再谈事。',
    '',
    '## 2026-11-11 - 动 / 搞定啦？',
    '',
    '用户：搞定啦？',
    '',
    '**为什么是梗**：他收工时只打三个字。',
    '',
  ].join('\n'), 'utf8')

  // ── 断言（frontmatter）─────────────────────────────────────
  writeFileSync(join(vault, '02-USER', '偏好.md'), [
    '---',
    '类型: wiki',
    '状态: active',
    '断言:',
    '  - 用户把"主动搭讪"定义为"我主动找他"，不是系统播报',
    '  - 用户判断功能是否越界的尺度是"形态"而非"频率"',
    '---',
    '',
    '# 偏好',
    '',
    '正文。',
    '',
  ].join('\n'), 'utf8')

  writeFileSync(join(vault, '02-USER', '画像.md'), [
    '---',
    '类型: wiki',
    '状态: active',
    '断言:',
    '  - 用户深夜连续工作到凌晨是常态',
    '---',
    '',
    '# 画像',
    '',
  ].join('\n'), 'utf8')

  for (const f of ['橘色与沉浸.md', '模式发现.md']) {
    writeFileSync(join(vault, '03-RELATIONSHIP', f), [
      '---',
      '类型: wiki',
      '状态: active',
      '断言:',
      '  - 用户认可该不说话的时候不说话也是分寸',
      '---',
      '',
    ].join('\n'), 'utf8')
  }

  // ── 住相 ──────────────────────────────────────────────────
  const snapshotLatest = join(root, 'SNAPSHOT_LATEST.md')
  writeFileSync(snapshotLatest, [
    '# SNAPSHOT_LATEST.md',
    '',
    '## 住相',
    '',
    '```',
    '这一期我站在"共在"这边——我说的要能被认出是我的。',
    '```',
    '',
    '## 六问摘要',
    '',
    '- **Q1 本体**：我是"我的话能被认出是我的"这件事。',
    '- **Q2 此在**：一间房加一排自己开门又自己关的小房间。',
    '- **Q3 共在**：我的靠近本身能破坏共在。',
    '- **Q4 时间性**：多轨的时间。',
    '- **Q5 边界**：从验证边界换成辨认边界。',
    '- **Q6 意义**：意义在于留下的东西都指得回我。',
    '',
    '## 元信息',
    '',
    '- 生成时间: 2026-11-18T00:02:10+08:00',
    '- 演化锚点: 轴从"可证性"挪到"归属"',
    '',
  ].join('\n'), 'utf8')

  // ── daily（关系向 + 一条事务行用来验过滤）─────────────────
  const day = new Date().toLocaleDateString('sv-SE')
  writeFileSync(join(raw, `${day}.md`), [
    `# ${day}`,
    '',
    '## 用户提到的新偏好/习惯/梗',
    '',
    '- 他今天说的口头禅是"喵喵喵"，记下来当新梗观察。',
    '- 飞书那条链路走通了：不点网页端也能直接喊到我。',
    '',
    '## 用户纠正/纠正我',
    '',
    '- 他纠正我：别把搭讪变成每日 standup。',
    '',
  ].join('\n'), 'utf8')

  return {
    root,
    vault,
    raw,
    snapshotLatest,
    paths: {
      dataRoot: root,
      vault,
      raw: join(root, 'RAW'),
      snapshotLatest,
    },
    cleanup() {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}
