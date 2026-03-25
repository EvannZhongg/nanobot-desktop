import React, { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Cpu, Plus, Settings, Trash, ChevronDown, Globe, Smartphone, Code, CheckCircle, AlertCircle } from "lucide-react";
import type { ConfigFilePayload, Status } from "../types";
import { PROVIDER_REGISTRY } from "../utils/providerRegistry";

// SVG Icons (Lucide inspired)
// Removed custom SVG icons in favor of lucide-react

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
  const [manualLink, setManualLink] = useState<string | null>(null);
  const pollingRef = useRef<boolean>(false);
  const oauthListenerRef = useRef<any>(null);

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

  useEffect(() => {
    loadConfig();
    
    let unlisten: any = null;
    const setupListener = async () => {
      unlisten = await listen("oauth-event", (event: any) => {
        const payload = event.payload;
        if (payload.type === "success") {
          setEditKey(payload.token.access);
          setDeviceAuth(null);
          setOauthLoading(false);
          toast.success(`Authorized ${payload.provider} successfully!`);
        } else if (payload.type === "error") {
          toast.error(`${payload.provider} auth failed: ${payload.message}`);
          setOauthLoading(false);
          setDeviceAuth(null);
        } else if (payload.type === "status") {
          toast.info(payload.message);
        }
      });
    };
    setupListener();

    return () => { if (unlisten) unlisten(); };
  }, [loadConfig]);

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
      if (current.gateway === "Running") await proc.restartProc("gateway");
      if (current.agent === "Running") await proc.restartProc("agent");
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
    setManualLink(null);
    pollingRef.current = false;
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
      setManualLink(null);
      toast.info("Opening browser for authorization...");
      const tokenPayload: any = await invoke("start_browser_oauth", { provider: editType });
      if (tokenPayload && tokenPayload.access) {
        setEditKey(tokenPayload.access);
        setManualLink(null);
        toast.success("Login successful!");
      }
    } catch (e: any) {
      if (e.includes("Could not open browser")) {
        const urlMatch = e.match(/https:\/\/auth\.openai\.com[^\s]*/);
        if (urlMatch) setManualLink(urlMatch[0]);
      }
      toast.error(`OAuth failed: ${e}`);
    } finally {
      setOauthLoading(false);
    }
  };

  const handleDeviceOAuth = async () => {
    try {
      setOauthLoading(true);
      setDeviceAuth(null);
      toast.info("Requesting device code...");
      const payload: any = await invoke("start_device_oauth", { provider: editType, region: "global" });
      setDeviceAuth(payload);
      // Rust backend will now handle polling and emit events.
    } catch (e) {
      toast.error(`Device auth failed: ${e}`);
      setOauthLoading(false);
    }
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
              <div className="premium-select-icon"><ChevronDown /></div>
            </div>
          </div>
          <button className="premium-btn premium-btn-primary" onClick={() => openProviderModal()}>
            <Plus /> Add Provider
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
                        {hasKey ? <CheckCircle /> : <AlertCircle />}
                        {hasKey ? "Configured" : "Missing Keys"}
                      </span>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button className="premium-btn premium-btn-outline" style={{ padding: "6px", height: "30px", width: "30px" }} onClick={() => openProviderModal(rp.id)}>
                    <Settings />
                  </button>
                  <button className="premium-btn premium-btn-outline" style={{ padding: "6px", height: "30px", width: "30px", color: "#ef4444" }} onClick={() => deleteProvider(rp.id)}>
                    <Trash />
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
          <div style={{ gridColumn: "1/-1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px", background: "rgba(255, 255, 255, 0.03)", backdropFilter: "blur(12px)", borderRadius: "24px", border: "1px solid rgba(255, 255, 255, 0.1)" }}>
            <div style={{ marginBottom: "12px", opacity: 0.8 }}><Cpu size={32} /></div>
            <h3 style={{ margin: "0 0 8px", fontSize: "16px", color: "#0f172a" }}>No Providers Configured</h3>
            <p style={{ margin: "0 0 16px", fontSize: "14px", color: "#64748b" }}>Add an AI provider connection to enable intelligent features.</p>
            <button className="premium-btn premium-btn-primary" onClick={() => openProviderModal()}>
              Get Started <Plus />
            </button>
          </div>
        )}
      </div>

      <div className="raw-json-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setShowRawJson(!showRawJson)}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{ background: "#e2e8f0", padding: "6px", borderRadius: "8px", color: "#475569" }}><Code /></div>
            <div>
              <h3 style={{ margin: 0, fontSize: "15px", color: "#0f172a", fontWeight: 600 }}>Advanced Settings</h3>
              <p style={{ margin: "2px 0 0", fontSize: "13px", color: "#64748b" }}>Edit raw JSON configuration source</p>
            </div>
          </div>
          <div style={{ color: "#94a3b8", transform: showRawJson ? "rotate(180deg)" : "rotate(0)", transition: "0.2s" }}><ChevronDown /></div>
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
                    <div className="premium-select-icon"><ChevronDown /></div>
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
                     <button onClick={handleBrowserOAuth} disabled={oauthLoading} className="premium-btn premium-btn-outline" style={{ flex: 1, height: "40px" }}>
                       {oauthLoading ? "Connecting..." : <><Globe size={16} /> Web Sign-in</>}
                     </button>
                  )}
                  {currentMeta?.authModes.includes("oauth_device") && (
                     <button onClick={handleDeviceOAuth} disabled={oauthLoading} className="premium-btn premium-btn-outline" style={{ flex: 1, height: "40px" }}>
                       {oauthLoading ? "Generating..." : <><Smartphone size={16} /> Device Connect</>}
                     </button>
                  )}
                </div>

                {manualLink && (
                  <div style={{ marginTop: "12px", padding: "12px", background: "#fffbeb", border: "1px solid #fef3c7", borderRadius: "10px", fontSize: "13px" }}>
                    <p style={{ margin: "0 0 8px", color: "#92400e", fontWeight: 600 }}>Browser didn't open?</p>
                    <a href={manualLink} target="_blank" rel="noreferrer" style={{ color: "#b45309", wordBreak: "break-all" }}>
                      Click here to authorize manually
                    </a>
                  </div>
                )}
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
