# GitLite NPM 发布与版本管理指南

> 本文档是 GitLite 7 个子包（Monorepo）**版本管理与 NPM 正式发布**的标准流程。
> 任何人类开发者或 AI 助手在执行版本升级与发布时，必须严格遵守本流程。

---

## 1. 账号与权限前置准备（只需做一次）

### 1.1 注册 NPM 账号
1. 访问 [npmjs.com/signup](https://www.npmjs.com/signup) 注册一个 npm 账号；
2. 登录邮箱完成邮件验证（必须验证邮箱才能发布包）。

### 1.2 准备 Scope（组织名 `@gitlite`）
当前 GitLite 7 个包均以 `@gitlite/` 为 Scope 前缀：
- `@gitlite/core`
- `@gitlite/adapters-node`
- `@gitlite/codegen`
- `@gitlite/sdk`
- `@gitlite/react`
- `@gitlite/ui`
- `@gitlite/cli`

**在 NPM 上创建 Organization**：
1. 登录 npm 后，点击右上角头像 ➜ **Add Organization**；
2. 组织名称输入 `gitlite`（选择 Free 免费版即可）；
3. *注：若 `gitlite` 组织名已被全球其他用户占用，可选择修改 scope（例如 `@genmer/gitlite-core`）或联系组织管理员。*

### 1.3 本地终端登录
在终端执行：
```bash
npm login
```
按提示在浏览器中完成授权或输入 2FA 验证码。登录后可通过以下命令验证身份：
```bash
npm whoami
```

---

## 2. 版本号管理与自动同步机制

GitLite 包含 7 个互相依赖的子包。**严禁手动逐个修改 7 个 `package.json`**，项目已内置自动化版本升级工具：

### 2.1 检查当前版本状态
```bash
npm run release:check
```
该命令会列出所有 7 个包的当前版本，并检查各个包之间的内部引用是否完全一致。

### 2.2 一键升级所有包版本号
```bash
# 语法：npm run version:bump <目标版本号>
npm run version:bump 0.2.0
```
**此脚本会自动完成以下动作**：
1. 更新根目录及 7 个 `packages/*/package.json` 中的 `"version"` 字段；
2. 递归查找并同步更新所有 `dependencies`、`devDependencies`、`peerDependencies` 中对 `@gitlite/*` 的跨包依赖版本号；
3. 保持 JSON 格式缩进一致，杜绝人为修改疏漏。

---

## 3. NPM 发布执行流程

### 3.1 严格的发布拓扑顺序
由于 Monorepo 存在跨包依赖，发布必须按以下**被依赖层优先**的顺序依次发布：

```
1. @gitlite/core            (底层核心引擎)
   │
   ├─► 2. @gitlite/adapters-node
   ├─► 3. @gitlite/codegen
   │
   └─► 4. @gitlite/sdk       (依赖 core + adapters-node)
          │
          ├─► 5. @gitlite/react (依赖 core + sdk)
          ├─► 6. @gitlite/ui    (依赖 core + sdk + adapters-node)
          │
          └─► 7. @gitlite/cli   (依赖 core + sdk + codegen + adapters-node)
```

### 3.2 预检发布（Dry Run，强烈推荐在初次或正式发版前运行）
```bash
npm run release:dry-run
```
此命令会编译所有包并模拟运行 `npm publish --dry-run`，检查是否有打包遗漏、类型错误或打包体积异常，不消耗真实发布配额。

### 3.3 正式发布（一键自动编译并按序发布）
```bash
npm run release:publish
```

脚本会自动执行：
1. `npm whoami` 校验登录态；
2. `npm run build` 全量编译 7 个包；
3. `npm run typecheck` 跑类型门禁；
4. 按上述拓扑顺序依次执行 `npm publish --access public`。

> ⚠️ **为什么必须带 `--access public`？**
> NPM 对带 Scope 的包（`@xxx/yyy`）默认按私有付费包处理。开源免费包发布时必须显式指定 `--access public`。发布脚本已默认集成此参数。

---

## 4. Git 提交与打 Tag 规范

发布成功后，请将版本变更提交至 Git 并打上对应版本的 Git Tag：

```bash
# 1. 提交 package.json 变更
git add .
git commit -m "chore(release): bump version to v0.2.0"

# 2. 创建带附注的 Git Tag
git tag -a v0.2.0 -m "Release v0.2.0"

# 3. 推送代码和 Tag 到远程仓库 (Gitee / GitHub)
git push origin master --tags
```

---

## 5. 常见发布错误与排查指南

| 错误信息 / 现象 | 原因分析 | 解决方案 |
|---|---|---|
| `npm error 403 Forbidden` | 1. 未登录 npm<br>2. 无 `@gitlite` 组织管理权限 | 1. 运行 `npm login`<br>2. 确认 npm 网页上已创建对应 Organization |
| `npm error 402 Payment Required` | 未加 `--access public` | 使用 `npm run release:publish` 脚本（已内置 `--access public`） |
| `npm error ENEEDAUTH` | 登录 token 过期 | 重新运行 `npm login` 刷新认证 |
| `Two-factor authentication (2FA)` | 账号开启了 2FA | 终端弹出提示时输入邮箱/身份验证器中的 6 位动态验证码 |
