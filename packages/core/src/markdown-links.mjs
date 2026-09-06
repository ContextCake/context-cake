// Lossless spans for the inline Markdown and wiki links ContextCake supports.
// Detection and repairs must consume this same parser: examples are content,
// never outgoing links. Reference links are intentionally outside this contract.
export function markdownLinkSpans(value) {
  const text = String(value);
  const hidden = codeMask(text);
  const brackets = closingBrackets(text, hidden);
  const hiddenPrefix = new Uint32Array(text.length + 1);
  for (let i = 0; i < hidden.length; i++) hiddenPrefix[i + 1] = hiddenPrefix[i] + hidden[i];
  const lineBreaks = /[\r\n]/g;
  let lineEnd = lineBreaks.exec(text)?.index ?? text.length;
  const links = [];
  for (let i = 0; i < text.length; i++) {
    while (i > lineEnd) lineEnd = lineBreaks.exec(text)?.index ?? text.length;
    if (hidden[i] || text[i] !== '[' || escaped(text, i)) continue;
    const image = i > 0 && text[i - 1] === '!' && !escaped(text, i - 1);
    let parsed = null;
    if (text[i + 1] === '[') {
      const outerClose = brackets.get(i);
      const close = outerClose === undefined ? -1 : outerClose - 1;
      if (close !== -1 && text[close] === ']' && close < lineEnd && hiddenPrefix[close + 2] === hiddenPrefix[i]) {
        const pipe = text.indexOf('|', i + 2);
        const targetEnd = pipe !== -1 && pipe < close ? pipe : close;
        if (targetEnd > i + 2) parsed = {
          start: i, end: close + 2, targetStart: i + 2, targetEnd,
          label: targetEnd < close ? text.slice(targetEnd + 1, close) : null, kind: 'wiki',
        };
      }
    } else {
      const close = brackets.get(i);
      // Find the balanced label without treating inline code's brackets as syntax.
      if (close !== undefined && text[close + 1] === '(') {
        const destination = parseDestination(text, close + 2, hidden);
        if (destination) parsed = { start: i, ...destination, label: text.slice(i + 1, close), kind: 'markdown' };
      }
    }
    if (!parsed) continue;
    if (!image) links.push({ ...parsed, target: text.slice(parsed.targetStart, parsed.targetEnd), raw: text.slice(parsed.start, parsed.end) });
    i = parsed.end - 1;
  }
  return links;
}

// Pair brackets in one pass so a document full of unmatched opening brackets
// cannot turn link discovery into quadratic work.
function closingBrackets(text, hidden) {
  const stack = [];
  const result = new Map();
  for (let i = 0; i < text.length; i++) {
    if (hidden[i] || (text[i] !== '[' && text[i] !== ']') || escaped(text, i)) continue;
    if (text[i] === '[') stack.push(i);
    else if (text[i] === ']' && stack.length) result.set(stack.pop(), i);
  }
  return result;
}

function escaped(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

function parseDestination(text, start, hidden) {
  let cursor = start;
  while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
  const angle = text[cursor] === '<';
  if (angle) cursor++;
  const targetStart = cursor;
  let depth = 0;
  while (cursor < text.length) {
    if (hidden[cursor]) return null;
    const char = text[cursor];
    if ('()<>'.includes(char) && escaped(text, cursor)) { cursor++; continue; }
    if (angle) {
      if (char === '>') break;
      if (char === '\n' || char === '<') return null;
    } else {
      if (/\s/.test(char)) break;
      if (char === '(') depth++;
      if (char === ')') { if (depth === 0) break; depth--; }
    }
    cursor++;
  }
  const targetEnd = cursor;
  if (targetEnd === targetStart || depth !== 0 || cursor === text.length) return null;
  if (angle && text[cursor++] !== '>') return null;
  const beforeSpace = cursor;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
  // A title is distinct from the destination. Preserve it byte-for-byte.
  if (cursor > beforeSpace && ['"', "'", '('].includes(text[cursor])) {
    const endQuote = text[cursor] === '(' ? ')' : text[cursor];
    cursor++;
    while (cursor < text.length && (text[cursor] !== endQuote || escaped(text, cursor))) cursor++;
    if (cursor === text.length) return null;
    cursor++;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
  }
  if (text[cursor] !== ')' || hidden[cursor]) return null;
  return { targetStart, targetEnd, end: cursor + 1 };
}

function codeMask(text) {
  const mask = new Uint8Array(text.length);
  let fence = null;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    // Blockquote markers can precede fences in quoted documentation examples.
    const content = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
    const marker = content.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (fence) {
      mask.fill(1, offset, offset + line.length);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length };
      mask.fill(1, offset, offset + line.length);
    } else if (/^(?: {4}|\t)/.test(content)) {
      // Conservative for indented examples; never repair possibly literal code.
      mask.fill(1, offset, offset + line.length);
    }
    offset += line.length;
  }
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) continue;
    const literalHtml = text[i] === '<' && text.slice(i).match(/^<(pre|code|script|style)(?:\s[^>]*|)>/i);
    if (literalHtml) {
      const closing = new RegExp(`</${literalHtml[1]}\\s*>`, 'ig');
      closing.lastIndex = i + literalHtml[0].length;
      const found = closing.exec(text);
      const end = found ? closing.lastIndex : text.length;
      mask.fill(1, i, end);
      i = end - 1;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      const end = close === -1 ? text.length : close + 3;
      mask.fill(1, i, end);
      i = end - 1;
      continue;
    }
    if (text[i] !== '`' || escaped(text, i)) continue;
    let length = 1;
    while (text[i + length] === '`') length++;
    let cursor = i + length;
    let end = -1;
    while (cursor < text.length) {
      if (mask[cursor]) break; // A code span cannot cross a fenced block.
      if (text[cursor] !== '`') { cursor++; continue; }
      let run = 1;
      while (text[cursor + run] === '`') run++;
      if (run === length) { end = cursor + run; break; }
      cursor += run;
    }
    if (end !== -1) { mask.fill(1, i, end); i = end - 1; }
    else i += length - 1; // Unmatched ticks are literal Markdown text.
  }
  return mask;
}
