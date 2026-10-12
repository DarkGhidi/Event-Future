const { app, protocol, dialog } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const smoke = process.argv.includes('--smoke-test');
protocol.registerSchemesAsPrivileged([{scheme:'maxibot',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const fail = error => {
  if (smoke) {
    writeFileSync(join(process.cwd(),'smoke-result.json'),JSON.stringify({error:error.message,code:error.code,stack:error.stack}));
    app.exit(1);
  } else {
    dialog.showErrorBox('Maxibot 2.0','Démarrage indisponible. Code : '+(error.code||'STARTUP_FAILED'));
    app.exit(1);
  }
};
if(smoke){writeFileSync(join(process.cwd(),'smoke-stage.txt'),'bootstrap');setTimeout(()=>fail(new Error('SMOKE_TIMEOUT')),60000).unref();}
process.on('uncaughtException',fail);
process.on('unhandledRejection',fail);
import('./main.mjs').catch(fail);
