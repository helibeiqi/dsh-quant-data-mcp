# dsh-quant-data-mcp

**零依赖 MCP stdio server 通用模板 + A 股数据开箱示例**，可直接作为 DeepSeek Harness (`dsh`) 的 bundle 安装。

- **零依赖**：只用 Node 内置模块（`fetch` 需要 Node ≥ 18）。无需 `pnpm`、无需 `npm install`、无需构建。
- **无 API key**：所有数据源都是公开免密钥端点（东方财富 / 腾讯）。开箱即用。
- **路径全环境变量化**：`cordis.patch.yml` 不写死任何绝对路径，全部通过 `!!js process.env.X` 在 dsh 启动时解析。
- **真实协议**：严格按 MCP 官方的 **NDJSON** 帧格式实现，能被 dsh 的 `dsh-mcp-client` 正常注册。

> 设计意图：它既是「A 股数据工具箱」，也是「手搓 MCP server 的模板」。把 `TOOLS` 数组与 `handleCall` 里的工具换成你自己的零密钥本地数据源，即可复用到任意场景。

---

## 文件结构

```
dsh-quant-data-mcp/
├── README.md              # 本文档
├── package.json           # dsh bundle 声明（dsh.bundle.patch）
├── cordis.patch.yml       # dsh 插件注册（全环境变量化，canonical 格式）
├── env.example.cmd        # dsh 启动前需 set 的环境变量示例（Windows）
├── setup.ps1              # 一键安装脚本：拷贝 bundle + 注册 + 打印环境变量
└── lib/
    └── quant-mcp-server.mjs   # 零依赖 MCP server（核心代码）
```

---

## 兼容性（Compatibility）

- 支持的 DSH 版本：v0.1.0-rc.6 及以上（使用 `dsh.bundle` manifest + `cordis.patch.yml` 机制）。
- 运行时：Node.js >= 18（仅用内置模块，无需 `npm install`）。
- 最后验证日期：2026-08-16。

---

## 安装

### 方式 A：一键脚本（Windows / PowerShell）

```powershell
pwsh -File setup.ps1
# 可选参数：-DshHome X:\path\to\.dsh   -Node X:\path\to\node.exe
```

脚本会：① 把本 bundle 拷贝到 `<DshHome>\profiles\node_modules\dsh-quant-data-mcp\`；
② 把 `dsh-quant-data-mcp` 追加进 web profile 的 `dsh.profile.bundles`（先备份 `package.json`）；
③ 打印你需要在 dsh 启动前设置的环境变量。

### 方式 B：手动

1. 把整个 `dsh-quant-data-mcp/` 文件夹拷到 `<DshHome>\profiles\node_modules\dsh-quant-data-mcp\`。
2. 编辑 `<DshHome>\profiles\web\package.json`，在 `dsh.profile.bundles` 数组里加 `"dsh-quant-data-mcp"`（若无该字段则新建）。
3. 在启动 dsh 前设置下面三个环境变量（参考 `env.example.cmd`）。
4. 重启 dsh。

---

## 环境变量

| 变量 | 用途 | 默认值 |
|---|---|---|
| `QUANT_MCP_NODE` | 要 spawn 的 Node 可执行文件绝对路径 | **必填，无默认** |
| `QUANT_MCP_SERVER` | `lib/quant-mcp-server.mjs` 的绝对路径 | **必填，无默认** |
| `QUANT_MCP_CWD` | server 子进程的工作目录 | **必填，无默认** |
| `QUANT_MCP_LOG` | 可选，server 端日志文件路径；不设则禁用日志 | 未设置 = 不写日志 |

示例（放进你的 `dsh-web-dual.cmd`，在启动看门狗/dsh 之前）：

```bat
REM ⚠️ 下面的路径是示例（原作者机器），请改成你自己的路径
set "QUANT_MCP_NODE=C:\Users\YOUR_USER\.workbuddy\binaries\node\versions\22.22.2\node.exe"
set "QUANT_MCP_SERVER=C:\Users\YOUR_USER\.dsh\profiles\node_modules\dsh-quant-data-mcp\lib\quant-mcp-server.mjs"
set "QUANT_MCP_CWD=C:\Users\YOUR_USER\quant-workspace"
REM 可选：set "QUANT_MCP_LOG=C:\Users\YOUR_USER\dsh-mcp-quant-server.log"
```

---

## 验证（三步）

dsh 重启后，确认：

1. **端口在监听**：`netstat -ano | findstr 8787` 出现 `LISTENING`。
2. **server 子进程被拉起**：任务管理器可见 `node ...\quant-mcp-server.mjs`。
3. **工具真注册**：若设置了 `QUANT_MCP_LOG`，日志里应出现 `sent tools/list with 6 tools: a_share_daily,quote_snapshot,quote_batch,financials,northbound,sectors`。
   在 dsh Web UI 里，模型可见 `mcp__quant_data__*` 前缀的 6 个工具。

> 想脱离 dsh 单独验证 server 协议正确性？用任意 MCP SDK 客户端（`StdioClientTransport` + `Client`）连它，跑 `connect → listTools → callTool` 三步即可。协议是标准 NDJSON，官方 SDK 必能连。

---

## 工具列表（`mcp__quant_data__*` 命名空间）

| 工具 | 说明 | 数据源 |
|---|---|---|
| `a_share_daily` | A 股日频 OHLCV（支持 qfq/hfq/raw 复权） | 东方财富 push2his，失败时回退腾讯 proxy.finance.qq.com fqkline（结果含 `source` 字段） |
| `quote_snapshot` | 单只 A 股实时快照（价/昨收/开/高/低/涨跌%） | 腾讯 qt.gtimg.cn |
| `quote_batch` | 多只 A 股实时快照（一次最多 50） | 腾讯 qt.gtimg.cn |
| `financials` | 主要财务指标（EPS/ROE/营收/净利/毛利率…） | 东方财富 RPT_LICO_FN_CPD |
| `northbound` | 沪深港通资金流快照（日/月/年/累计净买入） | 东方财富 kamt |
| `sectors` | 行业/概念/地域板块列表 + 主力净流入 | 东方财富 clist (m:90) |

---

## 网络韧性（重要）

本 server 的 **`a_share_daily` 已实现多源回退**：主源东方财富 `push2his`，在其被网络封锁时**自动回退**腾讯 `proxy.finance.qq.com` fqkline（返回结果含 `source` 字段标明实际命中源，`amount`/`amplitude` 在回退源下为 `null`）。其余工具的单源情况：

- `quote_snapshot` / `quote_batch` → 腾讯 `qt.gtimg.cn`
- `financials` → 东方财富 `datacenter-web`
- `northbound` → 东方财富 `push2` kamt
- `sectors` → 东方财富 `push2` clist

> ⚠️ 实测部分网络（如本测试机）会**按端点**封锁 `push2*.eastmoney.com`：`kamt`（北向）可达，而 `clist`（板块）/ `push2his`（日线）被拒。这种封锁是部署环境的出网策略，**换数据库/付费源救不了「本机出不去」**；但**换用可达主机即可解决**——`a_share_daily` 已内置该回退。`northbound`/`sectors` 在你的 QMT 交易机上通常可达（push2 本就是最稳的行情主机之一）；若需在受限网络下也跑通 `sectors`，请联系我为其接一个可达镜像源。

---

## 踩坑笔记（社区里最容易被坑的地方）

### 1. MCP 帧格式是 NDJSON，不是 Content-Length

官方 MCP SDK（以及 `dsh-mcp-client`）发送端 `JSON.stringify(msg)+'\n'`，接收端**按 `\n` 切分并 strip 行尾 `\r`**，**没有** `Content-Length` 头。如果你用 Content-Length 帧：
- 真 SDK 写 NDJSON，你的 `drain()` 永远匹配不到 `\r\n\r\n` → 收不到 `initialize`/`tools/list`；
- 你自己手搓的**同款**帧测试客户端会「假阳性通过」，但 dsh 真机注册不上。

正确实现见 `lib/quant-mcp-server.mjs` 的 `drain()`：按 `\n` 切分、strip 行尾 `\r`。

### 2. cordis patch 的 MCP 条目必须 `name` + `config:` 包裹

光写 `id` + 扁平的 `serverName/transport/...` 会导致 dsh **启动即崩**（`code=1` 死循环，Edge 显示拒绝连接），且 `dump-config` 还能通过——极具迷惑性。原因：`Include.import(name)` 执行 `name.startsWith("cordis:")`，当 `options.name` 为 `undefined` 时抛 `Cannot read properties of undefined (reading 'startsWith')`。

**canonical 写法**（本 bundle 即此格式）：

```yaml
- insert:
    - id: mcp-quant-data
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: quant_data
        transport: stdio
        command: !!js process.env.QUANT_MCP_NODE
        # ⚠️ 关键：args 里的 !!js 元素必须「不引号」写成 block list（见下方坑 4）。
        # 写成 args: ['!!js process.env.QUANT_MCP_SERVER']（单引号 flow 元素）会被当成
        # 字面量字符串，node 找不到该文件 → ENOENT → server 静默 spawn 失败、工具永久注销。
        args:
          - !!js process.env.QUANT_MCP_SERVER
        cwd: !!js process.env.QUANT_MCP_CWD
        ...
```

- patch 层是 **override-only**：裸 `- id: mcp-quant` 会报 `patch: entry "mcp-quant" not found`，必须用 `- insert:`。
- `!!js process.env.X` 是 cordis YAML 解析器支持的标签，能在加载时读取环境变量——这就是「路径全环境变量化」的实现方式，无需 install 脚本硬填路径。
- **`id` / `serverName` 必须全局唯一**：`dsh-mcp-client` 基础包自带一个 `id: mcp-quant` / `serverName: quant` 的示例条目。若你的 bundle 复用同名 `id`，cordis 合并 patch 树时会抛 `duplicate loader entry id: mcp-quant` 并**启动即崩（code=1 死循环）**。本 bundle 用 `mcp-quant-data` / `quant_data` 规避；给你的 bundle 命名请加专属前缀（如 `mcp-<yourbundle>`）。

### 3. `dump-config` 通过 ≠ 能启动

`dsh --profile web --dump-config` 仅验证配置**能解析**；boot 时插件树加载失败（如坑 2）不会体现在 dump 里。硬闸门是**真能启动 + 工具真注册**（见上「验证」三步）。

### 4. ⚠️ YAML 引号陷阱：`!!js` 标签只在「未引号」的 scalar 上被解析

**这是本 bundle 最隐蔽、也最致命的坑**，曾导致 server 静默 spawn 失败、工具全部注销而 dsh 毫无报错。

cordis 的 YAML 解析器只在**未加引号**的 scalar 上展开 `!!js` 标签；一旦用**单引号**包裹 flow 元素，它就退化成**字面量字符串**，`!!js` 不再解析：

```yaml
# ❌ 错误（曾用写法）：单引号 flow 元素 → args 变成字面量字符串
#    ["!!js process.env.QUANT_MCP_SERVER"]，node 找不到该文件 → ENOENT → spawn 瞬间退出
args: ['!!js process.env.QUANT_MCP_SERVER']

# ✅ 正确：未引号的 block list → cordis 逐元素展开 !!js
args:
  - !!js process.env.QUANT_MCP_SERVER
```

同理，`command:` / `cwd:` 也必须直接写 `!!js process.env.X`，**不要**写成 `'!!js process.env.X'`。

**如何自查是否踩中**：dsh 起来后若某个 `mcp__quant_data__*` 工具根本不存在（或 dsh 日志/进程树里看不到 `quant-mcp-server.mjs` 子进程），第一时间检查 `cordis.patch.yml` 的 `args` 是否用了单引号 flow 写法。现象特征：dsh 进程树里**只有默认的 quant + 因子 2 个 node 子进程，没有你的 server**；server 日志文件（`QUANT_MCP_LOG`）**不会被创建**（因为 server 根本没被 spawn）。这**不是** server 代码问题——server 单独 `node quant-mcp-server.mjs` 直跑完全正常。

---

## 数据源禁忌（请勿调用，已实测踩雷）

以下端点会 403 / 重定向到 HTML / 结构性失效，切勿复用：

- `emweb.securities.eastmoney.com/...`（老 emweb 站点） → 已停用
- `f10.eastmoney.com/.../zycwzbAjax.json` → **403 Forbidden**
- `web.ifzq.gtimg.cn/...json` → **"No dispatch info found"**（已下线）
- 东方财富报表名**不是**直观的 `RPT_F10_FN_INCOME/BALANCE/CASHFLOW/MAININDICATOR`（均返回「报表配置不存在」）；实测可用的只有 `RPT_LICO_FN_CPD`（财报汇总）、`RPT_F10_FINANCE_GINCOME`、`RPT_DMSK_FN_INCOME`。

金额口径：东方财富原始多为「元」，本 server 统一 `/1e8` 转「亿元」再 `toFixed(2)`。

---

## 升级 / 重装注意

- dsh 升级会清空 `node_modules` 补丁：bundle 目录、其 `package.json` 的 bundle 声明、web profile 的 `bundles` 列表都会被重置。升级后**重跑 `setup.ps1`** 即可恢复。
- `QUANT_MCP_*` 环境变量位于启动脚本 / shell 层，不受 dsh 升级影响（`env.example.cmd` 拷进你的启动脚本即可）。

---

## 卸载（Uninstall）

本插件为纯本地 stdio 进程，不写入系统目录、不注册系统服务，删除即彻底移除。

```powershell
# 1) 编辑 <DshHome>\profiles\web\package.json，从 dsh.profile.bundles 数组删除 "dsh-quant-data-mcp"
# 2) 删除 bundle 目录
Remove-Item -Recurse -Force "<DshHome>\profiles\node_modules\dsh-quant-data-mcp"
# 3) （可选）清理启动脚本里的 QUANT_MCP_* 环境变量，然后重启 dsh
```

- 环境变量（`QUANT_MCP_*`）只存在于你自己的 `env.example.cmd` / shell 中，按需清理即可，不随 bundle 删除而自动清除。
- 不残留任何系统级痕迹。

---

## 局限与声明

- 这是**模板 + 示例**，不是一站式量化平台。因子研究、回测、本地复权面板等请在本机 Anaconda 环境完成。
- 所有数据经公开端点抓取，可能随时因对方反爬 / 接口调整而失效；server 对失败返回 `isError`，不会伪造结果。
- **不含任何 API key、不含任何硬编码绝对路径**（`env.example.cmd` 与本文档示例里的路径均用 `YOUR_USER` 占位，照抄时改成你自己的即可）。
- 适用场景：dsh 内让模型直接取 A 股行情 / 财务 / 资金流做快速论证；严肃因子研究仍以本地复权面板为准。

---

## 如何扩展成你自己的数据源

1. 在 `TOOLS` 数组里加一条工具 schema（名称、描述、inputSchema）。
2. 在 `handleCall` 里加一个 `else if (name === 'your_tool') result = await yourHandler(args)`。
3. 在文件底部实现 `yourHandler`（用 `fetch` 调你的免密钥端点即可）。
4. 重新启动 dsh，看日志 `sent tools/list with N tools` 数量是否 +1。

无需改 `cordis.patch.yml`、无需重新注册 bundle。
