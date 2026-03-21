import React, { useCallback, useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ConfigFilePayload, Status } from "../types";
import { PROVIDER_REGISTRY, ProviderMeta } from "../utils/providerRegistry";

type Props = {
  toast: { success: (m: string) => void; error: (m: string) => void; info: (m: string) => void };
  proc: {
    status: Status;
    refreshStatus: () => Promise<void>;
    restartProc: (kind: "agent" | "gateway") => Promise<void>;
    setConfigMissing: (v: boolean) => void;
    setConfigMissingPath: (v: string) => void;
  };
};

export default function ModelPanel({ toast, proc }: Props) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const [configObj, setConfigObj] = useState<any>({});

  // 默认模型下拉框选值
  const [defaultModel, setDefaultModel] = useState<string>("");

  // Provider Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  
  // 编辑表单中的字段
  const [editType, setEditType] = useState<string>("openai");
  const [editKey, setEditKey] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editDefaultModel, setEditDefaultModel] = useState("");

  // OAuth 交互状态
  const [oauthLoading, setOauthLoading] = useState(false);
  const [deviceAuth, setDeviceAuth] = useState<any>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await invoke<ConfigFilePayload>("read_config_file");
      setContent(payload.content || "");
      let parsed: any = {};
      try {
        parsed = JSON.parse(payload.content || "{}");
      } catch (e) {
        toast.error("Invalid config JSON format");
      }
      setConfigObj(parsed);
      setDefaultModel(parsed?.agents?.defaults?.model || "");
      setDirty(false);
      proc.setConfigMissing(!payload.exists);
      proc.setConfigMissingPath(payload.path);
    } catch (err) {
      toast.error(`Load failed: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [proc, toast]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const saveConfigStruct = useCallback(async (newObj: any) => {
    if (saving) return;
    setSaving(true);
    try {
      const jsonStr = JSON.stringify(newObj, null, 2);
      await invoke("save_config_file", { content: jsonStr });
      setContent(jsonStr);
      setConfigObj(newObj);
      setDirty(false);
      toast.success("Models configured successfully");
      await loadConfig();
      const current = await invoke<Status>("get_status");
      proc.refreshStatus();
      if (current.gateway) await proc.restartProc("gateway");
      if (current.agent) await proc.restartProc("agent");
    } catch (err) {
      toast.error(`Save failed: ${err}`);
    } finally {
      setSaving(false);
    }
  }, [saving, loadConfig, proc, toast]);

  const saveRawJson = useCallback(async () => {
    if (saving) return;
    try {
      const obj = JSON.parse(content);
      await saveConfigStruct(obj);
    } catch {
      toast.error("Invalid JSON syntax.");
    }
  }, [saving, content, saveConfigStruct, toast]);

  // 从 config 中提取各平台模型配置
  const configuredProviders = useMemo(() => {
    const list: any[] = [];
    if (!configObj.agents) return list;
    for (const [key, val] of Object.entries(configObj.agents)) {
      if (key === "defaults") continue;
      const agent: any = val;
      if (agent?.model) {
        list.push({ id: key, config: agent });
      }
    }
    return list;
  }, [configObj]);

  const openProviderModal = (id?: string) => {
    setDeviceAuth(null);
    setOauthLoading(false);
    if (id && configObj?.agents?.[id]) {
      setEditingProviderId(id);
      const agent = configObj.agents[id];
      // Try to match standard type or fallback to custom
      let matchType = id;
      if (!PROVIDER_REGISTRY.find(p => p.id === id)) {
        if (id.includes("openai")) matchType = "openai";
        else matchType = "custom";
      }
      setEditType(matchType);
      
      let base = agent.api_base || "";
      let key = agent.api_key || "";
      
      // Some config stores in client_args
      if (agent.client_args) {
        if (agent.client_args.base_url) base = agent.client_args.base_url;
        if (agent.client_args.api_key) key = agent.client_args.api_key;
      }
      // Or in env map
      if (agent.env && agent.env[`${id.toUpperCase()}_API_KEY`]) {
        key = agent.env[`${id.toUpperCase()}_API_KEY`];
      }
      setEditKey(key);
      setEditBaseUrl(base);
      setEditDefaultModel(agent.model || "");
    } else {
      setEditingProviderId(null);
      setEditType("openai");
      const meta = PROVIDER_REGISTRY.find(p => p.id === "openai");
      setEditKey("");
      setEditBaseUrl(meta?.defaultBaseUrl || "");
      setEditDefaultModel(meta?.defaultModel || "");
    }
    setModalOpen(true);
  };

  const handleProviderTypeChange = (newType: string) => {
    setEditType(newType);
    const meta = PROVIDER_REGISTRY.find(p => p.id === newType);
    if (meta) {
      if (!editBaseUrl || editBaseUrl.trim() === "") {
        setEditBaseUrl(meta.defaultBaseUrl || "");
      }
      if (!editDefaultModel || editDefaultModel.trim() === "") {
        setEditDefaultModel(meta.defaultModel || "");
      }
    }
  };

  const saveProvider = () => {
    const mainId = editingProviderId || editType;
    const meta = PROVIDER_REGISTRY.find(p => p.id === editType);
    
    const newConfig = { ...configObj };
    if (!newConfig.agents) newConfig.agents = {};
    if (!newConfig.agents.defaults) newConfig.agents.defaults = { model: editDefaultModel || "gpt-4o" };
    
    const agentConfig: any = {
      model: editDefaultModel
    };
    
    // API KEY
    if (editKey) {
      agentConfig.env = { [`${mainId.toUpperCase()}_API_KEY`]: editKey };
      agentConfig.api_key = editKey;
    }
    // BASE URL
    if (editBaseUrl && editBaseUrl !== meta?.defaultBaseUrl) {
      agentConfig.client_args = { base_url: editBaseUrl };
      agentConfig.api_base = editBaseUrl;
    }
    
    newConfig.agents[mainId] = agentConfig;
    
    // Add default model to top level array if missing
    if (editDefaultModel) {
      if (!newConfig.models) newConfig.models = [];
      if (!newConfig.models.includes(editDefaultModel)) {
        newConfig.models.push(editDefaultModel);
      }
      if (!newConfig.agents.defaults.model) {
        newConfig.agents.defaults.model = editDefaultModel;
      }
    }

    setModalOpen(false);
    saveConfigStruct(newConfig);
  };

  const deleteProvider = (id: string) => {
    if (confirm(`Remove provider ${id}?`)) {
      const newConfig = { ...configObj };
      if (newConfig.agents && newConfig.agents[id]) {
        delete newConfig.agents[id];
        saveConfigStruct(newConfig);
      }
    }
  };

  const updateDefaultModel = useCallback((val: string) => {
    setDefaultModel(val);
    const newConfig = { ...configObj };
    if (!newConfig.agents) newConfig.agents = {};
    if (!newConfig.agents.defaults) newConfig.agents.defaults = {};
    newConfig.agents.defaults.model = val;
    saveConfigStruct(newConfig);
  }, [configObj, saveConfigStruct]);

  // --- OAuth Handlers ---
  const handleBrowserOAuth = async () => {
    try {
      setOauthLoading(true);
      toast.info("Waiting for browser authorization...");
      const tokenPayload: any = await invoke("start_browser_oauth", { provider: editType });
      if (tokenPayload && tokenPayload.access) {
        setEditKey(tokenPayload.access);
        toast.success("Browser login successful!");
      }
    } catch (e) {
      toast.error(`OAuth failed: ${e}`);
    } finally {
      setOauthLoading(false);
    }
  };

  const handleDeviceOAuth = async () => {
    try {
      setOauthLoading(true);
      toast.info("Requesting device code...");
      const payload: any = await invoke("start_device_oauth", { provider: editType, region: "global" });
      setDeviceAuth(payload);
      
      // Start polling
      pollDevice(payload);
      
    } catch (e) {
      toast.error(`Device auth failed: ${e}`);
      setOauthLoading(false);
    }
  };

  const pollDevice = async (payload: any) => {
    let interval = payload.interval * 1000;
    const expiresAt = Date.now() + (payload.expires_in * 1000);
    
    while(Date.now() < expiresAt && modalOpen) {
      try {
        const result: any = await invoke("poll_device_oauth", { 
          provider: editType, 
          deviceCode: payload.device_code, 
          verifier: payload.verifier,
          region: "global"
        });
        
        if (result.status === "success" || result.Success) {
          const token = result.token || result.Success.token;
          setEditKey(token.access);
          setDeviceAuth(null);
          toast.success("Device login successful!");
          break;
        } else if (result.status === "error" || result.Error) {
          throw new Error(result.message || result.Error.message);
        } else {
          // Pending, wait
          const slowDown = result.slow_down || (result.Pending && result.Pending.slow_down);
          if (slowDown) interval = Math.min(interval * 1.5, 10000);
        }
      } catch (e) {
        toast.error(`Polling failed: ${e}`);
        break;
      }
      await new Promise(r => setTimeout(r, interval));
    }
    setOauthLoading(false);
  };

  // 聚合当前所有可能的模型名称，以供选择
  const allAvailableModels = useMemo(() => {
    const models = new Set<string>();
    if (configObj.models && Array.isArray(configObj.models)) {
      configObj.models.forEach((m: string) => models.add(m));
    }
    if (configObj.agents) {
      for (const [k, v] of Object.entries(configObj.agents)) {
        if (k !== "defaults" && (v as any).model) {
          models.add((v as any).model);
        }
      }
    }
    PROVIDER_REGISTRY.forEach(p => { if(p.defaultModel) models.add(p.defaultModel) });
    return Array.from(models);
  }, [configObj]);

  const currentMeta = PROVIDER_REGISTRY.find(p => p.id === editType);

  return (
    <div className="content model-panel-wrapper">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Model Providers</h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: "var(--muted)" }}>Default Model:</label>
          <select 
            value={defaultModel} 
            onChange={e => updateDefaultModel(e.target.value)}
            style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)" }}
          >
            <option value="">-- Select --</option>
            {allAvailableModels.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <button onClick={() => openProviderModal()} style={{ background: "var(--accent)", color: "white", padding: "8px 16px", borderRadius: 10, border: "none", cursor: "pointer", fontWeight: 600 }}>
            + Add Provider
          </button>
        </div>
      </div>

      <div className="provider-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
        {configuredProviders.map(rp => {
          const meta = PROVIDER_REGISTRY.find(p => p.id === rp.id) || PROVIDER_REGISTRY.find(p => p.id === "custom");
          let base = rp.config.api_base || rp.config.client_args?.base_url || meta?.defaultBaseUrl || "Default";
          let key = rp.config.api_key || rp.config.env?.[`${rp.id.toUpperCase()}_API_KEY`];
          const hasKey = !!key;

          return (
            <div key={rp.id} className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, position: "relative" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span style={{ fontSize: 24 }}>{meta?.icon || '⚙️'}</span>
                <span style={{ fontWeight: 600, fontSize: 16 }}>{rp.id}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button onClick={() => openProviderModal(rp.id)} style={{ padding: "4px 8px", fontSize: 12, background: "#f3f4f6", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer" }}>Edit</button>
                  <button onClick={() => deleteProvider(rp.id)} style={{ padding: "4px 8px", fontSize: 12, background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 6, cursor: "pointer" }}>Delete</button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                <div><strong>Model:</strong> {rp.config.model || "None"}</div>
                <div style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}><strong>URL:</strong> {base}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  <span className={`breath-dot agent ${hasKey ? "on" : "off"}`}></span>
                  {hasKey ? "Configured" : "Missing Credentials"}
                </div>
              </div>
            </div>
          );
        })}
        {configuredProviders.length === 0 && (
          <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "40px", color: "var(--muted)", background: "var(--panel)", borderRadius: "var(--radius)", border: "1px dashed var(--border)" }}>
            No providers configured. Click "+ Add Provider" to start.
          </div>
        )}
      </div>

      <div style={{ marginTop: 24, padding: "16px", borderRadius: "12px", border: "1px solid var(--border)", background: "var(--panel)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setShowRawJson(!showRawJson)}>
          <h3 style={{ margin: 0, fontSize: 14, color: "var(--muted)" }}>Advance: Edit Raw JSON Configuration</h3>
          <span>{showRawJson ? "▲" : "▼"}</span>
        </div>
        {showRawJson && (
          <div style={{ marginTop: 16 }}>
            <textarea
              className="editor-textarea"
              value={content}
              onChange={e => {setContent(e.target.value); setDirty(true);}}
              placeholder="config.json content..."
              style={{ width: "100%", height: "300px", background: "#f9fafb", borderRadius: 8, padding: 12, fontFamily: "monospace", border: "1px solid var(--border)", resize: "vertical" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12, gap: 8 }}>
               <button onClick={loadConfig} disabled={loading} style={{ padding: "8px 16px", borderRadius: 8, background: "#f3f4f6", border: "1px solid var(--border)", cursor: "pointer" }}>Refresh</button>
               <button onClick={saveRawJson} disabled={saving || !dirty} style={{ padding: "8px 16px", borderRadius: 8, background: "var(--accent)", color: "white", border: "none", cursor: "pointer" }}>{saving ? "Saving..." : "Save JSON"}</button>
            </div>
          </div>
        )}
      </div>

      {/* Provider Edit Modal */}
      {modalOpen && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h3>{editingProviderId ? "Edit Provider" : "Add Provider"}</h3>
            
            {!editingProviderId && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Type</label>
                <select value={editType} onChange={e => handleProviderTypeChange(e.target.value)} style={{ padding: 8, borderRadius: 8 }}>
                  {PROVIDER_REGISTRY.map(p => <option key={p.id} value={p.id}>{p.icon} {p.name}</option>)}
                </select>
              </div>
            )}
            
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Default Model</label>
              <input value={editDefaultModel} onChange={e => setEditDefaultModel(e.target.value)} placeholder="e.g. gpt-4o" style={{ padding: 8, borderRadius: 8, border: "1px solid var(--border)" }} />
            </div>

            {currentMeta?.showBaseUrl && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Base URL</label>
                <input value={editBaseUrl} onChange={e => setEditBaseUrl(e.target.value)} placeholder={currentMeta?.defaultBaseUrl} style={{ padding: 8, borderRadius: 8, border: "1px solid var(--border)" }} />
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Credentials (API Key / Token)</label>
              <input 
                type="password"
                value={editKey} 
                onChange={e => setEditKey(e.target.value)} 
                placeholder={currentMeta?.placeholder || "sk-..."} 
                style={{ padding: 8, borderRadius: 8, border: "1px solid var(--border)" }} 
              />
              
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                {currentMeta?.authModes.includes("oauth_browser") && (
                   <button onClick={handleBrowserOAuth} disabled={oauthLoading} style={{ flex: 1, padding: "8px 0", background: "#f3f4f6", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                     {oauthLoading ? "Waiting..." : <>🌐 Sign in with Browser</>}
                   </button>
                )}
                {currentMeta?.authModes.includes("oauth_device") && (
                   <button onClick={handleDeviceOAuth} disabled={oauthLoading} style={{ flex: 1, padding: "8px 0", background: "#f3f4f6", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                     {oauthLoading ? "Waiting..." : <>📱 Sign in via Device Code</>}
                   </button>
                )}
              </div>
            </div>

            {/* Device Code Flow Display */}
            {deviceAuth && (
              <div style={{ padding: 16, background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: 12, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                 <p style={{ margin: 0, fontSize: 14 }}>Please visit the verification link to authorize:</p>
                 <a href={deviceAuth.verification_uri} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all", textAlign: "center", color: "#2563eb", fontWeight: 600 }}>
                   {deviceAuth.verification_uri}
                 </a>
                 <div style={{ fontSize: 32, letterSpacing: 4, fontWeight: "bold", background: "white", padding: "8px 24px", borderRadius: 8, border: "2px dashed #cbd5e1", marginTop: 8 }}>
                   {deviceAuth.user_code}
                 </div>
                 <p style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0 0" }}>Waiting for authorization...</p>
              </div>
            )}

            <div className="modal-actions" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => setModalOpen(false)}>Cancel</button>
              <button onClick={saveProvider} style={{ background: "var(--accent)", color: "white", border: "none" }}>{saving ? "Saving..." : "Save Provider"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
