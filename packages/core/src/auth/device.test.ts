import { describe, expect, it, vi } from 'vitest';
import { deviceFlowLogin } from './device.js';
import { AuthError } from '../errors.js';

function mockFetch(steps: Array<{ body: any }>): typeof fetch {
  let i = 0;
  return (async () => {
    const s = steps[Math.min(i++, steps.length - 1)]!;
    return new Response(JSON.stringify(s.body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
}

const noSleep = async () => {}; // 测试注入：跳过真实等待
const slept: number[] = [];
const fakeSleep = async (ms: number) => { slept.push(ms); };

describe('Device Flow（FR B1）', () => {
  it('pending → token；回调拿到 user_code', async () => {
    const onCode = vi.fn();
    const f = mockFetch([
      { body: { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 0 } },
      { body: { error: 'authorization_pending' } },
      { body: { access_token: 'tok123' } }
    ]);
    const { token } = await deviceFlowLogin(f, { onCode }, { sleep: noSleep });
    expect(token).toBe('tok123');
    expect(onCode).toHaveBeenCalledWith('ABCD-1234', 'https://github.com/login/device');
  });

  it('slow_down → interval 自增；expired → AuthError', async () => {
    slept.length = 0;
    const f1 = mockFetch([
      { body: { device_code: 'd', user_code: 'X', verification_uri: 'u', interval: 1 } },
      { body: { error: 'slow_down' } },
      { body: { access_token: 'ok' } }
    ]);
    expect((await deviceFlowLogin(f1, { onCode: () => {} }, { sleep: fakeSleep })).token).toBe('ok');
    expect(slept[0]).toBe(1000);   // 初始 interval 1s
    expect(slept[1]).toBe(6000);   // slow_down +5s

    const f2 = mockFetch([
      { body: { device_code: 'd', user_code: 'X', verification_uri: 'u', interval: 0 } },
      { body: { error: 'expired_token' } }
    ]);
    await expect(deviceFlowLogin(f2, { onCode: () => {} }, { sleep: noSleep }))
      .rejects.toBeInstanceOf(AuthError);
  });
});
