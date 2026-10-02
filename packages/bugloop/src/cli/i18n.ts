/**
 * Language of the CLI and of the files `init` writes. Picked once per run:
 * --lang tr|en, then BUGLOOP_LANG, then the terminal locale (LC_ALL, LC_MESSAGES, LANG, LANGUAGE),
 * then the system locale. Turkish systems get Turkish; everything else gets English.
 */
export type CliLang = "tr" | "en";

export function detectCliLang(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): CliLang {
  const i = argv.indexOf("--lang");
  const fromFlag = i >= 0 ? argv[i + 1] : undefined;
  const fromEnv = [env.BUGLOOP_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG, env.LANGUAGE].find((v) => v && v.trim());
  let fromSystem = "";
  try {
    fromSystem = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {}
  const pick = (fromFlag || fromEnv || fromSystem || "").toLowerCase();
  return pick.startsWith("tr") ? "tr" : "en";
}

let current: CliLang = detectCliLang();

export const lang = (): CliLang => current;
export function setLang(l: CliLang) {
  current = l;
}
/** Turkish or English, whichever this run speaks. */
export const t = (tr: string, en: string): string => (current === "tr" ? tr : en);
