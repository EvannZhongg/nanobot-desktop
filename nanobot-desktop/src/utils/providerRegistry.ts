export interface ProviderMeta {
  id: string;
  name: string;
  icon: string;         // emoji 
  placeholder: string;  // API Key 输入提示
  defaultBaseUrl?: string; // 如果提供，就是官方默认 URL
  showBaseUrl: boolean;    // 是否在前端展示 Base URL 输入框 (允许用户覆盖)
  defaultModel?: string;   // 选择该 Provider 时的默认模型
  category: 'official' | 'compatible' | 'local' | 'custom';
  authModes: ('api_key' | 'oauth_browser' | 'oauth_device')[];
}

export const PROVIDER_REGISTRY: ProviderMeta[] = [
  { 
    id: 'openai', 
    name: 'OpenAI', 
    icon: '💚', 
    placeholder: 'sk-proj-...', 
    defaultBaseUrl: 'https://api.openai.com/v1', 
    showBaseUrl: true, 
    defaultModel: 'gpt-4o', 
    category: 'official', 
    authModes: ['api_key', 'oauth_browser'] 
  },
  { 
    id: 'anthropic', 
    name: 'Anthropic', 
    icon: '🤖', 
    placeholder: 'sk-ant-api03-...', 
    showBaseUrl: true, 
    defaultModel: 'claude-3-7-sonnet-latest', 
    category: 'official', 
    authModes: ['api_key'] 
  },
  { 
    id: 'google', 
    name: 'Google', 
    icon: '🔷', 
    placeholder: 'AIza...', 
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', 
    showBaseUrl: true, 
    defaultModel: 'gemini-2.5-pro', 
    category: 'official', 
    authModes: ['api_key'] 
  },
  { 
    id: 'minimax', 
    name: 'MiniMax', 
    icon: 'Ⓜ️', 
    placeholder: 'sk-...', 
    defaultBaseUrl: 'https://api.minimax.io/v1', 
    showBaseUrl: true, 
    defaultModel: 'abab6.5s-chat', 
    category: 'official', 
    authModes: ['api_key', 'oauth_device'] 
  },
  { 
    id: 'qwen', 
    name: 'Qwen', 
    icon: '🟣', 
    placeholder: 'sk-...', 
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', 
    showBaseUrl: true, 
    defaultModel: 'qwen-max', 
    category: 'official', 
    authModes: ['api_key', 'oauth_device'] 
  },
  { 
    id: 'openrouter', 
    name: 'OpenRouter', 
    icon: '🌐', 
    placeholder: 'sk-or-v1-...', 
    defaultBaseUrl: 'https://openrouter.ai/api/v1', 
    showBaseUrl: true, 
    defaultModel: 'anthropic/claude-3.7-sonnet', 
    category: 'compatible', 
    authModes: ['api_key'] 
  },
  { 
    id: 'moonshot', 
    name: 'Moonshot', 
    icon: '🌙', 
    placeholder: 'sk-...', 
    defaultBaseUrl: 'https://api.moonshot.cn/v1', 
    showBaseUrl: true, 
    defaultModel: 'moonshot-v1-128k', 
    category: 'official', 
    authModes: ['api_key'] 
  },
  { 
    id: 'siliconflow', 
    name: 'SiliconFlow', 
    icon: '🌊', 
    placeholder: 'sk-...', 
    defaultBaseUrl: 'https://api.siliconflow.cn/v1', 
    showBaseUrl: true, 
    defaultModel: 'deepseek-ai/DeepSeek-V3', 
    category: 'compatible', 
    authModes: ['api_key'] 
  },
  { 
    id: 'ollama', 
    name: 'Ollama', 
    icon: '🦙', 
    placeholder: 'Not required', 
    defaultBaseUrl: 'http://localhost:11434/v1', 
    showBaseUrl: true, 
    category: 'local', 
    authModes: ['api_key'] 
  },
  { 
    id: 'custom', 
    name: 'Custom', 
    icon: '⚙️', 
    placeholder: 'API key...', 
    showBaseUrl: true, 
    category: 'custom', 
    authModes: ['api_key'] 
  },
];
