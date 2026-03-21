import React, { createContext, useContext, useEffect, useState } from "react";
import { Language, TranslationKey, getTranslation } from "../utils/i18n";

export type Theme = "light" | "dark";

type SettingsContextValue = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  language: Language;
  setLanguage: (l: Language) => void;
  t: (key: TranslationKey) => string;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

function getSavedTheme(): Theme {
  const saved = localStorage.getItem("nanobot-theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getSavedLanguage(): Language {
  const saved = localStorage.getItem("nanobot-language");
  if (saved === "zh" || saved === "en") return saved as Language;
  return navigator.language.startsWith("zh") ? "zh" : "en";
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getSavedTheme);
  const [language, setLanguageState] = useState<Language>(getSavedLanguage);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem("nanobot-theme", t);
  };

  const setLanguage = (l: Language) => {
    setLanguageState(l);
    localStorage.setItem("nanobot-language", l);
  };

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [theme]);

  const t = (key: TranslationKey) => getTranslation(language, key);

  return (
    <SettingsContext.Provider value={{ theme, setTheme, language, setLanguage, t }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within SettingsProvider");
  }
  return ctx;
}
