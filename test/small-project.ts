import { newProject, type Project } from '../src/core/project';

/** Compact stack for pipeline-heavy tests so the full suite stays under 5 s. */
export function smallProject(patch: Project['params'] = {}): Project {
  const p = newProject();
  p.params = {
    ...p.params,
    plateCount: '6',
    baseLength: '180',
    baseWidth: '110',
    stackHeight: '24',
    thickness: '3',
    ...patch,
  };
  return p;
}
