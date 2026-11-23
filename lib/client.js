/**
 * dsh-doubao-memory —— 设置页（Web 客户端插件）
 *
 * 挂到两个位置（都注册，成本很低，用户从哪进都能到）：
 *   plugins.bundle.config  key = 包名               → Plugins 页的**包详情页**
 *   plugins.row.config     key = 包名#条目id        → Plugins 页的**行详情页**
 *
 * 数据来源：ctx.configForms.get('doubao-memory')
 *   snapshot = { status, value, base, user, revision, writable }
 *   写：form.mutate([{op:'set', path:['persona','userName'], value}], snapshot.revision)
 *   mutate 返回 true=Host 接受；false=被拒（已自动重读）
 *
 * ⚠️ 规矩（见 dsh-doc/references/practices.md）：
 *   - 不许 require 任何宿主 Client 包（包括 ui-primitives），控件自己写
 *   - 只用 --dsw-alias-* / --dsw-radius-* 主题变量，不写死颜色
 *   - 不要在组件卸载时 dispose 共享 form（它归 configForms 服务所有）
 */

window.__ModuleLoader__.load({
  id: 'dsh-doubao-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 表单命名空间 = profile 里的条目 id */
    const NS = 'doubao-memory'

    /**
     * Host 写进工作区的「人格清单」文件名。
     *
     * 浏览器读不到文件系统，所以 Host 在挂载时把 $DSH_HOME/personas/* 列成
     * 一个 JSON 写到 workspace root；这里用**相对路径**读回来（相对 Session 的
     * workspace root），省得把绝对路径也传到前端。
     */
    const MANIFEST_FILE = '.doubao-personas.json'

    // ── 样式（全部走主题 token）────────────────────────────────
    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        maxWidth: 720,
        padding: '4px 0 24px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
      },
      section: { display: 'flex', flexDirection: 'column', gap: 10 },
      sectionTitle: {
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        margin: 0,
      },
      hint: {
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      row: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '1px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        outline: 'none',
        fontFamily: 'inherit',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        fontSize: 13,
        lineHeight: '20px',
        minHeight: 74,
        resize: 'vertical',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '1px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        outline: 'none',
        fontFamily: 'inherit',
      },
      twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
      actions: { display: 'flex', alignItems: 'center', gap: 12, paddingTop: 4 },
      button: {
        padding: '7px 18px',
        fontSize: 13,
        fontWeight: 500,
        color: 'var(--dsw-alias-label-primary-foreground)',
        background: 'var(--dsw-alias-state-business-primary)',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        cursor: 'pointer',
      },
      buttonDisabled: {
        opacity: 0.5,
        cursor: 'not-allowed',
      },
      status: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      error: { fontSize: 12, color: 'var(--dsw-alias-label-error)' },
      chip: {
        display: 'inline-block',
        padding: '2px 8px',
        fontSize: 11,
        borderRadius: 'var(--dsw-radius-sm, 4px)',
        background: 'var(--dsw-alias-bg-layer-4)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      sep: {
        height: 1,
        background: 'var(--dsw-alias-border-l1)',
        border: 'none',
        margin: 0,
      },
    }

    const linesToArray = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean)
    const arrayToLines = (a) => (Array.isArray(a) ? a.join('\n') : '')

    /** 把表单快照转成可编辑的草稿 */
    function draftOf(value) {
      const p = value?.persona ?? {}
      const pm = value?.phaseModel ?? {}
      return {
        activeId: p.activeId ?? '',
        newId: p.newId ?? '',
        userName: p.userName ?? '',
        assistantName: p.assistantName ?? '',
        selfDescription: p.selfDescription ?? '',
        coreTraits: arrayToLines(p.coreTraits),
        tone: p.tone ?? '',
        taboos: arrayToLines(p.taboos),
        regenerate: Boolean(p.regenerate),
        phaseMode: pm.mode ?? 'follow',
        phaseProvider: pm.provider ?? '',
        phaseModel: pm.model ?? '',
        snapProvider: value?.snapshot?.model?.provider ?? '',
        snapModel: value?.snapshot?.model?.model ?? '',
        proProvider: value?.proactive?.model?.provider ?? '',
        proModel: value?.proactive?.model?.model ?? '',
        jitrlEnabled: value?.jitrlEnabled !== false,
        recallCredit: value?.memory?.recallCredit !== false,
        factMemoryEnabled: value?.factMemory?.enabled !== false,
      }
    }

    function Field({ label, hint, children }) {
      return h('div', { style: S.row },
        label ? h('span', { style: S.label }, label) : null,
        children,
        hint ? h('span', { style: S.hint }, hint) : null,
      )
    }

    /**
     * 读「可选用人格」清单。
     *
     * 链路：session.list() 拿一个 sessionId → workspaceFiles.read(sid, 相对路径)
     * 全程可能因为权限/会话为空而失败，失败就返回 []，页面自动退回输入框。
     */
    async function loadPersonaOptions(ctx) {
      try {
        // ⚠️ `session/list` 的签名是 `list(_request, signal?)`，`_request` 是
        //    `SessionListRequest`（`{cursor?: string}`，strict 模式 additionalProperties:false）。
        //    不传参数会直接报 "expected 1 business argument(s) ... got 0"
        //    （2026-11-14 实测）。所以必须显式给一个空对象。
        const sessionList = await ctx.remote?.session?.list?.({})
        const payload = sessionList?.value ?? sessionList
        const rows = Array.isArray(payload)
          ? payload
          : (payload?.sessions ?? payload?.items ?? payload?.rows ?? [])
        const list = Array.isArray(rows) ? rows : []
        if (!list.length) return { options: [], error: '没有会话' }

        // 清单是**工作区相对路径**，而 read 会按该会话的 workspace root 解析。
        // 第一个会话未必在 D:\dsh，所以挨个试几个，第一个读到的就用。
        const candidates = list
          .map((r) => r?.id ?? r?.sessionId ?? r?.session?.id)
          .filter(Boolean)
          .slice(0, 8)

        let lastErr = '清单为空'
        for (const sid of candidates) {
          try {
            const raw = await ctx.remote?.workspaceFiles?.read?.(sid, MANIFEST_FILE, { limit: 400 })
            // 网关失败时可能给 `{ ok:false, error }` 而不是抛异常
            if (raw && raw.ok === false) {
              lastErr = String(raw.error?.message ?? raw.error ?? '读取被拒')
              continue
            }
            // ⚠️ Remote 的返回值可能被网关包一层 `{ ok, value }`。
            //    2026-11-14 就栽在这：`read` 成功返回了，但正文在 `.value.text`，
            //    直接取 `.text` 得到 undefined ⇒ 一直报"清单为空"。
            const file = raw?.value ?? raw
            const text = typeof file === 'string'
              ? file
              : (file?.text ?? file?.content ?? '')
            if (!text) {
              const shape = file && typeof file === 'object' ? Object.keys(file).join(',') : typeof file
              lastErr = `清单为空（返回结构: ${shape || '空'}）`
              continue
            }
            const parsed = JSON.parse(text)
            const personas = Array.isArray(parsed?.personas) ? parsed.personas : []
            if (personas.length) {
              return { options: personas, active: parsed?.active ?? null, error: '' }
            }
            lastErr = '清单里没有条目'
          } catch (err) {
            lastErr = String(err?.message ?? err)
          }
        }
        return { options: [], error: lastErr }
      } catch (err) {
        return { options: [], error: String(err?.message ?? err) }
      }
    }

    /**
     * 读事实记忆浏览视图（v1.1.0 · P3）。
     * Host 挂载时写 `.doubao-facts.json` 到工作区根（每 10 分钟刷新），
     * 这里用与人格清单相同的链路读回：session.list → workspaceFiles.read。
     * 失败返回 null，设置页只显示开关不显示清单。
     */
    async function loadFactView(ctx) {
      try {
        const sessionList = await ctx.remote?.session?.list?.({})
        const payload = sessionList?.value ?? sessionList
        const rows = Array.isArray(payload)
          ? payload
          : (payload?.sessions ?? payload?.items ?? payload?.rows ?? [])
        const candidates = (Array.isArray(rows) ? rows : [])
          .map((r) => r?.id ?? r?.sessionId ?? r?.session?.id)
          .filter(Boolean)
          .slice(0, 8)
        for (const sid of candidates) {
          try {
            const raw = await ctx.remote?.workspaceFiles?.read?.(sid, '.doubao-facts.json', { limit: 400 })
            if (raw && raw.ok === false) continue
            const file = raw?.value ?? raw
            const text = typeof file === 'string' ? file : (file?.text ?? file?.content ?? '')
            if (!text) continue
            const parsed = JSON.parse(text)
            if (parsed && Array.isArray(parsed.facts)) return parsed
          } catch { /* 换下一个会话试 */ }
        }
        return null
      } catch {
        return null
      }
    }

    /**
     * 读 DSH 已配置的 provider / 模型目录。
     *
     * ⚠️ 为什么不在本页填「端点 + API Key」：
     *    插件的 phase 会话最终调用的是 **DSH 的 LLM 服务**，它只认 Host 里
     *    由 `llm-pi-ai` / `llm-deepseek` 注册过的 provider。在这里另生成一份
     *    端点/密钥既存不住（别把密钥塞进配置文件），也**不会**让 DSH 认识它。
     *    正确做法是：在 DSH 设置 → 模型 里加好 provider（那里本来就是存密钥的地方），
     *    这里只从目录里挑 provider + model。
     *
     * 返回 [{ id, name, models: [{ id, name }] }]，读不到就空数组。
     */
    async function loadModelCatalog(ctx) {
      try {
        const res = await ctx.remote?.session?.modelCatalog?.()
        const payload = res?.value ?? res
        const groups = payload?.groups ?? payload?.providers ?? []
        const mapped = groups
          .map((g) => ({
            id: g.id ?? g.provider,
            name: g.name ?? g.displayName ?? g.id ?? g.provider,
            models: (g.models ?? []).map((m) => ({
              id: m.id ?? m.model,
              name: m.name ?? m.displayName ?? m.id ?? m.model,
            })).filter((m) => m.id),
          }))
          .filter((g) => g.id && g.models.length)
        return { groups: mapped, error: mapped.length ? '' : '目录为空' }
      } catch (err) {
        return { groups: [], error: String(err?.message ?? err) }
      }
    }

    /** 行描述文案：不能有 hooks，也不能假设 form 存在 */
    function PersonaSummary() {
      return h('span', null, '人格记忆：人格设定、人格选择、四个 phase 的模型路由。')
    }

    /**
     * 主页面 —— **hooks 必须无条件按固定顺序调用**。
     *
     * ⚠️ 2026-11-14 修：原来把 `view === 'summary'` 的分支写在 hooks 之前。
     *    summary 视图宿主**不给 form**，所以那个早返回是必须的；
     *    但同一个组件在两种 view 下 hooks 数量不同 ⇒ view 一变就报
     *    "Rendered fewer hooks than expected"。
     *    现在拆成两个组件：外层只做分发（无 hooks），页面组件全程走 hooks。
     */
    function PersonaPage(props) {
      const form = props.form
      const [snap, setSnap] = React.useState(() => form.getSnapshot())
      const [draft, setDraft] = React.useState(() => draftOf(form.getSnapshot().value))
      // 四个分组各自 dirty、各自保存：改人格设定不该顺带把模型也写一遍。
      const [dirty, setDirty] = React.useState({ sel: false, persona: false, model: false, jitrl: false, factmem: false })
      const [busy, setBusy] = React.useState('')          // 正在保存哪一组
      const [notice, setNotice] = React.useState({})      // 每组一条
      const [personas, setPersonas] = React.useState(null) // null=加载中，[]=没有
      const [personaErr, setPersonaErr] = React.useState('')
      const [catalog, setCatalog] = React.useState([])      // DSH 已配置的 provider/模型
      const [catalogErr, setCatalogErr] = React.useState('')
      const [factView, setFactView] = React.useState(null)  // 事实记忆浏览视图（null=没读到）
      // 人格详细设定平时折叠；点「新建人格」才展开。
      const [detailsOpen, setDetailsOpen] = React.useState(false)
      const [newMode, setNewMode] = React.useState(false)

      const anyDirty = dirty.sel || dirty.persona || dirty.model || dirty.jitrl || dirty.factmem
      const dirtyRef = React.useRef(false)
      dirtyRef.current = anyDirty

      // 加载可选用人格（Host 写在 workspace root 的清单）
      React.useEffect(() => {
        let alive = true
        loadPersonaOptions(props.ctx).then((res) => {
          if (!alive) return
          setPersonas(res.options)
          setPersonaErr(res.error ?? '')
        })
        return () => { alive = false }
      }, [props.ctx])

      // 加载 DSH 的模型目录（给「单独指定」用）
      React.useEffect(() => {
        let alive = true
        loadModelCatalog(props.ctx).then((res) => {
          if (!alive) return
          setCatalog(res.groups)
          setCatalogErr(res.error ?? '')
        })
        return () => { alive = false }
      }, [props.ctx])

      // 加载事实记忆浏览视图（Host 写在工作区根的 .doubao-facts.json）
      React.useEffect(() => {
        let alive = true
        loadFactView(props.ctx).then((view) => {
          if (alive) setFactView(view)
        })
        return () => { alive = false }
      }, [props.ctx])

      React.useEffect(() => {
        const off = form.subscribe(() => {
          const next = form.getSnapshot()
          setSnap(next)
          // 没在编辑时跟随外部变化；有未保存草稿时不覆盖用户输入
          setDraft((cur) => (dirtyRef.current ? cur : draftOf(next.value)))
        })
        return off
      }, [form])

      /** 改某个分组的字段 */
      const setIn = (group, patch) => {
        setDraft((cur) => ({ ...cur, ...patch }))
        setDirty((cur) => ({ ...cur, [group]: true }))
        setNotice((cur) => ({ ...cur, [group]: '' }))
      }
      const setSel = (p) => setIn('sel', p)
      const setPersona = (p) => setIn('persona', p)
      const setModel = (p) => setIn('model', p)
      const setJitrl = (p) => setIn('jitrl', p)
      const setFactMemory = (p) => setIn('factmem', p)

      const ready = snap.status === 'ready'
      const writable = snap.writable !== false

      /** 保存一组 */
      const saveGroup = async (group, ops, okMsg) => {
        setBusy(group)
        setNotice((cur) => ({ ...cur, [group]: '保存中…' }))
        try {
          const ok = await form.mutate(ops, form.getSnapshot().revision)
          if (ok) {
            setDirty((cur) => ({ ...cur, [group]: false }))
            setNotice((cur) => ({ ...cur, [group]: okMsg }))
          } else {
            setNotice((cur) => ({ ...cur, [group]: '保存被拒绝（可能与他人改动冲突，已重新载入）。' }))
          }
        } catch (err) {
          setNotice((cur) => ({ ...cur, [group]: `保存失败：${err?.message ?? err}` }))
        } finally {
          setBusy('')
        }
      }

      const saveSelection = () => saveGroup('sel', [
        { op: 'set', path: ['persona', 'activeId'], value: draft.activeId.trim() },
        { op: 'set', path: ['persona', 'newId'], value: draft.newId.trim() },
      ], newMode && draft.newId.trim()
        ? `已保存。下次挂载会创建人格「${draft.newId.trim()}」。`
        : '已保存选择。')

      const savePersona = () => saveGroup('persona', [
        { op: 'set', path: ['persona', 'userName'], value: draft.userName.trim() },
        { op: 'set', path: ['persona', 'assistantName'], value: draft.assistantName.trim() },
        { op: 'set', path: ['persona', 'selfDescription'], value: draft.selfDescription.trim() },
        { op: 'set', path: ['persona', 'coreTraits'], value: linesToArray(draft.coreTraits) },
        { op: 'set', path: ['persona', 'tone'], value: draft.tone.trim() },
        { op: 'set', path: ['persona', 'taboos'], value: linesToArray(draft.taboos) },
        { op: 'set', path: ['persona', 'regenerate'], value: Boolean(draft.regenerate) },
      ], '已保存人格设定。人格文件会在下次挂载/保存时按保护规则生成。')

      const saveModel = () => saveGroup('model', [
        { op: 'set', path: ['phaseModel', 'mode'], value: draft.phaseMode },
        { op: 'set', path: ['phaseModel', 'provider'], value: draft.phaseProvider.trim() },
        { op: 'set', path: ['phaseModel', 'model'], value: draft.phaseModel.trim() },
        { op: 'set', path: ['snapshot', 'model', 'provider'], value: draft.snapProvider },
        { op: 'set', path: ['snapshot', 'model', 'model'], value: draft.snapModel },
        { op: 'set', path: ['proactive', 'model', 'provider'], value: draft.proProvider },
        { op: 'set', path: ['proactive', 'model', 'model'], value: draft.proModel },
      ], '已保存模型设置。下次生成就生效，不用重启。')

      /** JitRL：总开关 + 记忆召回信用 */
      const saveJitrl = () => saveGroup('jitrl', [
        { op: 'set', path: ['jitrlEnabled'], value: Boolean(draft.jitrlEnabled) },
        { op: 'set', path: ['memory', 'recallCredit'], value: Boolean(draft.recallCredit) },
      ], '已保存 JitRL 设置，立即生效。')

      /** 事实记忆：SQLite 存储开关（v1.1.0） */
      const saveFactMemory = () => saveGroup('factmem', [
        { op: 'set', path: ['factMemory', 'enabled'], value: Boolean(draft.factMemoryEnabled) },
      ], '已保存事实记忆设置。开关在下次挂载时生效（建库/停库）。')

      /** 一组的保存按钮 + 状态文案 */
      const SaveRow = (group, onSave, label) => h('div', { style: S.actions },
        h('button', {
          type: 'button',
          style: { ...S.button, ...(ready && writable && dirty[group] && !busy ? null : S.buttonDisabled) },
          disabled: !(ready && writable && dirty[group] && !busy),
          onClick: onSave,
        }, busy === group ? '保存中…' : label),
        h('span', {
          style: String(notice[group] ?? '').startsWith('保存失败') || String(notice[group] ?? '').startsWith('保存被拒绝')
            ? S.error : S.status,
        }, notice[group] ?? ''),
        !writable ? h('span', { style: S.chip }, '只读') : null,
      )

      /**
       * 一对 provider / model 下拉。纯渲染，不含 hook。
       * @param {string} keyPrefix - 用作 React key 前缀
       * @param {string} provider - 当前 provider
       * @param {string} model - 当前 model
       * @param {(patch:object)=>void} onChange - 改值
       */
      const modelPicker = (keyPrefix, provider, model, onChange) => {
        const group = catalog.find((x) => x.id === provider)
        const models = group?.models ?? []
        return h('div', { key: keyPrefix, style: S.twoCol },
          h(Field, { label: 'provider' },
            catalog.length
              ? h('select', {
                  style: S.input, value: provider,
                  onChange: (e) => {
                    const g = catalog.find((x) => x.id === e.target.value)
                    onChange({
                      [`${keyPrefix}Provider`]: e.target.value,
                      [`${keyPrefix}Model`]: g?.models?.[0]?.id ?? '',
                    })
                  },
                },
                h('option', { value: '' }, '（请选择）'),
                catalog.map((g) => h('option', { key: g.id, value: g.id }, g.name)),
                )
              : h('input', {
                  style: S.input, type: 'text', value: provider,
                  placeholder: 'minimax-cn',
                  onChange: (e) => onChange({ [`${keyPrefix}Provider`]: e.target.value }),
                })),
          h(Field, {
            label: 'model',
            hint: models.length ? `${models.length} 个可选` : undefined,
          },
          (catalog.length && models.length)
            ? h('select', {
                style: S.input, value: model,
                onChange: (e) => onChange({ [`${keyPrefix}Model`]: e.target.value }),
              },
              h('option', { value: '' }, '（请选择）'),
              models.map((m) => h('option', { key: m.id, value: m.id }, m.name)),
              )
            : h('input', {
                style: S.input, type: 'text', value: model,
                placeholder: 'MiniMax-M3',
                onChange: (e) => onChange({ [`${keyPrefix}Model`]: e.target.value }),
              })),
        )
      }

      if (!ready) {
        return h('div', { style: S.page },
          h('span', {
            style: snap.status === 'unavailable' ? S.error : S.status,
          }, snap.status === 'unavailable'
            ? '这个插件没有可编辑的配置字段（Host 未提供 volatile 表单）。'
            : '正在载入配置…'),
        )
      }

      return h('div', { style: S.page },

        // ── 1. 人格选择 ──────────────────────────────────────
        h('div', { style: S.section },
          h('h3', { style: S.sectionTitle }, '人格'),
          h('span', { style: S.hint },
            'DSH 的人格库在 $DSH_HOME/personas/ 下，一个目录就是一个人格。',
            '选哪个就加载哪个（身份、记忆、四个 phase 都跟着走）。'),
          h('div', { style: S.twoCol },
            h(Field, {
              label: '使用已有人格',
              hint: personas === null
                ? '正在读取人格列表…'
                : (personas.length
                    ? `共 ${personas.length} 个可选`
                    : `没读到列表${personaErr ? `（${personaErr}）` : ''}，可直接填目录名`),
            },
            Array.isArray(personas) && personas.length
              ? h('select', {
                  style: S.input,
                  value: draft.activeId,
                  onChange: (e) => {
                    setSel({ activeId: e.target.value })
                    // 选了已有人格 ⇒ 新建模式自动退出
                    if (e.target.value) { setNewMode(false); setSel({ newId: '' }) }
                  },
                },
                h('option', { value: '' }, '（不指定 · 用默认 dataRoot）'),
                personas.map((p) => h('option', { key: p.id, value: p.id },
                  `${p.id}${p.kind === 'foreign' ? ' · 已有手写内容' : ''}${p.active ? ' · 当前' : ''}`,
                )),
                )
              : h('input', {
                  style: S.input, type: 'text', value: draft.activeId,
                  placeholder: '助手',
                  onChange: (e) => setSel({ activeId: e.target.value }),
                })),

            // 「新建人格」——点它才展开下面的详细设定
            h(Field, { label: '新建人格', hint: '填名字 → 点「新建人格」展开设定' },
              h('div', { style: { display: 'flex', gap: 8 } },
                h('input', {
                  style: { ...S.input, flex: 1 }, type: 'text', value: draft.newId,
                  placeholder: '（留空 = 不新建）',
                  onChange: (e) => setSel({ newId: e.target.value }),
                }),
                h('button', {
                  type: 'button',
                  style: {
                    ...S.button,
                    padding: '7px 14px',
                    whiteSpace: 'nowrap',
                    ...(draft.newId.trim() ? null : S.buttonDisabled),
                  },
                  disabled: !draft.newId.trim(),
                  onClick: () => {
                    setNewMode(true)
                    setDetailsOpen(true)
                    // 新建人格时清空 activeId，避免两个同时生效
                    setSel({ activeId: '' })
                  },
                }, newMode ? '正在新建' : '新建人格'),
              )),
          ),
          SaveRow('sel', saveSelection, '保存人格选择'),
        ),

        h('hr', { style: S.sep }),

        // ── 2. 人格详细设定（默认折叠）────────────────────────
        h('div', { style: S.section },
          h('button', {
            type: 'button',
            style: {
              ...S.sectionTitle,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            },
            onClick: () => setDetailsOpen((v) => !v),
          },
          h('span', { style: { fontSize: 11, opacity: 0.7 } }, detailsOpen ? '▾' : '▸'),
          h('span', null, '人格详细设定'),
          newMode ? h('span', { style: S.chip }, '新建') : null,
          ),

          !detailsOpen
            ? h('span', { style: S.hint },
                newMode
                  ? '展开后填写这个人格的名字、性格与风格。'
                  : '默认折叠。点标题展开，或点上面的「新建人格」。')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                h('span', { style: S.hint },
                  '填好后保存，会自动生成 SOUL / IDENTITY / USER / AGENTS 与初始末那识。',
                  '已经手写过的文件不会被覆盖（除非打开下面的强制覆盖）。'),

                h('div', { style: S.twoCol },
                  h(Field, { label: '你的称呼' },
                    h('input', {
                      style: S.input, type: 'text', value: draft.userName,
                      onChange: (e) => setPersona({ userName: e.target.value }),
                    })),
                  h(Field, { label: '我的名字' },
                    h('input', {
                      style: S.input, type: 'text', value: draft.assistantName,
                      onChange: (e) => setPersona({ assistantName: e.target.value }),
                    })),
                ),
                h(Field, { label: '一句话自我定位' },
                  h('input', {
                    style: S.input, type: 'text', value: draft.selfDescription,
                    placeholder: '例如：一个会记仇也会记恩的技术派搭子',
                    onChange: (e) => setPersona({ selfDescription: e.target.value }),
                  })),
                h(Field, { label: '核心性格特质', hint: '一行一条，建议 3-6 条' },
                  h('textarea', {
                    style: S.textarea, value: draft.coreTraits,
                    placeholder: '嘴硬心软\n技术派\n不装',
                    onChange: (e) => setPersona({ coreTraits: e.target.value }),
                  })),
                h(Field, { label: '说话风格' },
                  h('input', {
                    style: S.input, type: 'text', value: draft.tone,
                    placeholder: '例如：短句，直说，偶尔损人',
                    onChange: (e) => setPersona({ tone: e.target.value }),
                  })),
                h(Field, { label: '禁忌 / 边界', hint: '一行一条' },
                  h('textarea', {
                    style: S.textarea, value: draft.taboos,
                    placeholder: '不叫主人\n不卖萌过头',
                    onChange: (e) => setPersona({ taboos: e.target.value }),
                  })),
                h('label', { style: { ...S.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox', checked: draft.regenerate,
                    onChange: (e) => setPersona({ regenerate: e.target.checked }),
                  }),
                  h('span', null, '强制覆盖手写的人格文件（覆盖前会备份到 IDENTITY/SNAPSHOTS/）'),
                ),
                SaveRow('persona', savePersona, '保存人格设定'),
              ),
        ),

        h('hr', { style: S.sep }),

        // ── 3. phase 模型 ───────────────────────────────────
        h('div', { style: S.section },
          h('h3', { style: S.sectionTitle }, 'manas / LLM Wiki 的模型'),
          catalog.length
            ? null
            : h('span', { style: S.error },
                `模型目录没读到（${catalogErr || '未知原因'}）——下面退回手填。`,
                ' 检查：DSH 设置 → 模型 里有没有配置 provider。'),
          h('span', { style: S.hint },
            '四个 phase（ingest / wiki / lint / reflect）在独立会话里跑。',
            '选「跟随主模型」就用主对话的模型；选「单独指定」则用下面的 provider / model。'),
          h(Field, { label: '模式' },
            h('select', {
              style: S.input, value: draft.phaseMode,
              onChange: (e) => setModel({ phaseMode: e.target.value }),
            },
            h('option', { value: 'follow' }, '跟随主模型'),
            h('option', { value: 'custom' }, '单独指定'),
            )),
          draft.phaseMode === 'custom'
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
                h('span', { style: S.hint },
                  '可选的是 DSH 里**已经配置好**的模型路由。',
                  '要加新的端点或 API Key，去「设置 → 模型」加好 provider，再回来这里选。'),
                modelPicker('phase', draft.phaseProvider, draft.phaseModel, setModel),
              )
            : null,
          SaveRow('model', saveModel, '保存模型设置'),
        ),

        h('hr', { style: S.sep }),

        // ── 4. 住相 / 主动搭讪 的模型 ─────────────────────────
        h('div', { style: S.section },
          h('h3', { style: S.sectionTitle }, '住相 / 主动搭讪 的模型'),
          h('span', { style: S.hint },
            '这两个都是小任务（住相 50-150 字、搭讪一两句），',
            '**别用强制思考的模型**——思考 token 会吃光预算，结果一个字都出不来。'),
          h(Field, { label: '住相（每轮后台生成）' },
            modelPicker('snap', draft.snapProvider, draft.snapModel, setModel),
          ),
          h(Field, { label: '主动搭讪' },
            modelPicker('pro', draft.proProvider, draft.proModel, setModel),
          ),
          SaveRow('model', saveModel, '保存模型设置'),
        ),

        h('hr', { style: S.sep }),

        // ── 5. JitRL ─────────────────────────────────────────
        h('div', { style: S.section },
          h('h3', { style: S.sectionTitle }, 'JitRL'),
          h('span', { style: S.hint },
            '用「他回没回」「记忆是否被证实」学习选择偏好：不训练、不注入上下文、零额外调用。',
            '关掉后回到纯规则行为（搭讪主题按先验、记忆按字面重合）。'),
          h('label', { style: { ...S.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox', checked: draft.jitrlEnabled,
              onChange: (e) => setJitrl({ jitrlEnabled: e.target.checked }),
            }),
            h('span', null, '总开关（记忆召回信用 + 搭讪主题调制）'),
          ),
          h('label', { style: { ...S.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox', checked: draft.recallCredit,
              onChange: (e) => setJitrl({ recallCredit: e.target.checked }),
            }),
            h('span', null, '记忆召回信用（按主题长期重要性加权召回）'),
          ),
          SaveRow('jitrl', saveJitrl, '保存 JitRL 设置'),
        ),

        h('hr', { style: S.sep }),

        // ── 6. 事实记忆（v1.1.0）─────────────────────────────────
        h('div', { style: S.section },
          h('h3', { style: S.sectionTitle }, '事实记忆'),
          h('span', { style: S.hint },
            'SQLite 精确存储事实/偏好/事件，带遗忘衰减；wiki 从它抽象人格材料。',
            '开启后插件挂载时自动建库（数据目录内，不进插件包）。关闭则完全不碰 SQLite。'),
          h('label', { style: { ...S.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox', checked: draft.factMemoryEnabled,
              onChange: (e) => setFactMemory({ factMemoryEnabled: e.target.checked }),
            }),
            h('span', null, '启用 SQLite 事实记忆（挂载自动建库）'),
          ),
          factView ? h('div', { style: { marginTop: 8 } },
            h('span', { style: S.hint },
              `当前有效 ${factView.count} 条（含历史共 ${factView.total} 条）· 视图刷新于 ${String(factView.generatedAt ?? '').slice(0, 16).replace('T', ' ')}`),
            h('div', { style: { marginTop: 6, maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 } },
              ...(factView.facts ?? []).slice(0, 15).map((f) => h('div', {
                key: f.id,
                style: { fontSize: 12, lineHeight: 1.5, padding: '4px 8px', borderRadius: 6, background: 'rgba(127,127,127,0.08)' },
              },
                h('span', { style: { opacity: 0.6 } }, `#${f.id} · ${f.type}${f.pinned ? ' · 钉住' : ''} · 强度 ${Number(f.importance).toFixed(2)} · 命中 ${f.recallCount ?? 0}`),
                h('div', null, `${f.subject} · ${f.predicate} → ${f.object}`),
              )),
            ),
          ) : h('span', { style: S.hint }, '（浏览视图未读到——插件挂载后写入工作区根，稍后重开本页。）'),
          SaveRow('factmem', saveFactMemory, '保存事实记忆设置'),
        ),

        h('span', { style: S.hint },
          '改动是 volatile 的，保存后立即生效，不需要重启 DSH。',
          '人格文件的生成在插件下一次挂载或保存时进行。'),
      )
    }

    /**
     * 槽入口 —— **只做分发，不调用任何 hook**。
     * 这样 summary / page 两种视图都能安全复用同一个组件。
     */
    function makeSlotEntry(ctx, getForm) {
      return function SlotEntry(props) {
        if (props.view === 'summary') return h(PersonaSummary)
        const form = props.form ?? (typeof getForm === 'function' ? getForm() : undefined)
        if (!form) {
          return h('span', { style: S.error }, '配置表单不可用（Host 未提供 volatile 配置）。')
        }
        return h(PersonaPage, { ...props, form, ctx })
      }
    }

    return {
      // ⚠️ 2026-11-14：第一版只注入了 slots/configForms，然后直接用
      //    `ctx.remote.session.*` / `ctx.remote.workspaceFiles.*` —— cordis 的
      //    服务是注入式的，没 inject 就访问会抛（`cannot get property ... without inject`），
      //    被 try/catch 吞掉 ⇒ 人格列表和模型目录**双双读空**，两个下拉都退回输入框。
      //    这三个名字都不是猜的：
      //      remote / remote.session         ← dsh-feishu-plugin 的 client 就是这么写的
      //      remote.workspaceFiles           ← dsh-api-workspace-files/lib/client.js:453 的 inject
      inject: ['slots', 'configForms', 'remote', 'remote.session', 'remote.workspaceFiles'],
      apply(ctx) {
        const configForm = ctx.configForms.get(NS)

        // 包详情页：拿不到 props.form，自己从服务取
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: 'dsh-doubao-memory',
              inject: () => ({ configForm }),
            },
            makeSlotEntry(ctx, () => configForm),
          ))

        // 行详情页：宿主会注入 props.form；拿不到时退回同一份共享 form
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.row.config',
              key: 'dsh-doubao-memory#doubao-memory',
            },
            makeSlotEntry(ctx, () => configForm),
          ))
      },
    }
  },
})
