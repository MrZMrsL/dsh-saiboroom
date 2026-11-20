// 把 client.template.js 编译成 client.js：把占位符换成 base64（像素字体 + 7 张角色图 + 6 条两帧动画）
//
// 用法：node build.cjs
//
// 为什么要编译：DSH 的插件是 link 装到磁盘上的静态目录，浏览器里读不到本地文件路径，
// 所以图片与字体必须内联成 data URI 塞进 client.js。
const fs = require('fs')
const path = require('path')

const HERE = __dirname
const ASSETS = path.join(HERE, 'assets')
const TEMPLATE = path.join(HERE, 'client.template.js')
const OUT = path.join(HERE, 'client.js')

const b64 = (p) => fs.readFileSync(p).toString('base64')

let s = fs.readFileSync(TEMPLATE, 'utf8')

const imgs = {
  __IMG_MAIN__: 'chara/main.png',
  __IMG_THINK__: 'chara/think.png',
  __IMG_PROUD__: 'chara/proud.png',
  __IMG_SLEEP__: 'chara/sleep.png',
  __IMG_WORK__: 'chara/work.png',
  __IMG_EAT__: 'chara/eat.png',
  __IMG_ICON__: 'chara/icon.png',
  __ANIM_IDLE__: 'chara/anim_idle.png',
  __ANIM_THINK__: 'chara/anim_think.png',
  __ANIM_WORK__: 'chara/anim_work.png',
  __ANIM_EAT__: 'chara/anim_eat.png',
  __ANIM_PROUD__: 'chara/anim_proud.png',
  __ANIM_SLEEP__: 'chara/anim_sleep.png',
}
for (const [k, rel] of Object.entries(imgs)) {
  if (!s.includes(k)) throw new Error('模板里没有占位符 ' + k)
  const p = path.join(ASSETS, rel)
  if (!fs.existsSync(p)) throw new Error('缺素材 ' + p)
  s = s.split(k).join(b64(p))
}

if (!s.includes('__ZPIX__')) throw new Error('模板里没有 __ZPIX__')
s = s.split('__ZPIX__').join('data:font/ttf;base64,' + b64(path.join(ASSETS, 'zpix.ttf')))

const left = s.match(/__[A-Z_]+__/g)
if (left) throw new Error('还有残留占位符：' + [...new Set(left)].join(','))

fs.writeFileSync(OUT, s, 'utf8')

const mb = (fs.statSync(OUT).size / 1048576).toFixed(2)
const png = (s.match(/data:image\/png;base64,iVBOR/g) || []).length
const font = (s.match(/url\("data:font\/ttf;base64,/g) || []).length
console.log('built client.js  ' + mb + ' MB  png=' + png + '  font=' + font)
