import { useStore } from '../lib/store';
import { findRun, runsStore } from '../state/runs';
import { shellStore } from '../state/shell';
import { TerminalPanel } from '../workbench/TerminalPanel';
import { BrowserToolbar } from '../workbench/BrowserToolbar';
import { PreviewHost } from '../workbench/PreviewHost';
import { DiffView, LogView, ReportView } from '../workbench/RunViews';

/** 空间页的 Browser 区：页面 Tab 由原生 WebContentsView 承载，日志 / diff / 报告是同一标签栏下的视图。 */
export function SpacePage({ active, occluded }: { active: boolean; occluded: boolean }) {
  const tab = useStore(shellStore, (s) => s.browserTab);
  const record = useStore(runsStore, (s) => findRun(s, s.selectedRunId));
  return (
    <div className="browser">
      {tab === 'preview' ? <BrowserToolbar /> : null}
      <div className="browser-body" role="tabpanel" id={`space-panel-${tab}`} aria-labelledby={`space-tab-${tab}`}>
        <PreviewHost active={active && tab === 'preview'} occluded={occluded} />
        <TerminalPanel active={active && tab === 'terminal' && !occluded} visible={tab === 'terminal'} />
        {tab === 'log' ? <LogView record={record} /> : null}
        {tab === 'diff' ? <DiffView record={record} /> : null}
        {tab === 'report' ? <ReportView record={record} /> : null}
      </div>
    </div>
  );
}
