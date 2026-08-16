// 浏览器演示专用桩：页面不直接使用 node 运行时（真实能力由本服务的 /api 在服务端执行）。
// esbuild 打包时把 '@gitlite/adapters-node' 指到此文件，避免 node 内置被打进浏览器包。
export const createNodeRuntime = (): never => {
  throw new Error('browser demo: node runtime only exists server-side (/api/*)');
};
export const waitForRedirect = createNodeRuntime;
export const createNodeSqlite = (): null => null;
