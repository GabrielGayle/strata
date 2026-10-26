// Drop files anywhere: while files are dragged over the window, show what each can become.
// Only drags that carry files light it up, so the composer's blocks and the workspace tabs
// (dragged inside the page) keep their own drop zones.
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { useStore } from '../state/store';
import { activeLayout, useWorkspaces } from '../state/workspaces';
import { visibleTabs } from '../core/workspace';
import { dragKinds, dropTargets, fileKind, type DropKind, type DropTarget } from './dropTargets';
import { readImageFile, SURFACE_INFO } from './surfaces';
import { importLace, importMeshInto, openProjectFile } from './Toolbar';
import { sendToShadow } from './dropInbox';

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
// a dialog (composer, pattern, drawing pad) is open: leave it alone
const modalOpen = () => !!document.querySelector('.pm-back');

async function deliver(t: DropTarget, all: File[]) {
  const st = useStore.getState();
  const files = all.filter((f) => fileKind(f.name, f.type) === t.kind);
  if (!files.length) {
    st.toast(`${all.map((f) => f.name).join(', ')}: not something ${t.label} takes`);
    return;
  }
  const f = files[0];
  switch (t.id) {
    case 'side':
    case 'front':
    case 'top': {
      const img = await readImageFile(f);
      if (!img) return st.toast(`Could not read ${f.name} as an image`);
      st.setAsset('image', t.id, img);
      st.setParams(SURFACE_INFO[t.id].enable, 'img');
      st.setUi({ collapsed: { ...useStore.getState().ui.collapsed, Image: false } });
      st.toast(`${SURFACE_INFO[t.id].title}: ${f.name}`);
      return;
    }
    case 'shadow':
      sendToShadow({ images: files });
      st.setUi({ tab: 'shadow' });
      return;
    case 'video':
      sendToShadow({ video: f });
      st.setUi({ tab: 'shadow' });
      return;
    case 'ins':
    case 'src':
      return importMeshInto(t.id, f);
    case 'open':
      if (/\.lace-loft\.json$/i.test(f.name)) return importLace(f);
      if (window.confirm(`Open ${f.name}? It replaces the working copy (Undo brings it back).`)) return openProjectFile(f, { offerKeep: true });
  }
}

export default function DropOverlay() {
  const [kinds, setKinds] = useState<Set<DropKind> | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const layout = useWorkspaces(activeLayout);
  const shadowOpen = visibleTabs(layout).includes('shadow');

  useEffect(() => {
    const close = () => {
      clearTimeout(hide.current);
      setKinds(null);
      setOver(null);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // never let the browser navigate away to a dropped file
      e.preventDefault();
      if (modalOpen()) {
        e.dataTransfer!.dropEffect = 'none';
        return;
      }
      const types = [...e.dataTransfer!.items].filter((i) => i.kind === 'file').map((i) => i.type);
      setKinds((k) => {
        const next = dragKinds(types);
        return k && k.size === next.size && [...next].every((x) => k.has(x)) ? k : next;
      });
      // dragover keeps firing while the pointer is over the window; once it stops, the drag has left
      clearTimeout(hide.current);
      hide.current = setTimeout(close, 400);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget && (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight)) close();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('dragenter', onOver);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', close);
    return () => {
      clearTimeout(hide.current);
      window.removeEventListener('dragenter', onOver);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', close);
    };
  }, []);

  if (!kinds) return null;
  const targets = dropTargets(kinds, shadowOpen);
  const drop = (e: ReactDragEvent, t: DropTarget | null) => {
    e.preventDefault();
    e.stopPropagation();
    const files = [...e.dataTransfer.files];
    clearTimeout(hide.current);
    setKinds(null);
    setOver(null);
    if (!files.length) return;
    // dropped between the targets: fine when the files only fit one
    const pick = t ?? (() => {
      const fits = targets.filter((x) => files.some((f) => fileKind(f.name, f.type) === x.kind));
      return fits.length === 1 ? fits[0] : null;
    })();
    if (pick) deliver(pick, files);
    else useStore.getState().toast('Drop onto one of the targets');
  };
  const groups: { kind: DropKind; title: string }[] = [
    { kind: 'image', title: 'Picture' },
    { kind: 'mesh', title: 'STL / OBJ' },
    { kind: 'project', title: 'Project' },
    { kind: 'video', title: 'Video' },
  ];
  return (
    <div className="drop-overlay" onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, null)} role="dialog" aria-label="Drop files">
      <div className="drop-panel">
        <div className="drop-title">Drop to…</div>
        {groups.map((g) => {
          const ts = targets.filter((t) => t.kind === g.kind);
          if (!ts.length) return null;
          return (
            <div className="drop-group" key={g.kind}>
              <div className="drop-kind">{g.title}</div>
              <div className="drop-zones">
                {ts.map((t) => (
                  <div
                    key={t.id}
                    className={`drop-zone ${over === t.id ? 'over' : ''}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'copy';
                      if (over !== t.id) setOver(t.id);
                    }}
                    onDragLeave={() => setOver((o) => (o === t.id ? null : o))}
                    onDrop={(e) => drop(e, t)}
                  >
                    <span className="drop-label">{t.label}</span>
                    <small>{t.hint}</small>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
