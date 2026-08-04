import { EN_MESSAGES } from "./en.mjs";
import { KO_MESSAGES } from "./ko.mjs";

export const DEFAULT_LOCALE = "en";

export const BUILT_IN_CATALOGS = Object.freeze({
  en: EN_MESSAGES,
  ko: KO_MESSAGES,
});
