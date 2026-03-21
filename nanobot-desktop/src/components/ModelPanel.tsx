import React, { useCallback, useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConfigFilePayload, Status } from "../types";
import { PROVIDER_REGISTRY } from "../utils/providerRegistry";

// SVG Icons (Lucide inspired)
const PlusIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>;
const SettingsIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>;
const TrashIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>;
const ChevronDownIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>;
const GlobeIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><path d="M2 12h20"/></svg>;
const SmartphoneIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>;
const CodeIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
const CheckCircleIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
const AlertCircleIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;

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

  const [defaultModel, setDefaultModel] = useState<string>("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  
  const [editType, setEditType] = useState<string>("openai");
  const [editKey, setEditKey] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editDefaultModel, setEditDefaultModel] = useState("");

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
      let matchType = id;
      if (!PROVIDER_REGISTRY.find(p => p.id === id)) {
        if (id.includes("openai")) matchType = "openai";
        else matchType = "custom";
      }
      setEditType(matchType);
      
      let base = agent.api_base || "";
      let key = agent.api_key || "";
      
      if (agent.client_args) {
        if (agent.client_args.base_url) base = agent.client_args.base_url;
        if (agent.client_args.api_key) key = agent.client_args.api_key;
      }
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
      if (!editBaseUrl || editBaseUrl.trim() === "") setEditBaseUrl(meta.defaultBaseUrl || "");
      if (!editDefaultModel || editDefaultModel.trim() === "") setEditDefaultModel(meta.defaultModel || "");
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
    
    if (editKey) {
      agentConfig.env = { [`${mainId.toUpperCase()}_API_KEY`]: editKey };
      agentConfig.api_key = editKey;
    }
    if (editBaseUrl && editBaseUrl !== meta?.defaultBaseUrl) {
      agentConfig.client_args = { base_url: editBaseUrl };
      agentConfig.api_base = editBaseUrl;
    }
    
    newConfig.agents[mainId] = agentConfig;
    
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

  const updateDefaultModel = (val: string) => {
    setDefaultModel(val);
    const newConfig = { ...configObj };
    if (!newConfig.agents) newConfig.agents = {};
    if (!newConfig.agents.defaults) newConfig.agents.defaults = {};
    newConfig.agents.defaults.model = val;
    saveConfigStruct(newConfig);
  };

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
    <div className="content model-panel-wrapper" style={{ padding: "0 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "24px", fontWeight: "700", letterSpacing: "-0.5px", color: "#0f172a" }}>AI Models</h2>
          <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: "14px" }}>Manage integration with various language models.</p>
        </div>
        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "13px", fontWeight: 500, color: "#475569" }}>Default Router:</span>
            <div className="premium-select-wrapper">
              <select className="premium-select" value={defaultModel} onChange={e => updateDefaultModel(e.target.value)}>
                <option value="">-- Active Model --</option>
                {allAvailableModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <div className="premium-select-icon"><ChevronDownIcon /></div>
            </div>
          </div>
          <button className="premium-btn premium-btn-primary" onClick={() => openProviderModal()}>
            <PlusIcon /> Add Provider
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "20px" }}>
        {configuredProviders.map(rp => {
          const meta = PROVIDER_REGISTRY.find(p => p.id === rp.id) || PROVIDER_REGISTRY.find(p => p.id === "custom");
          let base = rp.config.api_base || rp.config.client_args?.base_url || meta?.defaultBaseUrl || "Default Endpoint";
          let key = rp.config.api_key || rp.config.env?.[`${rp.id.toUpperCase()}_API_KEY`];
          const hasKey = !!key;

          return (
            <div key={rp.id} className="premium-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
                  <div className="premium-icon-box">{meta?.icon || '📦'}</div>
                  <div>
                    <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "#0f172a", textTransform: "capitalize" }}>{rp.id}</h3>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
                      <span className={`status-badge ${hasKey ? "configured" : "missing"}`}>
                        {hasKey ? <CheckCircleIcon /> : <AlertCircleIcon />}
                        {hasKey ? "Configured" : "Missing Keys"}
                      </span>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button className="premium-btn premium-btn-outline" style={{ padding: "6px", height: "30px", width: "30px" }} onClick={() => openProviderModal(rp.id)}>
                    <SettingsIcon />
                  </button>
                  <button className="premium-btn premium-btn-outline" style={{ padding: "6px", height: "30px", width: "30px", color: "#ef4444" }} onClick={() => deleteProvider(rp.id)}>
                    <TrashIcon />
                  </button>
                </div>
              </div>

              <div style={{ marginTop: "4px", display: "grid", gap: "8px", fontSize: "13px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", color: "#475569" }}>
                  <span style={{ fontWeight: 500 }}>Active Model</span>
                  <span style={{ color: "#0f172a", fontWeight: 600 }}>{rp.config.model || "None"}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", color: "#475569" }}>
                  <span style={{ fontWeight: 500 }}>Endpoint</span>
                  <span style={{ color: "#0f172a", maxWidth: "160px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{base}</span>
                </div>
              </div>
            </div>
          );
        })}
        
        {configuredProviders.length === 0 && (
          <div style={{ gridColumn: "1/-1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px", background: "#f8fafc", borderRadius: "16px", border: "2px dashed #cbd5e1" }}>
            <div style={{ fontSize: "32px", marginBottom: "12px", opacity: 0.8 }}>🧩</div>
            <h3 style={{ margin: "0 0 8px", fontSize: "16px", color: "#0f172a" }}>No Providers Configured</h3>
            <p style={{ margin: "0 0 16px", fontSize: "14px", color: "#64748b" }}>Add an AI provider connection to enable intelligent features.</p>
            <button className="premium-btn premium-btn-primary" onClick={() => openProviderModal()}>
              Get Started <PlusIcon />
            </button>
          </div>
        )}
      </div>

      <div className="raw-json-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setShowRawJson(!showRawJson)}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ background: "#e2e8f0", padding: "6px", borderRadius: "8px", color: "#475569" }}><CodeIcon /></div>
            <div>
              <h3 style={{ margin: 0, fontSize: "15px", color: "#0f172a", fontWeight: 600 }}>Advanced Settings</h3>
              <p style={{ margin: "2px 0 0", fontSize: "13px", color: "#64748b" }}>Edit raw JSON configuration source</p>
            </div>
          </div>
          <div style={{ color: "#94a3b8", transform: showRawJson ? "rotate(180deg)" : "rotate(0)", transition: "0.2s" }}><ChevronDownIcon /></div>
        </div>
        
        {showRawJson && (
          <div style={{ marginTop: "20px", animation: "fadeIn 0.2s ease-out" }}>
            <textarea
              className="premium-input"
              value={content}
              onChange={e => {setContent(e.target.value); setDirty(true);}}
              style={{ width: "100%", height: "260px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "13px", lineHeight: "1.5", resize: "vertical" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "16px", gap: "10px" }}>
               <button className="premium-btn premium-btn-outline" onClick={loadConfig} disabled={loading}>Discard Changes</button>
               <button className="premium-btn premium-btn-primary" onClick={saveRawJson} disabled={saving || !dirty}>{saving ? "Saving JSON..." : "Apply JSON"}</button>
            </div>
          </div>
        )}
      </div>

      {modalOpen && (
        <div className="premium-modal-backdrop">
          <div className="premium-modal-card">
            <h3 style={{ margin: 0, fontSize: "20px", fontWeight: "700", color: "#0f172a" }}>
              {editingProviderId ? "Provider Settings" : "Configure AI Provider"}
            </h3>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              {!editingProviderId && (
                <div>
                  <label className="premium-label">Service Provider</label>
                  <div className="premium-select-wrapper" style={{ width: "100%", display: "block" }}>
                    <select className="premium-select" value={editType} onChange={e => handleProviderTypeChange(e.target.value)} style={{ width: "100%" }}>
                      {PROVIDER_REGISTRY.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <div className="premium-select-icon"><ChevronDownIcon /></div>
                  </div>
                </div>
              )}
              
              <div>
                <label className="premium-label">Default Model</label>
                <input className="premium-input" value={editDefaultModel} onChange={e => setEditDefaultModel(e.target.value)} placeholder="e.g. gpt-4-turbo" />
              </div>

              {currentMeta?.showBaseUrl && (
                <div>
                  <label className="premium-label">API Base URL</label>
                  <input className="premium-input" value={editBaseUrl} onChange={e => setEditBaseUrl(e.target.value)} placeholder={currentMeta?.defaultBaseUrl} />
                </div>
              )}

              <div>
                <label className="premium-label">Credentials (API Key / Token)</label>
                <input 
                  type="password"
                  className="premium-input"
                  value={editKey} 
                  onChange={e => setEditKey(e.target.value)} 
                  placeholder={currentMeta?.placeholder || "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"} 
                />
                
                <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
                  {currentMeta?.authModes.includes("oauth_browser") && (
                     <button onClick={handleBrowserOAuth} disabled={oauthLoading} className="premium-btn premium-btn-outline" style={{ flex: 1 }}>
                       {oauthLoading ? "Connecting..." : <><GlobeIcon /> Web Sign-in</>}
                     </button>
                  )}
                  {currentMeta?.authModes.includes("oauth_device") && (
                     <button onClick={handleDeviceOAuth} disabled={oauthLoading} className="premium-btn premium-btn-outline" style={{ flex: 1 }}>
                       {oauthLoading ? "Generating Code..." : <><SmartphoneIcon /> Device Connect</>}
                     </button>
                  )}
                </div>
              </div>

              {deviceAuth && (
                <div style={{ padding: "20px", background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: "12px", textAlign: "center", animation: "fadeIn 0.2s" }}>
                   <p style={{ margin: "0 0 12px", fontSize: "14px", color: "#334155" }}>Please verify this device:</p>
                   <a href={deviceAuth.verification_uri} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all", color: "#2563eb", fontWeight: 600, fontSize: "14px", textDecoration: "none" }}>
                     {deviceAuth.verification_uri}
                   </a>
                   <div style={{ fontSize: "36px", letterSpacing: "8px", fontWeight: "900", color: "#0f172a", margin: "16px 0", fontFamily: "monospace" }}>
                     {deviceAuth.user_code}
                   </div>
                   <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>Waiting for authorization prompt to complete...</p>
                </div>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "8px" }}>
              <button className="premium-btn premium-btn-outline" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="premium-btn premium-btn-primary" onClick={saveProvider}>{saving ? "Applying..." : "Save Connection"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
