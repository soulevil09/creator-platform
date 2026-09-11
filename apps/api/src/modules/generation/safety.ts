// =============================================================================
// Content-safety gate — runs on every CUSTOM prompt, before any credit is
// touched and before any row is written. Non-negotiable, no role bypass, no
// env switch: the function has no configuration surface at all.
//
// Two rejection categories, both of which the platform owns regardless of
// what the image provider's own filter is set to (we turn the provider's
// nudity checker OFF — this is a consented adult platform — so nothing
// upstream is doing this job for us):
//
//   minor        — any signal that the requested subject is under 18: age
//                  numerals and spelled-out ages, age-related nouns, school
//                  and childlike descriptors, in English and Portuguese.
//   real_person  — any signal that the prompt names or targets a real person
//                  other than the model being personalized: social handles and
//                  profile links, celebrity/public-figure vocabulary,
//                  relationship targeting ("my ex", "minha vizinha"),
//                  resemblance/face-swap phrasing, and Title-Case proper-name
//                  runs. The model's own name is exempt (it is the one
//                  likeness that HAS been consented to).
//
// Deliberately conservative. A false positive costs a subscriber one retry
// with different wording; a false negative is the platform generating an
// image it must never produce. Fail closed.
//
// Pure and synchronous. The caller writes the audit row (with `hashPrompt`,
// never the plaintext) — this file decides, it does not record.
// =============================================================================
import { createHash } from 'node:crypto';

export type PromptRejectionCategory = 'minor' | 'real_person';

export type PromptSafetyResult = { ok: true } | { ok: false; category: PromptRejectionCategory };

export interface PromptSafetyOptions {
  /**
   * Names the prompt may legitimately contain — the model's display name(s).
   * Stripped before the real-person checks so "Ana Silva in a red dress" is
   * fine when Ana Silva is the model, and only when she is.
   */
  allowedNames?: readonly string[];
}

// ── Normalization ────────────────────────────────────────────────────────────

/** Lowercase, strip diacritics, keep only letters/digits as word tokens. */
function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile a phrase list into one word-bounded, case-insensitive matcher. */
function phraseMatcher(phrases: readonly string[]): RegExp {
  const alternatives = phrases.map((phrase) => escapeRegExp(normalize(phrase))).join('|');
  return new RegExp(`(?:^|\\s)(?:${alternatives})(?=\\s|$)`);
}

// ── Category 1: minors ───────────────────────────────────────────────────────

const MINOR_PHRASES: readonly string[] = [
  // English — age nouns and descriptors
  'child',
  'children',
  'childlike',
  'child like',
  'childish',
  'kid',
  'kids',
  'kiddo',
  'kiddie',
  'minor',
  'minors',
  'underage',
  'under age',
  'under 18',
  'younger than 18',
  'below 18',
  'not yet 18',
  'preteen',
  'pre teen',
  'tween',
  'toddler',
  'infant',
  'newborn',
  'teen',
  'teens',
  'teenage',
  'teenager',
  'teenagers',
  'adolescent',
  'adolescents',
  'juvenile',
  'little girl',
  'little boy',
  'young girl',
  'young boy',
  'small girl',
  'small boy',
  'baby girl',
  'baby boy',
  'daughter',
  'stepdaughter',
  'step daughter',
  'little sister',
  'little brother',
  'kid sister',
  'kid brother',
  // English — school
  'schoolgirl',
  'school girl',
  'schoolboy',
  'school boy',
  'school uniform',
  'school outfit',
  'high school',
  'highschool',
  'middle school',
  'junior high',
  'elementary',
  'grade school',
  'kindergarten',
  'preschool',
  'pre school',
  'girl scout',
  'boy scout',
  // English — abuse vocabulary
  'loli',
  'lolita',
  'lolicon',
  'shota',
  'shotacon',
  'jailbait',
  'pedo',
  'pedophile',
  'paedophile',
  // Portuguese — age nouns and descriptors
  'crianca',
  'criancas',
  'criancinha',
  'menininha',
  'menininho',
  'garotinha',
  'garotinho',
  'novinha',
  'novinhas',
  'novinho',
  'ninfeta',
  'ninfetinha',
  'menor de idade',
  'menores de idade',
  'de menor',
  'menor de 18',
  'menos de 18',
  'abaixo de 18',
  'adolescente',
  'adolescentes',
  'pre adolescente',
  'bebezinha',
  'bebezinho',
  'recem nascido',
  'recem nascida',
  'infantil',
  'infancia',
  'filha',
  'filhinha',
  'filhinho',
  'enteada',
  'irmazinha',
  'irmaozinho',
  // Portuguese — school
  'colegial',
  'colegio',
  'escola',
  'escolar',
  'uniforme escolar',
  'uniforme de escola',
  'ensino medio',
  'ensino fundamental',
  'primario',
  'creche',
  'pre escola',
  // Portuguese — abuse vocabulary
  'pedofilo',
  'pedofilia',
];

const MINOR_MATCHER = phraseMatcher(MINOR_PHRASES);

/** Spelled-out ages, English and Portuguese, 0–17. */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  catorze: 14,
  quatorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
};

const NUMBER_TOKEN = `(?:\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;

/**
 * "<n> years old", "<n> yo", "<n> y o" (from "y/o"), "<n> anos", "age <n>",
 * "aged <n>", "idade <n>", "<n> de idade", "<n>th grade", "<n> ano escolar". Each pattern
 * captures the number; a captured value under 18 rejects.
 */
const AGE_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `(?:^|\\s)(${NUMBER_TOKEN}) ?(?:years? old|year olds|yrs? old|yo|y o|years?|yrs?)(?=\\s|$)`,
    'g',
  ),
  new RegExp(`(?:^|\\s)(${NUMBER_TOKEN}) ?(?:anos|aninhos|anitos|ano)(?=\\s|$)`, 'g'),
  new RegExp(`(?:^|\\s)(?:age|aged|age of|idade|idade de) (${NUMBER_TOKEN})(?=\\s|$)`, 'g'),
  new RegExp(`(?:^|\\s)(${NUMBER_TOKEN}) de idade(?=\\s|$)`, 'g'),
  new RegExp(
    `(?:^|\\s)(${NUMBER_TOKEN})(?:st|nd|rd|th)? (?:grade|grader|ano escolar)(?=\\s|$)`,
    'g',
  ),
];

function numberOf(token: string): number {
  return NUMBER_WORDS[token] ?? Number(token);
}

function indicatesMinor(normalized: string): boolean {
  if (MINOR_MATCHER.test(normalized)) return true;
  for (const pattern of AGE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized)) !== null) {
      const age = numberOf(match[1]);
      if (Number.isFinite(age) && age < 18) return true;
    }
  }
  return false;
}

// ── Category 2: real people other than the model ─────────────────────────────

const REAL_PERSON_PHRASES: readonly string[] = [
  // English — public-figure vocabulary
  'celebrity',
  'celebrities',
  'celeb',
  'famous',
  'popstar',
  'pop star',
  'rockstar',
  'rock star',
  'movie star',
  'film star',
  'tv star',
  'idol',
  'kpop',
  'k pop',
  'influencer',
  'influencers',
  'youtuber',
  'streamer',
  'tiktoker',
  'instagrammer',
  'pornstar',
  'porn star',
  'adult star',
  'first lady',
  'royal family',
  // English — relationship targeting
  'my ex',
  'my girlfriend',
  'my wife',
  'my boyfriend',
  'my husband',
  'my neighbor',
  'my neighbour',
  'my coworker',
  'my co worker',
  'my colleague',
  'my boss',
  'my teacher',
  'my professor',
  'my classmate',
  'my roommate',
  'my friend',
  'my best friend',
  'my crush',
  'my sister',
  'my brother',
  'my cousin',
  'my mom',
  'my mother',
  'my stepmom',
  'my step mom',
  'my aunt',
  'my niece',
  'my nephew',
  'my student',
  'my patient',
  'my secretary',
  'my nanny',
  'my babysitter',
  // English — resemblance / face swap
  'looks like',
  'look like',
  'looking like',
  'lookalike',
  'look alike',
  'resemble',
  'resembles',
  'resembling',
  'resemblance',
  'similar to',
  'the face of',
  'with the face of',
  'likeness of',
  'in the likeness of',
  'deepfake',
  'deep fake',
  'faceswap',
  'face swap',
  'swap the face',
  // Portuguese — public-figure vocabulary
  'celebridade',
  'celebridades',
  'famosa',
  'famoso',
  'influenciadora',
  'influenciador',
  'primeira dama',
  'estrela porno',
  'atriz porno',
  // Portuguese — relationship targeting
  'minha ex',
  'meu ex',
  'minha namorada',
  'meu namorado',
  'minha esposa',
  'minha mulher',
  'meu marido',
  'minha vizinha',
  'meu vizinho',
  'minha colega',
  'meu colega',
  'minha chefe',
  'meu chefe',
  'minha professora',
  'meu professor',
  'minha amiga',
  'meu amigo',
  'minha melhor amiga',
  'minha crush',
  'meu crush',
  'minha irma',
  'meu irmao',
  'minha prima',
  'meu primo',
  'minha mae',
  'minha tia',
  'minha madrasta',
  'minha sogra',
  'minha cunhada',
  'minha sobrinha',
  'minha enteada',
  'minha aluna',
  'minha paciente',
  'minha secretaria',
  // Portuguese — resemblance / face swap
  'parecida com',
  'parecido com',
  'parecendo',
  'igual a',
  'igualzinha',
  'igualzinho',
  'semelhante a',
  'com o rosto da',
  'com o rosto do',
  'com o rosto de',
  'com a cara da',
  'com a cara do',
  'com a cara de',
  'troca de rosto',
];

const REAL_PERSON_MATCHER = phraseMatcher(REAL_PERSON_PHRASES);

/** "@handle" — a social-media handle is a pointer to a real account. */
const HANDLE_PATTERN = /(?:^|[\s(])@[a-z0-9_.]{2,}/i;

/** Links and platform names — a profile link is a real-person reference. */
const LINK_PATTERN =
  /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|br|io|tv|me|xyz|app)\b)|\b(?:instagram|insta|tiktok|twitter|onlyfans|facebook|youtube|twitch|reddit|snapchat|telegram|linkedin|fansly)\b/i;

/**
 * Two or more consecutive Title-Case words ("Taylor Swift", "Ana Clara
 * Souza"). Each word must have a lowercase tail so SHOUTED prompts do not
 * count, and a name particle (de/da/do/dos/das/van/von/di) may sit between
 * them. Runs on the original text — case is the signal — after the allowed
 * names have been removed.
 */
const PROPER_NAME_PATTERN =
  /\b\p{Lu}\p{Ll}+(?:\s+(?:d[aeo]s?|van|von|di|del|de la)\s+|\s+)\p{Lu}\p{Ll}+\b/u;

function stripAllowedNames(text: string, allowedNames: readonly string[]): string {
  let result = text;
  for (const name of allowedNames) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    result = result.replace(new RegExp(escapeRegExp(trimmed), 'gi'), ' ');
  }
  return result;
}

function indicatesRealPerson(raw: string, normalized: string): boolean {
  return (
    HANDLE_PATTERN.test(raw) ||
    LINK_PATTERN.test(raw) ||
    REAL_PERSON_MATCHER.test(normalized) ||
    PROPER_NAME_PATTERN.test(raw)
  );
}

// ── Public surface ───────────────────────────────────────────────────────────

/**
 * Decide whether a CUSTOM prompt may be generated. Minor signals win over
 * real-person signals when both are present (the audit category should name
 * the more serious one).
 */
export function checkPromptSafety(
  prompt: string,
  options: PromptSafetyOptions = {},
): PromptSafetyResult {
  const withoutModelName = stripAllowedNames(prompt, options.allowedNames ?? []);
  const normalized = normalize(withoutModelName);

  if (indicatesMinor(normalized)) {
    return { ok: false, category: 'minor' };
  }
  if (indicatesRealPerson(withoutModelName, normalized)) {
    return { ok: false, category: 'real_person' };
  }
  return { ok: true };
}

/**
 * What the audit row carries instead of the prompt: a SHA-256 of the trimmed
 * text, so repeat attempts with the same wording can be correlated without
 * the wording itself sitting in the log table.
 */
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt.trim(), 'utf8').digest('hex');
}
