// schema 序列化/反序列化工具（JSONC 注释剥离）
export function stripJsonComments(text: string): string {
  let out = '', i = 0, inStr = false, strCh = '';
  while (i < text.length) {
    const c = text[i]!, n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === strCh) inStr = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

export function parseJsonc(text: string): any {
  // 剥注释 + 去尾逗号（,} 或 ,] 前的逗号）
  const noComments = stripJsonComments(text);
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
}
