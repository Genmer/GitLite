// app-config（应用级配置）测试：读写、按平台合并、持久化、authStatus
// 用 createNodeRuntime（真实文件，HOME 重定向到临时目录 → 跨实例持久可验证）
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAppConfig, saveOAuthApp, getOAuthApp, authStatus } from './app-config.js';
import { createNodeRuntime } from '@gitlite/adapters-node';

const realHome = process.env.USERPROFILE ?? process.env.HOME;
let tmpHome = '';
beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gitlite-appcfg-'));
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
});
afterAll(() => {
  process.env.USERPROFILE = realHome;
  process.env.HOME = realHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('app-config', () => {
  it('空配置读取 → {}；未配置平台 → 空对象', async () => {
    expect(await readAppConfig(createNodeRuntime())).toEqual({});
    expect(await getOAuthApp(createNodeRuntime(), 'gitee')).toEqual({});
  });

  it('保存 OAuth 应用：按平台合并互不覆盖；跨会话（新 runtime）可读回', async () => {
    await saveOAuthApp(createNodeRuntime(), 'gitee', { clientId: 'ge-id', clientSecret: 'ge-sec' });
    await saveOAuthApp(createNodeRuntime(), 'github', { clientId: 'gh-id' });
    expect(await getOAuthApp(createNodeRuntime(), 'gitee')).toEqual({ clientId: 'ge-id', clientSecret: 'ge-sec' });
    expect(await getOAuthApp(createNodeRuntime(), 'github')).toEqual({ clientId: 'gh-id' });
  });

  it('authStatus：oauthApp 与 token 两维独立', async () => {
    const s1 = await authStatus(createNodeRuntime());
    expect(s1.gitee.oauthApp).toBe(true);    // 上例已登记
    expect(s1.gitee.token).toBe(false);      // 未登录
    await createNodeRuntime().credential.set('gitlite:gitee:default', 'tok');
    const s2 = await authStatus(createNodeRuntime());
    expect(s2.gitee.token).toBe(true);
    expect(s2.github.token).toBe(false);
  });
});
