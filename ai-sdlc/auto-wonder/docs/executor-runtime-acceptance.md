# 执行器验收与海外版 Qoder 对照

## 2026-11-15 本轮复核与真实派发重跑

Community Docker 生命周期 `aw-e2e-3aa8ea9211-debe55e7` 从 `3aa8ea9` 加本次参数复核与文档修订的候选构建。Maven `clean verify` 通过，Java 测试 8,897 项，0 失败、0 错误、1 跳过；前端全量测试 4,402 项通过、1 跳过，国际化检查通过。`verify.sh --check` 标准门禁（健康、鉴权链、JSON 协议回归、日志归因）全部 PASS。本机环境需要 JDK 21（Homebrew mvn 默认指向更高版本 JDK 时编译失败）与 docker-java API 版本兼容设置（`~/.docker-java.properties` 的 `api.version`），见下文「本地点验」。

| 终端 | 实测版本 | 显式模型与推理配置 | 执行环境 | 派发 / 产物 |
| --- | --- | --- | --- | --- |
| Claude Code | `2.1.311` | `glm-5.3`，`low` | Linux Docker，百炼（2026-11-14 归档） | 10000 / 10000 |
| Codex CLI | `0.167.0-alpha.4.1` | `gpt-6.1-sol`，`low` | macOS，独立登录目录（2026-11-14 归档） | 10001 / 10001 |
| OpenCode | `2.2.7` | `bailian/glm-5.3#delivery` | 官方 Linux npm 二进制运行于 Docker，百炼（本轮重跑） | 10000 / 10000 |

平台内置运行时版本为 `community-e7f18923bcf5`，与 2026-11-14 归档证据所用哈希一致（本轮逐字节复核）。本轮 `--check --with-runtime` 以 `AW_E2E_RUNTIME_PROVIDER=opencode` 重跑真实派发：生成的启动命令含 `--model bailian/glm-5.3#delivery`，执行器经 Docker 内 OpenCode 2.2.7 连接百炼完成任务，`dispatch_succeeded` 与 `downloaded_artifact_matches`（SHA-256 `b55b6123…34b9c8`）均通过，检查项含 `generated_launch_model`。Claude Code 与 Codex CLI 的同哈希归档派发证据保留在 `.e2e-results/aw-e2e-3aa8ea9211-2f80a94c/`。Docker 内 CLI 通过路径转发脚本以相同绝对路径挂载任务目录与 XDG 目录；macOS 直连百炼的 `ECONNRESET` 现象与上轮一致，未在本轮 Docker 路径出现。

## 2026-11-14 参数复核

Community Docker 生命周期 `aw-e2e-3aa8ea9211-2f80a94c` 从 `3aa8ea9` 加本次参数复核候选构建。Maven `clean verify` 通过，Java 测试 8,897 项，0 失败、0 错误、1 跳过。前端全量测试 4,402 项通过、1 跳过，执行器页面的 193 项用例全部通过。前端国际化检查器 14 项、Python 验收脚本 41 项、Node 启动参数直接断言 7 项均通过。

| 终端 | 实测版本 | 显式模型与推理配置 | 执行环境 | 派发 / 产物 |
| --- | --- | --- | --- | --- |
| Claude Code | `2.1.311` | `glm-5.3`，`low` | Linux Docker，百炼 | 10000 / 10000 |
| Codex CLI | `0.167.0-alpha.4.1` | `gpt-6.1-sol`，`low` | macOS，独立登录目录 | 10001 / 10001 |
| OpenCode | `2.2.7` | `bailian/glm-5.3#delivery` | 官方 Linux Docker 镜像，百炼 | 10002 / 10002 |

平台内置运行时版本为 `community-e7f18923bcf5`。三个 provider 的 `verify.sh --check --with-runtime` 均返回 `VERDICT=PASS`。验收核对了命令参数、上线、路由、ACKED、RUNNING、SUCCEEDED、下载字节与摘要、日志门禁和测试对象清理。本机证据保存在 `.e2e-results/aw-e2e-3aa8ea9211-2f80a94c/`。派发策略在达到阈值后覆盖启动模型的路径经过代码复核，实际派发场景使用已保存的启动模型。

本机 macOS 直连百炼时，OpenCode 的部分请求复现 `ECONNRESET`，同版本官方 Linux Docker 镜像通过真实派发。海外版 Qoder 以 npm 运行时源码和回归测试为基准，本轮缺少可用 CLI 和已注入 Token。Windows 启动命令由服务端回归覆盖，真实派发在上表所列环境执行。

## 2026-11-13 首轮真实 CLI 验收

2026-11-13 的 Docker Community 生命周期 `aw-e2e-555edaf3ed-66d7ea0a` 使用 `555edaf` 加 OpenCode 候选源码，之后提交为 `3aa8ea9`。平台内置运行时为 `community-6a03d742aa59`。选择器的版本提示使用以下验收版本。

| 终端 | 实测版本 | 执行环境 | 派发 / 产物 |
| --- | --- | --- | --- |
| Claude Code | `2.1.311` | Linux Docker，百炼按量计费，GLM 5.3 | 10001 / 10001 |
| Codex CLI | `0.167.0-alpha.4.1` | macOS，独立登录目录 | 10002 / 10002 |
| OpenCode | `2.2.7` | macOS，独立 XDG 目录，百炼 GLM 5.3 | 10000 / 10000 |
| Qoder CLI（海外版） | 未记录真实 CLI 版本 | 对照本机缓存的 `@alicloud/autowonder@0.3.43` 源码和仓库回归测试 | 本轮缺少海外版 CLI 和已注入 Token |

三个实际场景都核对了平台生成命令、执行器上线、路由归属、ACKED、RUNNING、SUCCEEDED、下载字节与 SHA-256、日志门禁和测试资源清理。后端测试 8,894 项，0 失败、0 错误、1 跳过。执行器页面测试 189 项，验收脚本测试 41 项，均通过。前端全量并发运行中有两条非执行器用例超时，隔离复测通过。macOS 原生 Claude Code 的非交互调用曾复现 ECONNRESET，该场景使用同版本 Linux CLI 验收。

本机证据位于 `.e2e-results/aw-e2e-555edaf3ed-66d7ea0a/`，其中三个 `*-runtime-dispatch.json` 分别记录派发和产物。

## 启动参数与映射

对照基准是海外版 `QODER_CLI → qoder`。入口是页面或 MCP 的持久化配置与命令生成，CLI 认证和模型目录由执行机负责。

| 启动参数 | 海外版 Qoder | Claude Code | Codex CLI | OpenCode |
| --- | --- | --- | --- | --- |
| `--ws-url`、`--token`、`--executor-id`、`--provider` | npm connect 认证及路由 | 同一 WebSocket 认证与归属 | 同左 | 同左 |
| `--max-tasks` | 平台默认 5，配置范围 1–10，npm 直调默认 10 | 同一平台范围与默认值，限制接单容量 | 同左 | 同左 |
| `--workspace-root` | 支持环境变量与 `~/`，含仓库工作区 | 支持显式路径、环境变量及 `~/`，每次派发使用独立临时目录 | 同左 | 同左 |
| `--name` | daemon 标识，可影响本地进程管理 | 平台连接名称，派发归属仍使用 executor ID | 同左 | 同左 |
| `--memory-mode` | `platform`、`none`；npm 文档记载 `provider-local` 可解析但任务执行失败 | `platform` 解包平台记忆，`none` 跳过记忆文件，`provider-local` 保留本机新会话 | 同一模式，临时会话使用 `--ephemeral` | 同一模式，临时会话使用内存数据库 |
| `--model` | 通过 Qoder 实时目录验证并传入 | 可选，映射到 `--model` | 可选，映射到 `--model` | 可选，映射到 `--model`，使用 `provider/model` 或 `provider/model#variant` |
| `--reasoning-effort` | 按 Qoder 模型目录约束 | 映射到 `--effort`，支持 low、medium、high、xhigh、max，网关可进一步限制 | 映射到 `model_reasoning_effort`，支持 none、minimal、low、medium、high、xhigh，取决于模型 | 在模型 ID 中使用 `#variant`，支持的变体由 OpenCode 模型目录决定 |
| `--context-window` | 由 Qoder 模型窗口枚举控制 | 不支持：平台保存时拒绝该参数（`executor.command.context_unsupported`），窗口由 CLI 与模型配置管理 | 不支持：同左 | 不支持：同左，由 provider 的模型限制管理 |
| `--token-aware-enable` | Qoder Token 代理采集 token 用量 | 不支持 Token 代理与用量采集，直接使用本机 CLI 或网关认证；在线命令编辑同样拒绝该参数 | 不支持：同左 | 不支持：同左，使用本机 CLI 或 provider 认证 |
| `--settings` | npm CLI 的 Claude 专用参数，传入本机 Claude settings 文件 | 不作为启动参数暴露；内置运行时固定读取执行机 `CLAUDE_CONFIG_DIR`（默认 `~/.claude`）下的 `settings.json`（含模型回退），语义上覆盖该能力 | 不适用 | 不适用 |
| `--QODER_PERSONAL_ACCESS_TOKEN` / `--QODERCN_PERSONAL_ACCESS_TOKEN` | npm CLI 接受内联个人令牌，认证由执行机注入 | 不适用；执行器连接只用平台 `--token`，CLI 认证由执行机环境与登录目录负责 | 不适用 | 不适用 |
| `--debug` | npm daemon 诊断输出 | 连接和脱敏错误码 | 同左 | 同左 |
| runtime 版本、重启及升级 | npm 稳定版本固定及受能力协商控制的远程操作 | 平台发布的模块内容标识，更新后重新复制命令在执行机启动；不支持在线固定 npm 版本（`executor.command.bundled_version_managed`） | 同左 | 同左 |

普通工单由同一调度器冻结任务、校验运行时能力、生成签名任务包。内置运行时校验下载字节与文件摘要、在隔离目录执行 CLI、提交产物，再向平台发送终态并处理确认。模型优先级是派发策略选中的模型、保存的启动模型、CLI 默认模型。

三种内置 CLI 的普通工单范围包括状态和交付物。仓库自动检出、任务环境变量绑定、阻塞 Hook、任务级 MCP、对话、检查点续跑、在线升级、跨进程重启的结果重放，以及 Qoder 的显式产物清单和交付门禁尚未覆盖。本机记忆模式保留新 CLI 会话文件，平台不会把后续派发绑定到旧会话。

## 业务与数据流复核

| 环节 | 共用入口 | 内置运行时处理 |
| --- | --- | --- |
| 注册与鉴权 | 执行器类型、启动配置、Token、`/ws/executor` | 平台根据类型生成命令。连接上报容量、运行时版本和协议特性，按执行器 ID 路由。 |
| 派发与输入 | `DispatchService`、`WsDispatchTransport`、签名任务包 | 解包工单、身份、SDLC 及按记忆模式选取的文件。按派发冻结结果选模型。 |
| 任务执行 | 接收、确认与进度事件 | 每次派发创建独立目录，由 CLI 适配层设置原生参数、读取输出并处理终止。 |
| 交付与终态 | 派发产物上传接口、`TASK_RESULT` 和确认 | 上传任务产物后提交成功终态，平台校验归属并保存。产物回传异常会进入失败终态。 |

代码入口为 `ExecutorLaunchConfigService`、`ExecutorLaunchCommandService`、`ExecutorLaunchCommandParser`、`WsDispatchTransport` 和 `src/main/resources/executor-runtime/{executor,engine,capsule}.mjs`。Qoder 源码对照使用 npm 包中的 `bin/cli.js` 与 `README.md`。OpenCode 参数依据 2.2.7 的 `opencode run --help` 和 [OpenCode CLI 模型文档](https://opencode.ai/docs/models)。

## 本地点验

用 [Community 验收生命周期](../e2e-tests/AGENT_GUIDE.md) 启动 Docker 环境，从输出的 `PLATFORM_URL` 进入 AutoWonder。在工作空间新建执行器时，悬停问号可查看推荐的实测 CLI 版本。启动命令在已配置所选 CLI 认证的执行机运行，连接成功后执行器显示在线。

本机 macOS 复现要点：构建须用 JDK 21（Homebrew 的 `mvn` 包装脚本在未设置 `JAVA_HOME` 时指向最新的 Homebrew JDK，过高版本会触发 Lombok 编译崩溃，运行前 `export JAVA_HOME` 指向 `openjdk@21`）；Docker 29.x 服务端最低 API 为 1.40，而 testcontainers 1.20.6 默认固定 1.32，需在 `~/.docker-java.properties` 写入 `api.version` 使真实 MySQL 兼容门测试跑通；Docker Hub 与 quay.io 在部分网络下不可达时，可用官方二进制自建 MinIO/mc 镜像并经 `AW_E2E_MINIO_IMAGE`、`AW_E2E_MC_IMAGE` 覆盖，社区镜像源亦可补齐 Dockerfile 基础镜像。

在工单详情点「启动交付」，选择对应的数字员工和已启用的 SDLC。用单步工单要求在 `artifacts/output/deliverables/` 下生成一个固定内容的文件。检查「执行记录」中的终态，再从「产物」下载文件核对内容。点验结束后可通过同一生命周期停止环境或清理容器和数据。
