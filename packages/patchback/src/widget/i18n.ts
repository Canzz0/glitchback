/**
 * Widget texts. The language is picked from `locale`, then the page's <html lang>,
 * then the browser; anything that is not Turkish gets English.
 */
export interface Labels {
  button: string;
  title: string;
  subtitle: string;
  placeholder: string;
  contact: string;
  contactHint: string;
  attachedTitle: string;
  attachedPage: string;
  attachedErrors: (n: number) => string;
  attachedRequests: (n: number) => string;
  attachedActions: (n: number) => string;
  privacy: string;
  send: string;
  sending: string;
  cancel: string;
  close: string;
  sent: string;
  sentBody: string;
  done: string;
  tooShort: string;
  failed: string;
  rateLimited: string;
}

export const labelsTR: Labels = {
  button: "Sorun bildir",
  title: "Sorun bildir",
  subtitle: "Bu sayfada ne ters gitti?",
  placeholder: "Ne yapmaya çalışıyordunuz, ne oldu? Örn: Ödeme butonuna bastım, hiçbir şey olmadı.",
  contact: "E-posta",
  contactHint: "İsteğe bağlı. Size dönüş yapabilmemiz için.",
  attachedTitle: "Bildirime eklenecekler",
  attachedPage: "Sayfa adresi ve tarayıcı bilgisi",
  attachedErrors: (n) => `${n} konsol hatası`,
  attachedRequests: (n) => `${n} başarısız istek`,
  attachedActions: (n) => `Son ${n} tıklama ve sayfa geçişi`,
  privacy: "Form alanlarına yazdıklarınız eklenmez.",
  send: "Gönder",
  sending: "Gönderiliyor…",
  cancel: "Vazgeç",
  close: "Kapat",
  sent: "Bildiriminiz ulaştı",
  sentBody: "Teşekkürler. Ekibimiz inceleyecek.",
  done: "Tamam",
  tooShort: "Sorunu birkaç kelimeyle anlatın.",
  failed: "Bildirim gönderilemedi. Bağlantınızı kontrol edip tekrar deneyin.",
  rateLimited: "Kısa sürede çok fazla bildirim gönderildi. Birkaç dakika sonra tekrar deneyin.",
};

export const labelsEN: Labels = {
  button: "Report a problem",
  title: "Report a problem",
  subtitle: "What went wrong on this page?",
  placeholder: "What were you trying to do, and what happened? E.g. I clicked Pay and nothing happened.",
  contact: "Email",
  contactHint: "Optional. So we can follow up with you.",
  attachedTitle: "Included with your report",
  attachedPage: "Page address and browser details",
  attachedErrors: (n) => `${n} console ${n === 1 ? "error" : "errors"}`,
  attachedRequests: (n) => `${n} failed ${n === 1 ? "request" : "requests"}`,
  attachedActions: (n) => `Your last ${n} clicks and page changes`,
  privacy: "Anything you typed into forms is not included.",
  send: "Send report",
  sending: "Sending…",
  cancel: "Cancel",
  close: "Close",
  sent: "Report sent",
  sentBody: "Thanks. The team will look into it.",
  done: "Done",
  tooShort: "Describe the problem in a few words.",
  failed: "The report could not be sent. Check your connection and try again.",
  rateLimited: "Too many reports in a short time. Try again in a few minutes.",
};

export type Locale = "tr" | "en";

export function detectLocale(preferred?: string): Locale {
  const candidates = [
    preferred && preferred !== "auto" ? preferred : "",
    document.documentElement.lang,
    ...(navigator.languages ?? []),
    navigator.language,
  ];
  const first = candidates.find((c) => c && c.trim());
  return first?.toLowerCase().startsWith("tr") ? "tr" : "en";
}

export const LABELS: Record<Locale, Labels> = { tr: labelsTR, en: labelsEN };
