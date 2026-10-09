// Rails' default English inflections (ActiveSupport's inflections.rb), for
// route names, controller and model names and table names. A repository's
// own inflections (config/initializers/inflections.rb) are executable and
// never read, so every name made here is a convention: a rule that relies on
// one is likely at most, and its note says so.

type Rule = [RegExp, string];

// Most specific first (ActiveSupport applies the last defined rule first).
const PLURALS: Rule[] = [
  [/(quiz)$/i, "$1zes"],
  [/^(oxen)$/i, "$1"],
  [/^(ox)$/i, "$1en"],
  [/^(m|l)ice$/i, "$1ice"],
  [/^(m|l)ouse$/i, "$1ice"],
  [/(matr|vert|ind)(?:ix|ex)$/i, "$1ices"],
  [/(x|ch|ss|sh)$/i, "$1es"],
  [/([^aeiouy]|qu)y$/i, "$1ies"],
  [/(hive)$/i, "$1s"],
  [/(?:([^f])fe|([lr])f)$/i, "$1$2ves"],
  [/sis$/i, "ses"],
  [/([ti])a$/i, "$1a"],
  [/([ti])um$/i, "$1a"],
  [/(buffal|tomat)o$/i, "$1oes"],
  [/(bu)s$/i, "$1ses"],
  [/(alias|status)$/i, "$1es"],
  [/(octop|vir)i$/i, "$1i"],
  [/(octop|vir)us$/i, "$1i"],
  [/^(ax|test)is$/i, "$1es"],
  [/s$/i, "s"],
  [/$/, "s"],
];

const SINGULARS: Rule[] = [
  [/(database)s$/i, "$1"],
  [/(quiz)zes$/i, "$1"],
  [/(matr)ices$/i, "$1ix"],
  [/(vert|ind)ices$/i, "$1ex"],
  [/^(ox)en/i, "$1"],
  [/(alias|status)(es)?$/i, "$1"],
  [/(octop|vir)(us|i)$/i, "$1us"],
  [/^(a)x[ie]s$/i, "$1xis"],
  [/(cris|test)(is|es)$/i, "$1is"],
  [/(shoe)s$/i, "$1"],
  [/(o)es$/i, "$1"],
  [/(bus)(es)?$/i, "$1"],
  [/^(m|l)ice$/i, "$1ouse"],
  [/(x|ch|ss|sh)es$/i, "$1"],
  [/(m)ovies$/i, "$1ovie"],
  [/(s)eries$/i, "$1eries"],
  [/([^aeiouy]|qu)ies$/i, "$1y"],
  [/([lr])ves$/i, "$1f"],
  [/(tive)s$/i, "$1"],
  [/(hive)s$/i, "$1"],
  [/([^f])ves$/i, "$1fe"],
  [/(^analy)(sis|ses)$/i, "$1sis"],
  [/((a)naly|(b)a|(d)iagno|(p)arenthe|(p)rogno|(s)ynop|(t)he)(sis|ses)$/i, "$1sis"],
  [/([ti])a$/i, "$1um"],
  [/(n)ews$/i, "$1ews"],
  [/(ss)$/i, "$1"],
  [/s$/i, ""],
];

const IRREGULAR: [string, string][] = [
  ["person", "people"],
  ["man", "men"],
  ["child", "children"],
  ["sex", "sexes"],
  ["move", "moves"],
  ["zombie", "zombies"],
];

const UNCOUNTABLE = new Set(["equipment", "information", "rice", "money", "species", "series", "fish", "sheep", "jeans", "police"]);

// The longest name inflected; a longer one is returned as written, so no
// rule ever runs on a long run of repository text.
export const MAX_NAME = 128;

function inflect(word: string, rules: Rule[], irregular: (pair: [string, string]) => [string, string]): string {
  if (word === "" || word.length > MAX_NAME) return word;
  const last = word.split("_").pop() as string;
  if (UNCOUNTABLE.has(last.toLowerCase())) return word;
  for (const pair of IRREGULAR) {
    const [from, to] = irregular(pair);
    const low = last.toLowerCase();
    // A short irregular word only as the whole word ("man", "woman"), a
    // longer one also as a suffix ("salesperson").
    if (low === from || low === `wo${from}` || (from.length > 3 && low.endsWith(from))) {
      // Keep the case of the first letter the rule replaces.
      const head = word.slice(0, word.length - from.length);
      const first = word[word.length - from.length] as string;
      return head + (first === first.toUpperCase() ? to[0]?.toUpperCase() : to[0]) + to.slice(1);
    }
  }
  for (const [re, to] of rules) if (re.test(word)) return word.replace(re, to);
  return word;
}

export function pluralize(word: string): string {
  return inflect(word, PLURALS, (p) => p);
}

export function singularize(word: string): string {
  return inflect(word, SINGULARS, ([a, b]) => [b, a]);
}

// "admin/blog_posts" to "Admin::BlogPosts".
export function camelize(path: string): string {
  return path
    .split("/")
    .map((part) =>
      part
        .split("_")
        .map((w) => (w === "" ? "" : (w[0] as string).toUpperCase() + w.slice(1)))
        .join(""),
    )
    .join("::");
}

// "Admin::BlogPosts" to "admin/blog_posts", "HTTPClient" to "http_client":
// an underscore before an upper-case letter that follows a lower-case
// letter or a digit, or that starts a word after a run of capitals. A
// character loop, linear in the name.
export function underscore(name: string): string {
  const s = name.startsWith("::") ? name.slice(2) : name;
  const upper = (c: string | undefined) => c !== undefined && c >= "A" && c <= "Z";
  const lowerOrDigit = (c: string | undefined) => c !== undefined && ((c >= "a" && c <= "z") || (c >= "0" && c <= "9"));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === ":" && s[i + 1] === ":") {
      out += "/";
      i++;
      continue;
    }
    if (upper(c) && i > 0) {
      const prev = s[i - 1];
      if (lowerOrDigit(prev) || (upper(prev) && (s[i + 1] ?? "") >= "a" && (s[i + 1] ?? "") <= "z")) out += "_";
    }
    out += c === "-" ? "_" : c.toLowerCase();
  }
  return out;
}

// "Admin::BlogPost" to "BlogPost".
export function demodulize(name: string): string {
  const i = name.lastIndexOf("::");
  return i === -1 ? name : name.slice(i + 2);
}

// The table Rails names for a model class: "BlogPost" to "blog_posts".
export function tableize(className: string): string {
  return pluralize(underscore(demodulize(className)));
}

// The class an association or a resource name stands for: "comments" to "Comment".
export function classify(name: string): string {
  return camelize(singularize(name));
}
