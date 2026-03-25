import React from "react";
import { UploadCloud } from "lucide-react";

type Props = {
  isDragging: boolean;
};

export const DropZone: React.FC<Props> = ({ isDragging }) => {
  if (!isDragging) return null;

  return (
    <div className="window-drop-zone">
      <div className="drop-zone-content">
        <div className="drop-icon">
          <UploadCloud size={64} strokeWidth={1.5} />
        </div>
        <h2>Drop Files Here</h2>
        <p>Support Images, PDFs, and more</p>
      </div>
    </div>
  );
};
