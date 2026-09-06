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
  let destinations = null;
  for (let i = 0; i < text.length; i++) {
    while (i > lineEnd) lineEnd = lineBreaks.exec(text)?.index ?? text.length;
    if (hidden[i] || text[i] !== '[' || escaped(text, i)) continue;
    const image = i > 0 && text[i - 1] === '!' && !escaped(text, i - 1);
    let parsed = null;
    if (text[i + 1] === '[') {
      const outerClose = brackets.get(i);
      const close = outerClose === undefined ? -1 : outerClose - 1;
      if (close !== -1 && text[close] === ']' && close < lineEnd && hiddenPrefix[close + 2] === hiddenPrefix[i]) {
        // Search only this link: a document of plain wiki links must not
        // rescan every remaining link while looking for a nonexistent alias.
        const aliasOffset = text.slice(i + 2, close).indexOf('|');
        const targetEnd = aliasOffset !== -1 ? i + 2 + aliasOffset : close;
        if (targetEnd > i + 2) parsed = {
          start: i, end: close + 2, targetStart: i + 2, targetEnd,
          label: targetEnd < close ? text.slice(targetEnd + 1, close) : null, kind: 'wiki',
        };
      }
    } else {
      const close = brackets.get(i);
      // Find the balanced label without treating inline code's brackets as syntax.
      if (close !== undefined && text[close + 1] === '(') {
        destinations ??= destinationIndex(text, hidden);
        const destination = parseDestination(text, close + 2, hidden, destinations);
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

// Each candidate consults this suffix index in constant time. In particular,
// repeated "[x](" prefixes must not rescan the entire unfinished destination.
// bareEnd jumps balanced parentheses; angleEnd and titleEnd preserve the
// existing delimiter/escape rules without imposing an arbitrary length cap.
function destinationIndex(text, hidden) {
  const length = text.length;
  const bareEnd = new Int32Array(length + 1);
  const angleEnd = new Int32Array(length + 1);
  const nextText = new Int32Array(length + 1);
  const titleEnd = new Int32Array(length + 1);
  const escapes = new Uint8Array(length);
  let slashes = 0;
  for (let i = 0; i < length; i++) {
    escapes[i] = slashes % 2;
    slashes = text[i] === '\\' ? slashes + 1 : 0;
  }
  bareEnd[length] = angleEnd[length] = -1;
  nextText[length] = length;
  let single = -1, double = -1, right = -1;
  for (let i = length - 1; i >= 0; i--) {
    const char = text[i];
    const space = /\s/.test(char);
    nextText[i] = space ? nextText[i + 1] : i;
    titleEnd[i] = char === "'" ? single : char === '"' ? double : char === '(' ? right : -1;
    if (!escapes[i]) {
      if (char === "'") single = i;
      if (char === '"') double = i;
      if (char === ')') right = i;
    }
    if (hidden[i]) {
      bareEnd[i] = angleEnd[i] = -1;
      continue;
    }
    if (space || (char === ')' && !escapes[i])) bareEnd[i] = i;
    else if (char === '(' && !escapes[i]) {
      const close = bareEnd[i + 1];
      bareEnd[i] = close >= 0 && text[close] === ')' && !escapes[close] ? bareEnd[close + 1] : -1;
    } else bareEnd[i] = bareEnd[i + 1];
    angleEnd[i] = char === '>' && !escapes[i] ? i
      : char === '\n' || (char === '<' && !escapes[i]) ? -1 : angleEnd[i + 1];
  }
  return { bareEnd, angleEnd, nextText, titleEnd };
}

function parseDestination(text, start, hidden, index) {
  let cursor = index.nextText[start];
  const angle = text[cursor] === '<';
  if (angle) cursor++;
  const targetStart = cursor;
  const targetEnd = (angle ? index.angleEnd : index.bareEnd)[cursor];
  if (targetEnd === undefined || targetEnd < 0 || targetEnd === targetStart) return null;
  cursor = targetEnd + (angle ? 1 : 0);
  const beforeSpace = cursor;
  cursor = index.nextText[cursor];
  // A title is distinct from the destination. Preserve it byte-for-byte.
  if (cursor > beforeSpace && ['"', "'", '('].includes(text[cursor])) {
    const close = index.titleEnd[cursor];
    if (close < 0) return null;
    cursor = index.nextText[close + 1];
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
  const spanEnds = codeSpanEnds(text, mask);
  const htmlStart = /<(pre|code|script|style)(?=\s|>)/iy;
  let nextAngle = -1;
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) continue;
    htmlStart.lastIndex = i;
    const literalHtml = text[i] === '<' && htmlStart.exec(text);
    if (literalHtml && nextAngle < i) {
      const found = text.indexOf('>', i + literalHtml[0].length);
      nextAngle = found < 0 ? text.length : found;
    }
    if (literalHtml && nextAngle < text.length) {
      const closing = new RegExp(`</${literalHtml[1]}\\s*>`, 'ig');
      closing.lastIndex = nextAngle + 1;
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
    const end = spanEnds.get(i) ?? -1;
    if (end !== -1) { mask.fill(1, i, end); i = end - 1; }
    else i += length - 1; // Unmatched ticks are literal Markdown text.
  }
  return mask;
}

// Pair full backtick runs backwards within each unmasked block. An unmatched
// delimiter consults one lookup instead of rescanning all later runs. An
// escaped first tick can still leave the suffix as an opener (the established
// parser contract), but closing runs always count their complete length.
function codeSpanEnds(text, mask) {
  const runs = [];
  let segment = 0;
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) { segment++; continue; }
    if (text[i] !== '`') continue;
    const start = i;
    while (text[i + 1] === '`') i++;
    runs.push({ start, end: i + 1, length: i + 1 - start, segment });
  }
  const next = new Map();
  const ends = new Map();
  let currentSegment = -1;
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run.segment !== currentSegment) { next.clear(); currentSegment = run.segment; }
    if (next.has(run.length)) ends.set(run.start, next.get(run.length));
    if (run.length > 1 && escaped(text, run.start) && next.has(run.length - 1)) ends.set(run.start + 1, next.get(run.length - 1));
    next.set(run.length, run.end);
  }
  return ends;
}
