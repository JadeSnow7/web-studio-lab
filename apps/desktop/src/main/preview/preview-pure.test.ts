import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDemoFile } from './demo-path';
import { attributesToMap, quadToRect } from './element-summary';
import { clampToViewport } from './geometry';
import { isAllowedPreviewUrl, previewOriginOf } from './navigation-policy';

describe('导航白名单', () => {
  const allowed = ['wsl-demo://taskflow'];
  it('按 scheme + host 比较自定义协议', () => {
    expect(previewOriginOf('wsl-demo://taskflow/task.html?id=1')).toBe('wsl-demo://taskflow');
    expect(isAllowedPreviewUrl('wsl-demo://taskflow/index.html', allowed)).toBe(true);
  });
  it('拒绝其他 host、其他协议与无效地址', () => {
    expect(isAllowedPreviewUrl('wsl-demo://other/index.html', allowed)).toBe(false);
    expect(isAllowedPreviewUrl('https://example.com/', allowed)).toBe(false);
    expect(isAllowedPreviewUrl('file:///etc/passwd', allowed)).toBe(false);
    expect(isAllowedPreviewUrl('not a url', allowed)).toBe(false);
  });
  it('端口不同视为不同来源', () => {
    expect(isAllowedPreviewUrl('http://127.0.0.1:5174/', ['http://127.0.0.1:5173'])).toBe(false);
    expect(isAllowedPreviewUrl('http://127.0.0.1:5173/tasks', ['http://127.0.0.1:5173'])).toBe(true);
  });
});

describe('演示目录映射', () => {
  const root = path.resolve('/tmp/demo-root');
  it('映射到目录内文件，目录请求补 index.html', () => {
    expect(resolveDemoFile(root, 'wsl-demo://taskflow/task.html?id=1')).toBe(path.join(root, 'task.html'));
    expect(resolveDemoFile(root, 'wsl-demo://taskflow/')).toBe(path.join(root, 'index.html'));
  });
  it('拒绝越界路径与其他 host', () => {
    // URL 解析会先规范化 %2e%2e 段，结果仍在演示目录内。
    expect(resolveDemoFile(root, 'wsl-demo://taskflow/%2e%2e/%2e%2e/etc/passwd')?.startsWith(root + path.sep)).toBe(true);
    expect(resolveDemoFile(root, 'wsl-demo://taskflow/..%2Fsecret')).toBeNull();
    expect(resolveDemoFile(root, 'wsl-demo://other/index.html')).toBeNull();
    expect(resolveDemoFile(root, 'wsl-demo://taskflow/%E0%A4%A')).toBeNull();
  });
});

describe('元素几何', () => {
  it('border quad 换算外接矩形', () => {
    expect(quadToRect([10, 20, 110, 20, 110, 70, 10, 70])).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(quadToRect([1, 2])).toBeNull();
  });
  it('截图区域裁剪到视口内，完全在外时为 null', () => {
    expect(clampToViewport({ x: -5, y: 10, width: 50, height: 20 }, { width: 800, height: 600 })).toEqual({
      x: 0,
      y: 10,
      width: 45,
      height: 20,
    });
    expect(clampToViewport({ x: 900, y: 10, width: 50, height: 20 }, { width: 800, height: 600 })).toBeNull();
  });
  it('属性数组转成映射', () => {
    expect(attributesToMap(['id', 'a', 'class', 'x y']).get('class')).toBe('x y');
    expect(attributesToMap(undefined).size).toBe(0);
  });
});
