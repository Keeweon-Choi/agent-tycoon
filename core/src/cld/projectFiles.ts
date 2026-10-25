/** HTTP file API shapes. The contract is in core/asyncapi.yaml (T-0044). */
export interface ProjectFileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
  mtime: number;
}

export interface ProjectFileList {
  path: string;
  entries: ProjectFileEntry[];
  offset: number;
  nextOffset: number | null;
}

export interface ProjectFilePreview {
  path: string;
  kind: 'image' | 'markdown' | 'text' | 'csv' | 'json' | 'pdf' | 'html' | 'download';
  size: number;
  truncated: boolean;
  text?: string;
}

export interface ProjectRecentFiles {
  entries: ProjectFileEntry[];
  partial: boolean;
  ignored: string[];
}
