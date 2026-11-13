# Claude Code 与 Codex CLI 执行器改造文件清单

平台层已接入 Claude Code 和 Codex CLI 的创建与补录。两种 CLI 使用执行机上的默认模型，MCP 创建结果的模型字段可为空。Harness 初始化继续使用 Qoder 类型白名单。

推荐版本 `@alicloud/autowonder@0.3.43` 的启动脚本拒绝这两种 provider，绕过启动脚本的 Codex 真任务也在引擎创建阶段失败。Community 通过平台生成的命令下载并校验随应用发布的 Node 模块，复用同一套调度与产物接口。Qoder 系列仍从原 npm 包启动。

首期让普通数字员工能新建 Claude Code 或 Codex CLI 执行器、给缺类型的旧记录补录，并用生成的命令上线接任务。两种 CLI 沿用执行机上的默认模型。参谋长引导和 Harness 模板初始化的扩容作为独立需求。

## 一、按 Qoder 现有链路对照

| 环节 | Qoder 当前实现 | Claude Code / Codex 首期行为 |
| --- | --- | --- |
| 类型与启动参数 | `QODER_CLI → qoder`，`QODER_CN_CLI → qodercn`。平台保存 `clientKind`，生成命令时再映射成 `--provider`。 | 复用已有 `CLAUDE_CODE → claude`、`CODEX_CLI → codex` 映射。选择范围为这四种，现有 Cursor 映射仅供已有记录使用。 |
| 新建与补录 | 两处使用同一个前端选项列表。后端创建和补录共用可创建类型判断，补录在同一次带版本保护的写入中保存类型和配置。 | 两处都开放新类型，沿用校验、并发保护和命令生成。已绑定类型的执行器通过新建记录切换 provider。 |
| 启动配置 | Qoder 使用模型目录、推理强度、上下文窗口，启动命令还带 `--token-aware-enable`。 | 沿用记忆模式、并发数和工作目录。运行时版本是随平台发布的模块内容标识。首期命令的 provider 分别为 `claude`、`codex`，模型相关参数由 CLI 默认配置决定。 |
| 分发 | 服务端按数字员工、执行器状态和协议能力分发，模型目录有专门的 Qoder 协议。 | 沿用普通分发和结果回传。运行时下载并校验任务包，调用对应 CLI，回传进度、产物和终态。需要检查点续跑的派发会收到明确失败。 |
| Harness 初始化 | 按发布清单匹配角色模型族，并用实时 Qoder 模型目录冻结模型 ID。 | Harness 预览入口继续校验两个 Qoder 类型。普通执行器的四种类型与 Harness 支持列表分别维护。 |

## 二、产品文件与改动目的

| 文件 | Qoder 现状与改动目的 | 落地检查 |
| --- | --- | --- |
| `frontend/src/features/executor/ExecutorListPage.tsx` | `CREATABLE_CLIENT_KINDS` 目前由 `isQoderClientKind` 过滤。给新建和补录使用独立的四类型列表，`isQoderClientKind` 继续控制 Qoder 模型表单与目录查询。新建提交时按选中类型组装请求，避免 Qoder 默认值或切换残留进入 Claude/Codex 请求。 | 新建和补录均显示四种类型。切换到新类型后请求仍含通用字段，且无 `model`、`reasoningEffort`、`contextWindow`。 |
| `frontend/src/shared/i18n/locales/zh-CN/executor.json` | 补充执行器类型名称的语义键，供中文的新建、补录和列表显示使用。 | 中文界面显示产品名称。 |
| `frontend/src/shared/i18n/locales/en-US/executor.json` | 补齐相同语义键，供英文界面使用。 | 与中文资源键一致，切换语言后标签正常。 |
| `frontend/scripts/i18n-legacy-baseline.json` | 页面已有直接写入的类型标签。迁移标签后删除实际替换的字面量条目。 | 基线差异只包含本次迁移的记录。 |
| `src/main/java/com/aliyun/autowonder/executor/ExecutorLaunchOptionsService.java` | 目前可创建列表、校验和选项说明都假设只有两种 Qoder，`launchOptions` 还会无条件提供 Qoder 模型兜底。用同一四类型列表驱动通用校验与枚举，逐类型渲染说明，按 provider 组装模型选项。 | Claude/Codex 返回正确的 provider、通用记忆模式、空模型/推理强度/上下文列表及空默认值。Qoder 保留现有实时目录、兜底和默认值。 |
| `src/main/java/com/aliyun/autowonder/executor/ExecutorLaunchConfigService.java` | 缺类型补录调用通用判断，但拒绝时使用独立的固定错误文案。让该分支复用带错误码参数的共享校验，避免创建与补录各自维护支持范围。 | 两种新类型可一次补录并保存配置。已有类型不可改，旧记录的版本冲突行为保持。 |
| `src/main/java/com/aliyun/autowonder/executor/dto/UpdateExecutorLaunchConfigRequest.java` | 注释把可补录值写成两个 Qoder 类型。更新为由通用可创建类型决定，说明该字段只用于历史缺类型补录。 | DTO 字段、请求结构和存量兼容性保持。 |
| `src/main/java/com/aliyun/autowonder/mcp/McpToolService.java` | 创建、配置更新、查询启动选项的工具说明仍限定 Qoder，模型默认值 schema 也按字符串声明。同步通用四类型枚举及允许空值的 schema。两个初始化预览工具改读 Harness 专用类型列表。 | 通用工具可以创建并配置两种新类型，返回值与 schema 一致。工作区与 Harness 两个预览工具均只公布各自实际接受的类型。 |
| `src/main/java/com/aliyun/autowonder/harness/HarnessPreviewService.java` | 当前复用通用创建校验，之后强制依赖实时目录。把校验改为 Harness 专用列表，并让两个 MCP 预览 schema 使用同一列表，避免先接受新类型再报 `MODEL_CATALOG_UNAVAILABLE`。 | Claude/Codex 在类型校验阶段被拒绝，Qoder 仍按原规则生成模型快照。 |
| `src/main/java/com/aliyun/autowonder/common/error/ErrorCode.java` | `EXECUTOR_CLIENT_KIND_INVALID` 的原始提示硬编码两个 Qoder 类型。更新诊断文案，保留 `17009`。 | 原有错误码及响应边界保持。 |
| `src/main/resources/i18n/messages_zh_CN.properties` | 更新过期的类型错误提示，增加两个新选项的中文说明。 | 请求语言为中文时返回中文系统提示，错误码保持。 |
| `src/main/resources/i18n/messages_en_US.properties` | 同步英文错误提示和选项说明，参数与中文成对。 | 请求语言为英文时返回英文系统提示，错误码保持。 |

首期可直接复用 `ExecutorService.java` 的校验调用和落库、`ExecutorLaunchCommandService.java` 的参数生成、`ExecutorLaunchCommandParser.java` 对 provider 的一致性检查，以及现有任务分发。数据库的 `executor.client_kind` 已是 VARCHAR(64)。`ProviderModelCatalogService.java`、`InboundFrameRouter.java`、`MemoryImportService.java` 中的 Qoder 专用目录、协议和记忆导入继续服务对应功能。

| 文件 | 运行时改动目的 |
| --- | --- |
| `BundledExecutorRuntime.java`、`BundledExecutorRuntimeController.java` | 提供固定模块的公开下载路由，生成校验内容摘要的启动引导。 |
| `ExecutorLaunchCommandService.java`、`ExecutorLaunchCommandParser.java` | 生成和解析对应类型的启动命令，沿用连接参数和配置校验。 |
| `ExecutorRestartService.java`、`ExecutorUpdateService.java` | 按实际运行时能力限制在线应用 npm 命令与升级。 |
| `src/main/resources/executor-runtime/executor.mjs` | 对接既有 WebSocket 心跳、接单、进度、取消和结果确认。 |
| `src/main/resources/executor-runtime/capsule.mjs` | 校验任务包和文件完整性，读取工单上下文，通过现有接口上传产物。 |
| `src/main/resources/executor-runtime/engine.mjs` | 启动对应 CLI，限制进程、输入输出和权限范围，将 CLI 的结束结果转换为派发结果。 |

## 三、测试文件与证明目标

| 文件 | 对照 Qoder 测试后的改动目的 |
| --- | --- |
| `frontend/src/features/executor/ExecutorListPage.test.tsx` | 把新建和缺类型补录的两选项断言更新为四选项。验证 Claude/Codex 提交、Qoder 切换残留、补录和命令预览。 |
| `src/test/java/com/aliyun/autowonder/executor/ExecutorServiceTest.java` | 将旧的 Claude 拒绝断言改为两种新类型创建成功并正确落库，同时继续覆盖不受支持的类型。 |
| `src/test/java/com/aliyun/autowonder/executor/ExecutorLaunchOptionsServiceTest.java` | 保留 Qoder 目录和兜底用例，新增 Claude/Codex 空模型选项、空默认值及 provider 映射断言。 |
| `src/test/java/com/aliyun/autowonder/executor/ExecutorLaunchConfigServiceTest.java` | 验证历史空类型可补录为两种新类型，配置与类型原子写入，已绑定类型仍不可改。 |
| `src/test/java/com/aliyun/autowonder/executor/ExecutorLaunchCommandServiceTest.java` | 对照 Qoder 参数测试，确认两个新命令的 provider 正确、通用参数仍在、Qoder 专用参数缺席。 |
| `src/test/java/com/aliyun/autowonder/executor/ExecutorI18nBoundaryTest.java` | 更新 Qoder-only 文案断言，核对中英文响应及错误码。 |
| `src/test/java/com/aliyun/autowonder/mcp/McpToolServiceTest.java` | 验证普通工具四种类型及空默认值，两个预览工具仍只有 Qoder 类型。 |
| `src/test/java/com/aliyun/autowonder/harness/HarnessPreviewServiceTest.java` | 更新通用校验 mock，验证两种新类型在查目录前被拒绝，Qoder 仍能冻结模型。 |
| `src/test/java/com/aliyun/autowonder/harness/HarnessInitializationServiceTest.java` | 同步其预览依赖 mock，确保原有 Qoder 预览、确认与初始化流程仍能执行。 |
| `e2e-tests/runtime_dispatch.py` | 现有场景硬编码 `QODER_CLI`、`qoder`、`qodercli` 和 Qoder 凭据。用同一场景选择值贯穿创建类型、daemon provider、CLI 检查、认证环境及证据。每个 provider 单独核对上线、任务结果和产物。 |
| `e2e-tests/verify.sh` | 把同一场景选择传入运行时前置检查和实际执行，沿用 lifecycle 入口及默认 Qoder 路径。 |
| `e2e-tests/tests/test_runtime_dispatch.py` | 验证三种场景的类型与 provider 一致、CLI 和凭据检查按场景执行、证据可区分，且凭据不出现在输出中。 |
| `e2e-tests/AGENT_GUIDE.md` | 记录场景选择、所需 CLI、目标 runtime 版本和受保护的认证配置。脚本直接启动 daemon，因此另核对两种页面生成命令可在对应 CLI 环境启动。 |

候选实现完成后，使用 `e2e-tests/verify.sh --start --project-root <工作树>` 和 `e2e-tests/verify.sh --check --with-runtime --project-root <工作树>`。按实现后的场景参数分别验收 Qoder、Claude、Codex，两个 Qoder 类型的创建和命令通过既有及补充测试覆盖。证据需包括所用 runtime 版本、provider、上线状态、任务完成和产物回传。

## 四、配套文档与扩展范围

| 文件 | 改动目的 |
| --- | --- |
| `docs/community/upstream-sync-guide.md` | 更新现有 Qoder-only 同步约定，防止后续同步把普通执行器的新增类型回退。 |
| `docs/openapi-reference.md` | 把过期的创建请求示例替换为实际支持的四种类型。 |
| `docs/executor-client-kind-recovery.md` | 对齐缺类型补录的四种选项、错误提示和 provider 参数。 |
| `src/main/resources/harness/skill/references/platform-contract.md` | 明确从通用工具列表选择时还要应用 Harness 的类型范围，与现有 `src/main/resources/harness/skill/SKILL.md` 中的 Qoder 选项规则一致。 |

- 若参谋长引导也开放，改 `frontend/src/features/chiefOfStaff/ChiefGuidedSetup.tsx`、同目录的 `ChiefSetupPanel.tsx`、双语 `chiefOfStaff.json` 和相应测试。两个页面各自写死 Qoder 选项，后端创建路径已复用通用服务。验收还要核对 runtime 的对话事件及环境变量能力。
- 若页面要支持 Codex 启动模型和推理强度，再改 `ExecutorListPage.tsx`、`ExecutorLaunchOptionsService.java`、`ExecutorLaunchConfigService.java`、`ExecutorLaunchCommandService.java`、`McpToolService.java` 和对应测试。Codex 文档列出 `--model`、`--reasoning-effort`，目录来源、输入校验和默认值应按 Codex 定义。任务级模型覆盖另依赖 `TASK_MODEL_SELECTION_V1`。
- 若 Harness 也要开放，进一步调整 `src/main/resources/harness/release-manifest.json`、`HarnessPreviewService.java`、`HarnessInitializationService.java`、Harness Skill 和对应测试，先定义各 provider 的角色模型来源及快照规则。

仓库默认推荐的 npm runtime 为 `@alicloud/autowonder@0.3.43`，用于 Qoder 系列。内置运行时覆盖普通工单和产物。对话、检查点续跑、在线升级和任务级模型覆盖各有独立的协议能力。

每次 lifecycle 选择一个 runtime provider，并使用独立验收记录。现有 `runtime-dispatch.json` 由 `e2e-tests/verify.sh` 归档，还被 `e2e-tests/logscan.sh` 和 `e2e-tests/lib/supplement_cleanup_evidence.py` 消费。沿用原报告结构，provider 可记录在验收记录中。若后续要在同一次运行生成多份报告，再同步修改归档、日志归因和补充验收的读取逻辑。CLI 配置目录由验收启动器隔离，`CODEX_HOME` 与 `CLAUDE_CONFIG_DIR` 已是平台保留变量。
