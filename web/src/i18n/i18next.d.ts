import "i18next";
import type es from "./locales/es.json";

// Spanish is the reference locale: keys missing from it are type errors.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof es };
  }
}
