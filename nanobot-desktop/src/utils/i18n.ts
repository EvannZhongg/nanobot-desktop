export const translations = {
  en: {
    "nav.chat": "Chat",
    "nav.monitor": "Monitor",
    "nav.cron": "Cron",
    "nav.sessions": "Sessions",
    "nav.skills": "Skills",
    "nav.memory": "Memory",
    "nav.models": "Models",
    "nav.settings": "Settings",
    "status.agent": "Agent:",
    "status.gateway": "Gateway:",
    "status.running": "running",
    "status.stopped": "stopped",
    "status.session": "Session",
    "settings.title": "Settings",
    "settings.language": "Language",
    "settings.theme": "Theme",
    "settings.theme.light": "Light Mode",
    "settings.theme.dark": "Dark Mode",
    "settings.desc.language": "Choose your preferred language for the interface.",
    "settings.desc.theme": "Choose your preferred appearance.",
  },
  zh: {
    "nav.chat": "对话",
    "nav.monitor": "监控",
    "nav.cron": "定时任务",
    "nav.sessions": "会话",
    "nav.skills": "技能",
    "nav.memory": "记忆",
    "nav.models": "模型",
    "nav.settings": "设置",
    "status.agent": "代理:",
    "status.gateway": "网关:",
    "status.running": "运行中",
    "status.stopped": "已停止",
    "status.session": "当前会话",
    "settings.title": "设置",
    "settings.language": "语言 / Language",
    "settings.theme": "主题 / Theme",
    "settings.theme.light": "白天模式",
    "settings.theme.dark": "黑夜模式",
    "settings.desc.language": "选择界面语言。",
    "settings.desc.theme": "选择应用外观。",
  }
} as const;

export type Language = keyof typeof translations;
export type TranslationKey = keyof typeof translations.en;

export function getTranslation(lang: Language, key: TranslationKey): string {
  return translations[lang][key] || translations.en[key] || key;
}
