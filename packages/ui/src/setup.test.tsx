// @vitest-environment jsdom
// GitLiteSetup（引导配置模块）测试：检测渲染 / OAuth 登记引导与保存 / PAT 校验保存并跳步 / 空值拦截
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GitLiteSetup, type SetupFlows } from './index.js';

afterEach(cleanup);

const fakeDb = { fake: 'client' } as any;

function stubSetupFlows(overrides: Partial<SetupFlows> = {}): SetupFlows {
  return {
    // WizardFlows 部分（进入向导后使用）
    login: vi.fn(async () => 'tok-wizard'),
    identity: vi.fn(async () => 'alice'),
    connect: vi.fn(async () => fakeDb),
    // SetupFlows 部分
    detect: vi.fn(async () => ({
      github: { oauthApp: true, token: true },
      gitee: { oauthApp: false, token: false }
    })),
    saveOAuth: vi.fn(async () => {}),
    savePat: vi.fn(async () => 'alice'),
    ...overrides
  };
}

describe('GitLiteSetup（引导配置）', () => {
  it('挂载即检测并渲染两平台状态', async () => {
    const flows = stubSetupFlows();
    render(<GitLiteSetup onReady={() => {}} flows={flows} />);
    await waitFor(() => expect(screen.getByTestId('setup-choose')).toBeTruthy());
    expect(flows.detect).toHaveBeenCalled();
    expect(screen.getByTestId('setup-status-github').textContent).toContain('✅');
    expect(screen.getByTestId('setup-status-gitee').textContent).toContain('⬜');
  });

  it('OAuth 登记：引导页含注册链接/回调地址/权限说明；保存后进入连接向导', async () => {
    const flows = stubSetupFlows();
    render(<GitLiteSetup onReady={() => {}} flows={flows} />);
    await waitFor(() => expect(screen.getByTestId('setup-choose')).toBeTruthy());

    await act(async () => { fireEvent.click(screen.getByTestId('setup-oauth-gitee')); });
    expect(screen.getByTestId('setup-oauth')).toBeTruthy();
    expect(screen.getByTestId('setup-register-link').getAttribute('href')).toBe('https://gitee.com/oauth/applications/new');
    expect(screen.getByTestId('setup-oauth').textContent).toContain('http://127.0.0.1:18365/callback');
    expect(screen.getByTestId('setup-oauth').textContent).toContain('projects');
    expect(screen.getByTestId('setup-copy')).toBeTruthy();      // gitee 回调可复制
    expect(screen.queryByTestId('setup-client-secret')).toBeTruthy(); // gitee 需要 secret

    await act(async () => {
      fireEvent.change(screen.getByTestId('setup-client-id'), { target: { value: 'cid-1' } });
      fireEvent.change(screen.getByTestId('setup-client-secret'), { target: { value: 'sec-1' } });
    });
    await act(async () => { fireEvent.click(screen.getByTestId('setup-save-oauth')); });
    expect(flows.saveOAuth).toHaveBeenCalledWith('gitee', { clientId: 'cid-1', clientSecret: 'sec-1' });
    await waitFor(() => expect(screen.getByTestId('wizard-login')).toBeTruthy()); // 保存后进入向导（登录步）
  });

  it('GitHub OAuth 引导：无 secret 输入、回调说明为 Device Flow', async () => {
    const flows = stubSetupFlows();
    render(<GitLiteSetup onReady={() => {}} flows={flows} />);
    await waitFor(() => expect(screen.getByTestId('setup-choose')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTestId('setup-oauth-github')); });
    expect(screen.queryByTestId('setup-client-secret')).toBeNull();
    expect(screen.queryByTestId('setup-copy')).toBeNull();
    expect(screen.getByTestId('setup-oauth').textContent).toContain('Enable Device Flow');
  });

  it('PAT：校验保存后带 token/owner 直接进入向导仓库配置步（跳过登录）', async () => {
    const flows = stubSetupFlows();
    const onReady = vi.fn();
    render(<GitLiteSetup onReady={onReady} flows={flows} />);
    await waitFor(() => expect(screen.getByTestId('setup-choose')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTestId('setup-pat-gitee')); });
    expect(screen.getByTestId('setup-token-link').getAttribute('href')).toContain('personal_access_tokens');

    await act(async () => {
      fireEvent.change(screen.getByTestId('setup-pat-input'), { target: { value: 'pat-xyz' } });
    });
    await act(async () => { fireEvent.click(screen.getByTestId('setup-save-pat')); });
    expect(flows.savePat).toHaveBeenCalledWith('gitee', 'pat-xyz');
    await waitFor(() => expect(screen.getByTestId('wizard-config')).toBeTruthy()); // 直达配置步
    expect((screen.getByTestId('wizard-owner') as HTMLInputElement).value).toBe('alice'); // owner 已预填
  });

  it('PAT 校验失败 → 错误信息可见，不进向导；空值拦截', async () => {
    const flows = stubSetupFlows({ savePat: vi.fn(async () => { throw new Error('401 unauthorized'); }) });
    render(<GitLiteSetup onReady={() => {}} flows={flows} />);
    await waitFor(() => expect(screen.getByTestId('setup-choose')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTestId('setup-pat-github')); });

    // 空值拦截
    await act(async () => { fireEvent.click(screen.getByTestId('setup-save-pat')); });
    await waitFor(() => expect(screen.getByTestId('setup-error')).toBeTruthy());
    expect(screen.getByTestId('setup-error').textContent).toContain('不能为空');

    // 校验失败
    await act(async () => {
      fireEvent.click(screen.getByTestId('setup-error-back')); // 回到 PAT 表单
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('setup-pat-input'), { target: { value: 'bad' } });
      fireEvent.click(screen.getByTestId('setup-save-pat'));
    });
    await waitFor(() => expect(screen.getByTestId('setup-error').textContent).toContain('401'));
    expect(screen.queryByTestId('wizard-config')).toBeNull();
  });

  it('跳过 → 直接进入向导（选平台步）', async () => {
    const flows = stubSetupFlows();
    render(<GitLiteSetup onReady={() => {}} flows={flows} />);
    await waitFor(() => expect(screen.getByTestId('setup-choose')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTestId('setup-skip')); });
    expect(screen.getByTestId('wizard-provider')).toBeTruthy();
  });

  it('应用已登记但未登录 → 直接给「登录」主按钮，直达向导登录步', async () => {
    const flows = stubSetupFlows({
      detect: vi.fn(async () => ({
        github: { oauthApp: true, token: true },
        gitee: { oauthApp: true, token: false }
      }))
    });
    render(<GitLiteSetup onReady={() => {}} flows={flows} />);
    await waitFor(() => expect(screen.getByTestId('setup-choose')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTestId('setup-login-gitee')); });
    await waitFor(() => expect(screen.getByTestId('wizard-login')).toBeTruthy()); // 直达 gitee 登录步
    expect(screen.getByTestId('wizard-login').textContent).toContain('Gitee');
  });
});
