// Runs the real generator in a temporary directory with a closed synthetic network.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function runOfflineFeed(entry, mode = 'observed') {
  const sandbox = mkdtempSync(join(tmpdir(), 'crypto-os-feed-offline-'));
  try {
    mkdirSync(join(sandbox, 'config')); mkdirSync(join(sandbox, 'strategies'));
    writeFileSync(join(sandbox, 'config/wallets.json'), JSON.stringify({ watch: [{ address: '0x' + 'a'.repeat(40), label: 'SYNTHETIC_WATCH' }], exchanges: [{ address: '0x' + 'b'.repeat(40), label: 'SYNTHETIC_EXCHANGE' }] }));
    writeFileSync(join(sandbox, 'strategies/rsi.json'), readFileSync(new URL('../../strategies/rsi.json', import.meta.url)));
    const bootstrap = join(sandbox, 'offline-bootstrap.mjs');
    writeFileSync(bootstrap, `
import { writeFileSync } from 'node:fs';
import http from 'node:http';import https from 'node:https';import net from 'node:net';import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const blocked=()=>{throw Error('REAL_NETWORK_FORBIDDEN');};
http.request=http.get=https.request=https.get=net.connect=net.createConnection=tls.connect=blocked;syncBuiltinESMExports();
const NOW=Date.parse('2031-01-01T00:00:00Z'),H=3600000,RealDate=Date;
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}};
const mode=${JSON.stringify(mode)},counts={binance:0,hyperliquid:0,stablecoins:0,etherscan:0,denied:0};
const ok=value=>({ok:true,status:200,json:async()=>value});
globalThis.fetch=async(input,options={})=>{
 const u=new URL(String(input));
 if(u.hostname==='data-api.binance.vision'&&u.pathname==='/api/v3/klines'){
  counts.binance++;return ok(Array.from({length:240},(_,i)=>{const t=NOW-(240-i)*H,p=100+i/10;return[t,String(p),String(p+1),String(p-1),String(p),'1000',t+H-1,'100000',10,'500','50000','0'];}));
 }
 if(u.hostname==='api.hyperliquid.xyz'&&u.pathname==='/info'){
  counts.hyperliquid++;const type=JSON.parse(options.body).type;
  if(type==='spotMetaAndAssetCtxs')return ok([{tokens:[],universe:[]},[]]);
  if(type==='metaAndAssetCtxs')return ok([{universe:[]},[]]);
 }
 if(u.hostname==='stablecoins.llama.fi'){
  counts.stablecoins++;return ok({peggedAssets:[{symbol:'USDT',pegType:'peggedUSD',circulating:{peggedUSD:1000},circulatingPrevDay:{peggedUSD:990},circulatingPrevWeek:{peggedUSD:980},circulatingPrevMonth:{peggedUSD:970}}]});
 }
 if(u.hostname==='api.etherscan.io'&&u.pathname==='/v2/api'){
  counts.etherscan++;const action=u.searchParams.get('action');
  if(action==='getblocknobytime')return ok({status:'1',result:'42'});
  if(mode==='unavailable')return ok({status:'0',message:'SYNTHETIC_UNAVAILABLE',result:[]});
  if(action==='txlist'&&mode==='observed')return ok({status:'1',result:Array.from({length:7},(_,i)=>({hash:'SYNTHETIC_TX_'+i,timeStamp:String(NOW/1000-60-i*60),from:'0x'+'a'.repeat(40),to:'0x'+'b'.repeat(40),value:String(1000000n*10n**18n),isError:'0'}))});
  return ok({status:'0',message:'No transactions found',result:[]});
 }
 counts.denied++;throw Error('UNEXPECTED_OFFLINE_REQUEST');
};
process.on('exit',()=>writeFileSync('request-counts.json',JSON.stringify(counts)));
`);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(bootstrap).href, resolve(entry), '--out', 'out'], { cwd: sandbox, env: { ...process.env, ETHERSCAN_API_KEY: 'OFFLINE_FIXTURE_ONLY' }, encoding: 'utf8', timeout: 30000 });
    if (child.status !== 0) throw Error('Offline generator did not complete: ' + (child.stderr || child.error?.code || child.status));
    return { feed: JSON.parse(readFileSync(join(sandbox, 'out/feed.json'), 'utf8')), markdown: readFileSync(join(sandbox, 'out/feed.md'), 'utf8'), calls: JSON.parse(readFileSync(join(sandbox, 'request-counts.json'), 'utf8')) };
  } finally {
    const target = resolve(sandbox);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('crypto-os-feed-offline-')) throw Error('Unsafe test cleanup target');
    rmSync(target, { recursive: true, force: true });
  }
}
