import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchApp, target } from './helpers';

test('安装设置：失败恢复、可信目录选择、SSH字段与保存后重启', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wsl-install-ui-'));
  let { app, page } = await launchApp({ userData: directory, cleanInstall: true });
  try {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const section = page.getByRole('region', { name: '比赛环境安装' });
    await expect(section).toContainText('检查设备与安装载荷');
    await section.getByRole('button', { name: '检查安装条件' }).click();
    await expect(section.getByRole('alert')).toContainText(/Applications|签名|载荷|工具/);
    await expect(section.getByRole('button', { name: '重试安装' })).toBeEnabled();
    await section.getByRole('checkbox', { name: '配置可信 SSH 环境' }).check();
    await section.getByRole('button', { name: '保存环境配置' }).click();
    await expect(section.getByLabel('SSH 主机', { exact: true })).toBeFocused();
    await expect(section.getByLabel('可信主机 SHA-256 指纹')).toHaveAttribute('aria-invalid', 'true');
    await section.getByLabel('SSH 主机', { exact: true }).fill('localhost');
    await section.getByLabel('SSH 用户名').fill('比赛用户');
    await section.getByLabel('SSH 端口').fill('22');
    await section.getByLabel('可信主机 SHA-256 指纹').fill('a'.repeat(64));
    await section.getByLabel('SSH 授权目录').fill('/workspace');
    const chooser = section.getByRole('button', { name: '选择本地目录' });
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await chooser.click();
    await expect(chooser).toBeFocused();
    await expect(section.getByLabel('已授权本地目录')).toHaveValue('');
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, directory);
    await section.getByRole('button', { name: '选择本地目录' }).click();
    await expect(section.getByLabel('已授权本地目录')).toHaveValue(directory);
    await expect(chooser).toBeFocused();
    await section.getByRole('button', { name: '保存环境配置' }).click();
    await expect(section).toContainText('配置已保存，重启应用后生效');
    await expect(section.getByRole('button', { name: '保存环境配置' })).toBeEnabled();
    const saved = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'));
    expect(saved.config.localRoot).toBe(directory);
    expect(saved.config.ssh.username).toBe('比赛用户');
    expect(saved.config.ssh).not.toHaveProperty('agent');
    expect(saved.config.ssh).not.toHaveProperty('privateKey');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 720));
    await section.getByLabel('SSH 授权目录').focus();
    await page.keyboard.press('Tab');
    await expect(section.getByRole('button', { name: '保存环境配置' })).toBeFocused();
    await expect(section.getByRole('button', { name: '保存环境配置' })).toBeInViewport();
    await page.screenshot({ path: path.join(directory, 'installation-settings.png') });
    await app.close();
    ({ app, page } = await launchApp({ userData: directory }));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByLabel('已授权本地目录')).toHaveValue(directory);
    await expect(page.getByLabel('SSH 用户名')).toHaveValue('比赛用户');
    await expect(page.getByRole('region', { name: '比赛环境安装' })).not.toContainText('配置已保存，重启应用后生效');
  } finally {
    await app.close();
  }
});

test('无启动变量的新配置显示首次安装；损坏记录可见且不覆盖', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wsl-install-clean-'));
  const invalid = '{"schemaVersion":999}';
  await writeFile(path.join(directory, 'runtime.json'), invalid);
  const { app, page } = await launchApp({ userData: directory, cleanInstall: true });
  try {
    if (target !== 'packaged') await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('region', { name: '比赛环境安装' })).toContainText('原文件已保留');
    await expect(page.getByRole('button', { name: '开始准备' })).toBeDisabled();
    expect(await readFile(path.join(directory, 'runtime.json'), 'utf8')).toBe(invalid);
  } finally {
    await app.close();
  }
});
