import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { launchApp, setWindowSize, setWorkspaceTheme, workshopNavigate, windowShots } from '/Users/huaodong/.codex/worktrees/bf64/web-studio-lab/e2e/helpers.ts';
async function main() {
  const { app, page } = await launchApp({ sbxBin: '/Users/huaodong/.codex/worktrees/bf64/web-studio-lab/e2e/fixtures/sbx.mjs' });
  const records: unknown[]=[];
  try {
    await setWindowSize(app,1440,900);
    for (const theme of ['light','dark','warm']) {
      await setWorkspaceTheme(page,theme);
      await workshopNavigate(page,'设置');
      const samples=await page.evaluate(`(() => {
        const linear=x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;
        const luminance=value=>{const c=value.match(/[\\d.]+/g).slice(0,3).map(x=>linear(Number(x)/255));return c[0]*0.2126+c[1]*0.7152+c[2]*0.0722;};
        const settings=document.querySelector('.settings');
        return ['.notice-warn','.notice-info','.table th','select'].map(selector=>{
          const element=settings.querySelector(selector);if(!element)throw new Error('missing '+selector);
          const style=getComputedStyle(element);const a=luminance(style.color),b=luminance(style.backgroundColor);
          return {selector,color:style.color,background:style.backgroundColor,contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
        });
      })()`);
      for (const sample of samples)assert.ok(sample.contrast>=4.5,`${theme} ${sample.selector}: ${sample.contrast}`);
      records.push({theme,samples});
      await windowShots(app,page,`theme-semantic-settings-${theme}`);
    }
    await writeFile('/Users/huaodong/.codex/worktrees/bf64/web-studio-lab/docs/acceptance/space-remake/evidence/theme-semantic-contrast.json',JSON.stringify(records,null,2)+'\n');
    console.log(JSON.stringify(records));
  } finally { await app.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
