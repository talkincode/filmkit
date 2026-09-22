// The built-in template behind `filmkit storyboard`'s HTML sheet (spec §6.3).
// A single self-contained file: inline CSS, no JS, no network, no fonts from a
// CDN — it must open from file:// on any machine the project is copied to.
// Placeholders ({{name}}) are replaced by renderStoryboardHtml(); everything
// interpolated there is HTML-escaped, so this string never carries user data.
//
// Aesthetic: a film production call sheet — warm paper, ink, one vermilion
// accent, rubber-stamp status badges, a sprocket-hole timeline strip. Fonts
// are local stacks only (the sheet may be reviewed offline).

export const STORYBOARD_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}} · storyboard · filmkit</title>
<style>
:root{
  --paper:#efe9dd; --card:#faf7ef; --paper2:#e5dece;
  --ink:#1d1812; --ink2:#574e42; --line:#c9bfa9;
  --red:#c8401f; --green:#2f6f4f; --amber:#a8710f; --blue:#2a5f9e; --grey:#6b6459;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Source Han Serif SC","Noto Serif CJK SC","Songti SC",serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--serif);line-height:1.55;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.035 0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");}
.sheet{max-width:1180px;margin:0 auto;padding:34px 20px 70px}
.kicker{font-family:var(--mono);font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--red);
  display:flex;align-items:center;gap:12px;}
.kicker::after{content:"";flex:1;border-top:1px solid var(--ink);opacity:.45}
h1{font-size:clamp(30px,5vw,52px);line-height:1.1;margin:14px 0 6px;font-weight:700;letter-spacing:-.01em}
.lede{color:var(--ink2);margin:0 0 16px;max-width:70ch;font-size:16px}
.spec{display:flex;flex-wrap:wrap;gap:8px;font-family:var(--mono);font-size:12px;margin:0 0 4px;padding:0;list-style:none}
.chip{border:1px solid var(--ink);background:var(--card);padding:3px 10px;box-shadow:2px 2px 0 rgba(29,24,18,.16)}
.chip b{color:var(--red)}
.metaline{font-family:var(--mono);font-size:11px;color:var(--ink2);letter-spacing:.06em;margin-top:10px;overflow-wrap:anywhere}
h2{font-family:var(--mono);font-size:12px;letter-spacing:.22em;text-transform:uppercase;margin:44px 0 14px;
  display:flex;align-items:baseline;gap:12px;color:var(--ink)}
h2::after{content:"";flex:1;border-top:1px dashed var(--line)}
h2 .count{color:var(--red);letter-spacing:.08em}
/* ---- timeline strip: film with sprocket holes ---- */
.stripwrap{background:var(--ink);padding:11px 0;position:relative;box-shadow:4px 4px 0 rgba(29,24,18,.18)}
.stripwrap::before,.stripwrap::after{content:"";position:absolute;left:0;right:0;height:9px;
  background-image:repeating-linear-gradient(90deg,var(--paper) 0 9px,transparent 9px 24px);opacity:.85}
.stripwrap::before{top:0}.stripwrap::after{bottom:0}
.strip{position:relative;height:66px}
.blk{position:absolute;top:7px;bottom:7px;overflow:hidden;text-decoration:none;color:#f8f3e7;
  font-family:var(--mono);font-size:11px;padding:5px 7px;background:var(--grey);border-right:1px solid rgba(239,233,221,.6)}
.blk .sid{display:block;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.blk .rng{display:block;opacity:.85;white-space:nowrap;overflow:hidden}
.blk.st-ready{background:#2f6b4c}.blk.st-missing{background:#a63a1e}
.blk.st-stale{background:#8f6210}.blk.st-partial{background:#2a5f9e}.blk.st-blocked{background:#55503f}
.blk.est{background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.22) 0 7px,transparent 7px 14px)}
.blk.gap{background:repeating-linear-gradient(45deg,#3a352c 0 6px,#211d17 6px 12px);border-right:none}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-family:var(--mono);font-size:11px;color:var(--ink2);margin-top:10px}
.legend i{display:inline-block;width:11px;height:11px;margin-right:5px;vertical-align:-1px;border:1px solid rgba(0,0,0,.3)}
/* ---- shot cards ---- */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr));gap:20px;align-items:start}
.card{background:var(--card);border:1px solid var(--ink);box-shadow:5px 5px 0 rgba(29,24,18,.13);padding:14px 16px 18px;scroll-margin-top:16px}
.chead{display:flex;align-items:flex-start;gap:12px;border-bottom:2px solid var(--ink);padding-bottom:9px;margin-bottom:11px}
.no{font-size:34px;font-weight:700;line-height:.9;color:var(--red);font-variant-numeric:tabular-nums}
.chead .who{flex:1;min-width:0}
.chead h3{margin:0;font-family:var(--mono);font-size:15px;letter-spacing:.02em;overflow-wrap:anywhere}
.tc{font-family:var(--mono);font-size:11.5px;color:var(--ink2)}
.tc .est-mark{color:var(--amber);font-weight:700}
/* rubber-stamp status (scoped: .st-* also styles strip blocks, which keep their own text color) */
.stamp{display:inline-block;border:2px solid currentColor;padding:1px 8px;font-family:var(--mono);font-size:10px;
  letter-spacing:.16em;text-transform:uppercase;transform:rotate(-3.5deg);border-radius:2px;white-space:nowrap}
.stamp.st-ready{color:var(--green)}.stamp.st-missing{color:var(--red)}.stamp.st-stale{color:var(--amber)}
.stamp.st-partial{color:var(--blue)}.stamp.st-blocked{color:var(--grey)}
.intent p{margin:7px 0;font-size:14.5px;overflow-wrap:anywhere}
.intent .desc{font-size:15.5px}
.lbl{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--red);margin-right:8px}
.refs{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.refs a{font-family:var(--mono);font-size:11px;color:var(--ink);border-bottom:1px dotted var(--red)}
h4{font-family:var(--mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink2);
  margin:14px 0 6px;border-bottom:1px solid var(--line);padding-bottom:3px}
.media{background:var(--paper2);border:1px solid var(--line);padding:8px;margin:9px 0;display:flex;flex-direction:column;gap:6px}
.media img,.media video{display:block;max-width:100%;max-height:270px;margin:0 auto;background:#00000010;object-fit:contain}
.media audio{width:100%}
.media figcaption{font-family:var(--mono);font-size:10.5px;color:var(--ink2);overflow-wrap:anywhere}
.media figcaption code{color:var(--ink)}
.ph{border:1.5px dashed var(--red);color:var(--red);font-family:var(--mono);font-size:12px;padding:20px 10px;text-align:center}
.ph small{display:block;color:var(--ink2);margin-top:4px;overflow-wrap:anywhere}
.filelink{font-family:var(--mono);font-size:12px;color:var(--ink)}
details.srt summary{font-family:var(--mono);font-size:11px;cursor:pointer;color:var(--ink2)}
details.srt pre{background:var(--card);border:1px solid var(--line);padding:8px;font-family:var(--mono);font-size:11px;
  white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto;margin:6px 0 0}
.meta{display:flex;flex-wrap:wrap;gap:6px;font-family:var(--mono);font-size:10.5px;color:var(--ink2);margin-top:12px}
.meta span{border:1px solid var(--line);padding:1px 7px;background:var(--paper)}
.meta span.exec{border-color:var(--red);color:var(--red)}
.files ul{list-style:none;margin:6px 0 0;padding:0;font-family:var(--mono);font-size:11.5px}
.files li{padding:3px 0;border-bottom:1px dotted var(--line);overflow-wrap:anywhere}
.io-ok{color:var(--green);font-weight:700}.io-no{color:var(--red);font-weight:700}
details.params{margin-top:12px}details.params summary{font-family:var(--mono);font-size:11px;cursor:pointer;color:var(--ink2)}
details.params pre{background:#16130f;color:#e8e0cd;font-family:var(--mono);font-size:11px;padding:10px;overflow:auto;max-height:280px;white-space:pre-wrap;overflow-wrap:anywhere}
/* ---- assets / tracks / missing ---- */
.tracks{width:100%;border-collapse:collapse;background:var(--card);font-family:var(--mono);font-size:12px;box-shadow:4px 4px 0 rgba(29,24,18,.12)}
.tracks th,.tracks td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
.tracks th{background:var(--paper2);letter-spacing:.1em;text-transform:uppercase;font-size:10px;color:var(--ink2)}
.tracks .media{margin:0}.tracks .media img{max-height:70px}.tracks audio{width:190px}
.missing{list-style:none;margin:0;padding:0;font-family:var(--mono);font-size:12px}
.missing li{background:var(--card);border:1px solid var(--red);border-left-width:5px;padding:8px 12px;margin-bottom:8px;overflow-wrap:anywhere}
.missing .fld{color:var(--red);display:block;font-size:10.5px;letter-spacing:.08em}
.missing .who{color:var(--ink2);font-size:11px}
footer{margin-top:56px;border-top:2px solid var(--ink);padding-top:12px;font-family:var(--mono);font-size:11px;color:var(--ink2);display:flex;flex-wrap:wrap;gap:6px 22px}
footer code{color:var(--ink)}
@media (max-width:560px){.sheet{padding:22px 12px 50px}.strip{height:56px}.rng{display:none}}
</style>
</head>
<body>
<div class="sheet">
  <div class="kicker">filmkit storyboard · 分镜评审表</div>
  <h1>{{title}}</h1>
  {{lede}}
  <ul class="spec">{{chips}}</ul>
  <div class="metaline">source <code>{{film}}</code> · sha256 <code>{{filmSha}}</code> · output <code>{{outputPath}}</code></div>

  <h2>时间轴 timeline <span class="count">{{total}}</span></h2>
  <div class="stripwrap"><div class="strip">{{strip}}</div></div>
  <div class="legend">
    <span><i style="background:#2f6b4c"></i>ready 就绪</span><span><i style="background:#a63a1e"></i>missing 缺产物</span>
    <span><i style="background:#8f6210"></i>stale 过期</span><span><i style="background:#2a5f9e"></i>partial 部分</span>
    <span><i style="background:#55503f"></i>blocked 阻塞</span><span><i style="background:repeating-linear-gradient(45deg,#8f6210 0 3px,#a63a1e 3px 6px)"></i>estimated 预估时长</span>
  </div>

  <h2>分镜 shots <span class="count">{{sceneCount}}</span></h2>
  <div class="grid scenes">{{scenes}}</div>

  {{assetsSection}}
  {{tracksSection}}
  {{missingSection}}

  <footer>
    <span>数据文件 <code>{{jsonPath}}</code></span>
    <span>本页由 <code>filmkit storyboard</code> 生成：同一编排 + 同一产物 → 逐字相同，无时间戳。</span>
  </footer>
</div>
</body>
</html>
`;
