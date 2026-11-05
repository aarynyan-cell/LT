import { html, render } from './h.js';
import { boot } from './store.js';
import { App } from './app.js';

render(html`<${App} />`, document.getElementById('root'));
boot().catch((e) => {
  console.error(e);
  document.getElementById('root').innerHTML = '<pre style="padding:24px">启动失败：' + String(e?.message || e).replace(/</g, '&lt;') + '</pre>';
});
