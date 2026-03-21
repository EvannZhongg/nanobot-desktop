/**
 * Config panel: read, edit, save config.json.
 * All config-specific state lives here.
 */
import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConfigFilePayload, Status } from "../types";

type Props = {
  toast: { success: (m: string) => void; error: (m: string) => void };
  proc: {
    status: Status;
    refreshStatus: () => Promise<void>;
    restartProc: (kind: "agent" | "gateway") => Promise<void>;
    setConfigMissing: (v: boolean) => void;
    setConfigMissingPath: (v: string) => void;
  };
};

export default function ConfigPanel({ toast, proc }: Props) {
  const [configFile, setConfigFile] = useState<ConfigFilePayload | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await invoke<ConfigFilePayload>("read_config_file");
      setConfigFile(payload);
      setContent(payload.content || "");
      setDirty(false);
      proc.setConfigMissing(!payload.exists);
      proc.setConfigMissingPath(payload.path);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [proc]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const saveConfig = useCallback(async () => {
    if (saving) return;
    try {
      JSON.parse(content);
    } catch {
      toast.error("Invalid JSON — please fix syntax errors before saving.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await invoke("save_config_file", { content });
      setDirty(false);
      toast.success("Config saved");
      await loadConfig();
      const current = await invoke<Status>("get_status");
      proc.refreshStatus();
      if (current.gateway) await proc.restartProc("gateway");
      if (current.agent) await proc.restartProc("agent");
    } catch (err) {
      setError(String(err));
      toast.error(`Save failed: ${err}`);
    } finally {
      setSaving(false);
    }
  }, [saving, content, loadConfig, proc, toast]);

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    setDirty(true);
  }, []);

  return (
    <div className="content">
      <div className="card">
        <div className="card-row">
          <div>
            <h3>Config</h3>
            <div className="skill-meta" style={{ marginTop: 6 }}>
              {configFile?.path || "~/.nanobot/config.json"}
            </div>
          </div>
          <div className="editor-actions">
            <button onClick={loadConfig} disabled={loading}>
              {loading ? "Loading..." : "Refresh"}
            </button>
            <button onClick={saveConfig} disabled={saving || !dirty}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
        {error && <div className="skills-error">{error}</div>}
        <textarea
          className="editor-textarea"
          value={content}
          onChange={handleContentChange}
          placeholder="config.json content..."
          aria-label="Edit config.json"
        />
        <div className="editor-hint">
          Changes are saved to disk. Gateway/agent will auto-restart if needed.
        </div>
      </div>
    </div>
  );
}
