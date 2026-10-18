// Tabs for whole master setups: each tab is a complete project (parameters,
// images, composition, pour), so you can flip between designs like browser tabs.
import { useStore } from '../state/store';
import { Menu } from './Toolbar';
import { Tab as TabItem } from './Tab';

export default function SetupTabs() {
  const setups = useStore((s) => s.setups);
  const active = useStore((s) => s.activeSetup);
  const project = useStore((s) => s.project);
  const switchSetup = useStore((s) => s.switchSetup);
  const closeSetup = useStore((s) => s.closeSetup);
  const newSetup = useStore((s) => s.newSetup);
  return (
    <div className="setup-tabs">
      <menu role="tablist" aria-label="Master setups">
      {setups.map((t) => {
        const on = t.id === active;
        const name = (on ? project : t.project).name || 'Untitled';
        const close = () => {
          if (window.confirm(`Close the setup "${name}"? Save it as a project file first if you want to keep it.`)) closeSetup(t.id);
        };
        return (
          <TabItem
            key={t.id}
            selected={on}
            className="setup-tab"
            onSelect={() => switchSetup(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Delete' && setups.length > 1) {
                e.preventDefault();
                close();
              }
            }}
            title={on ? 'Rename it in the box at the top left' : `Switch to ${name}${setups.length > 1 ? ' (Delete closes it)' : ''}`}
            after={setups.length > 1 && (
              <button
                className="setup-x"
                tabIndex={-1}
                aria-label={`Close ${name}`}
                title="Close this setup"
                onClick={(e) => {
                  e.stopPropagation();
                  close();
                }}
              >
                ✕
              </button>
            )}
          >
            {name}
          </TabItem>
        );
      })}
      </menu>
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
    </div>
  );
}
