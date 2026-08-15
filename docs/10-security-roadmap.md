# 10 · 安全、配额与路线图

> 把「能用」推进到「敢用」。配额合规是 GitLite 区别于其他 Git-as-Backend 方案的一等公民；字段级加密让私密仓库也能存敏感数据；路线图诚实声明每个阶段交付什么、不交付什么。

## 0. 设计目标

1. **不踩配额红线**：自动管理 GitHub/Gitee 速率与配额，避免账号被封。
2. **数据保密**：私有仓库 + 字段级加密，敏感字段即使仓库泄露也不可读。
3. **审计可追溯**：所有写操作有 commit 历史 + 应用层审计日志。
4. **多租户隔离**：单机多账号、多应用互不串扰。
5. **合规友好**：明确数据驻留、可删除、可导出。

## 一、平台配额与速率限制

### GitHub

| 限制 | 阈值 | 来源 |
|---|---|---|
| 全局认证请求 | 5000/h | REST API v3 |
| 未认证请求 | 60/h | |
| 内容创建（次级） | 80/min、500/h | 创建 commit / blob / tree |
| Push（次级） | 6/min/仓库 | |
| Git DB API（blobs/trees/commits/refs） | 计入 5000/h | |
| GraphQL | 5000 points/h | |
| 仓库大小 | 软限 1GB，硬限 5GB | |
| 单文件 | 100MB（警告）、100MB（拒绝） | Contents API 单文件 1MB |
| LFS | 1GB 免费 + 1GB 流量/月 | |

### Gitee

| 限制 | 阈值 |
|---|---|
| 认证请求 | 5000/h |
| 未认证 | 60/h |
| 仓库大小（免费个人） | 500MB |
| 单文件 | 1MB（Contents API） |
| 私有仓库数（免费个人） | 5 个 |
| 组织仓库 | 取决于套餐 |

### 配额管理器（QuotaManager）

```ts
interface QuotaManager {
  /** 请求前申请配额，返回是否允许 */
  acquire(budget: QuotaBudget): Promise<QuotaGrant>;

  /** 记录实际消耗 */
  record(usage: QuotaUsage): void;

  /** 当前剩余配额 */
  remaining(): QuotaStatus;

  /** 监听配额事件 */
  on(event: 'warning' | 'exhausted' | 'recovered', fn: (s: QuotaStatus) => void): void;
}

interface QuotaStatus {
  restPerHour: number;       // 剩余 REST 配额
  contentCreationPerHour: number;
  pushPerMin: number;
  repoSizeBytes: number;
  repoSizeLimit: number;
}
```

### 工作机制

1. **预算申请**：每次远端操作前向 QuotaManager 申请配额。
2. **令牌桶**：本地令牌桶限流，按 60/min 限速 push，平滑突发。
3. **响应头解析**：每次响应解析 `X-RateLimit-Remaining` / `X-RateLimit-Reset` 更新本地计数。
4. **次级限制感知**：内容创建 500/h、push 6/min 通过本地计数器跟踪。
5. **退避**：触发 403 + `X-RateLimit-Remaining: 0` 时，等到 `X-RateLimit-Reset` 时间再重试。
6. **二级限流退避**：内容创建触发 `secondary rate limit` 时，指数退避（30s → 60s → 120s）。
7. **配额预警**：剩余 < 20% 触发 `warning` 事件，< 5% 触发 `exhausted`，SDK 暂停非关键写。

### 配额优化策略

| 策略 | 节省效果 |
|---|---|
| **economy 同步档（默认，60s/50 条批量）** | 远端调用压到 <70/h，远离限流区 |
| **读不轮询**（economy 默认 off） | pull 只在启动/手动/冲突时发生 |
| 批量提交（最多 50 ops/commit） | 减少 commit 数最多 50x |
| 索引随数据一起 commit | 避免二次 IO |
| tree 复用 base_tree | 减少 tree 创建调用 |
| 增量 pull（compare 接口） | 减少 GET 次数 |
| 本地缓存命中 | 0 远端调用 |
| 离线堆积合并 | 减少突发 push |
| **多绑定 failover**（绑 GitHub+Gitee） | 两平台配额池独立互为备份（见 06） |

## 二、字段级加密

### 模型

```jsonc
// users.schema.jsonc
{ "fields": {
    "email":  { "type": "string" },
    "_enc.ssn":   { "type": "string", "encrypted": true },   // 加密字段
    "_enc.salary":{ "type": "number", "encrypted": true }
}}
```

### 存储格式

```json
// users/01H8X....json
{
  "_id": "01H8X...",
  "email": "alice@example.com",        // 明文
  "_enc.ssn": {
    "alg": "AES-256-GCM",
    "iv": "base64...",
    "ciphertext": "base64...",
    "tag": "base64...",
    "kid": "key-1"                     // key id，支持密钥轮换
  },
  "_enc.salary": { /* 同上 */ }
}
```

### 密钥管理

```ts
interface KeyProvider {
  /** 取主密钥（按 kid） */
  getKey(kid: string): Promise<CryptoKey>;

  /** 创建新密钥并返回 kid */
  createKey(): Promise<{ kid: string; key: CryptoKey }>;

  /** 轮换：旧 kid → 新 kid */
  rotate(oldKid: string): Promise<{ newKid: string }>;
}
```

| KeyProvider 后端 | 适用 |
|---|---|
| `local`（默认） | 本地 OS keychain 派生（PBKDF2 用户口令 → master key） |
| `env` | 环境变量提供 master key（CI / 服务器） |
| `kms-aws` | AWS KMS |
| `kms-aliyun` | 阿里云 KMS |
| `vault` | HashiCorp Vault |

### 加密流程

```
encrypt(value, kid):
  1. 取主密钥 masterKey = getKey(kid)
  2. 生成随机 IV (12 bytes for GCM)
  3. AES-256-GCM(masterKey, IV, value)
  4. 输出 { alg, iv, ciphertext, tag, kid }

decrypt(encObj):
  1. masterKey = getKey(encObj.kid)
  2. AES-GCM-Decrypt(masterKey, iv, ciphertext, tag)
  3. 返回明文
```

### 查询限制

- 加密字段**不能直接查询**（密文不可比较）。
- 需查询的敏感字段：保留 hash 索引（如 `emailHash = SHA-256(email)`）用于等值匹配；明文加密存储。
- 范围查询敏感字段：不支持，请重新设计（如把 salary 分桶为 `salaryBand`）。

```jsonc
{ "fields": {
    "_enc.ssn": { "type": "string", "encrypted": true },
    "ssnHash":  { "type": "string", "indexed": true, "derivedFrom": "ssn", "hash": "sha-256" }
}}
```

### 密钥轮换

```bash
$ gitlite crypto rotate-keys
Rotating key-1 → key-2 ...
Re-encrypting 42 documents ...
✓ Done. Old key-1 marked as read-only.
```

- 旧密钥保留（read-only）用于解密历史数据。
- 新写入用新密钥。
- 后台异步把旧密文重新加密为新密钥。

## 三、审计与合规

### Commit 历史 = 天然审计

- 每次写操作都是一个 commit，含作者、时间、改动 diff。
- `git log` 即审计日志，不可篡改（除非 force-push，GitLite 默认禁用）。

### 应用层审计日志

```jsonc
// _meta/audit.log.jsonl（追加写入，不删）
{ "ts": "2026-08-15T12:00:00Z", "actor": "alice", "action": "users.update",
  "target": "01H8X...", "before": {...}, "after": {...}, "commitSha": "abc1234" }
```

### 数据驻留

- 数据存储位置 = Git 平台位置（GitHub 在美国，Gitee 在中国）。
- 用户根据合规要求选择平台；自托管场景用 GitLab/Gitea 适配器。
- 加密字段即使在平台存储中也加密，平台方不可读。

### 数据删除与导出

```bash
gitlite export --all --file ./backup.tar.gz        # GDPR 数据可携带
gitlite repo purge                                 # 彻底删除仓库（含历史）
gitlite data purge <collection> --filter '{...}'   # 删除匹配文档（含历史 commit）
```

`purge` 操作：

1. 删除文档文件。
2. 创建新 commit（不含目标文件）。
3. 可选：`git filter-branch` 或 `git filter-repo` 重写历史彻底清除（破坏性，需用户二次确认）。

## 四、安全威胁模型与缓解

| 威胁 | 缓解 |
|---|---|
| Token 泄露 | OS 凭据库存储；日志脱敏；token 限定 scope；可即时撤销 |
| 仓库被未授权访问 | 私有仓库 + 字段级加密；敏感字段即使仓库泄露也不可读 |
| OAuth CSRF | PKCE + state 校验 |
| Redirect 劫持 | 仅允许 `localhost` redirect_uri |
| 配额耗尽导致服务不可用 | QuotaManager 预算 + 限流 + 退避 |
| 客户端伪造 commit | commit author 由 token 决定，无法伪造他人身份 |
| 中间人攻击 | 强制 HTTPS；可选客户端对响应签名校验 |
| 重放攻击 | OAuth state 一次性；commit sha 不可预测 |
| 凭据库被本地恶意软件窃取 | OS 凭据库需用户态权限；可选主口令加密 fallback 文件 |
| 仓库内容被恶意 commit 污染 | 多客户端协作可设分支保护规则（平台侧）；GitLite 提供 `db.sync.verifyCommitSignature` 选项 |

## 五、平台限制与适配差异

| 维度 | GitHub | Gitee | 影响 |
|---|---|---|---|
| 仓库大小 | 5GB | 500MB（免费个人） | Gitee 用户更早触顶 |
| 私有仓库数 | 无限 | 5（免费个人） | Gitee 多 DB 需付费或组织 |
| 批量原子提交 | Git DB API | 无 | Gitee 降级多文件多次调用 |
| 大文件 | LFS / Contents 1MB | Contents 1MB | 都需外部存储 |
| Device Flow | ✓ | ✗ | Gitee 必须走浏览器重定向 |
| Fine-grained token | ✓ | ✗ | Gitee scope 粒度粗 |
| 删仓 scope | `delete_repo` | `projects`（含删仓） | Gitee 默认即有删仓权 |
| Webhook | 需公网入口 | 需公网入口 | 实时同步需 broker |

## 六、适用场景

### 强烈推荐

- **个人项目 / 知识库**：博客、笔记、个人 CRM、读书清单。
- **小型应用后端**：日活 < 1000、写频率 < 1/秒。
- **Headless CMS**：内容编辑 + 类型安全 + 多端只读。
- **配置中心**：环境配置、特性开关、AB 实验。
- **原型 / Demo**：快速验证想法，零运维。
- **低频写高并发读**：文档站、目录站、产品手册。
- **多端只读同步**：手机 / 桌面 / Web 共享数据。

### 不推荐

- **高并发写入**：写配额 ~1500 单文件/hour，撑不住高频写。
- **大数据量**：仓库 > 1GB 性能下降，> 5GB 触顶。
- **强一致事务**：金融、库存防超卖、订票。
- **实时查询**：默认最终一致，跨端延迟秒级。
- **大二进制存储**：图片 / 视频请用外部对象存储。
- **多用户并发编辑**：冲突频繁，体验差。
- **敏感数据不加密**：除非字段级加密，否则不要把敏感数据放仓库。

## 七、版本路线图

### v0.1 — 单平台 MVP（GitHub only）

**目标**：证明核心思路可用。

- ✅ Provider：GitHub（REST Contents + Git DB API）
- ✅ 鉴权：GitHub Device Flow + PAT
- ✅ 数据模型：JSON document + JSONC schema
- ✅ CRUD：insertOne/find/findOne/updateOne/deleteOne + 基础 filter
- ✅ 同步：自动同步 + 三层缓存 + 离线队列
- ✅ 索引：单字段 + 唯一（JSON 文件）
- ✅ 事务：短事务（单 commit）
- ✅ CLI：auth/repo/schema/data/sync 基础命令
- ✅ SDK：TS client + 基础类型
- ✅ 配额管理器（基础）

### v0.2 — Gitee 一等支持

- ✅ Provider：Gitee（含降级批量提交策略）
- ✅ 鉴权：Gitee OAuth + PKCE + Loopback + refresh
- ✅ 跨平台配额差异处理
- ✅ 多 profile 切换

### v0.3 — 类型、开发者体验与**格式冻结**

- ✅ Codegen：schema → 强类型 Client
- ✅ 复合索引 + 查询计划器 + explain
- ✅ 聚合管道
- ✅ CLI REPL
- ✅ React Hooks 包
- ✅ **格式宪法生效：冻结 `formatVersion 1.0.0`**（锚定 JSON Schema/ULID/SemVer，additive-only 演进，见 03 第十一节）
- ✅ 黄金仓库兼容性测试集 + 双客户端互操作 CI

### v0.4 — 高级事务

- ✅ 长事务（分支模式）+ checkpoint
- ✅ OCC + CAS + 自动 rebase 重试
- ✅ 字段级加密（local key provider）
- ✅ 软删除

### v0.5 — 性能与扩展

- ✅ SQLite 索引后端
- ✅ 文本索引（CJK 分词）
- ✅ 大 collection lazy 加载
- ✅ 索引分片
- ✅ 插件机制

### v0.6 — 跨运行时

- ✅ 浏览器端适配（IndexedDB + WebCrypto）
- ✅ Bun / Deno 适配
- ✅ React Native 适配

### v0.7 — 协作增强

- ✅ 实时同步（轮询 + webhook broker 可选）
- ✅ 冲突可视化解决器
- ✅ 向量时钟
- ✅ PR 工作流（长事务 → PR → merge）

### v0.8 — 安全加固

- ✅ KMS key provider（AWS / 阿里云）
- ✅ 密钥轮换自动化
- ✅ 审计日志查询 API
- ✅ commit 签名校验

### v0.9 — 企业特性

- ✅ 自托管 GitLab / Gitea 适配
- ✅ SSO 集成
- ✅ 多租户隔离强化
- ✅ 备份 / 恢复 / 灾难恢复

### v1.0 — 正式发布

- ✅ 稳定 API 契约
- ✅ 完整文档与教程
- ✅ 性能基准公开发布
- ✅ 生产案例集
- ✅ 治理委员会 + 社区路线

### v1.x+ — 探索方向

- GraphQL API 层
- 多仓库 federation（跨库 join）
- 内置可视化编辑器（Decap-like）
- Edge 部署模式
- 内置变更通知（WebSocket broker）

## 八、风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 平台 API 变更 | 中 | Provider 适配层隔离；版本化 API 调用 |
| 平台封禁（超配额） | 高 | QuotaManager 严格预算；用户文档强调合规 |
| Git 内核依赖锁定 | 中 | Provider 是唯一接触 Kernel 的层；可替换 |
| 大仓库性能退化 | 中 | SQLite 索引后端；lazy 加载；用户文档明确上限 |
| 加密密钥丢失 | 高 | 密钥备份提示；多 KMS 后端；恢复流程文档 |
| 多客户端冲突频繁 | 中 | 字段级合并；向量时钟；用户教育场景边界 |
| 开源治理与维护 | 中 | 早期明确贡献指南；核心团队主导 |

## 九、开源策略

- **License**：MIT（宽松，便于商用）
- **治理**：早期 BDFL（创始人主导），v1.0 后转委员会
- **贡献入口**：good-first-issue 标签；roadmap 公开
- **文档语言**：中英双语（Gitee 一等支持 → 中文社区优先）
- **示例库**：官方维护 5+ 示例应用（博客、CRM、任务管理、知识库、配置中心）

## 十、社区与生态

- **官方 broker**：`auth.gitlite.dev`（OAuth secret 中转），可选自建
- **官方 OAuth App**：预置 client_id，零配置登录
- **示例库集**：`gitlite/examples/*` 涵盖各场景
- **模板库**：`gitlite/templates/*` 一键创建带 schema 的项目骨架
- **集成生态**：React/Vue/Svelte hooks；Strapi/Next.js/Nuxt 模块；VSCode 扩展（schema 编辑 + 查询）

这一层让 GitLite 从「能跑的实验」走向「敢上生产的工具」——配额不踩雷、敏感数据可加密、版本路线诚实可期。
