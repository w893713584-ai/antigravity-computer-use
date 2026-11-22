# Antigravity 原生能力升级施工蓝图

建议把**人类接管、脚本生命周期和动作派发的最终裁决放在 Broker**。把有 TCC 权限的桌面 helper 与执行用户 JavaScript 的 runner 做成两个独立进程。先交付刹车和沙箱，再接入视频。视频上线前，先证明小窗里看到的窗口、坐标和实际收到事件的窗口是同一个。

本次是只读审阅。仓库为 `main @ ded4d57`，工作树干净。我核对了 brief、仓库源码、安装副本的关键入口、本机 SDK，以及 Antigravity 原生 helper 的链接和签名元数据。`55/55` 来自 brief。本机为 arm64、macOS `27.2.1`、Antigravity `2.33.0`。以下性能数字是建议的验收目标，TCC、Aux Pane 解码和原生派发需要实机验证。

## 六项决策

| 问题 | 拍板 |
|---|---|
| **Q1 推流协议** | 同端口 RFC 6455 WebSocket，二进制传 **AVCC access unit**，单独发真实 `avcC`。SSE 继续承载状态、动作和 JPEG 通知。WebCodecs 成功画出第一帧后，该小窗才切换到 H.264。 |
| **Q2 坐标与光标** | 以指定窗口的**逻辑点**为唯一坐标基准。视频、JPEG 和 OCU 动作截图各自持有尺寸与裁切信息。`/api/interact` 绑定实际绘制的帧和窗口，派发前检查窗口身份与几何。 |
| **Q3 TCC** | 桌面 helper 用固定安装路径、固定 Bundle ID、同一 Developer ID Team 签名和公证，通过 LaunchServices 后台启动。OCU、JXA、桌面 helper 分别报告权限。 |
| **Q4 脚本沙箱** | 发布版默认严格模式。**每次 `js` 新建一个 Seatbelt + JSC 进程**，Broker 按 MCP 连接保存可序列化绑定和 app 句柄。严格 runner 不可用时关闭 `js`，结构化 MCP 继续可用。 |
| **Q5 人类接管** | 用**实际动作目标**布防。确认真人操作命中目标、显式小窗操作或专用热键才锁存暂停。小窗单击触发接管并中止在途 AI 工作，手动点击等原生动作排空后再派发。 |
| **Q6 发布** | 发布机预编译两份 universal `.app`，一键包携带已公证的产物。安装机只做校验和安装。桌面 helper 与脚本 runner 可以独立降级。 |

三处现有实现直接决定施工顺序。

- `/api/interact` 用预览宽高判断 OCU 动作截图是否过期，再把归一化坐标乘上 OCU 截图宽高。普通 JPEG 回调主要按 `activeApp` 过滤。显式 `window_id` 的 `act` 已主动禁用 OCU 像素点击分支，走已验证 AX 元素的 `sky_click`。因此，**换成 H.264 之前要先解决同窗证明**，尤其是本机 JXA 未获 AX 授权的情况。[Broker 的预览与手动操作](../../src/broker-sidecar.mjs#L1124) · [显式 WID 的点击分支](../../src/action-executor.mjs#L1215)
- UI 的暂停开关直接写 `state.paused`。Broker 对普通动作有发送前检查，但 `BackgroundActionExecutor.dispatch()`、OCU 内部队列和 JXA 队列都还有各自的异步边界。要在**写入原生 IPC 之前**再检查一次，才能覆盖排队和重试期间的接管。[设置处理](../../src/sidecar-web-adapter.mjs#L456) · [OCU 原生派发](../../src/native-peer.mjs#L220) · [JXA 派发](../../src/ax-bridge.mjs#L2123)
- 现有 REPL 依赖 OCU 的 Node Worker 和持久 Node REPL，`var app = await cua.getApp(...)` 是已公开用法。现有 `/api/permissions` 的探针实际来自 JXA/`osascript`，页面却统一提示给 Antigravity 授权。两处语义都要在升级时明确。[REPL 入口](../../src/mcp-repl-server.mjs#L17) · [权限探针](../../src/headless-engine.mjs#L650) · [现有权限横幅](../../src/ui/index.html#L844)

## Phase 1 · 精准接管与脚本沙箱

### 1. 接管判定与输入来源

Broker 维护短期的动作目标记录 `{pid, processToken, windowId?, operationId, pauseEpoch}`。`act` 从准备阶段到 `expect` 结束都持有记录。`js` 在第一次访问实际桌面目标时登记，目标切换时更新。注册记录覆盖已经受理、可能继续派发的操作。单纯选中小窗或订阅视频只改变观看目标。进程身份复用 `AppSnapshotRegistry` 的进程代际校验。

| 信号 | 触发规则 |
|---|---|
| **小窗“暂停”与“置顶”** | 立即锁存暂停。“置顶”同时登记用户对该目标的显式焦点意图，然后执行既有置顶路径。 |
| **小窗画面上的单击、双击、右键、滚动，以及发送文字和快捷键** | 有效画面上的按下先申请接管。现有约 240 ms 单击等待只用于区分单击与双击。最终 `/api/interact` 携带同一 `intentId` 和帧引用，服务端幂等确认接管，再等待派发。浏览日志、选浏览窗口、编辑尚未发送的文字不触发。 |
| **真人点击目标真实窗口** | `.cgSessionEventTap`、`.listenOnly` 捕获按下。可信真人来源，且点击命中最上层可交互窗口的 `pid + windowId`，才触发。应用级任务用已验证 PID 作为作用域。显式指定 WID 的任务要求命中同 WID，或已证实属于该窗口的模态窗口。 |
| **真人切到目标或在目标中打字** | 有输入监控时，用系统切换手势和后续前台变化关联，例如 Cmd-Tab 后的切换、Dock 上的点击。目标已在前台时，真人按键还要匹配当前 focused WID。缺少可验证的 focused WID 时，显式指定 WID 的任务等待直接点击或显式接管。 |
| **全局急停** | 增强模式默认 `Control+Option+Escape`。只识别一次非重复按下，释放后重新布防。该组合在自动化按键入口保留。热键可配置，冲突或键盘监听不可用时显示实际状态。 |
| **在 Antigravity、Chrome、微信等其他窗口正常操作** | 不触发。普通鼠标移动、全局空闲时长、其他窗口的按键都不进入刹车条件。即使应用 PID 相同，指定 WID 的任务仍按窗口匹配。 |
| **权限不足、来源不明、合成事件** | 基础模式使用 `NSWorkspace.didActivateApplicationNotification` 和窗口层锚定候选目标，以小窗显式操作完成接管。单独的激活通知没有来源信息，不能硬刹。输入 tap 获准且实际可用后，才启用真人点击、切换和热键规则。 |

命中测试用 Quartz 全局点坐标，按 `CGWindowListCopyWindowInfo(.optionOnScreenOnly, …)` 的前后顺序判断。鼠标点先碰到 Antigravity、菜单、遮罩或另一窗口时，不把事件归给其后方的目标。不要为了匹配目标先把其他 layer 全过滤掉。对于透明覆盖、Space 切换、过期窗口清单或无法确定前后关系的情况，判为 `unknown`。tap 回调只复制必要字段，由独立队列做命中判断。普通按键内容不进 IPC 或日志。tap 失效、Secure Input 或锁屏时分别降级鼠标和键盘能力。Apple 对 session tap 的事件掩码有实际权限限制，启动后要验证收到的能力，而不能只看 preflight。 [Apple CGEventTap 文档](https://developer.apple.com/documentation/coregraphics/cgevent/tapcreate%28tap%3Aplace%3Aoptions%3Aeventsofinterest%3Acallback%3Auserinfo%3A%29?language=objc) · [Apple 窗口清单 API](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:))

**防自触发要分自有路径和 OCU 黑盒路径。** 自有 `window_post`、`window_key`、滚动及其他 CGEvent 投递统一在生成时写入本次 Broker 启动随机生成的 64 位标签。监听端结合标签、已验证的投递进程身份和实际事件来源分类。OCU 的 `sky_click`、`sky_key` 先用实机观察建立 `(系统 build, OCU build, route)` 的来源判定，覆盖 wrapper 和 app-agent。投递时间戳只用于给特定事件做诊断关联。**某条 OCU 路径如果生成了与真人事件无法区分的输入，就关闭该路径上相关事件类型的自动判定，保留其他可判定规则和显式急停。** 全局时间屏蔽会吞掉用户恰好在 AI 点击时发出的真实接管，不能采用。

### 2. Broker 内的暂停、排空和恢复

状态流程为 `running → paused/draining → paused/ready → running`。`requestPause(intent)` 在 Broker 的同一个同步步骤内设置 `paused=true`、递增 `pauseEpoch`、锁存 `pauseReason` 和 `pauseDetail`，并中止活动 AI controller。UI 立即收到 SSE `state` 与一条 `action`，显示 `[人类接管已暂停]`。`pauseDetail` 记录触发类别、目标标识和时间，供用户判断是哪次接管。

- **排队时**，每个 AI 请求保存入队时的 epoch。暂停后旧请求取消，即使用户很快点击继续，旧请求也不会复活。`js` 整体由 Broker 监管，每次 `cua` RPC 各自进入现有动作队列。这样脚本等待 Broker 时不会把动作队列锁住。
- **实际发送时**，在 `NativeComputerUsePeer` 完成 `ensureStarted()` 之后、`stdin.write` 之前校验许可。`PersistentAxBridge.#dispatchDirect()` 同样校验。每次重试、`act` 的每步滚动、直接 AX 写入、内部 launch/unhide 都走许可检查。现有 `get_app_state` 和 `query` 有 launch/unhide 路径，暂停期只开放确认无副作用的观察。
- **已经发送时**，返回 `not_sent`、`sent` 或 `sent_unknown`。立即结束 AI 层的后续步骤，杀掉活动脚本子进程。已经交给 OCU、JXA 或 WindowServer 的事件可能完成，尤其是一次原生字符序列或鼠标 down/up。手动写等当前原生动作确认结束。若 wrapper 超时退出而 app-agent 的执行状态未知，写入口保持锁定，直到确认本代 agent 退出或被隔离。取消后禁止补发。由本项目控制的长滚动、连点或按键序列应拆成有界的投递批次，并保证配对事件收尾。
- **焦点扫尾**使用独立的接管意图版本。确认真人显式接管某目标时，作废针对该目标的 reclaim sweep。用户在 Antigravity 内按急停或点小窗时，保留保护原前台的扫尾。在恢复焦点的原生调用前，复查期望前台 PID、进程代际和接管版本，避免 `getFrontmostApp` 返回后，延迟的恢复命令把用户刚选的窗口拉走。[现有 FocusPolicyGuard 的检查和恢复时序](../../src/focus-policy-guard.mjs#L327)
- **恢复**由用户点击“继续”，带 `expectedPauseEpoch`。清理历史事件、已按住的热键重复及旧前台切换候选，标记接管目标的旧快照需重读。恢复后新的明确真人输入仍能立即接管。

生产 MCP 连接使用唯一主 Broker。现有 `BrokerRpcClient` 会在断线后构造独立 fallback Broker，它无法获知主 Broker 的暂停状态。因此生产写操作与 `repl/run`、`repl/reset` 统一走主 Broker，并纳入**写入后禁止重放**的分类。增加连接内的 `rpc/cancel {requestId}`，将 MCP 取消和客户端超时传到 Broker 对应请求。连接关闭仍中止该连接所有请求。主 Broker 失联显示 `BROKER_UNAVAILABLE`，避免脱离接管控制继续写桌面。[现有重连与 fallback](../../src/broker-client.mjs#L228)

### 3. 严格 REPL 和 NDJSON

我选**持久数据与 app 句柄，每轮新进程**。持久 JSC context 可以保留闭包和对象身份，但跨轮 Promise 仍可能持有旧 `cua` 能力，取消后需要额外证明这些回调永远无法借用下一轮权限。每轮新进程把这个边界落实到进程退出，并支持内核级的单轮 CPU 限制。保留 Node Worker 作为自动兼容回退，会让同一个 `js` 名称在故障时改变隔离承诺。发布版关闭这条路径。

- **对外兼容。** 保留 `js({code,timeout_ms,title})`、`js_reset`、小窗 pill、`cua.getApp`、`cua.listApps`、现有 `app.query/click/scroll/typeText/pressKey` 等方法的参数契约。增加 `app.act(options)`，映射到现有 Broker `act`。截图返回 `Uint8Array`，显式 `emit` 仍可产出 MCP 图片。`nodeRepl.write` 可用，Node 文件路径、环境、模块加载和原生对象不暴露。
- **跨轮绑定。** 在已进入 Seatbelt 的 runner 内，用锁定版本、随二进制内嵌的 Acorn 解析顶层语法。第一版自动持久化顶层简单标识符的 `var/let/const`，支持顶层 `await`。把上轮数据导入本轮严格 async 函数的词法环境。`var` 可重声明，已存在的 `let/const` 保持声明约束。持久值支持有界 JSON 数据、`undefined` 和 Broker 签发的 app 句柄。app 句柄每轮重新生成只对本轮有效的方法对象。闭包、Promise 和 native 对象限于本轮。需要保存跨轮数据的脚本也可以显式使用 `session`。解析与绑定错误在任何桌面调用前返回。[Acorn 解析选项](https://github.com/acornjs/acorn/blob/master/acorn/README.md)
- **提交与失效。** 只有 `done.ok=true`、本轮无未完成桌面 RPC、epoch 仍有效时才提交绑定。普通脚本异常保留上一次成功提交的状态。超时、强制取消、子进程异常、连接断开与 `js_reset` 清掉相应会话绑定和句柄。已经发生的桌面写不随变量回滚。用应用句柄时继续走 PID、代际、窗口和 `SnapshotLedger` 验证。可选 `AxTree` 作为后续纯数据功能，只有结构化快照提供父子关系时才实现 `closest`。

Broker 持有 `repl/run` 和 `repl/reset`，runner 只接 stdin/stdout。下列消息的每一行是一条 UTF-8 JSON，`P` 为 Broker，`C` 为 runner。`call.id` 在一轮内递增，成功和失败回复使用同一 ID。

```text
C→P {"v":1,"type":"ready","profile":"strict-v1"}
P→C {"v":1,"type":"run","runId":"r7","code":"await app.query({text:'播放'})","bindings":[],"timeoutMs":30000}
C→P {"v":1,"type":"call","runId":"r7","id":1,"op":"app.query","args":{"appId":"a2","text":"播放"}}
P→C {"v":1,"type":"reply","runId":"r7","id":1,"ok":true,"value":{"matches":[],"truncated":false}}
C→P {"v":1,"type":"out","runId":"r7","item":{"type":"text","text":"…"}}
C→P {"v":1,"type":"done","runId":"r7","ok":true,"bindings":[]}
```

`reply` 失败用 `ok:false,error:{code,message}`，`done` 失败用同形错误且无绑定提交。`out.item` 只接受 MCP text/image 的固定结构。正常 `call` 只派发已枚举的 `cua`/`app` 方法，拒绝任意 RPC 方法、窗口提升、`source` 覆盖和没有本轮权限的句柄。由原生回调通过 `JSObjectMakeDeferredPromise` 把 `call` 转成 Promise，I/O 队列收取回复，单一 JSC 队列执行 resolve/reject。每轮上限建议为 **64 KiB 源码、64 KiB 持久状态、32 次调用、一次在途桌面 RPC**。桥接回复单行硬限 2 MiB。最终 MCP `result` 序列化后的 UTF-8 **总计 256 KiB**，包含图片 base64、错误和 pill。按完整项或 UTF-8 边界截断，预留一条截断提示，整张超限图片省略。Broker 再做一次独立计数。

### 4. Seatbelt、JSC 与资源限制

启动顺序固定为**最小环境和描述符 → 资源限制 → `sandbox_init` → JSC 启动自检 → `ready` → 读用户脚本**。runner 只保留 0/1/2 的受控 I/O 描述符。`sandbox_init` 用签名二进制内嵌的 profile 调 `sandbox_init(profile, 0, &error)`，释放 error buffer。当前 SDK 将此 API 标为 deprecated，且公开头文件不承诺 `flags=0` 的自定义 profile 行为。这条调用和 profile 必须在支持的每个系统上通过启动自检。失败返回 `SANDBOX_UNAVAILABLE`。Chromium 的 Seatbelt 实现也是参考资料，方便施工者核对 SBPL 和预打开文件描述符的语义。[Chromium Seatbelt 设计](https://github.com/chromium/chromium/blob/main/sandbox/mac/seatbelt_sandbox_design.md) · [Chromium macOS sandbox 说明](https://github.com/chromium/chromium/blob/main/sandbox/mac/README.md)

`strict.sb` 的**首轮验证基线**如下。`file-read*` 和可执行映射限系统框架、库与 dyld。ICU 和时区目录仅只读。`sysctl-read` 只开列出的键。网络包括 TCP、UDP、loopback 和 Unix socket。新建进程、文件写入和 Mach service lookup 由默认拒绝覆盖。

```scheme
(version 1)
(deny default)

(allow file-read-metadata
  (literal "/")
  (literal "/System")
  (literal "/System/Library")
  (literal "/usr")
  (literal "/usr/share"))

(allow file-read* file-map-executable
  (subpath "/System/Library/Frameworks")
  (subpath "/usr/lib")
  (subpath "/System/Library/dyld")
  (subpath "/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld"))

(allow file-read*
  (subpath "/usr/share/icu")
  (subpath "/usr/share/zoneinfo")
  (subpath "/private/var/db/timezone/zoneinfo"))

(allow sysctl-read
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.cachelinesize"))
```

实际遇到 dyld、ICU 或 JSC 初始化失败时，用同签名、同 profile 的诊断构建定位到具体系统资源，再补最窄的白名单。CI 同时做正向验证和拒绝验证，防止解决启动问题时意外开放用户目录或 socket。`cua` 是经过 Broker 的桌面能力。沙箱网络禁令约束 runner 进程，经授权操作的桌面应用仍有自己的网络权限。

- **JIT/WASM。** 在第一个 VM 前从干净环境注入 `JSC_useJIT=false`、`JSC_useWasm=false`、`JSC_validateOptions=true`。当前 WebKit 的选项名是 `useWasm`。历史构建逐一验证，以启动自检及发布测试的实际结果判定。冻结前确认 WASM 未暴露，再移除或锁定相关全局。runner 启用 Hardened Runtime，签名无 JIT、unsigned executable memory 或关闭 library validation 的例外。 [WebKit JSC 选项](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/OptionsList.h) · [WebKit 选项加载与联动](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/Options.cpp)
- **Realm。** 只用 JSC C API 装配数据桥，使用 `Reflect.ownKeys`、属性描述符和 `WeakSet` 遍历 primordials、原型及暴露 API，冻结 `Object/Array/Function/Promise` 等根及其原型，安装只读 host bindings。遍历属性描述符时避免求值 getter。用户变量留在本轮词法环境。动态代码生成可用经验证的 `JSGlobalContextSetEvalEnabled` SPI 禁用，host 通过 `JSEvaluateScript` 装载已生成的严格 async 包装。脚本数据经固定 schema 传递，避免把 Objective-C/Swift 对象暴露给脚本。 [WebKit JSC SPI 声明](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/API/JSContextRefPrivate.h)
- **超时。** 用 `dlsym` 检查 `JSContextGroupSetExecutionTimeLimit`，在每次进入 JSC 时按剩余 CPU 预算设置。初值为 2 秒 CPU，进程设 `RLIMIT_CPU` 软限 2 秒、硬限 3 秒。Broker 墙钟维持默认 30 秒、上限 300 秒，涵盖等待 Promise 的时间。超时、接管或请求取消时由 Broker `SIGKILL` 并回收该 runner。启动、源码解析与输出也纳入预算，另用进程内存监测和 Broker 并发上限控制峰值。SPI 缺失、`Intl` 自检失败或资源限制安装失败时，严格 runner 不进入 `ready`。 [WebKit Watchdog 实现](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/Watchdog.cpp)

## Phase 2 · 硬件小窗推流

### 5. Swift、Broker、WebView 的线路

桌面 helper 通过两条短路径 UDS 连 Broker。控制线传 NDJSON，画面线传二进制。这样大 IDR 和慢客户端不会堵住接管通知。Broker 在 `0700` 的运行目录内创建 socket 和 `0600` 的 rendezvous 文件，用一次性随机凭证绑定两个通道与 `brokerBootId`。helper 启动参数只携带 rendezvous 路径。控制消息使用 `{v,id,op,…}` 和同 ID 回复，操作限定为 `probe`、`listWindows`、`setTakeoverTargets`、`start`、`stop`、`keyframe`、`shutdown`，另有带单调时间的 `intent` 与 `streamStatus` 通知。控制线断开即结束 helper 和所属流。

**Swift → Node 与 Node → 浏览器共用 40 字节头。** UDS 按长度读包，WebSocket 每条二进制消息承载一个完整包。多字节字段一律大端。

| 偏移 | 类型 | 含义 |
|---|---|---|
| `0` | `4 bytes` | ASCII `CUV1` |
| `4` | `u8` | `1=CONFIG`、`2=ACCESS_UNIT`、`3=STATUS` |
| `5` | `u8` | bit 0 为真 IDR，仅用于 AU。其他位为零 |
| `6` | `u16` | `headerBytes=40` |
| `8` | `u32` | `streamId`，本次 Broker 启动内不复用 |
| `12` | `u32` | `generation`，配置或编码器重建时递增 |
| `16` | `u32` | AU `seq` 从 1 增长，其他包为 0 |
| `20` | `u32` | `payloadBytes`，CONFIG 最多 16 KiB，AU 最多 2 MiB，STATUS 最多 4 KiB |
| `24` | `u64` | `ptsUs`，本代流内单调微秒 |
| `32` | `u32` | `durationUs`，未知为 0 |
| `36` | `u32` | 保留，必须为 0 |

`CONFIG` 为 UTF-8 JSON，字段为 `{codec,avcC,codedWidth,codedHeight,displayWidth,displayHeight,targetKey,geometryRev,contentRectPt}`。`avcC` 用 base64 表示配置记录。`codec` 从 `avcC` 的 profile、compatibility、level 字节生成 `avc1.PPCCLL`。AU 里每个 NAL 前是四字节大端长度，整条 AU 对应一个 `EncodedVideoChunk`。VT 输出如用其他 NAL 长度字段，要一起标准化 AU 和 `avcC`。先检查实际 NAL type 5，再标 `key`。通过 `CMSampleBuffer` 的 format description 取 SPS/PPS 和 AVC 配置。不要把 sync attachment、单个 NAL 或固定的 profile 字符串当成完整解码契约。[W3C AVC WebCodecs 注册](https://www.w3.org/TR/webcodecs-avc-codec-registration/)

**订阅握手**

1. UI 先按现有方式连 SSE，打开 JPEG。检查 `isSecureContext`、`VideoDecoder` 和 `EncodedVideoChunk`。本地 loopback 具有可信来源条件，实际 Aux Pane 宿主策略仍由运行时检查决定。[Secure Contexts](https://www.w3.org/TR/secure-contexts/) · [WebCodecs](https://www.w3.org/TR/webcodecs/)
2. `POST /api/video/subscribe {viewId,targetId}` 用现有 sidecar token 认证。Broker 返回 `{mode:"probe",streamId,wsPath}` 或 `{mode:"jpeg",reason}`。`wsPath` 内是 10 秒一次性 ticket，绑定小窗、目标和 Broker boot。WebSocket upgrade 检查 loopback、准确的 `Host` 和 `Origin`、RFC 6455 version/key、ticket 和 `cua.h264.v1` 子协议。客户端控制走 HTTP，WS 入站只处理限长、带 mask 的 close/ping/pong。拒绝其他入站数据和扩展，关闭时显式释放已升级的 socket。[RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)
3. 收到 CONFIG 后，用**真实**配置调用 `VideoDecoder.isConfigSupported({codec,codedWidth,codedHeight,description,optimizeForLatency:true})`，其中 `description` 是解码后的 `avcC` 字节。支持后 `configure()`，通过 `POST /api/video/control` 发 `decode_ready {viewId,streamId,generation}`。Broker 请求 IDR，订阅从该 IDR 开始。
4. 首个解码帧在有效代际内绘制到 canvas 后，UI 上报 `rendered`。Broker 此时才取消**该 view** 的 JPEG 轮询需求。JPEG、WS 和解码回调都用 view generation 拒绝迟到的绘制。每个 `VideoFrame` 在绘制或丢弃后关闭。
5. 支持探测失败、WS 不通、首帧未在 2 秒内画出，立即向该 view 恢复 JPEG。序号跳变或解码积压则暂停喂入增量帧，请求一次 IDR 恢复。解码器报错时新建 decoder。恢复在 1 秒内仍无可画 IDR，就回 JPEG。权限拒绝和 codec 不支持在能力状态变化前不循环重试。

**编码、流管理和恢复**

- 选 `SCContentFilter(desktopIndependentWindow:)`，匹配 `ownerPID + processToken + CGWindowID`。选窗顺序是用户/`act` 已验证的显式 WID、已证明的动作窗口、首次选择时明确唯一的主窗口。捆绑标识、标题和面积可用于选择候选。实际回调只允许既定 WID。禁止捕获流程触发激活、移窗、取消最小化或自动改选弹窗。小窗把主窗和弹窗显示为不同窗口。 [Apple 单窗口捕获与遮挡说明](https://developer.apple.com/videos/play/wwdc2022/10155/)
- 每个目标一套 `SCStream + VTCompressionSession`，同目标订阅共享。首版上限 **两个活动目标**，所有观看者离开后保温 3 秒。单窗口 20 fps 上限，只消费有效的新画面，`queueDepth=3`，关闭音频及系统光标，使用无阴影内容。按有效源像素计算长边最多 1280，偶数尺寸用于 4:2:0，保留逻辑宽高比。裁切、尺寸或参数集变化发布新 generation 和 CONFIG。
- VT 要求硬件编码，并读取实际选择的编码器属性。优先 `H264_ConstrainedBaseline_AutoLevel`，可尝试同为硬件的 `Baseline_AutoLevel`。`RealTime=true`、`AllowFrameReordering=false`，初值 2.5 Mbps，GOP 上限 40 帧/2 秒。可用时打开 low-latency rate control，必需属性失败时降级 JPEG。客户端加入、切窗、resize、解码恢复时请求 `ForceKeyFrame`，以实际 IDR 确认生效。静止画面可重编码同 WID/同几何最后一张有效像素缓冲，用新的单调 PTS 产生 IDR。 [Apple 硬件编码约束](https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_requirehardwareacceleratedvideoencoder) · [Apple VT 压缩属性](https://developer.apple.com/documentation/videotoolbox/compression-properties)
- **分别跟踪控制心跳、SC 采样状态和 VT 输出。** 控制心跳每 500 ms，连续 3 次缺失判 helper 失联。`.idle` 对已知健康的静止窗口有效。连续 2 秒无采样反馈且无法确定静止时，做一次限时同 WID 截图探测，鉴别静止与采集停滞。`.blank`、`.suspended`、窗口消失或 VT 有输入无产出进入恢复。普通遮挡继续用单窗口流，最小化后优先尝试同窗口 JPEG。替代源也取不到时显示“画面暂停”，冻结或清空旧图并关闭坐标输入。 [Apple SCStream 帧元数据](https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo) · [Apple 单窗口最小化行为](https://developer.apple.com/videos/play/wwdc2022/10155/?time=814)
- **背压按订阅隔离。** 优先在编码前丢弃尚未提交的原始帧。编码后若某订阅丢了 AU，该订阅跳到 `await_idr`，丢弃依赖旧参考帧的后续 AU。服务端每连接只允许一个最大 AU 加有界待写队列。积压超过 300 ms 断开慢连接，让该 view 降级。UI 的 `decodeQueueSize > 4` 同样走 IDR 恢复。控制通道和其他订阅继续处理。

### 6. 同一幅画面的坐标契约

`PreviewGeometry` 分别记录窗口逻辑坐标、预览有效内容矩形、OCU 动作截图有效内容矩形。标识为 `{brokerBootId,viewId,targetKey,geometryRev}`，帧另有 `{transport,streamId,generation,seq}`。`targetKey` 包括 PID、进程代际、WID 和本次观察的窗口代际。helper 从实际像素缓冲和 SC attachments 得到裁切，验证 `contentRect`、`scaleFactor`、`contentScale` 与窗口逻辑尺寸的关系。包括 Retina、异缩放显示器和有 padding 的 resize 帧。拿不到可信几何时标为只读。 [Apple 窗口内容裁切和缩放说明](https://developer.apple.com/videos/play/wwdc2022/10155/?time=276)

```text
n = (指针 CSS 坐标 - 可见图像 CSS 矩形原点) / 可见图像 CSS 尺寸
p = 预览有效内容矩形的窗口局部逻辑点原点 + n × 逻辑尺寸
a = 把 p 投影进同一 WID 的 OCU 动作截图坐标系
overlay = (动作实际逻辑点 - 当前预览内容原点) / 当前预览逻辑尺寸
```

用实际绘制矩形作为 canvas 和虚拟光标的共同定位容器。长宽比取有效内容的逻辑宽高，点在黑边外直接拒绝。取整只发生在最终 OCU 像素接口。例子中窗口为 `1000×600 pt`，H.264 有效图区域为 `960×576 px`，JPEG 动作截图为 `1280×768 px`。两种画面上的 `(0.75, 0.25)` 都落在 `(750,150) pt`，使用 OCU 像素路径时派发 `(960,192)`。视频尺寸不再参与 OCU 截图缓存的新鲜度判断。可复用已有的逻辑点与截图像素转换函数。[现有坐标转换函数](../../src/action-executor.mjs#L74)

`/api/interact` 提交当前**实际绘制**的帧引用、`normX/normY` 和 `intentId`。wheel 也带指针位置，校验后走同 WID 的滚动投递或已验证的 AX 可滚动容器。Broker 在入队前以及派发前校验 view、窗口与几何。旧图、切窗、resize 或 WID 归属变化返回 `409 STALE_VIEW`。同一窗口、同一几何的静止帧可继续点击。JPEG 新客户端按帧引用获取对应图像或过期响应，避免用旧 `seq` 拿到一张新窗口的“最新 JPEG”。`action` 事件携带真实逻辑点和目标引用，只在匹配的小窗画光标。没有坐标证据的动作只显示文字。

**任意点点击的发布条件。** 视频看到指定 WID，只证明抓到了它。派发端还要有以下能力之一。

| 动作来源 | 开放条件 |
|---|---|
| **OCU 坐标点击** | OCU 提供有出处的同 WID 动作截图，并能在投递时原子校验 `windowId + actionViewportId`，或等价的原生窗口句柄。先核对安装版 `tools/list` 和实机行为。当前源码不能证明这条契约。若上游缺字段，施工要把它列为 OCU 版本依赖。 |
| **窗口本地投递** | 已授权的 JXA 路径可校验 owner、WID、实时布局和局部坐标，用现有 `window_post`/`window_scroll` 投递。指定 WID 的路径拒绝降级成 app 级猜测。 |
| **只有 OCU AX 路径** | 同 WID 的 `query`、qualified ref 和现有 `act`/元素 `sky_click` 可以继续通过。可提供明确的元素级操作。无法证明任意点落到同窗时，小窗标为只读。 |

对于 OCU-only 安装，原先的应用跟随 JPEG 模式仍可作为兼容路径。新加入的显式 WID、多窗口坐标能力以表中的证明为准。**如果剪映在本机只有 OCU 获权时也必须支持显式固定窗口的任意点和滚动，就把 OCU 同窗截图与派发契约列为 Phase 2 的上线依赖。** 时间戳、标题、尺寸或刚跑过 `query` 都无法补足这个证明。

## TCC、打包与降级

桌面 helper 安装在 `~/.gemini/codex-style-computer-use/native-runtime/CUADesktopHelper.app`，用你控制的正式 Bundle ID，设置 `LSUIElement`。Broker 可用 `open -n -g -j -a <app> --args --rendezvous <path>` 经 LaunchServices 启动，按 Broker boot 做 single-flight。脚本 runner 单独签成 `CUAScriptRunner.app`，由 Broker 直接 spawn 其绝对可执行路径。桌面 helper 负责屏幕录制和输入监控，脚本 runner 无桌面授权依赖。首次授权与覆盖升级都要用**真实启动链**验收 TCC 显示的责任身份。稳定 Developer ID designated requirement 是跨版本识别基础，ad-hoc 供开发验收且使用独立 ID。 [Apple designated requirement](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements/) · [Apple 非激活启动配置](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration)

`/api/permissions` 增加 `version:2` 和 `ocu.action`、`ocu.stream`、`jxa`、`desktopHelper`、`scriptRunner` 的分项诊断，含 `checkedAt`、身份和状态。将 **preflight、实际能力、具体 view 的 transport** 分开表示。例如 helper 录屏已授权，当前 view 仍可能显示 `JPEG · WebCodecs 不可用`。只有用户主动点击某项授权时才调用该 helper 自己的 `CGRequestScreenCaptureAccess` 或 `CGRequestListenEventAccess`。OCU 权限来自 OCU 自身可验证诊断或实际探测，不用 JXA 结果推断。

| 实际条件 | 小窗 | 桌面操作与接管 |
|---|---|---|
| 两边权限齐全、硬编和 WebCodecs 可用 | H.264，按目标共享，多流并行 | 已证明的同窗操作、增强接管、高级权限按实际能力显示 |
| **只有 OCU 授权** | OCU `streamPeer` JPEG/SSE | OCU 动作。基础接管。显式 WID 任意点开放范围见上表 |
| helper 录屏可用，OCU AX 缺失 | H.264 或可用的 JPEG，视图可只读 | 可用 AX 路径单独判断。增强接管取决于输入监控 |
| helper 输入监控可用，录屏缺失 | OCU JPEG，或无画面 | 增强接管仍可用 |
| WebCodecs 不可用、硬编繁忙或捕获失败 | 回同目标 JPEG。JPEG 也不可用时显示具体原因 | 操作能力独立于编码器 |
| 权限全缺或桌面 helper 缺失 | 使用已具备权限的旧画面来源。都不可用时显示空态 | 显式暂停可用。严格 `js` 仍可运行纯脚本，桌面调用返回具体权限错误 |
| 脚本 runner 缺失、签名不通过或 Seatbelt 自检失败 | 根据实际视频能力显示 | `js` 返回 `SANDBOX_UNAVAILABLE`。结构化 MCP 仍按已授权路径工作 |

发布机分别用 `arm64-apple-macos14.0`、`x86_64-apple-macos14.0` 构建，`lipo -create` 后签名。用 Developer ID Application、Hardened Runtime、时间戳、公证和 `stapler`。校验两片架构、最低版本、签名、预期 Team 和 bundle identifiers。当前外层 ZIP 已处理中文名与 executable mode，可保留。将每个已签名、已 staple 的 `.app` 用 `ditto` 制成**内层 ZIP**，外层只存其字节和版本清单。安装时受控解包到 staging、验证，再原子替换同路径 `.app`。收窄现有的递归清 quarantine 路径，保留新 payload 的 Gatekeeper 校验。升级失效时保留符合当前协议的上一个已验证产物，或禁用对应能力。安装机无需 `swiftc`、CLT 或部署期重签。 [现有打包入口](../../scripts/pack-share.mjs#L166) · [现有安装 staging](../../scripts/installer-lib.mjs#L398) · [Apple 公证和 staple](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)

## 文件分工与施工顺序

下列新文件名以项目根目录为基准，供施工使用。

| 阶段 | 新模块 | 现有接入点 |
|---|---|---|
| **1A 刹车** | `native/DesktopHelper/{main.swift,Info.plist,DesktopControl.swift,WindowInventory.swift,TakeoverSensor.swift}` 负责控制 IPC、窗口身份和来源判定。`src/desktop-helper-client.mjs` 管理生命周期与能力。`src/takeover-controller.mjs` 提供 `admit`、`setTarget`、`assertMayDispatch`、`requestPause`、`resume`。 | `broker-sidecar.mjs` 管 controller、目标和 drain。`sidecar-web-adapter.mjs` 把暂停、恢复、置顶和手动交互交给 controller。`action-executor.mjs`、`native-peer.mjs`、`ax-bridge.mjs` 在最终发送处检查许可。`focus-policy-guard.mjs` 接入人类焦点意图版本。 |
| **1B 沙箱** | `native/ScriptRunner/{main.swift,Info.plist,Seatbelt.c,Seatbelt.h,strict.sb,JscRunner.swift,bootstrap.js}`。`src/repl-runner.mjs` 提供 `run(session,request,operation)`、`reset(session)`、`close(session)`，负责协议、状态与看门狗。`src/repl-schema.mjs` 固化工具定义、参数映射及 allowlist。 | `mcp-repl-server.mjs` 改成 Broker `repl/*` 客户端。`mcp-server.mjs`、`broker-client.mjs`、`jsonrpc-stdio.mjs` 衔接生产主 Broker、取消和禁止重放。`broker-sidecar.mjs` 按连接持有 REPL 状态。 |
| **2A 同窗 JPEG 与坐标** | `src/preview-geometry.mjs` 提供 `validateFrameRef`、`mapToWindowPoint`、`mapToActionPixel`、`projectCursor`。 | `AppSnapshotRegistry` 提供有出处的动作几何。`broker-sidecar.mjs` 统一选窗和交互，`sidecar-web-adapter.mjs` 发可校验的 JPEG 帧引用。`ui/index.html` 切换为按真实绘制矩形取点。 |
| **2B H.264** | `native/DesktopHelper/{CaptureSession.swift,H264Encoder.swift,VideoWire.swift}`。`src/preview-stream.mjs` 负责流引用计数、JPEG/H.264 状态和代际。`src/video-websocket.mjs` 负责 upgrade 和有界传包。`src/ui/preview-video.js` 管 decoder 和切换。 | `sidecar-web-adapter.mjs` 增加订阅和控制端点。`ui/index.html` 复用同一个 canvas 和光标层。`broker-sidecar.mjs` 将观看选择与动作目标各自接到所属模块。 |
| **发布** | `scripts/build-native.mjs`、`src/native-distribution.mjs` 和 `scripts/verify-live-native.mjs`。 | `constants.mjs` 定义协议、路径及上限。`pack-share.mjs`、`installer-lib.mjs` 管内层载荷和升级校验。安装和卸载入口报告各能力状态，并按归属回收本项目进程及 socket。 |

**灰度顺序**为 1A → 1B → 2A → 2B。Phase 1 可以用现有 JPEG 完成全部接管验收。Phase 2A 先证明 JPEG 的同窗坐标，再给少量机器启用 H.264。视频回滚开关建议为 `AGY_CUA_VIDEO=jpeg`。严格脚本的回滚开关为 `AGY_CUA_JS=off`。两项可以独立处理。

## 验收计划

CI 用注入的 peer、helper、时钟和 decoder 测试替身，常规 `npm test` 不触发 TCC 弹窗。建议新增以下测试组，每组和所属变更一起交付。

| 测试文件 | 必须通过的断言 |
|---|---|
| `test/takeover.test.mjs` | Antigravity 里的鼠标和键盘不会锁存。覆盖窗、同 PID 不同 WID、来源不明和合成标签不会误停。目标真人按下、热键和小窗手动动作各锁存一次。暂停发生在 `ensureStarted()` 中间时，旧动作实际写 IPC 次数为 **0**。模拟已发送未确认时，手动写等 drain。取消后快速恢复也不能发出旧 epoch 的动作。 |
| `test/repl-sandbox.test.mjs` | `var app = await cua.getApp(...)` 后下一轮可调用 `app.query`。验证 `const` 重声明、JS 异常、断连、`js_reset`、CPU 死循环、永不 resolve 的 Promise、晚到 RPC 和输出恰好跨越 256 KiB。取消或 child crash 后无重放。验证 `repl/run` 与嵌套 `cua` 没有队列死锁。 |
| `test/preview-geometry.test.mjs` | 上述 `1000×600 pt` 样例经 JPEG 与视频落点一致。Retina、负屏幕原点、跨不同缩放屏、黑边、resize、同 app 换 WID、WID 复用、旧 JPEG 回调都覆盖。无同窗证明时实际写次数为 **0**。 |
| `test/video-wire.test.mjs` | 对照固定字节样本校验 40 字节头、SPS/PPS、AVCC、切包、非法长度、IDR、旧 generation、慢消费者、静止保活、挂流与回 JPEG。一个订阅过慢时，另一个订阅和接管控制仍前进。 |
| 扩展 `test/installer.test.mjs` | 任一 payload 缺失或签名错误时独立降级。同路径覆盖、原子回滚、中文文件名与 executable mode、现有 MCP 自定义项及 other sidecars 的配置得到验证。 |

`verify-live-native.mjs` 实现为可重复的本地验收入口，输出 JSON 证据并对未通过的门槛返回非零。先用本地双窗口 fixture，最后用剪映的临时工程复验。

1. **沙箱。** 在生产签名下执行同一套 `Intl`、中文、Promise、JS 自检及原生拒绝探针。用临时 fixture 测试文件读写、loopback、Unix socket、进程启动均被拒绝。用死循环和 pending Promise 分别证明 CPU 限制和墙钟限制。覆盖 macOS 14、15、26 和当前使用的 27，在各系统实际支持的架构上跑。按真实系统 build 记录，避免用 brief 中的 `16` 标签替代机器版本。[Apple macOS 发行说明](https://developer.apple.com/documentation/macos-release-notes)
2. **后台控制。** 让 Antigravity 前台实际持续打字和点击，后台由 `act` 对剪映测试窗口做含滚动和 `expect` 的操作。用可验证的 `frontmost PID`、AX/画面状态和物理光标位置记录结果。先验收 **零误停、零非预期置顶、零物理指针移动**，再分别测试真人点目标、系统切换、全局急停与小窗单击。每种在寻找元素、原生发送前、发送后等待 `expect` 三个阶段各跑一次。验收判据是已确认接管后 **零新增原生写**。建议输入确认到 Broker 锁存 P95 ≤ 75 ms。
3. **流与坐标。** 在真实 Aux Pane 记录 `isSecureContext`、实际 AVC 配置、第一帧和 decoder 错误。并开两个目标，做完整遮挡、最小化、resize、跨 Retina 屏、剪映促销弹窗、撤权限、断 helper 和不支持 WebCodecs 的演练。点击 fixture 四周和中心并核对实际落点。建议有连续变化时每流目标 20 fps、采集到绘制 P95 ≤ 180 ms、热切窗首帧 P95 ≤ 750 ms。故障时先报告 JPEG 状态，再验证第一张**同 WID** JPEG。没有可验证图像时，验收的是旧图不可互动。
4. **签名和升级。** 在干净用户上用一键包安装、按需授权，验证实际显示的 TCC 责任身份。用同一 Team、Bundle ID 和路径覆盖新版本，重新验证录屏与输入 tap。另测只有 OCU 授权和无 CLT 的安装机。用真实结果决定是否默认启用 H.264。

**上线最关键的两项证据**是已发送动作排空后的接管结果，以及 OCU-only 配置下显式 WID 的同窗派发证明。前者决定后台工作能否安全交给用户，后者决定能否在本机为任意点点击开放新小窗。两项都能在开始 H.264 接入前验证。