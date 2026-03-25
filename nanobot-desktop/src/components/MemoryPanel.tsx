/**
 * Memory panel: list, edit, delete daily memory files.
 * All memory-specific state lives here.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Brain, FileEdit } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { MemoryFileInfo, MemoryFilePayload } from "../types";
import { todayFileName } from "../utils/helpers";

type Props = {
  toast: { success: (m: string) => void; error: (m: string) => void };
};

export default function MemoryPanel({ toast }: Props) {
  const [files, setFiles] = useState<MemoryFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<MemoryFilePayload | null>(null);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await invoke<MemoryFileInfo[]>("list_memory_files");
      setFiles(items);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const openMemory = useCallback(async (name: string) => {
    try {
      const payload = await invoke<MemoryFilePayload>("read_memory_file", { name });
      setEditing(payload);
      setContent(payload.content);
      setDirty(false);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const saveMemory = useCallback(async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      await invoke("save_memory_file", { name: editing.name, content });
      setDirty(false);
      toast.success("Memory saved");
      await loadFiles();
    } catch (err) {
      setError(String(err));
      toast.error(`Save failed: ${err}`);
    } finally {
      setSaving(false);
    }
  }, [editing, saving, content, loadFiles, toast]);

  const deleteMemory = useCallback(async (name: string) => {
    if (!window.confirm(`Delete memory file "${name}"?`)) return;
    try {
      await invoke("delete_memory_file", { name });
      if (editing?.name === name) {
        setEditing(null);
        setContent("");
        setDirty(false);
      }
      toast.success("Memory file deleted");
      await loadFiles();
    } catch (err) {
      setError(String(err));
      toast.error(`Delete failed: ${err}`);
    }
  }, [editing, loadFiles, toast]);

  const closeEditor = useCallback(() => {
    setEditing(null);
    setContent("");
    setDirty(false);
  }, []);

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    setDirty(true);
  }, []);

  return (
    <div className="content">
      <div className="memory-header">
        <div>Daily memories: {files.length}</div>
        <div className="memory-actions">
          <button onClick={() => openMemory("MEMORY.md")} className="ghost">Open MEMORY.md</button>
          <button onClick={() => openMemory(todayFileName())}>New Today</button>
          <button onClick={loadFiles} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      {error && <div className="skills-error">{error}</div>}
      <div className="memory-layout">
        <div className="memory-list">
          {files.length === 0 && !loading && (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Brain size={32} />
              </div>
              <div className="empty-state-text">No memory files</div>
              <div className="empty-state-hint">Daily memories are stored here to help the agent remember context.</div>
            </div>
          )}
          {files.map((file) => (
            <div
              key={file.name}
              className={`memory-card ${editing?.name === file.name ? "active" : ""}`}
            >
              <div className="memory-top">
                <div className="memory-title">{file.name.replace(".md", "")}</div>
                <div className="memory-actions">
                  <button onClick={() => openMemory(file.name)}>Open</button>
                  <button className="danger" onClick={() => deleteMemory(file.name)}>Delete</button>
                </div>
              </div>
              <div className="skill-path">{file.path}</div>
              {file.modified ? (
                <div className="skill-meta">
                  Updated: {new Date(file.modified * 1000).toLocaleString()}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="memory-editor">
          {editing ? (
            <>
              <div className="editor-header">
                <div className="editor-title">Editing: {editing.name}</div>
                <div className="editor-actions">
                  <button onClick={saveMemory} disabled={saving || !dirty}>
                    {saving ? "Saving..." : "Save"}
                  </button>
                  <button className="ghost" onClick={closeEditor}>Close</button>
                </div>
              </div>
              <textarea
                className="editor-textarea"
                value={content}
                onChange={handleContentChange}
                aria-label={`Edit memory: ${editing.name}`}
              />
              <div className="editor-hint">{editing.path}</div>
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">
                <FileEdit size={32} />
              </div>
              <div className="empty-state-text">Select a memory file</div>
              <div className="empty-state-hint">Choose a past memory to view or edit its contents.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
