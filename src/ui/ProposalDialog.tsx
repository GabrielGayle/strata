// Client proposal: the words a proposal needs (the place, a local quotation,
// price band, timeline, finish) typed in beside the design, and three ways to
// send it: open the page, download it as one HTML file, or copy a link that
// rebuilds it at /p from the design's settings.
import { useState } from 'react';
import { useStore } from '../state/store';
import { download, openHtml } from '../core/exporters';
import { defaultProposal, proposalDefaults, proposalHtml, type ProposalSpec } from '../core/proposal';
import { LONG_LINK, omittedFrom, shareLink } from '../core/share';
import { PROPOSAL_PATH } from './proposal/route';
import { useFullModel } from './model';
import { busyThen } from './busy';
import { Modal } from './LibraryPanel';

type TextKey = Exclude<keyof ProposalSpec, 'priceEst'>;

interface Field {
  key: TextKey;
  label: string;
  /** Shown greyed in the empty box. */
  hint: string;
  rows?: number;
}

function fields(project: ReturnType<typeof useStore.getState>['project']): { title: string; items: Field[] }[] {
  const d = proposalDefaults(project);
  return [
    {
      title: 'The place',
      items: [
        { key: 'client', label: 'Prepared for', hint: '[client to confirm]' },
        { key: 'place', label: 'Place', hint: d.place || '[place to confirm]' },
        { key: 'quote', label: 'Local quotation', hint: 'A real line about the place, from someone who knows it', rows: 3 },
        { key: 'quoteBy', label: 'Quoted from', hint: 'Who said or wrote it, and where' },
        { key: 'archetype', label: 'Archetype', hint: d.archetype || '[source to confirm]' },
      ],
    },
    {
      title: 'The piece',
      items: [
        { key: 'number', label: 'ECTYPE No.', hint: d.number || '[number to confirm]' },
        { key: 'intro', label: 'About the piece', hint: 'A sentence or two (optional)', rows: 3 },
      ],
    },
    {
      title: 'Terms',
      items: [
        { key: 'price', label: 'Price band', hint: '[price to confirm]' },
        { key: 'timeline', label: 'Timeline', hint: '[timeline to confirm]' },
        { key: 'finish', label: 'Finish', hint: '[finish to confirm]' },
        { key: 'upkeep', label: 'Upkeep', hint: '[upkeep to confirm]', rows: 2 },
        { key: 'contact', label: 'Sign-off', hint: '[contact to confirm]' },
      ],
    },
  ];
}

const fileName = (name: string) => `${(name || 'proposal').replace(/[^\w-]+/g, '_')}-proposal.html`;

function ProposalDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const setProposal = useStore((s) => s.setProposal);
  const fullModel = useFullModel();
  const spec = project.proposal ?? defaultProposal();
  const [link, setLink] = useState<{ url: string; long: boolean; copied: boolean } | null>(null);
  const omitted = omittedFrom(project);
  const set = <K extends keyof ProposalSpec>(key: K, value: ProposalSpec[K]) => {
    setProposal({ ...spec, [key]: value }, `proposal:${key}`);
    setLink(null);
  };
  const page = async (then: (html: string) => void) => {
    try {
      await busyThen({ scene: 'pack', title: 'Client proposal', detail: 'Drawing the plan, front and side at one scale…' }, () => then(proposalHtml(useStore.getState().project, fullModel())));
    } catch (e) {
      useStore.getState().toast(`Proposal failed: ${(e as Error).message}`);
    }
  };
  const copyLink = async () => {
    const r = await shareLink(useStore.getState().project, `${location.origin}${PROPOSAL_PATH}`);
    let copied = false;
    try {
      await navigator.clipboard.writeText(r.url);
      copied = true;
    } catch {
      /* shown in the box to copy by hand */
    }
    setLink({ url: r.url, long: r.long, copied });
  };
  return (
    <Modal title="Client proposal" onClose={onClose} wide>
      <div className="proposal-form" data-hl="proposal-form">
        <p className="lib-note">
          The page leads with the place and its quotation, then the piece drawn in plan, front and side at one scale, then price, timeline and finish. The full spec is folded into a technical sheet at the end. Empty boxes print as <b>[… to confirm]</b>.
        </p>
        {fields(project).map((g) => (
          <fieldset key={g.title}>
            <legend>{g.title}</legend>
            {g.items.map((f) => (
              <label key={f.key} className="proposal-row">
                <span>{f.label}</span>
                {f.rows ? (
                  <textarea rows={f.rows} value={spec[f.key]} placeholder={f.hint} onChange={(e) => set(f.key, e.target.value)} data-proposal={f.key} />
                ) : (
                  <input type="text" value={spec[f.key]} placeholder={f.hint} onChange={(e) => set(f.key, e.target.value)} data-proposal={f.key} />
                )}
              </label>
            ))}
            {g.title === 'Terms' && (
              <div className="proposal-row check">
                <span />
                <span>
                  <input type="checkbox" id="proposal-est" checked={spec.priceEst} onChange={(e) => set('priceEst', e.target.checked)} data-proposal="priceEst" />
                  <label htmlFor="proposal-est">Mark the price est. (no live supplier quote behind it yet)</label>
                </span>
              </div>
            )}
          </fieldset>
        ))}
        <div className="lib-row end">
          <button className="btn" data-hl="proposal-download" onClick={() => void page((html) => download(fileName(project.name), html, 'text/html'))} title="One HTML file: email it, upload it, or open it and print to PDF">
            Download .html
          </button>
          <button className="btn" data-hl="proposal-link" onClick={() => void copyLink()} disabled={omitted.length > 0} title={omitted.length ? 'This design needs its pictures or map, which a link cannot carry' : 'Copy a link that opens this proposal'}>
            Copy link
          </button>
          <button className="btn primary" data-hl="proposal-open" onClick={() => void page(openHtml)}>
            Open proposal
          </button>
        </div>
        {omitted.length > 0 && (
          <div className="lib-note">
            A link carries the design's settings, not its {omitted.join(', ')}, so the piece would arrive without them. Send the downloaded page instead: it has the drawings in it.
          </div>
        )}
        {link && (
          <div className="lib-share proposal-link">
            <p>{link.copied ? 'Link copied to the clipboard.' : 'Copy the link below.'} It opens the proposal page, rebuilt from the design.</p>
            <input readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Proposal link" />
            {link.long && <div className="lib-note warn">This link is over {LONG_LINK.toLocaleString()} characters; some mail apps cut long links short. Send the downloaded page if it doesn't open.</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function ProposalButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="tb" data-hl="proposal" onClick={() => setOpen(true)} title="A page to send a client: the place and its quotation, the piece in plan, front and side, price, timeline and finish">
        Proposal
      </button>
      {open && <ProposalDialog onClose={() => setOpen(false)} />}
    </>
  );
}
