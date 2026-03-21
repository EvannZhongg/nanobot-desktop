import React, { memo } from "react";
import { 
  Home, Monitor, Clock, MessageSquare, 
  Settings, Layers, Terminal, Database, 
  Cpu, Plus, Router, Users, Calendar, 
  History, Zap, Brain, Activity, Settings2 
} from "lucide-react";
import type { TabKey, Status } from "../types";
import { useSettings } from "../hooks/useSettings";

type Props = {
  tab: TabKey;
  setTab: (t: TabKey) => void;
  status: Status;
  currentSession: string;
  onNewChat?: () => void;
};

const NAV_ITEMS: { key: TabKey; label: string; icon: any }[] = [
  { key: "chat", label: "Chat", icon: MessageSquare },
  { key: "monitor", label: "Monitor", icon: Monitor },
  { key: "cron", label: "Cron", icon: Calendar },
  { key: "sessions", label: "Sessions", icon: History },
  { key: "skills", label: "Skills", icon: Zap },
  { key: "memory", label: "Memory", icon: Brain },
  { key: "models", label: "Models", icon: Cpu },
];

export default memo(function Sidebar({ tab, setTab, status, currentSession, onNewChat }: Props) {
  const { t } = useSettings();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand-container">
        <div className="brand">
          <Brain size={24} className="icon-purple" />
          <span>Nanobot</span>
        </div>
        <button 
          className="new-chat-btn" 
          onClick={onNewChat}
          title="New Chat (Cmd+N)"
        >
          <Plus size={18} />
          <span>New Chat</span>
        </button>
      </div>

      <nav className="nav" role="tablist" aria-label="Main Navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              className={tab === item.key ? "active" : ""}
              onClick={() => setTab(item.key)}
              role="tab"
              aria-selected={tab === item.key}
              aria-controls={`panel-${item.key}`}
              title={t(`nav.${item.key}` as any)}
            >
              <Icon size={18} strokeWidth={tab === item.key ? 2.5 : 2} />
              <span>{t(`nav.${item.key}` as any)}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="status-group">
          <div className="status-row">
            <Activity size={14} className={status.agent ? "text-success" : "text-muted"} />
            <span className="status-label">Agent</span>
            <span className={`status-dot agent ${status.agent ? "on" : "off"}`} />
          </div>
          <div className="status-row">
            <Settings2 size={14} className={status.gateway ? "text-accent" : "text-muted"} />
            <span className="status-label">Gateway</span>
            <span className={`status-dot gateway ${status.gateway ? "on" : "off"}`} />
          </div>
          <div className="status-row">
            <Router size={14} className={status.router ? "text-info" : "text-muted"} />
            <span className="status-label">Router</span>
            <span className={`status-dot router ${status.router ? "on" : "off"}`} />
          </div>
          <div className="status-row">
            <Users size={14} className={status.subagents ? "text-warning" : "text-muted"} />
            <span className="status-label">Subagents</span>
            <span className={`status-dot subagents ${status.subagents ? "on" : "off"}`} />
          </div>
        </div>

        <button 
          className={`settings-tab-btn ${tab === "settings" ? "active" : ""}`}
          onClick={() => setTab("settings")}
        >
          <Settings size={18} />
          <span>{t("nav.settings")}</span>
        </button>
      </div>
    </aside>
  );
});
