import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import type es from "./locales/es.json";

// Every JSON file in ./locales is a language: drop in `fr.json` and it shows up in the picker.
const modules = import.meta.glob<{ default: typeof es }>("./locales/*.json", { eager: true });

const resources = Object.fromEntries(
  Object.entries(modules).map(([path, mod]) => [path.match(/([\w-]+)\.json$/)![1], { translation: mod.default }]),
);

export const LANGUAGES = Object.entries(resources)
  .map(([code, r]) => ({ code, name: r.translation.meta.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    supportedLngs: Object.keys(resources),
    // "es-CL", "es-MX"… all resolve to "es".
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    fallbackLng: "en",
    interpolation: { escapeValue: false }, // React escapes; map popups escape their own values.
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "atlas:lang",
      caches: ["localStorage"],
    },
  });

const syncHtmlLang = (lng: string) => (document.documentElement.lang = lng);
syncHtmlLang(i18n.resolvedLanguage ?? "en");
i18n.on("languageChanged", syncHtmlLang);

export default i18n;
