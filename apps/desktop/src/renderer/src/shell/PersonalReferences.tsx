import { useState } from 'react';
import { useStore } from '../lib/store';
import { workspaceStore } from '../state/workspace';
import { personalReferencesStore } from '../state/references';
export function PersonalReferences({ disabled }: { disabled: boolean }) {
  const catalog = useStore(workspaceStore, (s) => s.snapshot?.catalog);
  const selected = useStore(personalReferencesStore, (s) => s);
  const [resourceId, setResourceId] = useState(''),
    [version, setVersion] = useState('');
  const items =
    catalog?.resources.filter((item) => item.versions.length && catalog.library.some((entry) => entry.resourceId === item.resourceId)) ??
    [];
  const item = items.find((item) => item.resourceId === resourceId);
  return (
    <details className="personal-references">
      <summary>个人参考 · 已选择 {selected.length} / 16</summary>
      <p className="muted small">仅发送明确选择的收藏正文版本；新版不会替换当前选择。</p>
      <div className="row wrap gap-8">
        <label className="field">
          收藏参考
          <select
            aria-label="收藏参考"
            disabled={disabled}
            value={resourceId}
            onChange={(e) => {
              setResourceId(e.target.value);
              setVersion('');
            }}
          >
            <option value="">选择有正文的收藏</option>
            {items
              .filter((item) => !selected.some((entry) => entry.resourceId === item.resourceId))
              .map((item) => (
                <option key={item.resourceId} value={item.resourceId}>
                  {item.title}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          参考版本
          <select aria-label="个人参考版本" disabled={disabled || !item} value={version} onChange={(e) => setVersion(e.target.value)}>
            <option value="">选择明确版本</option>
            {item?.versions.map((value) => (
              <option key={value} value={value}>
                v{value}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          disabled={disabled || !item || !version || selected.length >= 16}
          onClick={() => {
            personalReferencesStore.set((old) => [...old, { resourceId, version: Number(version) }]);
            setResourceId('');
            setVersion('');
          }}
        >
          加入本轮参考
        </button>
      </div>
      {!items.length ? <p className="muted small">没有保存正文的收藏。先在空间中保存正文快照并收藏。</p> : null}
      {selected.map((entry) => (
        <div className="row wrap gap-8" key={entry.resourceId}>
          <span className="resource-location">
            {items.find((item) => item.resourceId === entry.resourceId)?.title ?? '已不可用的收藏'} · v{entry.version}
          </span>
          <button
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() => personalReferencesStore.set((old) => old.filter((item) => item.resourceId !== entry.resourceId))}
          >
            移除参考
          </button>
        </div>
      ))}
    </details>
  );
}
