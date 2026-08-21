import { describe, expect, it } from 'vitest';
import {
  createNodeRuntime,
  createNodeSqlite,
  waitForRedirect,
  GITLITE_LOOPBACK_PORT,
  createOsCredentialStore,
  FileCredentialStore,
  GitLiteClient,
  MemoryProvider,
  GitHubProvider,
  GiteeProvider,
  Collection,
  POLICIES,
  SYS,
  GITLITE_GITHUB_CLIENT_ID,
  GITLITE_GITEE_CLIENT_ID,
  GitLiteError,
  OAuthAppNotConfiguredError,
  AuthError,
  ValidationError,
  initDB,
  connect,
  parseUri,
  databases,
  interactiveLogin,
  giteeLogin
} from './index.js';

describe('@gitlite/sdk 导出物完整性测试', () => {
  it('导出所有 Node 适配器函数与常量', () => {
    expect(typeof createNodeRuntime).toBe('function');
    expect(typeof createNodeSqlite).toBe('function');
    expect(typeof waitForRedirect).toBe('function');
    expect(typeof createOsCredentialStore).toBe('function');
    expect(typeof FileCredentialStore).toBe('function');
    expect(GITLITE_LOOPBACK_PORT).toBe(18365);
  });

  it('导出所有核心类、策略、常量与异常', () => {
    expect(typeof GitLiteClient).toBe('function');
    expect(typeof MemoryProvider).toBe('function');
    expect(typeof GitHubProvider).toBe('function');
    expect(typeof GiteeProvider).toBe('function');
    expect(typeof Collection).toBe('function');
    expect(POLICIES).toBeDefined();
    expect(SYS).toBeDefined();
    expect(GITLITE_GITHUB_CLIENT_ID).toBe('gitlite-placeholder');
    expect(GITLITE_GITEE_CLIENT_ID).toBe('gitlite-placeholder');



    expect(typeof GitLiteError).toBe('function');
    expect(typeof OAuthAppNotConfiguredError).toBe('function');
    expect(typeof AuthError).toBe('function');
    expect(typeof ValidationError).toBe('function');

    const err = new OAuthAppNotConfiguredError('github');
    expect(err.code).toBe('OAUTH_APP_NOT_CONFIGURED');
    expect(err.provider).toBe('github');
    expect(err.message).toContain('github');
  });

  it('导出 SDK 核心入口函数', () => {
    expect(typeof initDB).toBe('function');
    expect(typeof connect).toBe('function');
    expect(typeof parseUri).toBe('function');
    expect(typeof databases.create).toBe('function');
    expect(typeof databases.list).toBe('function');
    expect(typeof databases.drop).toBe('function');
    expect(typeof interactiveLogin).toBe('function');
    expect(typeof giteeLogin).toBe('function');
  });
});
