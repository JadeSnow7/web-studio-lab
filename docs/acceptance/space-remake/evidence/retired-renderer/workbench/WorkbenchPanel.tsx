import { DemoBadge } from '../components/Badges';
import { DEMO_SPACE } from '../domain/space';
import { CaptureSection } from './CaptureSection';
import { RunSection } from './RunSection';
import { TaskSection } from './TaskSection';

/** Workshop 在空间页的工作面板：现场 → 任务确认 → 运行与审阅。 */
export function WorkbenchPanel() {
  return (
    <div className="workbench-panel">
      <div className="wb-header">
        <span className="muted small">空间</span>
        <strong>{DEMO_SPACE.name}</strong>
        <DemoBadge label="演示页面" />
      </div>
      <div className="wb-scroll">
        <CaptureSection />
        <TaskSection />
        <RunSection />
      </div>
    </div>
  );
}
