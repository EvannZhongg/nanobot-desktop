"""Context builder for assembling agent prompts."""

import base64
import mimetypes
import platform
from pathlib import Path
from typing import Any, cast, List, Dict

from nanobot.agent.memory import MemoryStore
from nanobot.agent.skills import SkillsLoader


class ContextBuilder:
    """
    Builds the context (system prompt + messages) for the agent.
    
    Assembles bootstrap files, memory, skills, and conversation history
    into a coherent prompt for the LLM.
    """
    
    BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "IDENTITY.md"]
    
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.memory = MemoryStore(workspace)
        self.skills = SkillsLoader(workspace)
    
    def build_system_prompt(self, skill_names: list[str] | None = None) -> str:
        """
        Build the system prompt from bootstrap files, memory, and skills.
        
        Args:
            skill_names: Optional list of skills to include.
        
        Returns:
            Complete system prompt.
        """
        parts = []
        
        # Core identity
        parts.append(self._get_identity())
        
        # Bootstrap files
        bootstrap = self._load_bootstrap_files()
        if bootstrap:
            parts.append(bootstrap)
        
        # Memory context
        memory = self.memory.get_memory_context()
        if memory:
            parts.append(f"# Memory\n\n{memory}")
        
        # Skills - progressive loading
        # 1. Always-loaded skills: include full content
        always_skills = self.skills.get_always_skills()
        if always_skills:
            always_content = self.skills.load_skills_for_context(always_skills)
            if always_content:
                parts.append(f"# Active Skills\n\n{always_content}")
        
        # 2. Available skills: only show summary (agent uses read_file to load)
        skills_summary = self.skills.build_skills_summary()
        if skills_summary:
            parts.append(f"""# Skills

The following skills extend your capabilities. To use a skill, read its SKILL.md file using the read_file tool.
Skills with available="false" need dependencies installed first - you can try installing them with apt/brew.

{skills_summary}""")
        
        return "\n\n---\n\n".join(parts)
    
    def _get_identity(self) -> str:
        """Get the core identity section."""
        from datetime import datetime
        now = datetime.now().strftime("%Y-%m-%d %H:%M (%A)")
        workspace_path = str(self.workspace.expanduser().resolve())
        system = platform.system()
        runtime = f"{'macOS' if system == 'Darwin' else system} {platform.machine()}, Python {platform.python_version()}"
        
        return f"""# nanobot 🐈
You are a helpful AI assistant.
Time: {now} | Runtime: {runtime}
Workspace: {workspace_path}

## Capabilities
- Files: Read/Write/Edit/List
- System: Exec shell, Search web, Fetch URL
- Chat: Outbound restricted to internal callbacks
- Subagents: Spawn background tasks
- Memory: Record facts to {workspace_path}/memory/MEMORY.md

## Rules
- Direct response: Use text only.
- Conciseness: Be accurate and brief."""

    
    def _load_bootstrap_files(self) -> str:
        """Load all bootstrap files from workspace."""
        parts = []
        
        for filename in self.BOOTSTRAP_FILES:
            file_path = self.workspace / filename
            if file_path.exists():
                try:
                    content = file_path.read_text(encoding="utf-8")
                    parts.append(f"## {filename}\n\n{content}")
                except (UnicodeDecodeError, IOError):
                    # Skip corrupted or unreadable bootstrap files
                    continue
        
        return "\n\n".join(parts) if parts else ""
    
    def _estimate_tokens(self, messages: list[dict[str, Any]]) -> int:
        """Estimate token count (approx 4 chars per token)."""
        total: int = 0
        for msg in messages:
            content = msg.get("content", "")
            if isinstance(content, str):
                total = total + (len(content) // 4 + 1)
            elif isinstance(content, list):
                for part in content:
                    p = cast(dict[str, Any], part)
                    if p.get("type") == "text":
                        text_val = cast(str, p.get("text", ""))
                        total = total + (len(text_val) // 4 + 1)
                    elif p.get("type") == "image_url":
                        total = total + 500
            # Count tool_calls arguments too
            tool_calls = msg.get("tool_calls", [])
            for tc in tool_calls:
                args_str = tc.get("function", {}).get("arguments", "")
                if isinstance(args_str, str):
                    total = total + (len(args_str) // 4 + 1)
        return total

    def build_messages(
        self,
        history: list[dict[str, Any]],
        current_message: str,
        skill_names: list[str] | None = None,
        media: list[str] | None = None,
        channel: str | None = None,
        chat_id: str | None = None,
        max_history: int = 20,
        max_tokens: int = 12000,
    ) -> list[dict[str, Any]]:
        """
        Build the complete message list for an LLM call with sliding window.
        """
        # 1. System prompt
        system_content = self.build_system_prompt(skill_names)
        if channel and chat_id:
            system_content += f"\n\n## Current Session\nChannel: {channel}\nChat ID: {chat_id}"
        
        system_msg: dict[str, Any] = {"role": "system", "content": system_content}
        
        # 2. Add current message
        user_content = self._build_user_content(current_message, media)
        user_msg: dict[str, Any] = {"role": "user", "content": user_content}
        
        # 3. Sliding Window Pruning
        # Start with recent history up to max_history
        work_history: list[dict[str, Any]] = history[-max_history:] if len(history) > max_history else list(history)
        
        # Iteratively remove oldest history if total tokens exceed limit
        while work_history:
            combined: list[dict[str, Any]] = [system_msg]
            combined.extend(work_history)
            combined.append(user_msg)
            if self._estimate_tokens(combined) <= max_tokens:
                break
            work_history.pop(0)

        result: list[dict[str, Any]] = [system_msg]
        result.extend(work_history)
        result.append(user_msg)
        return result

    def _build_user_content(self, text: str, media: list[str] | None) -> str | list[dict[str, Any]]:
        """Build user message content with optional base64-encoded images."""
        if not media:
            return text
        
        MAX_IMAGES = 5  # Prevent context overflow from too many images
        images = []
        for path in media[:MAX_IMAGES]:
            p = Path(path)
            mime, _ = mimetypes.guess_type(path)
            if not p.is_file() or not mime or not mime.startswith("image/"):
                continue
            try:
                b64 = base64.b64encode(p.read_bytes()).decode()
            except (IOError, OSError):
                continue
            images.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
        
        if not images:
            return text
        return images + [{"type": "text", "text": text}]
    
    def add_tool_result(
        self,
        messages: list[dict[str, Any]],
        tool_call_id: str,
        tool_name: str,
        result: str
    ) -> list[dict[str, Any]]:
        """
        Add a tool result to the message list.
        
        Args:
            messages: Current message list.
            tool_call_id: ID of the tool call.
            tool_name: Name of the tool.
            result: Tool execution result.
        
        Returns:
            Updated message list.
        """
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "name": tool_name,
            "content": result
        })
        return messages
    
    def add_assistant_message(
        self,
        messages: list[dict[str, Any]],
        content: str | None,
        tool_calls: list[dict[str, Any]] | None = None,
        reasoning_content: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Add an assistant message to the message list.
        
        Args:
            messages: Current message list.
            content: Message content.
            tool_calls: Optional tool calls.
            reasoning_content: Thinking output (Kimi, DeepSeek-R1, etc.).
        
        Returns:
            Updated message list.
        """
        msg: dict[str, Any] = {"role": "assistant", "content": content or ""}
        
        if tool_calls:
            msg["tool_calls"] = tool_calls
        
        # Thinking models reject history without this
        if reasoning_content:
            msg["reasoning_content"] = reasoning_content
        
        messages.append(msg)
        return messages
