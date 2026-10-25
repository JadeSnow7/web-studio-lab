export const meta = { name: 'phase-undeclared', description: '负例：未声明的 phase 标题', phases: ['唯一'] };

export default async function main() {
  phase('不存在的阶段');
  return { status: 'complete' };
}
