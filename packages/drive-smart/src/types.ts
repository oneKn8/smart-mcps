export type DriveRootKind = "google-drive" | "local" | "rclone" | "unknown";

export type DriveRoot = {
  id: string;
  label: string;
  path: string;
  account?: string;
  kind: DriveRootKind;
  source: "config" | "auto";
  exists: boolean;
};

export type IndexedFile = {
  id: string;
  root_id: string;
  root_label: string;
  account?: string;
  path: string;
  relative_path: string;
  name: string;
  extension: string;
  size: number;
  modified_ms: number;
  kind: "file";
};

export type DriveIndex = {
  version: 1;
  generated_at: string;
  roots: DriveRoot[];
  files: IndexedFile[];
  skipped: Array<{ path: string; reason: string }>;
};

export type DriveSmartConfig = {
  roots?: Array<{
    id?: string;
    label?: string;
    path: string;
    account?: string;
    kind?: DriveRootKind;
  }>;
  ignore_names?: string[];
};
