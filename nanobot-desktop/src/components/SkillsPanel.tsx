/**
 * Skills panel: list, search, edit, delete workspace skills.
 * All skills-specific state lives here.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SkillItem, SkillFile } from "../types";

type Props = {
  toast: { success: (m: string) => void; error: (m: string) => void };
};

export default function SkillsPanel({ toast }: Props) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [editingSkill, setEditingSkill] = useState<SkillFile | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);

  const filteredSkills = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q),
    );
  }, [skills, searchQuery]);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await invoke<SkillItem[]>("list_workspace_skills");
      setSkills(items);
    } catch (err) {
      setError(String(err));
      toast.error(`Failed to load skills: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadSkills(); }, [loadSkills]);

  const openSkill = useCallback(async (name: string) => {
    try {
      const payload = await invoke<SkillFile>("read_skill_file", { name });
      setEditingSkill(payload);
      setEditorContent(payload.content);
      setEditorDirty(false);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const saveSkill = useCallback(async () => {
    if (!editingSkill || editorSaving) return;
    setEditorSaving(true);
    try {
      await invoke("save_skill_file", { name: editingSkill.name, content: editorContent });
      setEditorDirty(false);
      toast.success("Skill saved");
      await loadSkills();
    } catch (err) {
      setError(String(err));
      toast.error(`Save failed: ${err}`);
    } finally {
      setEditorSaving(false);
    }
  }, [editingSkill, editorSaving, editorContent, loadSkills, toast]);

  const deleteSkill = useCallback(async (name: string) => {
    if (!window.confirm(`Delete skill "${name}"? This will remove its folder.`)) return;
    try {
      await invoke("delete_skill", { name });
      if (editingSkill?.name === name) {
        setEditingSkill(null);
        setEditorContent("");
        setEditorDirty(false);
      }
      toast.success("Skill deleted");
      await loadSkills();
    } catch (err) {
      setError(String(err));
      toast.error(`Delete failed: ${err}`);
    }
  }, [editingSkill, loadSkills, toast]);

  const closeEditor = useCallback(() => {
    setEditingSkill(null);
    setEditorContent("");
    setEditorDirty(false);
  }, []);

  const handleEditorChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditorContent(e.target.value);
    setEditorDirty(true);
  }, []);

  return (
    <div className="content">
      <div className="skills-header">
        <div>
          Workspace skills: {filteredSkills.length}{" "}
          {searchQuery && `(filtered from ${skills.length})`}
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Search skills..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="skills-search-input"
            aria-label="Search skills"
          />
          <button onClick={loadSkills} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      {error && <div className="skills-error">{error}</div>}
      <div className="skills-layout">
        <div className="skills-list">
          {skills.length === 0 && !loading && (
            <div className="empty-state">
              <div className="empty-state-icon">🧩</div>
              <div className="empty-state-text">No skills found in workspace/skills</div>
            </div>
          )}
          {filteredSkills.map((skill) => (
            <div
              key={skill.name}
              className={`skill-card ${editingSkill?.name === skill.name ? "active" : ""}`}
            >
              <div className="skill-top">
                <div className="skill-title">{skill.name}</div>
                <div className="skill-actions">
                  <button onClick={() => openSkill(skill.name)}>
                    {skill.hasSkillMd ? "Open" : "Create"}
                  </button>
                  <button className="danger" onClick={() => deleteSkill(skill.name)}>
                    Delete
                  </button>
                </div>
              </div>
              <div className="skill-meta">
                {skill.hasSkillMd ? "SKILL.md" : "Missing SKILL.md"}
              </div>
              <div className="skill-path">{skill.path}</div>
              {skill.modified ? (
                <div className="skill-meta">
                  Updated: {new Date(skill.modified * 1000).toLocaleString()}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="skill-editor">
          {editingSkill ? (
            <>
              <div className="editor-header">
                <div className="editor-title">Editing: {editingSkill.name}</div>
                <div className="editor-actions">
                  <button onClick={saveSkill} disabled={editorSaving || !editorDirty}>
                    {editorSaving ? "Saving..." : "Save"}
                  </button>
                  <button className="ghost" onClick={closeEditor}>Close</button>
                </div>
              </div>
              <textarea
                className="editor-textarea"
                value={editorContent}
                onChange={handleEditorChange}
                aria-label={`Edit skill: ${editingSkill.name}`}
              />
              <div className="editor-hint">{editingSkill.path}</div>
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">📝</div>
              <div className="empty-state-text">Select a skill to edit</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
