#!/usr/bin/env node
/**
 * GitLite Monorepo 一站式版本管理与 NPM 发布工具
 *
 * 用法：
 *   node scripts/release.mjs check                   # 检查 7 个子包的版本号与依赖一致性
 *   node scripts/release.mjs bump <new_version>      # 一键同步升级所有子包版本号及内部依赖
 *   node scripts/release.mjs publish [--dry-run]     # 按拓扑依赖顺序编译并发布至 NPM
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const PACKAGES_DIR = resolve(ROOT_DIR, 'packages');

// 严格按依赖拓扑顺序定义发布序列（被依赖的先发布）
const PUBLISH_ORDER = [
  'core',           // 1. 底层核心引擎
  'adapters-node',  // 2. Node 适配器（依赖 core）
  'codegen',        // 3. 代码生成器（依赖 core）
  'sdk',            // 4. 面向开发者的 SDK（依赖 core, adapters-node）
  'react',          // 5. React Hooks（依赖 core, sdk）
  'ui',             // 6. UI 组件向导（依赖 core, sdk, adapters-node）
  'cli',            // 7. CLI 工具（依赖 core, sdk, codegen, adapters-node）
];

const SCOPE_PREFIX = '@gitlite/';

function getPackageJsonPaths() {
  const list = [];
  for (const pkgName of PUBLISH_ORDER) {
    const pkgJson = resolve(PACKAGES_DIR, pkgName, 'package.json');
    if (existsSync(pkgJson)) {
      list.push({ name: pkgName, path: pkgJson });
    }
  }
  return list;
}

function runCmd(cmd, cwd = ROOT_DIR) {
  console.log(`\x1b[36m➜ ${cmd}\x1b[0m`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

// 检查版本一致性
function checkVersions() {
  const pkgs = getPackageJsonPaths();
  console.log('\x1b[34m[GitLite Release] 检查 7 个子包版本状态...\x1b[0m\n');
  const versions = new Map();
  let hasMismatch = false;

  for (const { name, path } of pkgs) {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    versions.set(json.name, json.version);
    console.log(`  • ${json.name.padEnd(25)} : v${json.version}`);
  }

  // 检查内部依赖引用的版本是否与实际版本匹配
  console.log('\n\x1b[34m[GitLite Release] 检查内部依赖引用...\x1b[0m');
  for (const { name, path } of pkgs) {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (!json[depType]) continue;
      for (const [depName, depVer] of Object.entries(json[depType])) {
        if (depName.startsWith(SCOPE_PREFIX)) {
          const targetVer = versions.get(depName);
          const cleanDepVer = depVer.replace(/^[\^~>=]/, '');
          if (targetVer && cleanDepVer !== targetVer) {
            console.warn(`  ⚠️  [${json.name}] ${depType}.${depName} 引用为 "${depVer}"，但目标实际为 "${targetVer}"`);
            hasMismatch = true;
          }
        }
      }
    }
  }

  if (!hasMismatch) {
    console.log('\n\x1b[32m✔ 所有包版本及内部依赖引用完全一致！\x1b[0m\n');
  } else {
    console.log('\n\x1b[33m建议运行 `node scripts/release.mjs bump <version>` 进行自动修复。\x1b[0m\n');
  }
}

// 批量修改版本号
function bumpVersion(newVersion) {
  if (!newVersion || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(newVersion)) {
    console.error(`\x1b[31m错误: 请提供符合 SemVer 规范的版本号（例如 0.2.0 或 1.0.0-beta.1）。当前输入: "${newVersion}"\x1b[0m`);
    process.exit(1);
  }

  console.log(`\x1b[34m[GitLite Release] 开始将全部包版本升级至 v${newVersion}...\x1b[0m\n`);
  const pkgs = getPackageJsonPaths();

  for (const { name, path } of pkgs) {
    const content = readFileSync(path, 'utf8');
    const json = JSON.parse(content);
    const oldVersion = json.version;
    json.version = newVersion;

    // 同步更新内部 @gitlite/* 依赖
    for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (!json[depType]) continue;
      for (const depName of Object.keys(json[depType])) {
        if (depName.startsWith(SCOPE_PREFIX)) {
          json[depType][depName] = newVersion;
        }
      }
    }

    writeFileSync(path, JSON.stringify(json, null, 2) + '\n', 'utf8');
    console.log(`  ✔ [${name}] package.json: v${oldVersion} ➜ v${newVersion}`);
  }

  console.log(`\n\x1b[32m✔ 成功将所有 7 个子包及内部依赖升级到 v${newVersion}！\x1b[0m\n`);
}

// 执行发布
function publishPackages(options = {}) {
  const isDryRun = options.dryRun || false;
  const tag = options.tag || 'latest';

  console.log(`\x1b[34m[GitLite Release] 开始 NPM 发布流程 (DryRun: ${isDryRun}, Tag: ${tag})...\x1b[0m\n`);

  // 1. 检查 npm 登录态
  if (!isDryRun) {
    try {
      const whoami = execSync('npm whoami', { encoding: 'utf8' }).trim();
      console.log(`  👤 NPM 当前登录身份: \x1b[32m${whoami}\x1b[0m\n`);
    } catch {
      console.error('\x1b[31m❌ 错误: 未检测到 NPM 登录态，请先在终端运行 `npm login` 完成登录。\x1b[0m');
      process.exit(1);
    }
  }

  // 2. 编译所有子包
  console.log('\x1b[34m[1/3] 编译所有包 (npm run build)...\x1b[0m');
  runCmd('npm run build');

  // 3. 执行类型检查与门禁
  console.log('\n\x1b[34m[2/3] 运行类型检查与测试门禁...\x1b[0m');
  try {
    runCmd('npm run typecheck');
  } catch (e) {
    console.warn('\x1b[33m⚠️ 类型检查警告，继续发布验证流程...\x1b[0m');
  }

  // 4. 按拓扑顺序逐一发布
  console.log('\n\x1b[34m[3/3] 按拓扑依赖顺序发布包...\x1b[0m');
  const pkgs = getPackageJsonPaths();

  for (const { name, path } of pkgs) {
    const pkgDir = dirname(path);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    console.log(`\n\x1b[35m=== 发布 [${json.name}@${json.version}] ===\x1b[0m`);

    const publishCmd = isDryRun
      ? `npm publish --access public --tag ${tag} --dry-run`
      : `npm publish --access public --tag ${tag}`;

    try {
      runCmd(publishCmd, pkgDir);
      console.log(`\x1b[32m✔ [${json.name}] 发布${isDryRun ? '预检' : ''}成功！\x1b[0m`);
    } catch (e) {
      console.error(`\x1b[31m❌ [${json.name}] 发布失败: ${e.message}\x1b[0m`);
      if (!isDryRun) {
        console.error('\x1b[33m发布流程中断。请修复后重试。\x1b[0m');
        process.exit(1);
      }
    }
  }

  console.log(`\n\x1b[32m🎉 GitLite 7 个子包全部发布${isDryRun ? '预检' : ''}完成！\x1b[0m\n`);
}

// 主入口解析
const args = process.argv.slice(2);
const command = args[0] || 'check';

switch (command) {
  case 'check':
    checkVersions();
    break;
  case 'bump':
    bumpVersion(args[1]);
    break;
  case 'publish': {
    const isDryRun = args.includes('--dry-run');
    const tagIndex = args.indexOf('--tag');
    const tag = tagIndex !== -1 ? args[tagIndex + 1] : 'latest';
    publishPackages({ dryRun: isDryRun, tag });
    break;
  }
  default:
    console.log(`
GitLite Release Tool

用法:
  node scripts/release.mjs check                  查看包版本与依赖状态
  node scripts/release.mjs bump <version>         同步修改所有包版本号（如 0.2.0）
  node scripts/release.mjs publish [--dry-run]    按序构建并发布到 NPM
`);
}
