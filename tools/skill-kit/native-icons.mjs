// Public format checks, implemented from the documented native icon contract.
// This is author tooling, not a copy of the robot's private icon implementation.
import {inflateSync} from 'node:zlib';
import theme from '../theme-kit/themeFormat.cjs';
const builtins='calendar circuit-saver clock commute create dance exercise full-report fun-stuff introduction joke news personal-report photobooth radio settings surprise things-to-do tips weather word-of-the-day wifi volume battery themes mode help updates storage padlock app-store-grid'.split(' ');
function fail(code){throw Object.assign(new Error('app_icon_'+code),{code:'app_icon_'+code});}
function exact(v,names){return v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));}
function integer(v,min,max){return Number.isSafeInteger(v)&&v>=min&&v<=max;}
export function iconFields(app){
  const names=['iconApi','icon','iconImage'],present=names.filter(k=>Object.hasOwn(app,k));
  if(!present.length)return {};
  if(present.length!==3)fail('ref_invalid');
  return Object.fromEntries(names.map(k=>[k,app[k]]));
}
export function validateIcon(d,manifest){
  if(d.iconApi!==1)fail('api_invalid');
  if(d.icon===null){if(d.iconImage!==null)fail('ref_invalid');}
  else if(exact(d.icon,['type','catalog','name'])&&d.icon.type==='builtin'&&d.icon.catalog==='jibo-menu-v1'&&builtins.includes(d.icon.name)){if(d.iconImage!==null)fail('ref_invalid');}
  else if(exact(d.icon,['type','asset'])&&d.icon.type==='image'&&d.icon.asset==='app-icon'){
    const m=d.iconImage;
    if(!exact(m,['mediaType','width','height','bytes','sha256'])||m.mediaType!=='image/png'||!integer(m.width,32,330)||!integer(m.height,32,300)||m.width*m.height>99000||!integer(m.bytes,57,262144)||typeof m.sha256!=='string'||!/^[a-f0-9]{64}$/.test(m.sha256))fail('metadata_invalid');
  }else fail('ref_invalid');
  const app=manifest.filter(e=>e.path==='app.json'),reserved=manifest.filter(e=>e.path==='assets/app-icon.png');
  if(app.length!==1||!integer(app[0].length,1,65536)||app[0].mode!==420)fail('manifest_invalid');
  if(d.icon?.type==='image'){
    if(reserved.length!==1||reserved[0].length!==d.iconImage.bytes||reserved[0].sha256!==d.iconImage.sha256||reserved[0].mode!==420)fail('manifest_invalid');
  }else if(reserved.length)fail('reserved_collision');
}
export function inspectIcon(bytes,meta){
  // theme's shared PNG parser checks every CRC; native icons allow NO ancillary
  // chunks and additionally bound chunk count and exact zlib consumption.
  if(bytes.length!==meta.bytes||bytes.length>262144)fail('digest_invalid');
  let at=8,count=0,stage=0;
  while(at<bytes.length){
    if(at+12>bytes.length||++count>128)fail('chunks_invalid');
    const size=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8),end=at+12+size;
    if(end>bytes.length)fail('chunks_invalid');
    if(stage===0&&type==='IHDR'&&size===13)stage=1;
    else if((stage===1||stage===2)&&type==='IDAT'&&size>0)stage=2;
    else if(stage===2&&type==='IEND'&&size===0&&end===bytes.length)stage=3;
    else fail('chunks_invalid');
    at=end;
  }
  if(stage!==3)fail('chunks_invalid');
  const info=theme.inspectImage(bytes,meta),stride=info.width*info.channels+1,budget=stride*info.height;
  const decoded=inflateSync(info.data,{maxOutputLength:budget,info:true});
  if(decoded.engine.bytesWritten!==info.data.length||decoded.buffer.length!==budget)fail('zlib_trailing_or_size');
  for(let row=0;row<budget;row+=stride)if(decoded.buffer[row]>4)fail('filter_invalid');
}
export function requireNativeSchema(info,schema){
  if(schema!==2)return;
  if(!Array.isArray(info.nativeContainerSchemas)||!info.nativeContainerSchemas.includes(2)){
    const message='This Jibo firmware cannot install native test builds with declared icons. Update Jibo to firmware advertising nativeContainerSchemas: [1, 2], then retry. The kit will not silently discard artwork; no project was allocated or uploaded.';
    throw Object.assign(new Error('unsupported_native_icons'),{code:'unsupported_native_icons',ownerMessage:message});
  }
}
