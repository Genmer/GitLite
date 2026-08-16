// @vitest-environment jsdom
// GitLiteWizard 测试：注入 stub flows 走完多步状态机（选平台→登录→配置→连接→onReady）+ 错误路径
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GitLiteWizard, type WizardFlows } from './index.js';

afterEach(cleanup); // vitest 未开 globals → RTL 自动清理不生效，手动清理

const fakeDb = { fake: 'client' } as any;

function stubFlows(overrides: Partial<WizardFlows> = {}): WizardFlows {
  return {
    login: vi.fn(async (_p, onCode) => {
      onCode('打开 example.com 输入代码: ABC-123');
      await new Promise(r => setTimeout(r, 30)); // 留出登录步渲染提示的时间
      return 'tok-1';
    }),
    identity: vi.fn(async () => 'alice'),
    connect: vi.fn(async () => fakeDb),
    ...overrides
  };
}

describe('GitLiteWizard（内置向导）', () => {
  it('全流程：GitHub → 登录（onCode 提示）→ 身份预填 → 连接 → onReady(db)', async () => {
    const flows = stubFlows();
    const onReady = vi.fn();
    render(<GitLiteWizard onReady={onReady} flows={flows} />);

    // 选平台
    expect(screen.getByTestId('wizard-provider')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('GitHub')); });
    expect(screen.getByTestId('wizard-login')).toBeTruthy();

    // 登录：提示码在登录步可见；成功后进入配置，owner 已由 identity 预填
    await act(async () => { fireEvent.click(screen.getByText('登录')); });
    await waitFor(() => expect(screen.getByTestId('wizard-hint').textContent).toContain('ABC-123'));
    await waitFor(() => expect(screen.getByTestId('wizard-config')).toBeTruthy());
    expect((screen.getByTestId('wizard-owner') as HTMLInputElement).value).toBe('alice');

    // 连接：参数透传 + onReady 收到 db
    await act(async () => { fireEvent.click(screen.getByTestId('wizard-connect')); });
    await waitFor(() => expect(screen.getByTestId('wizard-done')).toBeTruthy());
    expect(onReady).toHaveBeenCalledWith(fakeDb);
    expect(flows.connect).toHaveBeenCalledWith('github', expect.objectContaining({
      token: 'tok-1', owner: 'alice', repo: 'gitlite-repo', database: 'default'
    }));
  });

  it('连接进度回调渲染步骤文案', async () => {
    const flows = stubFlows({
      connect: vi.fn(async (_p, opts) => {
        opts.onProgress('create-repo');
        opts.onProgress('ready');
        return fakeDb;
      })
    });
    render(<GitLiteWizard onReady={() => {}} flows={flows} />);
    await act(async () => { fireEvent.click(screen.getByText('Gitee')); });
    await act(async () => { fireEvent.click(screen.getByText('登录')); });
    await waitFor(() => expect(screen.getByTestId('wizard-config')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByTestId('wizard-connect')); });
    await waitFor(() => expect(screen.getByTestId('wizard-done')).toBeTruthy());
  });

  it('登录失败 → error 步骤；重试回到登录', async () => {
    const flows = stubFlows({ login: vi.fn(async () => { throw new Error('user denied'); }) });
    render(<GitLiteWizard onReady={() => {}} flows={flows} />);
    await act(async () => { fireEvent.click(screen.getByText('GitHub')); });
    await act(async () => { fireEvent.click(screen.getByText('登录')); });
    await waitFor(() => expect(screen.getByTestId('wizard-error')).toBeTruthy());
    expect(screen.getByTestId('wizard-error').textContent).toContain('user denied');
    await act(async () => { fireEvent.click(screen.getByText('重试')); });
    expect(screen.getByTestId('wizard-login')).toBeTruthy();
  });

  it('identity 失败可手填 owner；owner 为空连接被拦', async () => {
    const flows = stubFlows({ identity: vi.fn(async () => null) });
    render(<GitLiteWizard onReady={() => {}} flows={flows} />);
    await act(async () => { fireEvent.click(screen.getByText('GitHub')); });
    await act(async () => { fireEvent.click(screen.getByText('登录')); });
    await waitFor(() => expect(screen.getByTestId('wizard-config')).toBeTruthy());
    // owner 空 → 点连接被本地拦截
    await act(async () => { fireEvent.change(screen.getByTestId('wizard-owner'), { target: { value: '' } }); });
    await act(async () => { fireEvent.click(screen.getByTestId('wizard-connect')); });
    await waitFor(() => expect(screen.getByTestId('wizard-error')).toBeTruthy());
    expect(flows.connect).not.toHaveBeenCalled();
  });
});
