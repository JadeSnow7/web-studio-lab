/* global module */
module.exports = async function beforePack() {
  const { beforePack } = await import('./before-pack.mjs');
  await beforePack();
};
