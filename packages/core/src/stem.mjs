// Porter stemmer (Porter, 1980), so a query for "databases" reaches a document
// that says "database" and "rebalancing" reaches "rebalance".
//
// Deliberately the published algorithm rather than a hand-tuned suffix list:
// the retrieval eval is scored on questions written by hand, and a stemmer
// invented alongside those questions would be measuring itself. Porter predates
// this corpus by forty-odd years and cannot have been fitted to it.
//
// Dependency-free, like the rest of the engine.

const VOWEL = "aeiou";

function isConsonant(word, index) {
  const letter = word[index];
  if (VOWEL.includes(letter)) return false;
  // 'y' is a consonant unless the letter before it is one.
  if (letter !== "y") return true;
  return index === 0 ? true : !isConsonant(word, index - 1);
}

// The "measure": how many vowel-consonant sequences the stem contains. Porter
// uses it to avoid stripping suffixes off words that are too short to survive it.
function measure(word) {
  let count = 0;
  let index = 0;
  const length = word.length;

  while (index < length && isConsonant(word, index)) index += 1;
  while (index < length) {
    while (index < length && !isConsonant(word, index)) index += 1;
    if (index >= length) break;
    count += 1;
    while (index < length && isConsonant(word, index)) index += 1;
  }
  return count;
}

function hasVowel(word) {
  for (let index = 0; index < word.length; index += 1) {
    if (!isConsonant(word, index)) return true;
  }
  return false;
}

function endsWithDoubleConsonant(word) {
  if (word.length < 2) return false;
  const last = word.length - 1;
  return word[last] === word[last - 1] && isConsonant(word, last);
}

// consonant-vowel-consonant where the final consonant is not w, x or y.
function endsCvc(word) {
  if (word.length < 3) return false;
  const last = word.length - 1;
  if (!isConsonant(word, last) || isConsonant(word, last - 1) || !isConsonant(word, last - 2)) return false;
  return !"wxy".includes(word[last]);
}

function replaceSuffix(word, suffix, replacement, minMeasure) {
  if (!word.endsWith(suffix)) return null;
  const stem = word.slice(0, word.length - suffix.length);
  if (minMeasure !== undefined && measure(stem) <= minMeasure) return null;
  return stem + replacement;
}

const STEP2 = [
  ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"],
  ["izer", "ize"], ["bli", "ble"], ["alli", "al"], ["entli", "ent"],
  ["eli", "e"], ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
  ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"],
  ["ousness", "ous"], ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"],
  ["logi", "log"],
];

const STEP3 = [
  ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"],
  ["ical", "ic"], ["ful", ""], ["ness", ""],
];

const STEP4 = [
  "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement",
  "ment", "ent", "ou", "ism", "ate", "iti", "ous", "ive", "ize",
];

export function stem(input) {
  let word = input;
  // Too short to have a suffix worth removing, and acronyms like "tls" must not
  // lose their trailing s.
  if (word.length <= 3) return word;

  // Step 1a — plurals.
  word = replaceSuffix(word, "sses", "ss") ?? replaceSuffix(word, "ies", "i")
    ?? (word.endsWith("ss") ? word : replaceSuffix(word, "s", "")) ?? word;

  // Step 1b — past tense and gerunds.
  let step1bApplied = false;
  const eed = replaceSuffix(word, "eed", "ee", 0);
  if (eed !== null) {
    word = eed;
  } else {
    for (const suffix of ["ed", "ing"]) {
      if (!word.endsWith(suffix)) continue;
      const stripped = word.slice(0, word.length - suffix.length);
      if (!hasVowel(stripped)) continue;
      word = stripped;
      step1bApplied = true;
      break;
    }
  }
  if (step1bApplied) {
    if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) word += "e";
    else if (endsWithDoubleConsonant(word) && !"lsz".includes(word[word.length - 1])) word = word.slice(0, -1);
    else if (measure(word) === 1 && endsCvc(word)) word += "e";
  }

  // Step 1c — terminal y to i.
  if (word.endsWith("y") && hasVowel(word.slice(0, -1))) word = `${word.slice(0, -1)}i`;

  // Step 2 and 3 — derivational suffixes, longest match first.
  for (const [suffix, replacement] of STEP2) {
    const next = replaceSuffix(word, suffix, replacement, 0);
    if (next !== null) { word = next; break; }
  }
  for (const [suffix, replacement] of STEP3) {
    const next = replaceSuffix(word, suffix, replacement, 0);
    if (next !== null) { word = next; break; }
  }

  // Step 4 — strip the suffix entirely when the stem is substantial enough.
  for (const suffix of STEP4) {
    if (!word.endsWith(suffix)) continue;
    const stripped = word.slice(0, word.length - suffix.length);
    if (measure(stripped) <= 1) continue;
    word = stripped;
    break;
  }
  if (word.endsWith("ion")) {
    const stripped = word.slice(0, -3);
    if (measure(stripped) > 1 && (stripped.endsWith("s") || stripped.endsWith("t"))) word = stripped;
  }

  // Step 5 — tidy up a trailing e and a doubled l.
  if (word.endsWith("e")) {
    const stripped = word.slice(0, -1);
    const m = measure(stripped);
    if (m > 1 || (m === 1 && !endsCvc(stripped))) word = stripped;
  }
  if (measure(word) > 1 && endsWithDoubleConsonant(word) && word.endsWith("l")) word = word.slice(0, -1);

  return word;
}
