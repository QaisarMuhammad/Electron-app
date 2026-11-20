import { bootNewDesktop, connectPage, makeWebDesktop, web } from './_kit.mjs';
const { world } = await bootNewDesktop();
const page = connectPage(world);
const { desktop, events } = makeWebDesktop(page.electron);
let r;
for (let i = 1; i <= 6; i += 1) {
  r = await desktop.openCashDrawer({ password: i === 6 ? 'tills-pw' : 'bad' + i }, { notify: false });
  console.log(`attempt ${i}${i === 6 ? ' (RIGHT password)' : ''}:`, JSON.stringify({ code: r.code, details: r.details }), '| dialog text:', JSON.stringify(web.index.failureText(r)));
}
world.cleanup();
