// What creators can upload, shared by the API (validation), the UI (accept=,
// previews, editors) and the worker (how the agent can perceive each kind).
// Contract: docs/assets-and-history.md. Content sniffing lives in lib/assets.mjs.
//   perceive: 'view'  the agent can look at it directly (images, PDF pages)
//             'frames' the worker extracts still frames for the agent (video)
//             'read'  the agent reads it as text
//             'meta'  the agent only gets metadata plus the creator's note
//   editor:   which in-Studio editor opens it (components/studio/editors)
export const MB=1024*1024;
export const ASSET_KINDS={
  image:{label:'Image',ext:['png','jpg','jpeg','webp','gif','avif','svg'],mime:['image/png','image/jpeg','image/webp','image/gif','image/avif','image/svg+xml'],maxBytes:10*MB,perceive:'view',editor:'image',direct:true},
  audio:{label:'Audio',ext:['mp3','ogg','wav','m4a','flac'],mime:['audio/mpeg','audio/ogg','audio/wav','audio/mp4','audio/flac'],maxBytes:15*MB,perceive:'meta',editor:'audio',direct:true},
  font:{label:'Font',ext:['ttf','otf','woff','woff2'],mime:['font/ttf','font/otf','font/woff','font/woff2'],maxBytes:5*MB,perceive:'meta',editor:null,direct:true},
  model:{label:'3D model',ext:['glb','gltf','obj'],mime:['model/gltf-binary','model/gltf+json','model/obj'],maxBytes:15*MB,perceive:'meta',editor:null,direct:true},
  // v1.3: GPU textures for `texture` slots (docs/asset-manifest.md). Counted as assets so coverage sees them and the version
  // file route serves them (texture previews, a .gltf's external .ktx2); replaced only by the same format.
  texture:{label:'Texture',ext:['ktx2','hdr'],mime:['image/ktx2','image/vnd.radiance'],maxBytes:15*MB,perceive:'meta',editor:null,direct:true},
  video:{label:'Video',ext:['mp4','webm'],mime:['video/mp4','video/webm'],maxBytes:25*MB,perceive:'frames',editor:null,direct:false},
  text:{label:'Text or data',ext:['txt','md','json','csv','tmj','tsj','tmx','tsx','xml','yaml','yml'],mime:['text/plain','text/markdown','application/json','text/csv','application/xml','application/yaml'],maxBytes:2*MB,perceive:'read',editor:'text',direct:true},
  document:{label:'PDF',ext:['pdf'],mime:['application/pdf'],maxBytes:20*MB,perceive:'view',editor:null,direct:false},
};
export const ROLES=['inspiration','direct','target'];
export const ROLE_LABELS={inspiration:'Inspiration',direct:'Use in game',target:'Change this'};
export const PROJECT_ASSET_BYTES=150*MB;   // live revisions per project, plus the owner's staged uploads
export const MAX_ATTACHMENTS=12;           // per message
export const extensionOf=name=>(/\.([a-z0-9]+)$/i.exec(name??'')?.[1]??'').toLowerCase();
// A direct swap writes new bytes at the old path, so both files must share a format (jpg and jpeg are one format).
export function sameFileFormat(a,b){const norm=e=>e==='jpeg'?'jpg':e;return norm(extensionOf(a))===norm(extensionOf(b));}
export function kindForFilename(name){const ext=extensionOf(name);return Object.entries(ASSET_KINDS).find(([,k])=>k.ext.includes(ext))?.[0]??null;}
export const ACCEPT=Object.values(ASSET_KINDS).flatMap(k=>k.ext.map(e=>'.'+e)).join(',');
// Game-source files that the "Used in this version" list shows as assets.
// Build bookkeeping the worker, the maker and the asset tools (asset-manifest/enrich.mjs) write beside the game; never creator-facing.
export const isBookkeepingPath=path=>/(^|\/)(adaptation-plan|foundation\.lock|asset-usage|package(-lock)?|TEMPLATE|build(-manifest)?|enrich-report)\.json$/i.test(path);
// License and credit files travel with ported code (CLAUDE.md rule 3); they aren't game assets to edit.
export const isLegalPath=path=>/(^|\/)((LICEN[CS]E|COPYING|NOTICE|ATTRIBUTION|CREDITS|AUTHORS|README)(\.[a-z]+)?|LICEN[CS]E-[^/]+)$/i.test(path);
export const isAssetPath=path=>{const kind=kindForFilename(path);return kind!==null&&!(kind==='text'&&(isBookkeepingPath(path)||isLegalPath(path)));};
