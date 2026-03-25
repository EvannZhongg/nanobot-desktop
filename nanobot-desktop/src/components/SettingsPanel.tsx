import React from "react";
import { useSettings } from "../hooks/useSettings";

export default function SettingsPanel() {
  const { theme, setTheme, language, setLanguage, t } = useSettings();

  return (
    <div className="content">
      <div className="card" style={{ padding: "24px", maxWidth: "600px", margin: "0 auto", width: "100%" }}>
        <h2 style={{ marginTop: 0, marginBottom: "24px" }}>{t("settings.title")}</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <div className="settings-section">
            <label style={{ display: "block", fontWeight: 600, marginBottom: "8px" }}>
              {t("settings.language")}
            </label>
            <p style={{ margin: "0 0 12px", fontSize: "13px", color: "var(--muted)" }}>
              {t("settings.desc.language")}
            </p>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as any)}
              className="clean-select"
              style={{ width: "100%", padding: "8px", borderRadius: "8px", border: "1px solid var(--border)", background: "var(--panel-2)" }}
            >
              <option value="en">English</option>
              <option value="zh">简体中文</option>
            </select>
          </div>

          <div className="settings-section">
            <label style={{ display: "block", fontWeight: 600, marginBottom: "8px" }}>
              {t("settings.theme")}
            </label>
            <p style={{ margin: "0 0 12px", fontSize: "13px", color: "var(--muted)" }}>
              {t("settings.desc.theme")}
            </p>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as any)}
              className="clean-select"
              style={{ width: "100%", padding: "8px", borderRadius: "8px", border: "1px solid var(--border)", background: "var(--panel-2)" }}
            >
              <option value="light">{t("settings.theme.light")}</option>
              <option value="dark">{t("settings.theme.dark")}</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
