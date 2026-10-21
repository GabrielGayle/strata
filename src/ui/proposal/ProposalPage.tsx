// The client proposal at /p#s=…: the design from the link, built here the way
// the phone viewer builds a saved project, then drawn as the proposal page.
// Nothing is edited or saved on this route (hydrate() is not called).
import { useEffect, useMemo, useState } from 'react';
import { decodeShare, projectFromShare, shareCodeFromHash } from '../../core/share';
import { proposalHtml } from '../../core/proposal';
import type { Project } from '../../core/project';
import { useViewerModel } from '../mobile/useViewerModel';

const box = { font: '14px/1.6 ui-monospace, Menlo, monospace', color: '#6e7276', background: '#f4f2ec', minHeight: '100vh', margin: 0, padding: '48px 24px' } as const;

export default function ProposalPage() {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const code = shareCodeFromHash(location.hash);
    if (!code) {
      setError('This proposal link is missing its design.');
      return;
    }
    decodeShare(code)
      .then((s) => setProject(projectFromShare(s)))
      .catch((e) => setError((e as Error).message));
  }, []);
  const state = useViewerModel(project);
  const html = useMemo(() => (project && state.phase === 'ready' && !state.finishing ? proposalHtml(project, state.model) : ''), [project, state]);
  useEffect(() => {
    if (!html) return;
    // the page is a whole document: swap it in so it prints and reads as itself
    document.open();
    document.write(html);
    document.close();
  }, [html]);
  const failed = error || (state.phase === 'error' ? state.error : '');
  if (failed) return <div style={box} role="alert">{failed}</div>;
  return (
    <div style={box} role="status" data-testid="proposal-loading">
      {state.phase === 'building' ? `${state.step}…` : 'Opening the proposal…'}
    </div>
  );
}
