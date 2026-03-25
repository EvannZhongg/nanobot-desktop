import React from "react";
import { X, FileText, Image as ImageIcon } from "lucide-react";
import type { Attachment } from "../types";

type Props = {
  attachments: Attachment[];
  onRemove: (id: string) => void;
};

export const AttachmentBar: React.FC<Props> = ({ attachments, onRemove }) => {
  if (attachments.length === 0) return null;

  return (
    <div className="attachments-bar">
      {attachments.map((at) => (
        <div key={at.id} className="attachment-pill">
          {at.previewUrl ? (
            <img src={at.previewUrl} alt={at.name} className="attachment-preview" />
          ) : (
            <div className="attachment-icon">
              {at.type.includes("image") ? <ImageIcon size={14} /> : <FileText size={14} />}
            </div>
          )}
          <span className="attachment-name">{at.name}</span>
          <button 
            className="attachment-remove" 
            onClick={() => onRemove(at.id)}
            aria-label="Remove attachment"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
};

export default AttachmentBar;
