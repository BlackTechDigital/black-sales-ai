import { api } from "../api";
import type {
  BriefFields,
  BriefVersionMeta,
  ProjectMode,
  StudioDetail,
  StudioProject,
} from "../../shared/studio";
export const listProjects = (offset = 0) =>
  api<{ projects: StudioProject[] }>(`/studio/projects?offset=${offset}`);
export const projectDetail = (id: string, version?: string) =>
  api<StudioDetail>(
    `/studio/projects/${id}${version ? `/versions/${version}` : ""}`,
  );
export const listBriefVersions = (id: string, offset = 0) =>
  api<{ versions: BriefVersionMeta[] }>(
    `/studio/projects/${id}/versions?offset=${offset}`,
  );
export const createProject = (input: {
  title: string;
  mode: ProjectMode;
  lead_id: string | null;
  request_id: string;
}) =>
  api<{ project_id: string; version_id: string }>("/studio/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
export const saveBrief = (
  id: string,
  expected_head_id: string,
  fields: BriefFields,
  request_id: string,
) =>
  api<{ version_id: string; number: number }>(`/studio/projects/${id}/briefs`, {
    method: "POST",
    body: JSON.stringify({ expected_head_id, fields, request_id }),
  });
export const approveBrief = (
  id: string,
  version_id: string,
  content_hash: string,
) =>
  api(`/studio/projects/${id}/approvals`, {
    method: "POST",
    body: JSON.stringify({ version_id, content_hash, confirm: true }),
  });
