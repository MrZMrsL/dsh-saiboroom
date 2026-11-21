// 海底小屋 · 界面半边（v0.7.0 · 赛博像素）
//
// 形态：侧边栏一页（sidebar.panellist 一行 + main 一页），不找你，你找它。
// 风格：赛博朋克像素 —— 近黑底 + 紫雾 + 透视网格 + 扫描线，霓虹青/品红/柠檬绿，
//       字用 Zpix 像素宋（构建时把 base64 字体内联进样式）。
// 数据：心情数字、六根情绪、最近变化全部来自宿主半边 GET /dsh-room/state。
//
// 注意：CSS 里不要写反引号，整个样式用模板字符串包着。

window.__ModuleLoader__.load({
  id: 'dsh-saiboroom',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;

    // 页面要是崩了，至少让我知道崩在哪：异常统一发回 /dsh-room/client-error，宿主写进 client-error.log
    function reportClientError(kind, msg, stack) {
      try {
        fetch('/dsh-room/client-error', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: kind, msg: String(msg || '').slice(0, 400), stack: String(stack || '').slice(0, 2000) }),
        }).catch(function () {});
      } catch (e) { /* 连上报都失败就算了 */ }
    }
    try {
      window.addEventListener('error', function (e) {
        reportClientError('window.error', e && e.message, e && e.error && e.error.stack);
      });
      window.addEventListener('unhandledrejection', function (e) {
        const r = e && e.reason;
        reportClientError('unhandledrejection', r && (r.message || r), r && r.stack);
      });
    } catch (e) { /* ignore */ }

    // 角色图（作者自绘，抠底后 336px）+ 侧栏用头像
    const CHARS = {
      main: 'data:image/png;base64,__IMG_MAIN__',
      think: 'data:image/png;base64,__IMG_THINK__',
      work: 'data:image/png;base64,__IMG_WORK__',
      eat: 'data:image/png;base64,__IMG_EAT__',
      proud: 'data:image/png;base64,__IMG_PROUD__',
      sleep: 'data:image/png;base64,__IMG_SLEEP__',
    };
    const FACE = 'data:image/png;base64,__IMG_ICON__';
    const WHALE = CHARS.main;
    // 横条（作者自绘的分帧精灵表，抠底 + 底对齐后拼的），用 CSS steps 播
    const ANIM = {
      idle: 'data:image/png;base64,__ANIM_IDLE__',
      think: 'data:image/png;base64,__ANIM_THINK__',
      work: 'data:image/png;base64,__ANIM_WORK__',
      eat: 'data:image/png;base64,__ANIM_EAT__',
      proud: 'data:image/png;base64,__ANIM_PROUD__',
      sleep: 'data:image/png;base64,__ANIM_SLEEP__',
    };
    const ANIM_KEY = { main: 'idle', think: 'think', work: 'work', eat: 'eat', proud: 'proud', sleep: 'sleep' };
    // 她长什么样，跟着「此刻在干什么」+ 心情 + 钟点走
    const pickKey = (st) => {
      const m = st && typeof st.mood === 'number' ? st.mood : null;
      const hr = new Date().getHours();
      const alive = (st && st.activity && st.activity.alive) || null;
      if (m === null) return 'main';
      // 正在干活优先：深夜还在跑工具，不能显示成在睡觉
      if (alive && alive.busy) return 'work';
      if (m < 42) return 'sleep';
      if (hr >= 23 || hr < 7) return 'sleep';
      if (alive && alive.ate) return 'eat';
      if (m < 62) return 'think';
      if (m >= 78) return 'proud';
      return 'main';
    };
    const pickChar = (st) => CHARS[pickKey(st)] || CHARS.main;
    // 有「活着的证据」时给图加一点动感（呼吸/摆尾的 CSS 近似）
    const charMotion = (st) => {
      const alive = (st && st.activity && st.activity.alive) || null;
      if (alive && alive.busy) return ' work';
      if (alive && alive.ate) return ' eat';
      return '';
    };
    const PANEL_ID = 'dsh-room';

    const CSS = `
.dshrm-page{position:relative;height:100%;width:100%;box-sizing:border-box;overflow:auto;
  padding:20px 18px 30px;font-family:Zpix,ui-monospace,Consolas,monospace;font-size:14px;
  line-height:1.9;letter-spacing:.02em;color:#e8e4ff;-webkit-font-smoothing:none;
  background-color:#07060d;
  background-image:
    repeating-linear-gradient(0deg, rgba(0,0,0,.22) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(90deg, rgba(0,234,255,.045) 0 1px, transparent 1px 24px),
    radial-gradient(120% 80% at 50% -10%, rgba(139,92,255,.38), transparent 60%),
    radial-gradient(90% 60% at 100% 100%, rgba(255,46,151,.20), transparent 60%),
    radial-gradient(90% 60% at 0% 80%, rgba(0,234,255,.14), transparent 60%),
    linear-gradient(#07060d,#0a0813 40%,#0d0a18);
  background-attachment:local}
.dshrm-page>*{position:relative;z-index:1;max-width:940px;margin-left:auto;margin-right:auto}

@font-face{font-family:Zpix;src:url("__ZPIX__") format("truetype");font-display:block}

.dshrm-head{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.dshrm-whale{width:104px;height:104px;flex:0 0 auto;transform-origin:50% 92%;
  filter:drop-shadow(0 0 5px rgba(0,234,255,.75)) drop-shadow(0 0 18px rgba(139,92,255,.55));
  animation:dshrm-breathe 4.6s ease-in-out infinite}
.dshrm-whale.idle{animation:dshrm-bob 4.2s ease-in-out infinite}
.dshrm-whale.work{animation:dshrm-work 1.5s ease-in-out infinite}
.dshrm-whale.eat{animation:dshrm-eat .72s ease-in-out infinite}
@keyframes dshrm-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.012)}}
@keyframes dshrm-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes dshrm-work{0%,100%{transform:translateY(0) rotate(-.7deg)}50%{transform:translateY(-3px) rotate(.7deg)}}
@keyframes dshrm-eat{0%,100%{transform:scale(1)}45%{transform:scale(1.03) translateY(1px)}}
@media (prefers-reduced-motion:reduce){.dshrm-whale,.dshrm-whale.idle,.dshrm-whale.work,.dshrm-whale.eat{animation:none}}
/* 两帧微动：只播「动作幅度最小的那一对帧」，且两帧共用同一裁切窗口（站位不动，动的是尾巴），
   step-end 让每帧停住；再叠一层 6.5s 的 ±2px 浮动，读起来是呼吸而不是来回甩。 */
.dshrm-anim{width:104px;height:104px;flex:0 0 auto;background-repeat:no-repeat;
  background-size:200% 100%;background-position:0 0;
  filter:drop-shadow(0 0 5px rgba(0,234,255,.75)) drop-shadow(0 0 18px rgba(139,92,255,.55));
  animation:dshrm-f2 2.6s step-end infinite, dshrm-float 6.5s ease-in-out infinite}
.dshrm-anim.work{animation-duration:1.8s, 6.5s}
.dshrm-anim.eat{animation-duration:2.2s, 6.5s}
@keyframes dshrm-f2{
  0%,49.99%{background-position:0 0}
  50%,100%{background-position:-104px 0}}
@keyframes dshrm-float{
  0%,100%{transform:translateY(0)}
  50%{transform:translateY(-2px)}}
@media (prefers-reduced-motion:reduce){.dshrm-anim{animation:none}}
.dshrm-htext{flex:1 1 180px;min-width:0}
.dshrm-title{margin:0;font-size:36px;line-height:1.25;letter-spacing:.1em;color:#fff;
  text-shadow:0 0 6px #00eaff,0 0 18px rgba(0,234,255,.6),2px 0 0 rgba(255,46,151,.55)}
.dshrm-sub{margin:2px 0 0;font-size:14px;letter-spacing:.06em;color:#7a72a8}

.dshrm-at{flex:none;font-size:12px;color:#5c5585;letter-spacing:.04em}
.dshrm-todotext{flex:1 1 auto;min-width:0}
.dshrm-src{flex:none;font-size:11px;color:#7a72a8;border:1px solid #2a1f4d;padding:0 4px;border-radius:2px}
.dshrm-recent{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 8px}
.dshrm-chip{background:transparent;border:1px dashed #2a1f4d;color:#9a90c8;font-family:inherit;
  font-size:12px;padding:2px 7px;cursor:pointer;border-radius:2px;max-width:46%;overflow:hidden;
  white-space:nowrap;text-overflow:ellipsis}
.dshrm-chip:hover{color:#00eaff;border-color:#00eaff}
.dshrm-refresh{flex:none;margin-left:6px;background:transparent;border:1px solid #2a1f4d;color:#8b7bc8;
  font-family:inherit;font-size:18px;line-height:1;padding:4px 8px;cursor:pointer;border-radius:2px}
.dshrm-refresh:hover{color:#00eaff;border-color:#00eaff;box-shadow:0 0 10px rgba(0,234,255,.35)}
.dshrm-refresh.on{color:#00eaff;animation:dshrm-spin .7s linear infinite}
@keyframes dshrm-spin{to{transform:rotate(360deg)}}
.dshrm-card.folded{padding-bottom:8px}
.dshrm-fold{margin-left:8px;flex:none;background:transparent;border:1px solid #2a1f4d;color:#8b7bc8;
  font-family:inherit;font-size:14px;line-height:1;padding:3px 7px;cursor:pointer;border-radius:2px}
.dshrm-fold:hover{color:#00eaff;border-color:#00eaff;box-shadow:0 0 10px rgba(0,234,255,.35)}
.dshrm-foldsum{margin-top:8px;font-size:14px;color:#9a90c8;line-height:1.5}
.dshrm-rv{display:flex;flex-direction:column;gap:9px}
.dshrm-rvrow{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dshrm-rvbig{font-size:32px;color:#ffc23a;text-shadow:0 0 12px rgba(255,194,58,.5);letter-spacing:.02em}
.dshrm-rvunit{font-size:13px;color:#7a72a8;letter-spacing:.06em}
.dshrm-rvbar{position:relative;height:8px;background:#161327;border:1px solid #2a1f4d;overflow:hidden}
.dshrm-rvbar i{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#00eaff,#8b5cff)}
.dshrm-rvbar.b2 i{background:linear-gradient(90deg,#b6ff3c,#00eaff)}
.dshrm-rvbar.b3 i{background:linear-gradient(90deg,#ff2e97,#ffc23a)}
.dshrm-kv{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;color:#b9b0e6;line-height:1.5}
.dshrm-kv b{color:#00eaff;font-weight:normal}
.dshrm-rvtag{display:inline-block;font-size:12px;padding:2px 7px;border:1px solid #2a1f4d;color:#b9b0e6;letter-spacing:.04em}
.dshrm-rvtag.m{border-color:#6b2b52;color:#ff7ab8}
.dshrm-rvtag.u{border-color:#2b4a6b;color:#7ab8ff}
.dshrm-rvtag.p{border-color:#3b6b2b;color:#b6ff7a}
.dshrm-rvtag.d{border-color:#4a4550;color:#8a8498}
.dshrm-bdrow{display:flex;align-items:center;gap:8px;font-size:14px;padding:5px 0;border-top:1px dashed #241c40}
.dshrm-bdrow:first-child{border-top:0}
.dshrm-dot{width:8px;height:8px;flex:none;border-radius:50%;background:#5c5585}
.dshrm-dot.on{background:#b6ff3c;box-shadow:0 0 8px #b6ff3c;animation:dshrm-pulse 1.6s infinite}
.dshrm-bdtitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6e0ff}
.dshrm-bdmeta{flex:none;font-size:12px;color:#7a72a8;letter-spacing:.05em}
.dshrm-bud{display:flex;align-items:center;gap:8px;margin-top:10px}
.dshrm-budinput{flex:1;min-width:0;background:#0b0916;border:1px solid #2a1f4d;color:#e6e0ff;
  font-family:inherit;font-size:14px;padding:6px 8px;outline:none}
.dshrm-budinput:focus{border-color:#00eaff;box-shadow:0 0 10px rgba(0,234,255,.25)}
.dshrm-budwarn{font-size:13px;line-height:1.6;color:#ff7ab8;margin-top:8px;border-left:2px solid #ff2e97;padding-left:8px}
@keyframes dshrm-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.dshrm-warn{margin:8px 0 2px;font-size:12px;line-height:1.55;color:#ffc23a;opacity:.9}
.dshrm-ideatext{flex:1;min-width:0;overflow-wrap:anywhere}
.dshrm-ideaact{display:flex;gap:4px;flex:none}
.dshrm-mini{font:inherit;font-size:11px;line-height:1;padding:4px 6px;border:1px solid #2a1f4d;background:#0b0916;color:#00eaff;border-radius:3px;cursor:pointer;letter-spacing:.5px}
.dshrm-mini:hover{border-color:#00eaff;box-shadow:0 0 8px rgba(0,234,255,.35)}
.dshrm-mini:disabled{opacity:.45;cursor:default;box-shadow:none}
.dshrm-mini.danger{color:#ff2e97;border-color:#3a1730}
.dshrm-mini.danger:hover{border-color:#ff2e97;box-shadow:0 0 8px rgba(255,46,151,.35)}
.dshrm-flag.done{color:#b6ff3c;border-color:#2d4520}
.dshrm-card{position:relative;background:rgba(14,11,26,.82);border:1px solid #2a1f4d;
  padding:14px 14px 12px;margin-bottom:12px;
  box-shadow:0 0 0 1px rgba(0,0,0,.6),0 0 18px rgba(139,92,255,.18),inset 0 0 24px rgba(139,92,255,.06)}
.dshrm-card::before,.dshrm-card::after{content:"";position:absolute;width:10px;height:10px;
  border:2px solid #00eaff;opacity:.9;pointer-events:none}
.dshrm-card::before{left:-2px;top:-2px;border-right:0;border-bottom:0}
.dshrm-card::after{right:-2px;bottom:-2px;border-left:0;border-top:0}

.dshrm-h{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.dshrm-h .bar{width:4px;height:14px;background:#00eaff;box-shadow:0 0 8px #00eaff;flex:0 0 auto}
.dshrm-h .name{font-size:14px;letter-spacing:.16em;color:#00eaff;text-shadow:0 0 8px rgba(0,234,255,.7)}
.dshrm-h .sub{margin-left:auto;font-size:14px;color:#7a72a8;letter-spacing:.08em}
.dshrm-h.amber .bar{background:#ffc23a;box-shadow:0 0 8px #ffc23a}
.dshrm-h.amber .name{color:#ffc23a;text-shadow:0 0 8px rgba(255,194,58,.7)}
.dshrm-h.magenta .bar{background:#ff2e97;box-shadow:0 0 8px #ff2e97}
.dshrm-h.magenta .name{color:#ff2e97;text-shadow:0 0 8px rgba(255,46,151,.7)}
.dshrm-h.violet .bar{background:#8b5cff;box-shadow:0 0 8px #8b5cff}
.dshrm-h.violet .name{color:#b79bff;text-shadow:0 0 8px rgba(139,92,255,.7)}

.dshrm-moodrow{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.dshrm-num{font-size:48px;line-height:1;color:#b6ff3c;letter-spacing:.02em;
  text-shadow:0 0 8px rgba(182,255,60,.9),0 0 24px rgba(182,255,60,.45);font-variant-numeric:tabular-nums}
.dshrm-num.low{color:#ffc23a;text-shadow:0 0 8px rgba(255,194,58,.9),0 0 24px rgba(255,194,58,.45)}
.dshrm-num.bad{color:#ff2e97;text-shadow:0 0 8px rgba(255,46,151,.9),0 0 24px rgba(255,46,151,.45)}
.dshrm-of{font-size:14px;color:#7a72a8;padding-bottom:6px}
.dshrm-tag{font-size:14px;padding:2px 8px;border:1px solid #ff2e97;color:#ff2e97;letter-spacing:.1em;
  box-shadow:0 0 10px rgba(255,46,151,.4) inset,0 0 8px rgba(255,46,151,.35)}
.dshrm-conf{margin-left:auto;font-size:14px;color:#7a72a8;padding-bottom:6px}

.dshrm-seg{display:flex;gap:3px;margin:12px 0 10px}
.dshrm-seg i{flex:1;height:10px;background:#170f2b;border:1px solid #2a1f4d}
.dshrm-seg i.on{background:#b6ff3c;border-color:#b6ff3c;box-shadow:0 0 8px rgba(182,255,60,.85)}
.dshrm-seg i.hot{background:#ffc23a;border-color:#ffc23a;box-shadow:0 0 8px rgba(255,194,58,.85)}

.dshrm-quote{border-left:2px solid #8b5cff;padding:6px 0 6px 10px;color:#cfc8ff;font-size:14px;
  background:linear-gradient(90deg,rgba(139,92,255,.14),transparent 70%)}

.dshrm-dims{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.dshrm-dimrow{display:flex;align-items:center;gap:8px;font-size:14px}
.dshrm-dimrow .k{width:44px;color:#7a72a8;flex:0 0 auto}
.dshrm-dimrow .track{flex:1;height:8px;background:#170f2b;border:1px solid #241a44;position:relative}
.dshrm-dimrow .fill{position:absolute;left:0;top:0;bottom:0;background:#00eaff;box-shadow:0 0 8px rgba(0,234,255,.8)}
.dshrm-dimrow .v{width:20px;text-align:right;flex:0 0 auto;font-variant-numeric:tabular-nums}

/* 悬停说明：鼠标停上去才出现的解释，不占版面 */
.dshrm-tip{position:relative}
.dshrm-tip:hover::after{content:attr(data-tip);position:absolute;left:0;bottom:calc(100% + 8px);
  width:min(330px,84vw);z-index:80;background:#0b0916;border:1px solid #00eaff;color:#cfc8ff;
  font-size:13px;line-height:1.6;padding:9px 11px;white-space:pre-line;letter-spacing:0;
  box-shadow:0 0 16px rgba(0,234,255,.35),inset 0 0 20px rgba(0,234,255,.06);pointer-events:none}
.dshrm-hint{margin-top:8px;font-size:12px;color:#5c5585;letter-spacing:.05em}

.dshrm-log{margin-top:12px;border-top:1px dashed #2a1f4d;padding-top:8px;display:flex;flex-direction:column;gap:4px}
.dshrm-log .row{display:flex;gap:8px;font-size:13px;color:#7a72a8;overflow:hidden}
.dshrm-log .row time{flex:0 0 auto;opacity:.8}
.dshrm-log .row b{flex:0 0 auto;font-weight:400;color:#b6ff3c}
.dshrm-log .row b.down{color:#ff2e97}
.dshrm-log .row span{color:#9d95c9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dshrm-meal{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dshrm-meal .big{font-size:36px;color:#ffc23a;text-shadow:0 0 10px rgba(255,194,58,.8)}
.dshrm-meal .unit{font-size:14px;color:#7a72a8}
.dshrm-week{display:flex;align-items:flex-end;gap:6px;margin-top:14px;height:66px}
.dshrm-day{flex:1 1 0;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
.dshrm-day .b{width:100%;background:linear-gradient(180deg,#ffc23a,#ff2e97);box-shadow:0 0 8px rgba(255,46,151,.45);
  min-height:2px;border-radius:0}
.dshrm-day .d{font-size:12px;color:#7a72a8;letter-spacing:.02em}
.dshrm-proj{margin-top:14px;border-top:1px dashed #2a1f4d;padding-top:10px;display:flex;flex-direction:column;gap:6px}
.dshrm-proj .row{display:flex;align-items:baseline;gap:8px;font-size:14px}
.dshrm-proj .nm{flex:1 1 auto;color:#b9b1e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshrm-proj .vv{flex:0 0 auto;color:#00eaff;text-shadow:0 0 6px rgba(0,234,255,.5)}
.dshrm-note{color:#b9b1e6;font-size:14px;margin:8px 0 0}
.dshrm-list{display:flex;flex-direction:column;gap:6px}
.dshrm-list .item{display:flex;gap:8px;font-size:14px}
.dshrm-list .n{color:#ff2e97;flex:0 0 auto;text-shadow:0 0 6px rgba(255,46,151,.6)}
.dshrm-foot{margin-top:16px;text-align:center;font-size:14px;color:#5d5680;letter-spacing:.08em}
.dshrm-titlewrap{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshrm-pen{background:none;border:1px solid #2a1f4d;color:#7a72a8;font-family:inherit;font-size:14px;
  padding:1px 7px;cursor:pointer;line-height:1.8;letter-spacing:.05em}
.dshrm-pen:hover{color:#00eaff;border-color:#00eaff;text-shadow:0 0 8px rgba(0,234,255,.7)}
.dshrm-nameinput{background:#0d0a18;border:1px solid #00eaff;color:#fff;font-family:inherit;
  font-size:30px;padding:2px 8px;width:min(300px,60vw);outline:none;letter-spacing:.06em}
.dshrm-nameinput.small{font-size:20px;width:min(140px,30vw)}
.dshrm-search{display:flex;gap:8px;align-items:center}
.dshrm-search .dshrm-nameinput{flex:1 1 auto;width:auto;min-width:0;font-size:20px}
.dshrm-hit{border-left:2px solid #2a1f4d;padding:6px 0 6px 10px;margin-top:10px}
.dshrm-hit:hover{border-left-color:#ff2e97}
.dshrm-hithead{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.dshrm-hittitle{color:#dfe6ff;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:62%}
.dshrm-hitdate{color:#5c5585;font-size:12px;margin-left:auto;flex:none}
.dshrm-hitsnip{color:#9c94c8;font-size:13px;line-height:1.65;margin-top:4px}
.dshrm-lab{font-size:14px;color:#7a72a8;letter-spacing:.08em}
.dshrm-hint{font-size:13px;color:#ffc23a;margin:8px 0 0;letter-spacing:.04em}
.dshrm-hint.tip{font-size:12px;color:#5c5585;margin-top:8px;letter-spacing:.05em}
.dshrm-item{display:flex;gap:8px;font-size:14px;color:#cfc8ff;margin:7px 0;line-height:1.5}
.dshrm-item .n{color:#00eaff;flex:0 0 auto}
.dshrm-item.done{opacity:.45;text-decoration:line-through}
.dshrm-box{flex:0 0 auto;width:17px;height:17px;margin-top:2px;border:1px solid #2a1f4d;background:transparent;color:#b6ff3c;font-size:13px;line-height:1;padding:0;cursor:pointer;border-radius:2px}
.dshrm-box.on{border-color:#b6ff3c;box-shadow:0 0 8px rgba(182,255,60,.35)}
.dshrm-box:hover{border-color:#00eaff}
.dshrm-box:disabled{cursor:not-allowed;opacity:.4}
.dshrm-spark{width:100%;height:42px;margin:10px 0 4px;display:block}
.dshrm-pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:13px;line-height:1.65;color:#cfc8ff;background:#0b0916;border:1px solid #2a1f4d;padding:10px 12px;max-height:300px;overflow:auto;margin:8px 0 0}
.dshrm-empty{font-size:14px;color:#7a72a8;margin:8px 0 0}
.dshrm-flag{margin-left:auto;font-size:12px;color:#00eaff;border:1px solid #16455a;padding:0 5px;letter-spacing:.5px;flex:none}
`;

    function clock(ts) {
      try {
        const d = new Date(ts);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      } catch (e) { return '--:--'; }
    }

    function useMood() {
      const [mood, setMood] = useState(null);
      const [err, setErr] = useState('');
      const [at, setAt] = useState(0);
      useEffect(() => {
        let alive = true;
        let fails = 0;
        const pull = () => {
          fetch('/dsh-room/state', { credentials: 'same-origin', cache: 'no-store' })
            .then((r) => {
              if (!r.ok) throw new Error('HTTP ' + r.status);
              return r.json();
            })
            .then((j) => {
              if (!alive) return;
              if (j && j.ok) { fails = 0; setErr(''); setMood(j); setAt(Date.now()); }
            })
            .catch((e) => {
              if (!alive) return;
              fails += 1;
              // 连续两次失败才吭声：单次抖动很常见，不值得报警
              if (fails >= 2) setErr(String((e && e.message) || '读不到状态'));
            });
        };
        pull();
        refreshSubs.add(pull);
        const t = setInterval(pull, 15000);
        return () => { alive = false; clearInterval(t); refreshSubs.delete(pull); };
      }, []);
      return [mood, err, at];
    }

    const DIM_COLOR = {
      happy: '#b6ff3c', calm: '#8b5cff', sweet: '#ff2e97',
      heartache: '#ff2e97', worry: '#ffc23a', sad: '#8b5cff',
    };

    // 悬停说明：这根情绪被什么带动、高了/低了各会怎样。
    const DIM_META = {
      happy: {
        why: '事情办成、被你夸、你自己想通了',
        up: '我更愿意多说一句，敢损你两句',
        down: '我话变短，只敢给结论，不敢多嘴',
      },
      calm: {
        why: '活推进得顺、没留尾巴、节奏稳',
        up: '适合推硬活，我直接给下一步动作',
        down: '我心里没底，会给你更多游移的选项',
      },
      sweet: {
        why: '你信任我、跟我说私事、说话客气',
        up: '说话更亲近，可以开点小玩笑',
        down: '公事公办，不越界也不撒娇',
      },
      heartache: {
        why: '你累、熬夜、吃亏、事情砸了',
        up: '我先给一句具体关切，再谈正事',
        down: '我按平常节奏办事，不预设你需要安慰',
      },
      worry: {
        why: '有风险、你说赶时间、我看你反复改同一处',
        up: '我会多提醒风险和代价，给兜底方案',
        down: '我少啰嗦，放手让你试',
      },
      sad: {
        why: '白忙一场、报错、被怼、事确实糟了',
        up: '我不装没事，先承认这事不轻',
        down: '我没被这件事压住，能照常干活',
      },
    };

    const MOOD_TIP = '总分 = 70 的底 + 每轮判定的涨跌（判定值只吃 1/3）'
      + '\n你不跟我说话时，12 小时往 70 折半回落'
      + '\n≥80 欢喜 / 62–79 开心 / 42–61 一般 / 25–41 沉 / <25 低'
      + '\n它不只是数字：它会写进我的系统提示，真的改我说话的语气';

    const CONF_TIP = '把握度 = 判定模型对这一轮判断的自信程度'
      + '\n低于 60 的时候别太当真，很可能是我读错了你';

    // 心情曲线：把手上的心情点连成一条线，70 那条虚线是基线
    function sparkline(hist) {
      const pts = (Array.isArray(hist) ? hist : []).filter((p) => p && Number.isFinite(Number(p.mood)));
      if (pts.length < 2) return null;
      const t0 = Number(pts[0].at);
      const t1 = Number(pts[pts.length - 1].at);
      const span = Math.max(1, t1 - t0);
      const W = 300, H = 42, pad = 3;
      const x = (p) => pad + ((Number(p.at) - t0) / span) * (W - pad * 2);
      const y = (v) => pad + (1 - v / 100) * (H - pad * 2);
      const line = pts.map((p) => x(p).toFixed(1) + ',' + y(Number(p.mood)).toFixed(1)).join(' ');
      const last = pts[pts.length - 1];
      const col = Number(last.mood) < 45 ? '#ff2e97' : (Number(last.mood) < 62 ? '#ffc23a' : '#00eaff');
      return h('svg', { className: 'dshrm-spark', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' },
        h('line', { x1: 0, y1: y(70).toFixed(1), x2: W, y2: y(70).toFixed(1), stroke: '#2a1f4d', strokeWidth: 1, strokeDasharray: '3 4' }),
        h('polyline', { points: line, fill: 'none', stroke: col, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }),
        h('circle', { cx: x(last).toFixed(1), cy: y(Number(last.mood)).toFixed(1), r: 3, fill: col }));
    }

    function dayLine(days) {
      const t = days && days.today;
      const y0 = days && days.yesterday;
      if (!t && !y0) return '今天还没记到心情点，聊几轮就有了。';
      const out = [];
      if (t) out.push('今天均值 ' + t.avg + '（最低 ' + t.min + '，最高 ' + t.max + '，记了 ' + t.n + ' 次）');
      if (y0) out.push('昨天均值 ' + y0.avg + '（' + y0.n + ' 次）');
      if (t && y0) out.push(t.avg >= y0.avg ? '比昨天高 ' + (t.avg - y0.avg) : '比昨天低 ' + (y0.avg - t.avg));
      return out.join(' · ');
    }

    function MoodCard(props) {
      const m = props.mood;
      if (!m) {
        return h('div', { className: 'dshrm-card' },
          h('div', { className: 'dshrm-h' },
            h('span', { className: 'bar' }),
            h('span', { className: 'name' }, '心情'),
            h('span', { className: 'sub' }, '还没有判定')),
          h('div', { className: 'dshrm-quote' }, '聊过一轮之后，这里会长出我今天的心情。'));
      }
      const mood = typeof m.mood === 'number' ? m.mood : 70;
      const cls = mood < 45 ? 'dshrm-num bad' : (mood < 62 ? 'dshrm-num low' : 'dshrm-num');
      const segs = [];
      const lit = Math.round((mood / 100) * 20);
      for (let i = 0; i < 20; i++) {
        segs.push(h('i', { key: i, className: i < lit ? (mood < 45 ? 'hot' : 'on') : '' }));
      }
      const dims = Array.isArray(m.dims) ? m.dims : [];
      const maxDim = dims.reduce((a, d) => Math.max(a, Math.abs(d.value || 0)), 10);
      return h('div', { className: 'dshrm-card' },
        h('div', { className: 'dshrm-h' },
          h('span', { className: 'bar' }),
          h('span', { className: 'name' }, '心情'),
          h('span', { className: 'sub' }, '本机判定 · 不联网')),
        h('div', { className: 'dshrm-moodrow' },
          h('span', { className: cls + ' dshrm-tip', 'data-tip': MOOD_TIP }, String(mood)),
          h('span', { className: 'dshrm-of' }, '/100'),
          m.label ? h('span', { className: 'dshrm-tag' }, m.label) : null,
          typeof m.confidence === 'number'
            ? h('span', { className: 'dshrm-conf dshrm-tip', 'data-tip': CONF_TIP }, '把握 ' + m.confidence + '%') : null),
        h('div', { className: 'dshrm-seg' }, segs),
        sparkline(props.hist),
        h('div', { className: 'dshrm-hint tip' }, dayLine(props.days)),
        m.reason ? h('div', { className: 'dshrm-quote' }, m.reason) : null,
        dims.length ? h('div', { className: 'dshrm-dims' },
          dims.map((d, i) => {
            const meta = DIM_META[d.key] || {};
            const tip = d.label + '（现在是 ' + (d.value || 0) + '）'
              + (meta.why ? '\n被什么带动：' + meta.why : '')
              + (meta.up ? '\n偏高时：' + meta.up : '')
              + (meta.down ? '\n偏低时：' + meta.down : '');
            return h('div', { className: 'dshrm-dimrow dshrm-tip', key: i, 'data-tip': tip },
              h('span', { className: 'k' }, d.label),
              h('span', { className: 'track' },
                h('span', {
                  className: 'fill',
                  style: {
                    width: Math.round((Math.abs(d.value || 0) / maxDim) * 100) + '%',
                    background: DIM_COLOR[d.key] || '#00eaff',
                    boxShadow: '0 0 8px ' + (DIM_COLOR[d.key] || '#00eaff'),
                  },
                })),
              h('span', { className: 'v' }, String(d.value || 0))
            );
          })) : null,
        dims.length ? h('div', { className: 'dshrm-hint tip' }, '停在数字或某一条情绪上，会告诉你是被什么带动的') : null,
        (m.timeline && m.timeline.length)
          ? h('div', { className: 'dshrm-log' },
              m.timeline.slice(0, 6).map((t, i) => h('div', { className: 'row', key: i },
                h('time', null, clock(t.at)),
                h('b', { className: t.delta > 0 ? '' : (t.delta < 0 ? 'down' : '') },
                  t.delta > 0 ? '+' + t.delta : String(t.delta)),
                h('span', null, t.reason || '（没写原因）')
              )))
          : null
      );
    }

    let PANEL_NAME = '海底小屋';
    let AGENT_NAME = '大肥鱼';
    let REREGISTER_SIDEBAR = null;

    const BUCKET_LABEL = {
      memory: '长期记忆',
      user: '你的档案',
      project: '项目记忆',
      'todo-work': '工作待办',
      'todo-project': '项目待办',
      drop: '不入库',
    };

    // 折叠状态：每张卡一个开关，记在 localStorage 里，下次打开还是收着的
    const FOLD_KEY = 'dshroom.fold.v1';
    let FOLD = (function () {
      try {
        const j = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}');
        return j && typeof j === 'object' ? j : {};
      } catch (e) { return {}; }
    })();
    const foldSubs = new Set();
    // 轻刷新总线：header 的 ⟳ 按钮点一下，所有 useMood 的拉取函数立刻跑一遍。
    const RECENT_KEY = 'dshroom.recentq.v1';
    function readRecentQ() {
      try {
        const raw = localStorage.getItem(RECENT_KEY);
        const a = raw ? JSON.parse(raw) : [];
        return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 5) : [];
      } catch (e) { return []; }
    }
    function pushRecentQ(q) {
      const t = String(q || '').trim();
      if (!t) return;
      try {
        const a = readRecentQ().filter((x) => x !== t);
        a.unshift(t);
        localStorage.setItem(RECENT_KEY, JSON.stringify(a.slice(0, 5)));
      } catch (e) { }
    }
    const refreshSubs = new Set();
    function bumpRefresh() {
      refreshSubs.forEach((fn) => { try { fn(); } catch (e) { } });
    }
    function setFold(k, v) {
      FOLD = Object.assign({}, FOLD, { [k]: v });
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(FOLD)); } catch (e) { /* 忽略 */ }
      foldSubs.forEach((f) => f());
    }
    function useFold(k) {
      const pair = useState(0);
      const bump = pair[1];
      useEffect(() => {
        const f = () => bump((x) => x + 1);
        foldSubs.add(f);
        return () => { foldSubs.delete(f); };
      }, []);
      return [!!FOLD[k], () => setFold(k, !FOLD[k])];
    }

    function ago(ms) {
      const v = Number(ms);
      if (!isFinite(v) || v < 0) return '没动静';
      if (v < 60000) return '刚刚';
      if (v < 3600000) return Math.round(v / 60000) + ' 分钟前';
      if (v < 86400000) return Math.round(v / 3600000) + ' 小时前';
      return Math.round(v / 86400000) + ' 天前';
    }
    function stripModel(m) {
      return String(m || '').replace(/^deepseek[-/]?/, '').replace(/^v/, '');
    }

    // 金额显示：≥100 取整、≥10 一位小数、其余两位。放在工厂作用域，reportPanel 也要用
    function yuan(v) {
      const n = Number(v) || 0;
      if (n >= 100) return '¥' + n.toFixed(0);
      if (n >= 10) return '¥' + n.toFixed(1);
      return '¥' + n.toFixed(2);
    }

    function Card(props) {
      const key = props.id || props.title;
      const f = useFold(key);
      const folded = f[0];
      const toggle = f[1];
      return h('div', { className: 'dshrm-card' + (folded ? ' folded' : '') },
        h('div', { className: 'dshrm-h' + (props.tone ? ' ' + props.tone : '') },
          h('span', { className: 'bar' }),
          h('span', { className: 'name' }, props.title),
          props.sub ? h('span', { className: 'sub' }, props.sub) : null,
          h('button', {
            className: 'dshrm-fold',
            title: folded ? '展开这张卡' : '收起这张卡，只留摘要',
            onClick: toggle,
          }, folded ? '＋' : '－')),
        folded
          ? (props.summary ? h('div', { className: 'dshrm-foldsum' }, props.summary) : null)
          : props.children);
    }

    // 日报的可视化视图：一块一块的条形 + 标签，不写字
    function reportPanel(v, agent) {
      if (!v) {
        return h('p', { className: 'dshrm-empty' }, '还没有今天的日报。点「现在生成」，或者等 21:30 自动写。');
      }
      const m = v.money || {};
      const mo = v.mood || {};
      const td = v.todos || {};
      const cachePct = Math.round((m.cacheRate || 0) * 100);
      const bar = (pct, cls) => h('div', { className: 'dshrm-rvbar' + (cls ? ' ' + cls : '') },
        h('i', { style: { width: Math.max(2, Math.min(100, pct || 0)) + '%' } }));
      const moodPct = Math.max(0, Math.min(100, mo.now || 0));
      const todoAll = (td.count || 0) + (td.done || 0);
      const donePct = todoAll ? ((td.done || 0) / todoAll) * 100 : 0;
      const tagCls = (b) => (b === 'memory' ? 'm' : b === 'user' ? 'u' : b === 'project' ? 'p' : b === 'drop' ? 'd' : '');
      const tagName = (b) => (b === 'memory' ? '长期' : b === 'user' ? '你' : b === 'project' ? '项目' : b === 'todo-work' ? '工作待办' : b === 'todo-project' ? '项目待办' : b === 'drop' ? '不入库' : b);
      return h('div', { className: 'dshrm-rv' },
        h('div', { className: 'dshrm-rvrow' },
          h('span', { className: 'dshrm-rvbig' }, yuan(m.today)),
          h('span', { className: 'dshrm-rvunit' }, '今天 · ' + (v.tokensToday ? Math.round(v.tokensToday / 10000) + ' 万 tokens' : '—'))),
        bar(cachePct, cachePct >= 90 ? 'b2' : cachePct >= 60 ? 'b1' : 'b3'),
        h('div', { className: 'dshrm-kv' },
          h('span', null, '缓存命中 ', h('b', null, cachePct + '%')),
          h('span', null, '本月 ', h('b', null, yuan(m.month))),
          h('span', null, '预计月末 ', h('b', null, yuan(m.projected)))),
        h('div', { style: { marginTop: '4px' } },
          h('div', { className: 'dshrm-kv', style: { marginBottom: '4px' } },
            h('span', null, '心情 ', h('b', null, (mo.now || '—') + '/100 ' + (mo.label || '')),
              mo.today ? (' · 今天均值 ' + Math.round(mo.today.avg) + '（' + Math.round(mo.today.min) + '–' + Math.round(mo.today.max) + '），' + mo.today.n + ' 次') : '')),
          bar(moodPct, moodPct >= 62 ? 'b2' : moodPct >= 42 ? 'b1' : 'b3')),
        mo.top && mo.top.length
          ? h('div', { className: 'dshrm-kv' }, mo.top.map((x, i) => h('span', { key: i }, x.label + ' ', h('b', null, x.value))))
          : null,
        h('div', { style: { marginTop: '4px' } },
          h('div', { className: 'dshrm-kv', style: { marginBottom: '4px' } },
            h('span', null, '待办 ', h('b', null, (td.count || 0) + ' 条没办'), ' / 共 ' + todoAll + ' 条')),
          bar(donePct, 'b2')),
        m.byModel && m.byModel.length
          ? h('div', { className: 'dshrm-kv' }, m.byModel.map((x, i) => h('span', { key: i },
              h('span', { className: 'dshrm-rvtag' + (x.local ? ' p' : '') }, x.name + ' ' + yuan(x.cost)))))
          : null,
        td.items && td.items.length
          ? h('div', null, td.items.slice(0, 4).map((x, i) => h('div', { className: 'dshrm-item', key: i },
              h('span', { className: 'n' }, x.done ? '✓' : String(i + 1).padStart(2, '0')),
              h('span', null, x.text))))
          : null,
        v.ideas && v.ideas.length
          ? h('div', { className: 'dshrm-kv' }, v.ideas.map((x, i) => h('span', { className: 'dshrm-rvtag', key: i }, x.title)))
          : null,
        v.dream && v.dream.length
          ? h('div', { className: 'dshrm-kv' }, v.dream.map((x, i) => h('span', { className: 'dshrm-rvtag ' + tagCls(x.bucket), key: i },
              tagName(x.bucket) + '｜' + String(x.content || '').slice(0, 14))))
          : null,
        h('p', { className: 'dshrm-note' }, '纯本机算的，不调模型不花钱。文字版在「看文字版」里。'));
    }

    function Page() {
      const [st, loadErr, at] = useMood();
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState('');
      const [uDraft, setUDraft] = useState('');
      const [aDraft, setADraft] = useState('');
      const [hint, setHint] = useState('');
      const [q, setQ] = useState('');
      const [recentQ, setRecentQ] = useState(readRecentQ());
      const [hits, setHits] = useState(null);
      const [searching, setSearching] = useState(false);
      const [qErr, setQErr] = useState('');
      const [dreaming, setDreaming] = useState(false);
      const [dreamRes, setDreamRes] = useState(null);
      const [dreamErr, setDreamErr] = useState('');
      const [todoOv, setTodoOv] = useState(null);
      const [todoBusy, setTodoBusy] = useState('');
      const [reporting, setReporting] = useState(false);
      const [reportRes, setReportRes] = useState(null);
      const [reportErr, setReportErr] = useState('');
      const [showText, setShowText] = useState(false);
      const [refreshing, setRefreshing] = useState(false);
      function refresh() {
        setRefreshing(true);
        bumpRefresh();
        setTimeout(() => setRefreshing(false), 700);
      }
      const [view, setView] = useState(null);
      const [ideaDraft, setIdeaDraft] = useState('');
      const [ideaBusy, setIdeaBusy] = useState(false);
      const [ideaMsg, setIdeaMsg] = useState('');
      const [ideaOv, setIdeaOv] = useState(null);
      const [archOv, setArchOv] = useState(null);
      const [budDraft, setBudDraft] = useState('');
      const [budBusy, setBudBusy] = useState(false);
      const name = (st && st.panelName) || PANEL_NAME;
      const user = (st && st.userName) || '你';
      const agent = (st && st.agentName) || AGENT_NAME;
      const act = (st && st.activity) || null;
      const tok = (st && st.tokens) || null;
      const todos = (st && st.todos) || null;
      const notes = Array.isArray(st && st.notes) ? st.notes : null;
      const ideas = Array.isArray(st && st.ideas) ? st.ideas : null;
      const archList = archOv || (st && Array.isArray(st.archive) ? st.archive : null);
      const bud = (st && st.budget) || null;
      const budVal = bud && Number(bud.amount) > 0 ? bud : null;

      function recall(arg) {
        const s = String(arg == null ? q : arg || '').trim();
        if (!s) { setHits(null); setQErr(''); return; }
        setSearching(true);
        setQErr('');
        fetch('/dsh-room/recall?q=' + encodeURIComponent(s) + '&n=8', { credentials: 'same-origin', cache: 'no-store' })
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then((j) => {
            setHits(Array.isArray(j && j.items) ? j.items : []);
            pushRecentQ(s);
            setRecentQ(readRecentQ());
          })
          .catch((e) => { setQErr(String((e && e.message) || e)); setHits(null); })
          .then(() => setSearching(false), () => setSearching(false));
      }

      function dream(now) {
        if (dreaming) return;
        setDreaming(true);
        setDreamErr('');
        if (now) setDreamRes(null);
        fetch('/dsh-room/dream', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then((j) => {
            if (j && j.ok) setDreamRes(j);
            else setDreamErr((j && j.error) || '没做成');
          })
          .catch((e) => setDreamErr(String((e && e.message) || e)))
          .then(() => setDreaming(false), () => setDreaming(false));
      }

      // 待办就地打勾：只对「有 file/line 且 editable」的条目开按钮（dtodo 的条目只读）
      const shownTodos = todoOv || todos;

      const [editIdeaSeq, setEditIdeaSeq] = useState(0);
      const [editTodoKey, setEditTodoKey] = useState('');
      function saveIdeaEdit(seq, text) {
        const t = String(text || '').trim();
        if (!t) { setIdeaMsg('内容空着，没存'); return; }
        fetch('/dsh-room/idea/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seq: seq, text: t }) })
          .then((r) => r.json())
          .then((j) => {
            if (j && j.ok) { setIdeaOv(j.ideas || []); setIdeaMsg('A' + j.seq + ' 改好了'); setEditIdeaSeq(0); }
            else { setIdeaMsg('没改成：' + ((j && j.error) || '服务端拒了')); }
          })
          .catch(() => setIdeaMsg('没改成：网络断了'));
      }
      function saveTodoEdit(it, text) {
        const t = String(text || '').trim();
        if (!t) { setTodoOv(null); setEditTodoKey(''); return; }
        fetch('/dsh-room/todo/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: it.file, line: it.line, text: t }) })
          .then((r) => r.json())
          .then((j) => {
            if (j && j.ok) { setTodoOv(j.todos || null); setEditTodoKey(''); }
          })
          .catch(() => {});
      }
      function toggleTodo(it) {
        if (!it || !it.file || todoBusy) return;
        if (!it.editable && it.kind !== 'dtodo') return;
        const key = it.file + ':' + it.line;
        setTodoBusy(key);
        fetch('/dsh-room/todo', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: it.file, line: it.line, done: !it.done, kind: it.kind || '' }),
        }).then((r) => (r.ok ? r.json() : null)).then((j) => {
          if (j && j.ok) setTodoOv(j.todos);
        }).catch(() => {}).then(() => setTodoBusy(''), () => setTodoBusy(''));
      }

      function makeReport() {
        if (reporting) return;
        setReporting(true);
        setReportErr('');
        fetch('/dsh-room/report', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((j) => { if (j && j.ok) setReportRes(j); else setReportErr((j && j.error) || '没写成'); })
          .catch((e) => setReportErr(String((e && e.message) || e)))
          .then(() => setReporting(false), () => setReporting(false));
      }

      // 载入今天的日报视图（结构化，用来画图表；文字版要另点）
      useEffect(() => {
        let alive = true;
        const pullView = () => {
          fetch('/dsh-room/report', { credentials: 'same-origin', cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => { if (alive && j && j.view) setView(j.view); })
            .catch(() => {});
        };
        pullView();
        refreshSubs.add(pullView);
        return () => { alive = false; refreshSubs.delete(pullView); };
      }, []);

      function saveIdea() {
        const t = String(ideaDraft || '').trim();
        if (!t || ideaBusy) return;
        setIdeaBusy(true);
        setIdeaMsg('');
        fetch('/dsh-room/idea', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: t }),
        })
          .then((r) => r.json().then((j) => ({ code: r.status, j: j })))
          .then((x) => {
            if (x.j && x.j.ok) {
              setIdeaMsg('记下了 ' + (x.j.seq || '') + '，已写进 30-想法池.md');
              setIdeaDraft('');
              if (Array.isArray(x.j.ideas)) setIdeaOv(x.j.ideas);
            } else setIdeaMsg((x.j && x.j.error) || '没存上');
          })
          .catch((e) => setIdeaMsg('没存上：' + String((e && e.message) || e)))
          .then(() => setIdeaBusy(false), () => setIdeaBusy(false));
      }

      function decideIdea(d, action) {
        if (!d || !d.seq || ideaBusy) return;
        setIdeaBusy(true);
        setIdeaMsg('');
        fetch('/dsh-room/idea/decide', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seq: d.seq, action: action }),
        })
          .then((r) => r.json().then((j) => ({ code: r.status, j: j })))
          .then((x) => {
            if (x.j && x.j.ok) {
              const said = action === 'keep' ? '已标记住，去记忆 Tab 一键批准就进长期记忆'
                : action === 'todo' ? '已转成待办，写进 40-待办.md'
                : '标成舍弃，不再占地方';
              setIdeaMsg('A' + d.seq + ' ' + said);
              if (Array.isArray(x.j.ideas)) setIdeaOv(x.j.ideas);
            } else setIdeaMsg((x.j && x.j.error) || '没改上');
          })
          .catch((e) => setIdeaMsg('没改上：' + String((e && e.message) || e)))
          .then(() => setIdeaBusy(false), () => setIdeaBusy(false));
      }

      function restoreIdeaItem(a) {
        if (!a || !a.seq || ideaBusy) return;
        setIdeaBusy(true);
        setIdeaMsg('');
        fetch('/dsh-room/idea/restore', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seq: a.seq }),
        })
          .then((r) => r.json().then((j) => ({ code: r.status, j: j })))
          .then((x) => {
            if (x.j && x.j.ok) {
              setIdeaMsg('A' + a.seq + ' 放回随录了，可以重新决定');
              if (Array.isArray(x.j.ideas)) setIdeaOv(x.j.ideas);
              if (Array.isArray(x.j.archive)) setArchOv(x.j.archive);
            } else setIdeaMsg((x.j && x.j.error) || '没恢复上');
          })
          .catch((e) => setIdeaMsg('没恢复上：' + String((e && e.message) || e)))
          .then(() => setIdeaBusy(false), () => setIdeaBusy(false));
      }

      function saveBudget() {
        if (budBusy) return;
        const n = Number(String(budDraft || '').replace(/[^0-9.]/g, ''));
        if (!isFinite(n) || n < 0) { setBudDraft(''); return; }
        setBudBusy(true);
        fetch('/dsh-room/budget', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amount: n }),
        })
          .then((r) => r.json())
          .then((j) => { if (j && j.ok) { setBudDraft(''); setIdeaMsg('月上限设成 ¥' + (j.budget && j.budget.amount)); } })
          .catch(() => {})
          .then(() => setBudBusy(false), () => setBudBusy(false));
      }

      function save() {
        const v = String(draft || '').trim().slice(0, 20);
        const u = String(uDraft || '').trim().slice(0, 12);
        const a = String(aDraft || '').trim().slice(0, 12);
        if (!v && !u && !a) { setEditing(false); return; }
        // 先发请求、成功了才收起输入框 —— 失败时别把用户刚打的字弄丢
        setHint('存着…');
        fetch('/dsh-room/name', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: v || name, userName: u || user, agentName: a || agent }),
        }).then((r) => (r.ok ? r.json() : null)).then((j) => {
          if (j && j.ok) {
            setEditing(false);
            PANEL_NAME = j.name;
            if (j.agentName) AGENT_NAME = j.agentName;
            let said = '存好了。';
            if (typeof REREGISTER_SIDEBAR === 'function') {
              try { REREGISTER_SIDEBAR(); said = '存好了，侧栏那一行也换了。'; }
              catch (e) { said = '存好了。侧栏那一行要按 F5 才换。'; }
            } else said = '存好了。侧栏那一行要按 F5 才换。';
            setHint(said);
          } else setHint('没存上（服务端拒了），字还在，可以再点一次。');
        }).catch(() => setHint('没存上（网络），字还在，可以再点一次。'));
      }

      const title = editing
        ? h('div', { className: 'dshrm-titlewrap' },
            h('label', { className: 'dshrm-lab' }, '面板名'),
            h('input', {
              className: 'dshrm-nameinput', value: draft, autoFocus: true,
              maxLength: 20,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') setEditing(false);
              },
            }),
            h('label', { className: 'dshrm-lab' }, '称呼你'),
            h('input', {
              className: 'dshrm-nameinput small', value: uDraft, maxLength: 12,
              onChange: (e) => setUDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') setEditing(false);
              },
            }),
            h('label', { className: 'dshrm-lab' }, '叫我'),
            h('input', {
              className: 'dshrm-nameinput small', value: aDraft, maxLength: 12,
              onChange: (e) => setADraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') setEditing(false);
              },
            }),
            h('p', { className: 'dshrm-warn' }, '⚠ 改名只影响这一页怎么写，不会改记忆与人格文件。名字改多了，旧记忆里的称呼就会跟新名字对不上，翻记录时容易错乱——建议第一次就定下来，之后就少动。'),
            h('button', { className: 'dshrm-pen', onClick: save }, '存'),
            h('button', { className: 'dshrm-pen', onClick: () => setEditing(false) }, '取消'))
        : h('span', { className: 'dshrm-titlewrap' },
            h('h1', { className: 'dshrm-title' }, name),
            h('button', {
              className: 'dshrm-pen',
              onClick: () => { setDraft(name); setUDraft(user); setADraft(agent); setEditing(true); setHint(''); },
              title: '改这一页的名字、怎么称呼你、以及我叫什么',
            }, '改名'));

      const bowls = tok && Number.isFinite(tok.bowls) ? tok.bowls : 0;
      const tokTxt = !tok ? '0'
        : tok.today >= 1e8 ? (tok.today / 1e8).toFixed(2) + ' 亿'
        : (tok.today / 1e4).toFixed(0) + ' 万';
      const week = Array.isArray(tok && tok.byDay) ? tok.byDay : [];
      const projs = Array.isArray(tok && tok.byProject) ? tok.byProject : [];
      const maxDayCost = week.reduce((m, d) => ((d.cost || 0) > m ? (d.cost || 0) : m), 0) || 1;
      const money = (tok && tok.money) || null;

      return h('div', { className: 'dshrm-page' },
        h('style', null, CSS),
        h('div', { className: 'dshrm-head' },
          (function () {
            const k = ANIM_KEY[pickKey(st)] || 'idle';
            const url = ANIM[k];
            if (!url || url.indexOf('base64,__') >= 0) {
              return h('img', { className: 'dshrm-whale', src: pickChar(st), alt: '', draggable: false });
            }
            return h('div', { className: 'dshrm-anim' + charMotion(st), title: '两帧微动', style: { backgroundImage: 'url("' + url + '")' } });
          })(),
          h('div', { className: 'dshrm-htext' },
            title,
          ),
          at ? h('span', { className: 'dshrm-at', title: '这份数据最后一次读到的时间' },
            '更新 ' + new Date(at).toTimeString().slice(0, 8)) : null,
          h('button', {
            className: 'dshrm-refresh' + (refreshing ? ' on' : ''),
            title: '轻刷新：立刻重读一遍状态（心情、饭量、待办、随录），不必整页刷新',
            onClick: refresh,
          }, '\u27F3'),
          st && st.label ? h('span', { className: 'dshrm-tag' }, st.label) : null
        ),
        hint ? h('p', { className: 'dshrm-hint' }, hint) : null,

        h(MoodCard, { mood: st, hist: st && st.moodHist, days: st && st.moodDays }),

        h(Card, { title: agent + '的饭量', sub: '1 碗 = 1 块钱的 token · 我吃掉的', tone: 'amber' },
          h('div', { className: 'dshrm-meal' },
            h('span', { className: 'big' }, bowls.toFixed(1)),
            h('span', { className: 'unit' }, '碗 · 今天'),
            h('span', { className: 'unit' }, tokTxt + ' tokens' + (money && money.cacheRate ? '（' + Math.round(money.cacheRate * 100) + '% 走缓存）' : ''))),
          week.length
            ? h('div', { className: 'dshrm-week' }, week.map((d, i) => h('div', {
                className: 'dshrm-day', key: i, title: d.date + '：' + d.bowls + ' 碗 ≈ ¥' + (d.cost || 0),
              },
                h('div', { className: 'b', style: { height: Math.max(2, Math.round((d.cost || 0) / (maxDayCost || 1) * 44)) + 'px' } }),
                h('div', { className: 'd', }, d.date))))
            : null,
          projs.length
            ? h('div', { className: 'dshrm-proj' }, projs.map((p, i) => h('div', { className: 'row', key: i },
                h('span', { className: 'nm' }, p.name),
                h('span', { className: 'vv' }, (Number(p.bowls) || 0).toFixed(1) + ' 碗'),
                h('span', { className: 'unit' }, '¥' + (p.cost || 0)))))
            : null,
          h('p', { className: 'dshrm-note' },
            '近 7 天按天、按项目记账（只算开着的会话）。一碗 = 一块钱，按命中/未命中/输出的真实价目折出来的。')),

        money
          ? h(Card, {
              id: 'budget',
              title: '额度守护',
              sub: budVal ? ('月上限 ¥' + budVal.amount) : '谷价估算 · 不是账单',
              tone: 'magenta',
              summary: yuan(money.monthToDate) + ' 本月' + (budVal ? (' · 用掉 ' + Math.round((budVal.ratio || 0) * 100) + '%') : '') + ' · 预计月末 ' + yuan(money.projectedMonth),
            },
              h('div', { className: 'dshrm-meal' },
                h('span', { className: 'big' }, yuan(money.monthToDate)),
                h('span', { className: 'unit' }, '本月已花'),
                h('span', { className: 'unit' }, '今天 ' + yuan(money.today))),
              h('div', { className: 'dshrm-proj' },
                h('div', { className: 'row' },
                  h('span', { className: 'nm' }, '按最近 7 天节奏（每天 ' + yuan(money.perDay) + '）'),
                  h('span', { className: 'vv' }, '预计月末 ' + yuan(money.projectedMonth))),
                h('div', { className: 'row' },
                  h('span', { className: 'nm' }, '剩下 ' + money.daysLeft + ' 天，照这个节奏'),
                  h('span', { className: 'vv' }, '还要 ' + yuan(money.perDay * money.daysLeft))),
                h('div', { className: 'row' },
                  h('span', { className: 'nm' }, '缓存命中率（省钱的命门）'),
                  h('span', { className: 'vv' }, Math.round((money.cacheRate || 0) * 100) + '%'))),
              budVal
                ? h('div', { style: { marginTop: '10px' } },
                    h('div', { className: 'dshrm-rvbar' + (budVal.ratio >= 1 ? ' b3' : budVal.ratio >= 0.8 ? ' b1' : ' b2') },
                      h('i', { style: { width: Math.max(2, Math.min(100, (budVal.ratio || 0) * 100)) + '%' } })),
                    h('div', { className: 'dshrm-kv' },
                      h('span', null, '已用 ', h('b', null, Math.round((budVal.ratio || 0) * 100) + '%')),
                      h('span', null, yuan(budVal.used) + ' / ¥' + budVal.amount),
                      h('span', null, '还剩 ' + yuan(Math.max(0, budVal.amount - budVal.used)) + '（' + money.daysLeft + ' 天）')))
                : null,
              budVal && budVal.ratio >= 0.8
                ? h('div', { className: 'dshrm-budwarn' },
                    budVal.ratio >= 1
                      ? '超了。要压下来，三刀最有用：①做梦从每天改成每三天一次（每次 1–2K tokens）；②判定档降到最便宜的；③别在会话开头改系统提示词和工具清单——缓存命中价差 50 倍。'
                      : '快到了。后面几天把长任务集中做，别让会话空转；缓存命中率别掉（现在 ' + Math.round((money.cacheRate || 0) * 100) + '%）。')
                : null,
              h('div', { className: 'dshrm-bud' },
                h('input', {
                  className: 'dshrm-budinput',
                  value: budDraft,
                  placeholder: budVal ? '改月上限（元）' : '设个月上限（元），超了会变色',
                  onChange: (e) => setBudDraft(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') saveBudget(); },
                }),
                h('button', { className: 'dshrm-pen', onClick: saveBudget }, budBusy ? '存着…' : '设')),
              h('p', { className: 'dshrm-note' },
                'DeepSeek 谷价：命中 0.02 / 未命中 1 / 输出 4 元每百万 token，峰时翻倍。命中率越高越省——别乱改系统提示词和工具清单，那会把缓存打掉。'))
          : null,

        money && money.byModel && money.byModel.length
          ? h(Card, { title: '总账单 · 按模型', sub: '本月各模型实花 + 各自预计月末', tone: 'cyan' },
              h('div', { className: 'dshrm-proj' },
                money.byModel.map((m, i) => h('div', { className: 'row', key: i },
                  h('span', { className: 'nm' }, m.name),
                  h('span', { className: 'vv' }, yuan(m.cost)),
                  h('span', { className: 'unit' }, '占 ' + Math.round((m.share || 0) * 100) + '% · 预计 ' + yuan(m.projected))))),
              h('div', { className: 'dshrm-proj' },
                h('div', { className: 'row' },
                  h('span', { className: 'nm' }, '合计（' + money.byModel.length + ' 个模型）'),
                  h('span', { className: 'vv' }, yuan(money.monthToDate))),
                h('div', { className: 'row' },
                  h('span', { className: 'nm' }, '照这个节奏到月底'),
                  h('span', { className: 'vv' }, yuan(money.projectedMonth)))),
              h('p', { className: 'dshrm-note' },
                '每个事件都带 provider/model，所以换模型、多会话用不同模型都分别记账；本地模型（Ollama 等）按 0 元、标为「本地」。'))
          : null,

        money && money.bySession && money.bySession.length
          ? h(Card, { title: '各会话在用哪个模型', sub: '本月，按花的钱排序', tone: 'amber' },
              h('div', { className: 'dshrm-proj' },
                money.bySession.map((s, i) => h('div', { className: 'row', key: i },
                  h('span', { className: 'nm' }, s.title),
                  h('span', { className: 'unit' }, s.model || '未知'),
                  h('span', { className: 'vv' }, s.local ? '本地' : yuan(s.cost))))),
              h('p', { className: 'dshrm-note' },
                '同一个会话中途换过模型，会把两个模型名用 + 连起来。'))
          : null,

        h(Card, {
          title: '在干什么',
          sub: act ? act.sessions + ' 个会话开着' : '等数据',
          tone: 'cyan',
        },
          act
            ? h('div', null,
                h('div', { className: 'dshrm-item' },
                  h('span', { className: 'n' }, '聊'),
                  h('span', null, (act.active && act.active.title) || '没有正在聊的会话')),
                h('div', { className: 'dshrm-item' },
                  h('span', { className: 'n' }, '刚'),
                  h('span', null, (act.active && act.active.lastUser) || '这一页只是看着，不说话')),
                act.note ? h('p', { className: 'dshrm-note' }, act.note) : null)
            : h('p', { className: 'dshrm-empty' }, '读不到会话列表。')),

        st && Array.isArray(st.board) && st.board.length > 1
          ? h(Card, {
              id: 'board',
              title: '别的会话在干什么',
              sub: st.board.length + ' 个开着',
              tone: 'cyan',
              summary: st.board.slice(0, 3).map((x) => x.title).join(' · '),
            },
              h('div', null, st.board.map((x, i) => h('div', { className: 'dshrm-bdrow', key: i },
                h('span', { className: 'dshrm-dot' + (x.busy ? ' on' : (x.msAgo >= 0 && x.msAgo < 900000 ? '' : ' idle')) }),
                h('span', { className: 'dshrm-bdtitle' }, x.title),
                h('span', { className: 'dshrm-bdmeta' }, (x.busy ? '在跑' : ago(x.msAgo)) + (x.model ? ' · ' + stripModel(x.model) : ''))))),
              h('p', { className: 'dshrm-note' }, '绿点闪 = 正在跑工具。这里只做看板，点不过去。'))
          : null,

        h(Card, {
          title: '待办',
          sub: shownTodos ? (shownTodos.count ? shownTodos.count + ' 条没办' : '干净的') : '等数据',
          tone: 'amber',
        },
          Array.isArray(shownTodos && shownTodos.items) && shownTodos.items.length
            ? h('div', null, shownTodos.items.map((it, i) => h('div', {
                className: 'dshrm-item' + (it.done ? ' done' : ''), key: i,
              },
                h('button', {
                  className: 'dshrm-box' + (it.done ? ' on' : ''),
                  disabled: !it.editable || !!todoBusy,
                  title: it.editable ? (it.done ? '点一下标回未完成' : '点一下标为完成') : '来自 dtodo，去记忆 Tab 改',
                  onClick: () => toggleTodo(it),
                }, it.done ? '✓' : ''),
                editTodoKey === (it.file + ':' + it.line)
                  ? h('input', { className: 'dshrm-nameinput small', defaultValue: it.text, autoFocus: true,
                      onKeyDown: (e) => { if (e.key === 'Enter') saveTodoEdit(it, e.target.value); if (e.key === 'Escape') setEditTodoKey(''); } })
                  : h('span', { className: 'dshrm-todotext' }, it.text),
                it.src === 'note' && editTodoKey !== (it.file + ':' + it.line)
                  ? h('button', { className: 'dshrm-mini', title: '改这条待办的文字', onClick: () => setEditTodoKey(it.file + ':' + it.line) }, '改')
                  : null,
                it.src ? h('span', { className: 'dshrm-src' }, it.src) : null)))
            : h('p', { className: 'dshrm-empty' }, '待办是空的。真干净，还是没记？'),
          shownTodos && shownTodos.bySrc
            ? h('div', { className: 'dshrm-hint tip' },
                '两个来源合在一起了：dtodo ' + shownTodos.bySrc.dtodo + ' 条 + 笔记 ' + shownTodos.bySrc.note + ' 条。都能直接点勾。')
            : null),

        h(Card, {
          id: 'report',
          title: '今天的日报',
          sub: (st && st.report && st.report.exists) ? '已经生成了' : '21:30 自动生成',
          tone: 'amber',
          summary: view ? (yuan(view.money && view.money.today) + ' · 心情 ' + ((view.mood && view.mood.now) || '—') + ' · 缓 ' + Math.round(((view.money && view.money.cacheRate) || 0) * 100) + '%') : '还没有今天的数据',
        },
          h('div', { className: 'dshrm-search' },
            h('button', { className: 'dshrm-pen', onClick: makeReport }, reporting ? '写着…' : '现在生成'),
            h('button', { className: 'dshrm-pen', onClick: () => setShowText(!showText) }, showText ? '看图表' : '看文字版')),
          reportErr ? h('p', { className: 'dshrm-empty' }, '没写成：' + reportErr) : null,
          reportRes && reportRes.path ? h('p', { className: 'dshrm-hint tip' }, '写好了：' + reportRes.path) : null,
          showText
            ? (reportRes && reportRes.text
                ? h('pre', { className: 'dshrm-pre' }, reportRes.text)
                : h('p', { className: 'dshrm-empty' }, '点「现在生成」把文字版拉出来。'))
            : reportPanel(view, agent)),

        h(Card, { title: '笔记本 · 卡在哪', sub: '来自 00-当前.md 的「卡在哪」段', tone: 'magenta' },
          notes && notes.length
            ? h('div', null, notes.map((t, i) => h('div', { className: 'dshrm-item', key: i },
                h('span', { className: 'n' }, String(i + 1).padStart(2, '0')),
                h('span', null, t))))
            : h('p', { className: 'dshrm-empty' }, '笔记里没写卡点。')),

        h(Card, {
          id: 'ideas',
          title: '随录',
          sub: (ideas ? '共 ' + ideas.length + ' 条' : '随手记') + (st && st.ideasToday ? ' · 今天 ' + st.ideasToday + ' 条' : ''),
          tone: 'cyan',
          summary: (ideaOv || ideas || []).slice(0, 2).map((d) => d.title).join(' · ') || '随手记一句，就有一句',
        },
          (ideaOv || ideas) && (ideaOv || ideas).length
            ? h('div', null, (ideaOv || ideas).map((d, i) => {
                const pending = !d.status || /想法|讨论中/.test(d.status)
                return h('div', { className: 'dshrm-item', key: i },
                  h('span', { className: 'n' }, String(i + 1).padStart(2, '0')),
                  editIdeaSeq === d.seq
                    ? h('input', { className: 'dshrm-nameinput small', defaultValue: d.text || d.title, autoFocus: true,
                        onKeyDown: (e) => { if (e.key === 'Enter') saveIdeaEdit(d.seq, e.target.value); if (e.key === 'Escape') setEditIdeaSeq(0); } })
                    : h('span', { className: 'dshrm-ideatext', title: '点右边「改」可以改写' }, d.text || d.title),
                  d.today ? h('span', { className: 'dshrm-flag' }, '今天') : null,
                  !d.today && d.at ? h('span', { className: 'dshrm-flag' }, d.at.slice(5)) : null,
                  !pending && d.status ? h('span', { className: 'dshrm-flag done' }, d.status) : null,
                  pending
                    ? h('span', { className: 'dshrm-ideaact' },
                        h('button', { className: 'dshrm-mini', title: '改这一条的文字', onClick: () => setEditIdeaSeq(d.seq) }, '改'),
                        h('button', { className: 'dshrm-mini', disabled: !!ideaBusy, title: '记为要记住的，进记忆待确认', onClick: () => decideIdea(d, 'keep') }, '记住'),
                        h('button', { className: 'dshrm-mini', disabled: !!ideaBusy, title: '转成一条待办', onClick: () => decideIdea(d, 'todo') }, '待办'),
                        h('button', { className: 'dshrm-mini danger', disabled: !!ideaBusy, title: '舍弃，不再显示操作按钮', onClick: () => decideIdea(d, 'drop') }, '舍弃'))
                    : null)
              }))
            : h('p', { className: 'dshrm-empty' }, '还没记过。想说一句就往下写，回车即存。'),
          h('div', { className: 'dshrm-bud' },
            h('input', {
              className: 'dshrm-budinput',
              value: ideaDraft,
              maxLength: 140,
              placeholder: '随手记一句（回车存进笔记）',
              onChange: (e) => setIdeaDraft(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') saveIdea(); },
            }),
            h('button', { className: 'dshrm-pen', onClick: saveIdea }, ideaBusy ? '存着…' : '记下')),
          ideaMsg ? h('p', { className: 'dshrm-hint tip' }, ideaMsg) : null,
          h('p', { className: 'dshrm-note' }, '点了「待办」就搬进待办卡，不在这儿堆着；点「改」能改字。写的和微信里说的都落进 笔记/30-想法池.md。')),

                h(Card, {
          id: 'archive',
          title: '最近处理过',
          sub: '已采纳 / 已转待办 / 已舍弃',
          tone: 'violet',
          summary: archList && archList.length ? archList.length + ' 条' : '暂时没有',
        },
          archList && archList.length
            ? h('div', null, archList.map((a, i) => h('div', { className: 'dshrm-item', key: i },
                h('span', { className: 'n' }, 'A' + a.seq),
                h('span', { className: 'dshrm-ideatext' }, a.text || a.title),
                h('span', { className: 'dshrm-flag done' }, String(a.status).replace(/[（(].*$/, '')),
                a.at ? h('span', { className: 'dshrm-flag' }, a.at.slice(5)) : null,
                /^舍弃/.test(String(a.status || ''))
                  ? h('button', {
                      className: 'dshrm-mini', disabled: !!ideaBusy, title: '放回随录，再决定一次',
                      onClick: () => restoreIdeaItem(a),
                    }, '恢复')
                  : null)))
            : h('p', { className: 'dshrm-empty' }, '还没有处理过的条目。'),
          h('p', { className: 'dshrm-note' }, '只留最近 30 天的 5 条；「舍弃」的点一下就放回随录，能重新决定。更早的没删，还在 30-想法池.md 里，用下面的记忆检索翻。')),

h(Card, { title: '记忆检索', sub: '从笔记和记忆里翻旧账 · 本机索引', tone: 'magenta' },
          h('div', { className: 'dshrm-search' },
            h('input', {
              className: 'dshrm-nameinput',
              value: q,
              placeholder: '问一句，比如「上次说拖拽的坑」',
              onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') recall(); },
            }),
            h('button', { className: 'dshrm-pen', onClick: recall }, searching ? '翻…' : '翻')),
          recentQ && recentQ.length
            ? h('div', { className: 'dshrm-recent' }, recentQ.map((r, i) => h('button', {
                className: 'dshrm-chip', key: i, title: '再翻一次：' + r,
                onClick: () => { setQ(r); recall(r); },
              }, r)))
            : null,
          qErr ? h('p', { className: 'dshrm-empty' }, '这边没翻动：' + qErr) : null,
          hits === null
            ? h('p', { className: 'dshrm-empty' }, '写下来的都在这儿：问一句，我去笔记和记忆里翻。')
            : !hits.length
              ? h('p', { className: 'dshrm-empty' }, '没翻到。换个说法，或者它确实还没被写下来。')
              : h('div', null, hits.map((it, i) => h('div', { className: 'dshrm-hit', key: i },
                  h('div', { className: 'dshrm-hithead' },
                    h('span', { className: 'dshrm-flag' }, it.src || '?'),
                    h('span', { className: 'dshrm-hittitle' }, it.title || ''),
                    it.date ? h('span', { className: 'dshrm-hitdate' }, it.date) : null),
                  h('div', { className: 'dshrm-hitsnip' }, it.snippet || ''))))),

        h(Card, { title: '今晚的梦', sub: '把今天过一遍，只挑值得留下的', tone: 'violet' },
          h('div', { className: 'dshrm-search' },
            h('button', { className: 'dshrm-pen', onClick: () => dream(true) }, dreaming ? '睡着…' : '现在做一次'),
            h('span', { className: 'dshrm-hitdate' }, '每晚 23:00 自动做')),
          dreamErr ? h('p', { className: 'dshrm-empty' }, '没做成：' + dreamErr) : null,
          dreamRes
            ? h('div', null,
                h('p', { className: 'dshrm-empty' }, '新增 ' + dreamRes.added + ' 条候选、重复 ' + dreamRes.dup + ' 条（已进记忆 Tab 的待确认）'),
                (dreamRes.items || []).map((it, i) => h('div', { className: 'dshrm-hit', key: i },
                  h('div', { className: 'dshrm-hithead' },
                    h('span', { className: 'dshrm-flag' }, BUCKET_LABEL[it.bucket] || it.bucket),
                    h('span', { className: 'dshrm-hittitle' }, it.content)),
                  it.reason ? h('div', { className: 'dshrm-hitsnip' }, it.reason) : null)))
            : (st && st.dream && st.dream.items && st.dream.items.length
              ? h('div', null,
                  h('p', { className: 'dshrm-empty' }, '上一次：' + new Date(st.dream.at).toLocaleString('zh-CN', { hour12: false }) + '，新增 ' + (st.dream.added || 0) + ' 条'),
                  st.dream.items.map((it, i) => h('div', { className: 'dshrm-hit', key: i },
                    h('div', { className: 'dshrm-hithead' },
                      h('span', { className: 'dshrm-flag' }, BUCKET_LABEL[it.bucket] || it.bucket),
                      h('span', { className: 'dshrm-hittitle' }, it.content)))))
              : h('p', { className: 'dshrm-empty' }, '今晚还没做梦。候选会进「记忆」Tab 里等你逐条确认，不会自己写进长期记忆。'))),

        loadErr ? h('p', { className: 'dshrm-foot', style: { color: '#ff2e97' } }, '⚠ 读不到状态（' + loadErr + '）：面板停在上一份数据') : null,
        h('p', { className: 'dshrm-foot' }, '本机读取 · 心情、饭量、待办、笔记都不出这台机器')
      );
    }

    // 出错时不留白屏：把错误原文显示出来，同时报回宿主
    class ErrBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }
      static getDerivedStateFromError(err) {
        return { err: err };
      }
      componentDidCatch(err, info) {
        reportClientError('render', err && err.message, (err && err.stack) + '\n' + (info && info.componentStack));
      }
      render() {
        if (this.state.err) {
          const e = this.state.err;
          return h('div', { className: 'dshrm-page' },
            h('div', { className: 'dshrm-card' },
              h('div', { className: 'dshrm-h' }, h('span', { className: 'bar' }), h('span', { className: 'name' }, '面板崩了')),
              h('p', { className: 'dshrm-empty' }, '错误：' + String((e && e.message) || e)),
              h('pre', { className: 'dshrm-pre' }, String((e && e.stack) || '').slice(0, 1500)),
              h('p', { className: 'dshrm-hint tip' }, '这条错误已经报回宿主的 client-error.log，我在后台能看到。')));
        }
        return this.props.children;
      }
    }

    function SafePage(props) {
      return h(ErrBoundary, null, h(Page, props));
    }

    function RowIcon(owner) {
      const size = (owner && owner.size) || 16;
      return h('img', {
        src: FACE, alt: '', width: size, height: size, draggable: false,
        style: { display: 'block', objectFit: 'contain', borderRadius: '50%' },
      });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          order: 5,
        }, SafePage));

        ctx.slots.inject('sidebar.panellist', () => {
          let dispose = null;
          const mount = () => {
            const prev = dispose;
            let next = null;
            try {
              next = ctx.slots.register({
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 3,
                label: () => PANEL_NAME,
              }, RowIcon);
            } catch (e) {
              // 新的一行注册失败就保留旧的，别让侧栏整行消失
              return prev;
            }
            if (prev && prev !== next) { try { prev(); } catch (e) { /* ignore */ } }
            dispose = next;
            return next;
          };
          REREGISTER_SIDEBAR = mount;
          // 交给宿主的是"稳定的" disposer：卸载时总是注销当前那一份，不会泄漏
          return () => {
            REREGISTER_SIDEBAR = null;
            const d = dispose;
            dispose = null;
            if (d) { try { d(); } catch (e) { /* ignore */ } }
          };
        });

        // 名字存在服务端，开页时对一次（侧栏那一行首帧就是对的）
        try {
          fetch('/dsh-room/state', { credentials: 'same-origin', cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              if (!j) return;
              if (j.agentName) AGENT_NAME = j.agentName;
              if (!j.panelName || j.panelName === PANEL_NAME) return;
              PANEL_NAME = j.panelName;
              // 侧栏那一行是按注册时的 label 渲染的，改名后重挂一次让它立刻跟上
              try { if (REREGISTER_SIDEBAR) REREGISTER_SIDEBAR(); } catch (e) { /* 下次刷新再说 */ }
            })
            .catch(() => {});
        } catch (e) { /* 无所谓 */ }
      },
    };
  },
});
