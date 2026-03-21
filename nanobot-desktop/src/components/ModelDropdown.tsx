import React from "react";

const STYLE_NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
const STYLE_MODEL_WRAPPER: React.CSSProperties = {
  position: "relative", display: "inline-flex", alignItems: "center", marginRight: "8px",
  ...(STYLE_NO_DRAG as any)
};

type Props = {
  selectedModel: string;
  setSelectedModel: (m: string) => void;
  showDropdown: boolean;
  setShowDropdown: (s: boolean) => void;
  modelList: string[];
  dropdownRef: React.RefObject<HTMLDivElement | null>;
};

export const ModelDropdown: React.FC<Props> = ({
  selectedModel,
  setSelectedModel,
  showDropdown,
  setShowDropdown,
  modelList,
  dropdownRef
}) => {
  return (
    <div ref={dropdownRef as any} style={STYLE_MODEL_WRAPPER}>
      <input
        value={selectedModel}
        onChange={(e) => setSelectedModel(e.target.value)}
        onFocus={() => setShowDropdown(true)}
        onClick={() => setShowDropdown(true)}
        className="clean-model-input"
        placeholder="Model configured..."
      />
      <button 
        onClick={() => setShowDropdown(!showDropdown)} 
        className="clean-dropdown-arrow" 
        aria-label="Toggle model dropdown"
      >
        ▼
      </button>
      {showDropdown && (
        <div className="clean-model-dropdown">
          {modelList.map((m) => (
            <div
              key={m}
              className={`model-dropdown-item ${selectedModel === m ? "selected" : ""}`}
              onClick={() => {
                setSelectedModel(m);
                setShowDropdown(false);
              }}
            >
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
