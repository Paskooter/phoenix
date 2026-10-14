import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staticRoutes } from '../src/static.js';

function get(handler) {
  assert.equal(typeof handler, 'function', 'route is registered');
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(bytes) { this.bytes = Buffer.from(bytes); this.body = this.bytes.toString(); } };
  handler({ req: { headers: {} }, res }); return res;
}
function env(values, fn) {
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k,v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k,v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('served robots allows public pages and assets with prefix and end-anchor-aware parsers', () => env({ PHOENIX_SITE_URL: 'https://synthetic.example' }, () => {
  const robots = get(staticRoutes()['GET /robots.txt']).body;
  const code = `import sys,json,urllib.robotparser,re
r=sys.stdin.read();p=urllib.robotparser.RobotFileParser();p.parse(r.splitlines())
public=['/','/terms','/privacy','/security','/guide','/apps','/apps/app-phoenix-tic-tac-toe','/apps.js','/apps.css','/apple-touch-icon.png']
private=['/app','/admin','/activate','/reset','/invite','/create','/home','/verify-email','/confirmemailreset','/api/me','/member-photos/a']
rules=[]
for line in r.splitlines():
 k,_,v=line.partition(':');v=v.strip()
 if k.lower() in ['allow','disallow']:rules.append((k.lower()=='allow',v))
def anchored(path):
 matches=[(len(v.replace('$','')),allow) for allow,v in rules if re.match('^'+re.escape(v).replace('\\\\$','$').replace('\\\\*','.*'),path)]
 return max(matches,default=(0,True))[1]
for label,fn in [('prefix',lambda s:p.can_fetch('*','https://synthetic.example'+s)),('anchored',anchored)]:
 for path in public:assert fn(path),(label,path,'public blocked')
 for path in private:assert not fn(path),(label,path,'console exposed')
print(json.dumps({'parsers':2,'public':len(public),'private':len(private)}))`;
  const result = spawnSync('python3', ['-c', code], { input: robots, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(robots, /Disallow: \/app\$/); assert.match(robots, /Sitemap: https:\/\/synthetic.example\/sitemap.xml/);
}));

test('sitemap extension is dynamic, escaped, deduplicated and validates public paths and real dates', () => env({ PHOENIX_SITE_URL: 'https://synthetic.example' }, () => {
  let entries = [{ path: '/apps' }, { path: '/apps/app-a', lastmod: '2026-10-13T12:34:56.000Z' }, { path: '/apps/app-a' }, { path: '//evil.example/a' }, { path: '/app' }, { path: '/apps/a?owner=x' }, { path: '/apps/app-b', lastmod: 'invented' }];
  const routes = staticRoutes({ sitemapEntries: () => entries });
  let xml = get(routes['GET /sitemap.xml']).body;
  assert.match(xml, /<loc>https:\/\/synthetic.example\/apps<\/loc>/);
  assert.match(xml, /<lastmod>2026-10-13T12:34:56.000Z<\/lastmod>/);
  assert.equal((xml.match(/\/apps\/app-a<\/loc>/g) || []).length, 1);
  assert.ok(!xml.includes('evil.example') && !xml.includes('owner=x') && !xml.includes('invented'));
  assert.ok(!xml.includes('<loc>https://synthetic.example/app</loc>'));
  entries = [{ path: '/apps/app-new' }]; xml = get(routes['GET /sitemap.xml']).body;
  assert.match(xml, /\/apps\/app-new<\/loc>/); assert.ok(!xml.includes('/apps/app-a'));
}));

test('self-hosted sitemap stays correct without the optional store', () => env({ PHOENIX_SITE_URL: undefined, PHOENIX_PAGES_DIR: undefined }, () => {
  const xml = get(staticRoutes()['GET /sitemap.xml']).body;
  assert.ok(!xml.includes('/apps') && !xml.includes('jibo.io') && !xml.includes('%SITE_URL%'));
  assert.match(xml, /<loc>\/privacy<\/loc>/);
}));

test('favicon and touch icon are real binaries served with the correct media types', () => {
  const routes = staticRoutes(), ico = get(routes['GET /favicon.ico']), png = get(routes['GET /apple-touch-icon.png']);
  assert.equal(ico.status, 200); assert.equal(ico.headers['content-type'], 'image/x-icon');
  assert.equal(ico.bytes.subarray(0,4).toString('hex'), '00000100');
  assert.equal(png.bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a'); assert.equal(png.bytes.readUInt32BE(16),180); assert.equal(png.bytes.readUInt32BE(20),180);
  assert.match(get(routes['GET /']).body, /rel="apple-touch-icon"/);
});

test('security.txt uses the existing security page, never invents a contact and supports a reviewed override', () => env({ PHOENIX_SITE_URL: 'https://synthetic.example' }, () => {
  const baseline = get(staticRoutes()['GET /.well-known/security.txt']);
  assert.equal(baseline.status,200); assert.match(baseline.body, /^Contact: https:\/\/synthetic.example\/security$/m); assert.match(baseline.body,/^Expires: /m);
  assert.ok(!baseline.body.includes('mailto:'));
  env({ PHOENIX_SITE_URL: undefined }, () => {
    const text = get(staticRoutes()['GET /.well-known/security.txt']).body;
    assert.match(text, /^Contact: https:\/\//m, 'RFC 9116 Contact is an absolute URI even without an instance origin');
  });
  env({ PHOENIX_SITE_URL: 'http://localhost:9011' }, () => {
    const text = get(staticRoutes()['GET /.well-known/security.txt']).body;
    assert.match(text, /^Contact: https:\/\//m, 'web Contact URIs must use HTTPS, not the development HTTP origin');
  });
  const dir=mkdtempSync(join(tmpdir(),'phx-seo-')); const file=join(dir,'security.txt');
  writeFileSync(file,'Contact: mailto:reviewed@synthetic.example\nExpires: 2027-01-01T00:00:00Z\n');
  try { env({ PHOENIX_SECURITY_FILE:file }, () => assert.match(get(staticRoutes()['GET /.well-known/security.txt']).body,/mailto:reviewed@synthetic.example/)); }
  finally { rmSync(dir,{recursive:true,force:true}); }
}));

test('landing structured data follows rendered instance branding and a safe origin', () => env({ PHOENIX_SITE_URL: 'https://synthetic.example' }, () => {
  const html = get(staticRoutes()['GET /']).body;
  const match=html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/); assert.ok(match,'JSON-LD exists');
  const data=JSON.parse(match[1]); assert.equal(data['@context'],'https://schema.org');
  const organization=data['@graph'].find(x=>x['@type']==='Organization'), site=data['@graph'].find(x=>x['@type']==='WebSite');
  assert.equal(organization.name,'Phoenix'); assert.equal(organization.url,'https://synthetic.example/'); assert.equal(site.url,organization.url);
  assert.ok(organization.sameAs.includes('https://github.com/Paskooter/phoenix'));
  assert.ok(!data['@graph'].some(x=>x['@type']==='FAQPage'),'no unsupported FAQ rich-result claim');
  env({ PHOENIX_SITE_URL:undefined },()=>assert.ok(!get(staticRoutes()['GET /']).body.includes('application/ld+json'),'no false hosted identity without an origin'));
}));

test('operator landing override receives structured data without modifying the repo default', () => {
  const dir=mkdtempSync(join(tmpdir(),'phx-seo-brand-')); const file=join(dir,'brand.json');
  writeFileSync(file,JSON.stringify({name:'Synthetic </script> & site',links:{github:'https://github.com/example/synthetic'}}));
  writeFileSync(join(dir,'index.html'),'<html><head><title>Operator</title></head><body data-page="landing"><h1>Operator</h1></body></html>');
  try { env({PHOENIX_SITE_URL:'https://synthetic.example',PHOENIX_PAGES_DIR:dir,PHOENIX_BRANDING_FILE:file},()=>{
    const html=get(staticRoutes()['GET /']).body;
    assert.match(html,/<h1>Operator<\/h1>/); const m=html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/); assert.ok(m);
    const data=JSON.parse(m[1]); assert.equal(data['@graph'][0].name,'Synthetic </script> & site'); assert.ok(!m[1].includes('</script>'));
    assert.deepEqual(data['@graph'][0].sameAs,['https://github.com/example/synthetic']);
  }); } finally { rmSync(dir,{recursive:true,force:true}); }
});
