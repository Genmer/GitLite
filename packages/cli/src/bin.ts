#!/usr/bin/env node
// gitlite CLI 入口（由 bin 字段指向；node 直接执行本 TS 源时经 tsx/loader）
import { run } from './index.js';

run(process.argv.slice(2)).then(code => process.exit(code)).catch(e => {
  console.error(e);
  process.exit(1);
});
