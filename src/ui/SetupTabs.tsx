// Tabs for whole master setups: each tab is a complete project (parameters,
// images, composition, pour), so you can flip between designs like browser tabs.
import { useStore } from '../state/store';
import { Menu } from './Toolbar';

export default function SetupTabs() {
  const setups = useStore((s) => s.setups);
  const active = useStore((s) => s.activeSetup);
  const project = useStore((s) => s.project);
  const switchSetup = useStore((s) => s.switchSetup);
  const closeSetup = useStore((s) => s.closeSetup);
  const newSetup = useStore((s) => s.newSetup);
  return (
    <nav className="setup-tabs" role="tablist" aria-label="Master setups">
      {setups.map((t) => {
        const on = t.id === active;
        const name = (on ? project : t.project).name || 'Untitled';
        return (
          <div key={t.id} className={`setup-tab ${on ? 'active' : ''}`}>
            <button role="tab" aria-selected={on} className="setup-name" onClick={() => switchSetup(t.id)} title={on ? 'Rename it in the box at the top left' : `Switch to ${name}`}>
              {name}
            </button>
            {setups.length > 1 && (
              <button
                className="setup-x"
                aria-label={`Close ${name}`}
                title="Close this setup"
                onClick={() => {
                  if (window.confirm(`Close the setup "${name}"? Save it as a project file first if you want to keep it.`)) closeSetup(t.id);
                }}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
      <Menu label="+" className="setup-add">
        {(close) => (
          <>
            <button
              className="item"
              onClick={() => {
                newSetup('duplicate');
                close();
              }}
            >
              Duplicate this setup <small>everything, images included</small>
            </button>
            <button
              className="item"
              onClick={() => {
                newSetup('blank');
                close();
              }}
            >
              New blank setup <small>default design</small>
            </button>
          </>
        )}
      </Menu>
    </nav>
  );
}
